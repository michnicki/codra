import type { AppBindings } from '../env';
import { reviewWithGoogle } from '../models/google';
import { reviewWithCloudflare, submitCloudflareBatch, pollCloudflareBatch } from '../models/cloudflare';
import { reviewWithOpenAI } from '../models/openai';
import { reviewWithAnthropic } from '../models/anthropic';
import { buildFileReviewPrompts } from '../prompts/file-review';
import { buildSecurityReviewPrompts } from '../prompts/security-review';
import { buildCriticPrompts, type CriticCandidateFinding } from '../prompts/critic';
import { buildSummaryPrompt, SUMMARY_SYSTEM_PROMPT } from '../prompts/summary';
import { WALKTHROUGH_DIAGRAM_SYSTEM_PROMPT, buildWalkthroughDiagramPrompt } from '../prompts/walkthrough-diagram';
import { WALKTHROUGH_ENRICHMENT_SYSTEM_PROMPT, buildWalkthroughEnrichmentPrompt, type EnrichmentFileEntry } from '../prompts/walkthrough-enrichment';
import { parseFileReviewResponse, parseAnswerResponse } from '../core/model-output';
import { truncateFileDiff, chunkFileDiff, type FileDiff } from '../core/diff';
import type { RepoConfig } from '@shared/schema';
import type { TokenTracker } from '../core/token-tracker';
import { UnparseableModelResponseError, type ModelRequestInput, type ModelResponse } from '../models/types';
import { logger } from '../core/logger';
import { normalizeModelId } from '@shared/schema';
import { isTimeoutMessage, matchesAnyTransientSubstring } from '@shared/transient-errors';
import { getResolvedModelConfig, type ResolvedModelConfig } from '@server/db/model-configs';
import { decryptLlmApiKey } from '@server/core/llm-crypto';
import { ModelCallGate, adaptiveModelTimeoutMs, MODEL_FALLBACK_CHAIN_BUDGET_MS } from '../models/limits';
import { admitEnsembleUnit, type EnsembleRun, type EnsembleAdmissionShape } from '../core/ensemble';

const PROVIDER_UNAVAILABLE_TTL_SECONDS = 24 * 60 * 60;
const COMPACT_REVIEW_PROMPT_LINE_CAP = 400;
const MODEL_ALIASES: Record<string, string> = {
  'gemma-4-31b': 'gemma-4-31b-it',
  'gemma-4-26b': 'gemma-4-26b-a4b-it',
};

export class RetryableModelError extends Error {
  readonly retryable = true;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'RetryableModelError';
    if (cause !== undefined) {
      Object.defineProperty(this, 'cause', {
        value: cause,
        writable: true,
        configurable: true,
      });
    }
  }
}

export function isRetryableModelError(error: unknown) {
  return Boolean(error && typeof error === 'object' && 'retryable' in error && error.retryable === true);
}

function normalizeModel(model: string) {
  return normalizeModelId(MODEL_ALIASES[model] ?? model);
}

function uniqueModels(models: string[]) {
  return Array.from(new Set(models.map(normalizeModel)));
}

function isCloudflareAllocationError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('4006') || message.toLowerCase().includes('daily free allocation');
}

function isGoogleRateLimitError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  
  if (lower.includes('timed out') || lower.includes('timeout')) {
    return false;
  }
  
  return lower.includes('429') || lower.includes('resource_exhausted') || lower.includes('quota exceeded');
}

function isTransientModelFailure(error: unknown) {
  if (isRetryableModelError(error)) return true;
  // No reviewable output (reasoning-only / truncated / empty) is deterministic -- never retry it.
  if (error instanceof UnparseableModelResponseError) return false;
  if (isCloudflareAllocationError(error)) return false;
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();

  // Explicitly fail fast for timeouts so they don't loop endlessly
  if (isTimeoutMessage(lower)) {
    return false;
  }

  return (
    isGoogleRateLimitError(error) ||
    matchesAnyTransientSubstring(lower) ||
    lower.includes('fetch failed') ||
    lower.includes('network') ||
    lower.includes('temporar') ||
    // Upstream 5xx (e.g. Gemini's frequent "request failed with 500: Internal error encountered")
    // is a transient server-side outage, not a deterministic client error. Without this a sustained
    // 5xx run makes every model in the chain throw a non-transient error, so the file is marked
    // permanently failed instead of being deferred and retried once the provider recovers.
    /\b50[0-9]\b/.test(lower) ||
    lower.includes('internal error')
  );
}

export class ModelService {
  // Model configs don't change during a single review invocation, but resolveModel() is called
  // once per file *and* once per fallback model. Left uncached that's a Hyperdrive round-trip
  // (a counted subrequest) for every one of those, which both burns the per-invocation
  // subrequest budget (shrinking how many files a chunk can review in parallel) and floods the
  // connection pool. Memoize per ModelService instance (one instance == one invocation/chunk)
  // so each distinct model is resolved from the DB at most once. Cache the in-flight promise
  // (not just the settled value) so concurrent resolveModel() calls for the same model made
  // before the first DB round-trip completes all await the same request instead of each firing
  // their own.
  private readonly resolvedModelCache = new Map<string, Promise<ResolvedModelConfig | null>>();

  // The Workers runtime allows only 6 simultaneous connections per invocation; anything beyond
  // that is queued without starting. When several files review in parallel, un-gated model
  // calls queue behind each other and burn their entire client timeout before the request is
  // even dispatched (observed as a provider "timing out" at exactly the configured timeout on
  // every attempt). Gate all outbound model calls for this invocation so a call's timeout only
  // starts once it actually has a connection slot.
  private readonly callGate = new ModelCallGate();

  // Provider-unavailable markers live in KV and every read is a counted subrequest. The marker
  // can't flip from set back to unset within one invocation, so cache lookups per instance
  // (one instance == one invocation) instead of re-reading KV for every file in the chunk.
  private readonly providerUnavailableCache = new Map<string, Promise<boolean>>();

  // Models proven (this invocation) not to support the async batch queue. try-async-then-fallback
  // means the first file probes async; if that fails, every later file in the same chunk skips the
  // probe and goes straight to the synchronous path, so a non-async model isn't charged an extra
  // (potentially full-inference) submit attempt per file.
  private readonly asyncUnsupportedModels = new Set<string>();

  constructor(
    private env: AppBindings,
    private tracker?: TokenTracker,
    private options: { jobId?: string } = {},
  ) {}

  private providerUnavailableKey(providerId: string) {
    return this.options.jobId ? `jobs:${this.options.jobId}:provider-unavailable:${providerId}` : null;
  }

  private isProviderUnavailable(providerId: string): Promise<boolean> {
    const key = this.providerUnavailableKey(providerId);
    if (!key) return Promise.resolve(false);

    let pending = this.providerUnavailableCache.get(providerId);
    if (!pending) {
      pending = (async () => {
        try {
          this.tracker?.incrementSubrequests(1);
          return (await this.env.APP_KV.get(key)) !== null;
        } catch (error) {
          logger.warn(`Failed to read unavailable provider marker for ${providerId}`, {
            error: error instanceof Error ? error.message : String(error),
          });
          return false;
        }
      })();
      this.providerUnavailableCache.set(providerId, pending);
    }
    return pending;
  }

  private async markProviderUnavailable(providerId: string, reason: string) {
    const key = this.providerUnavailableKey(providerId);
    if (!key) return;

    // Keep the in-invocation cache consistent with what we just wrote.
    this.providerUnavailableCache.set(providerId, Promise.resolve(true));

    try {
      this.tracker?.incrementSubrequests(1);
      await this.env.APP_KV.put(
        key,
        JSON.stringify({
          reason,
          markedAt: new Date().toISOString(),
        }),
        { expirationTtl: PROVIDER_UNAVAILABLE_TTL_SECONDS },
      );
    } catch (error) {
      logger.warn(`Failed to write unavailable provider marker for ${providerId}`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private selectModel(params: {
    totalLineCount: number;
    config: RepoConfig;
    // When false, the size-override block is skipped entirely and model.main + fallbacks resolve
    // directly. Two reasons this exists (both from the review-verified HIGH bug): (1) a size-override
    // is only meaningful for a single SIZED file/diff, but the critic reviews a whole finding SET,
    // not a sized file; (2) with overrides applied, selectModel({ totalLineCount: 0 }) matches the
    // FIRST override (0 <= any positive max_lines) instead of using model.main — so 0 (a valid line
    // count / "not a sized call") must NOT silently swap the model. Defaults to true so every
    // existing caller is behavior-identical.
    applySizeOverrides?: boolean;
  }): { primary: string; fallbacks: string[] } {
    const { model: modelCfg } = params.config;
    const thresholdBase = params.totalLineCount;
    const applySizeOverrides = params.applySizeOverrides ?? true;

    let selectedModel = modelCfg?.main ? normalizeModel(modelCfg.main) : null;
    let fallbackModels = (modelCfg?.fallbacks || []).map(normalizeModel);

    // Apply size overrides based on total PR lines
    if (applySizeOverrides && modelCfg?.size_overrides && modelCfg.size_overrides.length > 0) {
      const sortedOverrides = [...modelCfg.size_overrides].sort((a, b) => a.max_lines - b.max_lines);
      const matched = sortedOverrides.find(o => thresholdBase <= o.max_lines);
      if (matched) {
        selectedModel = normalizeModel(matched.model);
        fallbackModels = (matched.fallbacks || fallbackModels).map(normalizeModel);
      }
    }

    const chain = uniqueModels([...(selectedModel ? [selectedModel] : []), ...fallbackModels]);
    if (chain.length === 0) {
      throw new Error('No review model strategy is configured. Choose a global model strategy in Settings, or configure this repository.');
    }

    selectedModel = chain[0];
    fallbackModels = chain.slice(1);

    return { primary: selectedModel, fallbacks: fallbackModels };
  }

  private async resolveModel(model: string) {
    const normalized = normalizeModel(model);
    let pending = this.resolvedModelCache.get(normalized);
    if (!pending) {
      // Cache the DB answer -- including a null "not configured" result -- so a missing or
      // repeatedly-used model isn't re-queried for every file in the chunk.
      pending = getResolvedModelConfig(this.env, normalized);
      this.resolvedModelCache.set(normalized, pending);
      // A failed lookup (e.g. a transient DB error) shouldn't poison the cache for the rest of
      // the invocation -- drop it so the next call retries instead of rejecting immediately.
      pending.catch(() => this.resolvedModelCache.delete(normalized));
    }
    const resolved = await pending;
    if (!resolved) {
      throw new Error(`Model ${normalized} is not configured. Add it in Settings before using it in a route.`);
    }

    if (!resolved.providerEnabled) {
      throw new Error(`Provider ${resolved.providerName} is disabled.`);
    }

    return resolved;
  }

  private async decryptApiKey(config: ResolvedModelConfig) {
    if (!config.encryptedApiKey) {
      throw new Error(`Provider ${config.providerName} does not have a saved API key.`);
    }
    return decryptLlmApiKey(this.env, config.encryptedApiKey);
  }

  private async callResolvedModel(
    config: ResolvedModelConfig,
    input: ModelRequestInput,
    timeoutMs?: number,
  ): Promise<ModelResponse> {
    // Resolve credentials *before* taking a gate slot so slow KV/crypto work never occupies a
    // model-call slot, then run the actual provider request under the gate. The provider's
    // timeout only starts inside the gated call, so time spent waiting for a slot is free.
    if (config.apiFormat === 'cloudflare-workers-ai') {
      return this.callGate.run(() =>
        reviewWithCloudflare(this.env, config.modelName, input, this.tracker, config.providerName, { timeoutMs }),
      );
    }

    if (config.apiFormat === 'gemini') {
      const apiKey = await this.decryptApiKey(config);
      return this.callGate.run(() =>
        reviewWithGoogle(
          { apiKey, baseUrl: config.baseUrl, providerName: config.providerName, timeoutMs },
          config.modelName,
          input,
          this.tracker,
        ),
      );
    }

    if (config.apiFormat === 'openai') {
      const apiKey = await this.decryptApiKey(config);
      return this.callGate.run(() =>
        reviewWithOpenAI(
          {
            apiKey,
            baseUrl: config.baseUrl || 'https://api.openai.com/v1',
            providerName: config.providerName,
            timeoutMs,
          },
          config.modelName,
          input,
          this.tracker,
        ),
      );
    }

    const apiKey = await this.decryptApiKey(config);
    return this.callGate.run(() =>
      reviewWithAnthropic(
        { apiKey, baseUrl: config.baseUrl, providerName: config.providerName, timeoutMs },
        config.modelName,
        input,
        this.tracker,
      ),
    );
  }

  async reviewFile(params: {
    file: any;
    prTitle: string | null;
    prDescription: string | null;
    config: RepoConfig;
    totalLineCount: number;
    compactPrompt?: boolean;
    // Selects which review PROMPT this unit uses (D-01). 'security' routes through
    // buildSecurityReviewPrompts; 'main' (default) is behavior-identical to today. This selects only
    // the prompt — model resolution, chunking, fallback chain, and retry classification are shared
    // (D-02: there is NO per-pass model override).
    pass?: 'main' | 'security';
    temperature?: number;
  }) {
    const configuredLineCap = params.config.review.max_diff_lines_per_file;
    const modelLineCap = params.compactPrompt
      ? Math.min(configuredLineCap, COMPACT_REVIEW_PROMPT_LINE_CAP)
      : configuredLineCap;

    let chunks = chunkFileDiff(params.file, modelLineCap);
    // Remember the pre-cap chunk count so wasPromptTruncated doesn't have to re-run chunkFileDiff.
    const totalChunkCount = chunks.length;

    // Cap chunks to prevent single files from burning all subrequests and getting stuck.
    const MAX_CHUNKS = 4;
    if (chunks.length > MAX_CHUNKS) {
      chunks = chunks.slice(0, MAX_CHUNKS);
    }

    if (chunks.length === 1) {
      return this.reviewFileChunk({ ...params, file: chunks[0] });
    }

    const results: Array<ModelResponse & { parsed: ReturnType<typeof parseFileReviewResponse>, reviewedLineCount: number, wasPromptTruncated: boolean, userPrompt: string }> = [];
    
    for (const chunk of chunks) {
      // Don't start a new chunk if we are dangerously close to the 50 subrequest limit.
      if (results.length > 0 && this.tracker?.isNearLimit()) {
        logger.warn(`Stopping chunk processing for ${params.file.path} early due to subrequest budget limits.`);
        break;
      }
      
      try {
        const res = await this.reviewFileChunk({ ...params, file: chunk });
        results.push(res as any);
      } catch (error) {
        if (results.length === 0) {
          throw error; // First chunk failed, let it defer/fail properly
        }
        logger.warn(`Chunk review failed for ${params.file.path}, returning partial results to avoid stalling the job.`, { error: error instanceof Error ? error.message : String(error) });
        break;
      }
    }

    const combinedFindings = results.flatMap(r => r.parsed.comments);
    // Merge every chunk's severity audit events (same .flatMap pattern as combinedFindings) so a
    // multi-chunk file surfaces adjustments from all chunks, not just the primary chunk's.
    const combinedSeverityAuditEvents = results.flatMap(r => r.parsed.severityAuditEvents);
    // Report the file with the most serious chunk's verdict/summary/correctness, not just the last
    // chunk's: taking `results[results.length - 1]` would let a clean final chunk mask real findings
    // from an earlier chunk of the same file (reporting verdict 'approve' while carrying its comments).
    const primaryResult = results.find(r => r.parsed.verdict === 'comment') ?? results[results.length - 1];

    return {
      ...primaryResult,
      inputTokens: results.reduce((sum, r) => sum + r.inputTokens, 0),
      outputTokens: results.reduce((sum, r) => sum + r.outputTokens, 0),
      parsed: {
        ...primaryResult.parsed,
        comments: combinedFindings,
        severityAuditEvents: combinedSeverityAuditEvents,
      },
      reviewedLineCount: results.reduce((sum, r) => sum + r.reviewedLineCount, 0),
      wasPromptTruncated: chunks.length < totalChunkCount || results.length < chunks.length,
    };
  }

  /**
   * Phase 19 (PASS-02 / D-13): ensemble fan-out. Dispatches N main-pass samples of the SAME
   * file review, each independently walked through the existing chunking + fallback chain +
   * Google retry pipeline. Returns the per-run results so the caller can reconcile / persist
   * the consensus finding list.
   *
   * **D-13 contract:**
   *   - Main units call this with `runs > 1`. The primary sample (runIndex 0) uses the configured
   *     review settings exactly as the scalar/async path does; only the N-1 extras are given
   *     `ensembleTemperature` (D-13: extras only).
   *   - Security units are NEVER fanned out — the caller is responsible for clamping
   *     `runs` to 1 when pass='security' so this method sees runs=1 and falls through to the
   *     scalar reviewFile (NREG-01).
   *   - When `runs === 1`, this method delegates to `reviewFile` directly so the scalar/async
   *     path is preserved byte-identically.
   *
   * **Admission (D-13 / T-19-07):**
   *   Before fanning out, the worst-case subrequest cost is computed as
   *   `samples × chunks × (1 + fallbacks + Google retries) + ENSEMBLE_ADMISSION_HEADROOM` and
   *   admitted against the remaining safe budget. A rejected unit throws a `RetryableModelError`
   *   whose message includes 'subrequest' so `isSubrequestBudgetError` catches it and the
   *   orchestrator fresh-hands-off to a new invocation.
   *
   * **Fan-out (D-13):**
   *   The N samples are dispatched via `Promise.allSettled`; each sample's individual model
   *   call still flows through the shared `ModelCallGate` (max 3 concurrent), so this method
   *   never inflates the per-invocation connection pool above the existing ceiling.
   *
   * **Returns:** `{ runs: EnsembleRun[] }` — one entry per requested sample, in stable
   * `runIndex` order. A sample whose call rejected is recorded as `{ failed: true, reason }`
   * with `findings: []` so the caller can subtract it from the D-10 denominator.
   */
  async runFileWithEnsemble(params: {
    file: any;
    prTitle: string | null;
    prDescription: string | null;
    config: RepoConfig;
    totalLineCount: number;
    compactPrompt?: boolean;
    pass?: 'main' | 'security';
    runs: number;
    ensembleTemperature?: number;
    // Internal: when an inner reviewFile call returns, this method may need to know the
    // per-sample temperature. The primary call leaves it undefined; extras receive
    // `ensembleTemperature`. The field is set internally by the fan-out loop.
    temperature?: number;
  }): Promise<{ runs: EnsembleRun[] }> {
    // Defensive: when runs=1, fall through to the scalar/async path so the existing reviewFile
    // contract is byte-identically preserved. The caller (review.ts) is the source of truth for
    // when to fan out — model service does not silently expand runs.
    if (params.runs <= 1) {
      const result = await this.reviewFile({ ...params });
      return {
        runs: [
          {
            runIndex: 0,
            findings: result.parsed.comments,
            model: result.modelUsed,
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
            failed: false,
          },
        ],
      };
    }

    // Compute admission shape from the actual file + configured model strategy. chunkFileDiff is
    // pure (no I/O) so calling it here for admission is cheap; the same chunks are recomputed
    // inside each sample's reviewFile call (N+1 chunkFileDiff invocations total, but each is
    // trivial). The fallback count comes from the same selectModel that reviewFile uses, so
    // admission matches the per-sample worst case.
    const configuredLineCap = params.config.review.max_diff_lines_per_file;
    const modelLineCap = params.compactPrompt
      ? Math.min(configuredLineCap, COMPACT_REVIEW_PROMPT_LINE_CAP)
      : configuredLineCap;
    const chunks = chunkFileDiff(params.file, modelLineCap);
    const MAX_CHUNKS = 4;
    const chunkCount = Math.min(chunks.length, MAX_CHUNKS);
    const { fallbacks } = this.selectModel({
      totalLineCount: params.totalLineCount,
      config: params.config,
    });
    const admissionShape: EnsembleAdmissionShape = {
      runs: params.runs,
      chunkCount,
      fallbackCount: fallbacks.length,
      googleMaxRetries: 2, // matches google.ts GEMINI_MAX_RETRIES
    };
    if (this.tracker) {
      const admission = admitEnsembleUnit(this.tracker, admissionShape);
      if (!admission.admitted) {
        // Surface as a RetryableModelError with a "subrequest" marker so isSubrequestBudgetError
        // catches it and the orchestrator fresh-hands-off. The orchestrator's subrequest-budget
        // branch re-throws with retryAfterSeconds=FRESH_INVOCATION_YIELD_SECONDS.
        throw new RetryableModelError(admission.reason ?? 'Ensemble admission rejected: would exceed safe subrequest budget.');
      }
    }

    // Fan out N samples. Each sample is a complete reviewFile call: same chunking, same fallback
    // chain, same Google retry behavior. The three-slot ModelCallGate inside callResolvedModel
    // bounds the actual concurrency — Promise.allSettled only schedules the promises, the gate
    // throttles dispatch.
    const settled = await Promise.allSettled(
      Array.from({ length: params.runs }, async (_, i) => {
        const isPrimary = i === 0;
        // D-13: only extras receive the ensemble temperature; the primary call uses its normal
        // review settings (undefined preserves the existing per-adapter default). The primary
        // call is therefore made WITHOUT a `temperature` field on its params object, so the
        // providers' `input.temperature === undefined ? {} : { temperature: ... }` guards
        // omit the field from the request body.
        const reviewParams: typeof params = isPrimary
          ? params
          : { ...params, temperature: params.ensembleTemperature };
        return this.reviewFile(reviewParams);
      }),
    );

    // Convert settled -> EnsembleRun[]. D-10: failed runs are removed from the denominator by the
    // reconciler; the caller reads `successfulRuns` to decide between degrade and consensus.
    const runs: EnsembleRun[] = settled.map((result, runIndex) => {
      if (result.status === 'fulfilled') {
        const value = result.value;
        return {
          runIndex,
          findings: value.parsed.comments,
          model: value.modelUsed,
          inputTokens: value.inputTokens,
          outputTokens: value.outputTokens,
          failed: false,
        };
      }
      // Failed run — record a machine-readable reason so the audit can explain the gap.
      const reason = result.reason instanceof Error ? result.reason.message : String(result.reason ?? 'unknown');
      return {
        runIndex,
        findings: [],
        model: null,
        inputTokens: 0,
        outputTokens: 0,
        failed: true,
        reason: reason.slice(0, 200),
      };
    });

    return { runs };
  }

  /**
   * Try to submit a file's review to the Workers AI asynchronous batch queue. Returns the queue
   * request_id and the model it was submitted to, or null when async batching isn't usable for
   * the primary model (non-Cloudflare provider, or the model/account doesn't support queueing) --
   * in which case the caller falls back to the synchronous reviewFile path. This decouples slow
   * (e.g. reasoning) model inference from the per-invocation timeout and subrequest cap.
   */
  async submitReviewBatch(params: {
    file: any;
    prTitle: string | null;
    prDescription: string | null;
    config: RepoConfig;
    totalLineCount: number;
    compactPrompt?: boolean;
  }): Promise<{ requestId: string; model: string } | null> {
    const { primary } = this.selectModel({ totalLineCount: params.totalLineCount, config: params.config });

    let resolved: ResolvedModelConfig;
    try {
      resolved = await this.resolveModel(primary);
    } catch {
      return null;
    }
    // Only Cloudflare Workers AI exposes the async batch queue; other providers use the sync path.
    if (resolved.apiFormat !== 'cloudflare-workers-ai') return null;
    // Skip the probe for a model already shown not to support async queueing this invocation.
    if (this.asyncUnsupportedModels.has(resolved.modelName)) return null;

    const configuredLineCap = params.config.review.max_diff_lines_per_file;
    const modelLineCap = params.compactPrompt
      ? Math.min(configuredLineCap, COMPACT_REVIEW_PROMPT_LINE_CAP)
      : configuredLineCap;
    const file = truncateFileDiff(params.file, modelLineCap);
    const { systemPrompt, userPrompt } = buildFileReviewPrompts({
      ...params,
      file,
      config: params.config.review,
    });

    try {
      const requestId = await this.callGate.run(() =>
        submitCloudflareBatch(this.env, resolved.modelName, { systemPrompt, userPrompt }, this.tracker),
      );
      return { requestId, model: resolved.modelName };
    } catch (error) {
      // Any failure here (async unsupported, transient submit error) is non-fatal: the caller
      // reviews the file synchronously instead. Remember the model so sibling files this
      // invocation don't each pay the failed probe.
      this.asyncUnsupportedModels.add(resolved.modelName);
      logger.warn(`Async batch submit unavailable for ${resolved.modelName}; using synchronous review`, {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Poll a previously submitted async batch review. Returns 'pending' while still queued/running,
   * 'done' with the parsed review once complete, or 'failed' if the poll or parse errored.
   */
  async pollReviewBatch(params: { model: string; requestId: string; file: any; config?: RepoConfig; compactPrompt?: boolean }): Promise<
    | { status: 'pending' }
    | { status: 'done'; response: ModelResponse & { parsed: ReturnType<typeof parseFileReviewResponse>; reviewedLineCount: number; wasPromptTruncated: boolean; userPrompt: string } }
    | { status: 'failed'; error: unknown }
  > {
    let resolved: ResolvedModelConfig;
    try {
      resolved = await this.resolveModel(params.model);
    } catch (error) {
      return { status: 'failed', error };
    }

    try {
      const poll = await this.callGate.run(() =>
        pollCloudflareBatch(this.env, resolved.modelName, params.requestId, this.tracker, resolved.providerName),
      );
      if (poll.status === 'pending') return { status: 'pending' };

      const response = poll.response;
      if (this.tracker) {
        this.tracker.record(response.modelUsed, response.inputTokens, response.outputTokens);
      }
      // EVID-01 (Codex 15-04 HIGH): reconstruct the EXACT bounded file the model actually saw before
      // parsing. submitReviewBatch truncated the file to `modelLineCap` (compact-aware) and submitted
      // ONLY that prefix; parsing the FULL untruncated params.file here would let evidence present only
      // in the truncated-away tail falsely pass the soft evidence gate (it would never emit not_in_hunk).
      // Reproduce the SAME modelLineCap formula so the evidence haystack matches the submitted prefix.
      // When config is absent (the type allows it; no caller omits it today) fall back to params.file
      // unchanged — no worse than the pre-EVID-01 behavior.
      let fileForParse = params.file;
      if (params.config) {
        const configuredLineCap = params.config.review.max_diff_lines_per_file;
        const modelLineCap = params.compactPrompt
          ? Math.min(configuredLineCap, COMPACT_REVIEW_PROMPT_LINE_CAP)
          : configuredLineCap;
        fileForParse = truncateFileDiff(params.file, modelLineCap);
      }

      // The async batch path is main-pass-only (see this method's contract). `config` is OPTIONAL:
      // fail open to engine-enabled when absent.
      const parsed = parseFileReviewResponse(response.rawText, fileForParse, {
        pass: 'main',
        severityEngineEnabled: params.config?.review.severity_engine.enabled ?? true,
      });
      return {
        status: 'done',
        response: {
          ...response,
          parsed,
          userPrompt: '',
          reviewedLineCount: fileForParse.lineCount,
          wasPromptTruncated: fileForParse.isTruncated === true,
        },
      };
    } catch (error) {
      return { status: 'failed', error };
    }
  }

  private async reviewFileChunk(params: {
    file: any;
    prTitle: string | null;
    prDescription: string | null;
    config: RepoConfig;
    totalLineCount: number;
    compactPrompt?: boolean;
    pass?: 'main' | 'security';
    temperature?: number;
  }) {
    // The security pass swaps in buildSecurityReviewPrompts (same input shape, identical findings
    // JSON contract so parseFileReviewResponse handles it unchanged). Everything below —
    // selectModel, resolveModel, the fallback chain, adaptive timeout, tracker recording, and
    // RetryableModelError classification — is reused verbatim, so a transient failure on a
    // (file,'security') unit classifies retryable exactly like the main pass (D-01/D-02).
    const { systemPrompt, userPrompt } = params.pass === 'security'
      ? buildSecurityReviewPrompts({
          ...params,
          file: params.file,
          config: params.config.review,
        })
      : buildFileReviewPrompts({
          ...params,
          file: params.file,
          config: params.config.review,
        });

    const { primary, fallbacks } = this.selectModel({
      totalLineCount: params.totalLineCount,
      config: params.config,
    });
    const modelsToTry = [primary, ...fallbacks];

    // Size the per-call timeout to the diff the model actually sees: small
    // files fail over to the next model fast; large diffs get a proportionally longer budget.
    const timeoutMs = adaptiveModelTimeoutMs(params.file.lineCount);

    let lastError: unknown;
    let lastTransientError: unknown;
    let sawTransientFailure = false;
    const chainStartedAt = Date.now();
    for (const [modelIndex, currentModel] of modelsToTry.entries()) {
      // Always allow the first (primary) model a shot even if the shared job budget is
      // already tight, so a file isn't punished for other files' earlier failures. But once
      // we're into the fallback chain, each additional attempt costs more subrequests
      // (config lookup + provider call, sometimes a provider-availability check too) that
      // could tip this whole invocation over Cloudflare's per-invocation subrequest cap
      // (Workers Free plan: 50). Defer the file for a later retry instead of gambling the
      // rest of the invocation's budget on a low-probability extra fallback.
      if (modelIndex > 0 && this.tracker?.isNearLimit()) {
        logger.warn(`Skipping remaining fallback models for ${params.file.path}; subrequest budget for this invocation is nearly exhausted`, {
          skippedModels: modelsToTry.slice(modelIndex),
        });

        // If we haven't seen any transient failures (e.g. they were all permanent timeouts),
        // don't force this to become a transient failure. Just break and let the last permanent error propagate.
        if (sawTransientFailure) {
          lastTransientError = lastTransientError ?? lastError ?? new Error('Subrequest budget for this invocation was nearly exhausted before trying all configured fallback models');
        }
        break;
      }

      // Stop walking the fallback chain once this file has consumed its wall-clock budget: a long
      // chain of slow/timing-out models could otherwise run several calls back-to-back and push the
      // whole workflow invocation past Cloudflare's ~120s limit (killing it as `exceededCpu` and
      // losing all progress). Defer instead -- the file resumes from the fast primary model in a
      // fresh invocation. Always let the primary (modelIndex 0) run first.
      if (modelIndex > 0 && Date.now() - chainStartedAt > MODEL_FALLBACK_CHAIN_BUDGET_MS) {
        logger.warn(`Deferring ${params.file.path}: fallback chain exceeded its per-invocation time budget`, {
          elapsedMs: Date.now() - chainStartedAt,
          skippedModels: modelsToTry.slice(modelIndex),
        });
        // Treat as a transient/deferrable outcome so the file is retried on a fresh budget rather
        // than marked permanently failed.
        sawTransientFailure = true;
        lastTransientError = lastTransientError ?? lastError ?? new Error(`Model fallback chain for ${params.file.path} exceeded its time budget; deferring for retry.`);
        break;
      }

      let resolved: ResolvedModelConfig;
      try {
        resolved = await this.resolveModel(currentModel);
      } catch (error) {
        lastError = error;
        logger.warn(`Model ${currentModel} could not be resolved`, {
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }

      if (resolved.apiFormat === 'cloudflare-workers-ai' && await this.isProviderUnavailable(resolved.providerId)) {
        logger.warn(`Skipping ${resolved.providerName} model ${currentModel} because the provider is unavailable for job ${this.options.jobId ?? 'unknown'}`);
        continue;
      }

      // One shot per model: a failed call is never retried against the same model (a retryable
      // outage is handled by deferring the whole file to a fresh invocation), so on failure we just
      // fall through to the next model in the fallback chain.
      try {
        const response = await this.callResolvedModel(
          resolved,
          { systemPrompt, userPrompt, temperature: params.temperature },
          timeoutMs,
        );

        if (this.tracker) {
          this.tracker.record(response.modelUsed, response.inputTokens, response.outputTokens);
        }

        const parsed = parseFileReviewResponse(response.rawText, params.file, {
          pass: params.pass ?? 'main',
          severityEngineEnabled: params.config.review.severity_engine.enabled,
        });
        return {
          ...response,
          parsed,
          userPrompt,
          reviewedLineCount: params.file.lineCount,
          wasPromptTruncated: params.file.isTruncated === true,
        };
      } catch (error) {
        lastError = error;
        if (isTransientModelFailure(error)) {
          sawTransientFailure = true;
          lastTransientError = error;
        }
        if (resolved.apiFormat === 'cloudflare-workers-ai' && isCloudflareAllocationError(error)) {
          await this.markProviderUnavailable(resolved.providerId, error instanceof Error ? error.message : String(error));
        }

        logger.warn(`Model ${currentModel} failed for ${params.file.path}`, {
          error: error instanceof Error ? error.message : String(error),
          rateLimited: isGoogleRateLimitError(error),
          willTryFallback: modelIndex < modelsToTry.length - 1,
        });
        // Fall through to the next model in the fallback chain.
      }
    }

    if (sawTransientFailure) {
      const retryCause = lastTransientError ?? lastError;
      const lastMessage = retryCause instanceof Error ? retryCause.message : String(retryCause ?? 'Unknown model error');
      throw new RetryableModelError(
        `All configured review models failed for ${params.file.path}; retrying later. Last error: ${lastMessage}`,
        retryCause,
      );
    }

    // lastError stays undefined when every model was skipped without throwing (e.g. all Cloudflare
    // providers were marked unavailable and hit `continue`). `throw undefined` would erase all
    // context and defeat downstream `instanceof`/message inspection, so surface a real Error.
    throw lastError ?? new Error(`No review model produced a result for ${params.file.path}; all configured models were skipped or unavailable.`);
  }

  async generateSummary(params: {
    prTitle: string | null;
    verdict: 'approve' | 'comment';
    fileSummaries: Array<{ path: string; summary: string; verdict: string }>;
    config: RepoConfig;
  }) {
    const { primary, fallbacks } = this.selectModel({ totalLineCount: 0, config: params.config });
    const modelsToTry = [primary, ...fallbacks];

    let lastError: unknown;
    let lastTransientError: unknown;
    let sawTransientFailure = false;
    for (const currentModel of modelsToTry) {
      let resolved: ResolvedModelConfig;
      try {
        resolved = await this.resolveModel(currentModel);
      } catch (error) {
        lastError = error;
        logger.warn(`Summary model ${currentModel} could not be resolved`, {
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }

      if (resolved.apiFormat === 'cloudflare-workers-ai' && await this.isProviderUnavailable(resolved.providerId)) {
        logger.warn(`Skipping ${resolved.providerName} summary model ${currentModel} because the provider is unavailable for job ${this.options.jobId ?? 'unknown'}`);
        continue;
      }

      try {
        const response = await this.callResolvedModel(resolved, {
          systemPrompt: SUMMARY_SYSTEM_PROMPT,
          userPrompt: buildSummaryPrompt(params),
        }, adaptiveModelTimeoutMs(0));

        if (this.tracker) {
          this.tracker.record(response.modelUsed, response.inputTokens, response.outputTokens);
        }

        return response;
      } catch (error) {
        lastError = error;
        if (isTransientModelFailure(error)) {
          sawTransientFailure = true;
          lastTransientError = error;
        }
        if (resolved.apiFormat === 'cloudflare-workers-ai' && isCloudflareAllocationError(error)) {
          await this.markProviderUnavailable(resolved.providerId, error instanceof Error ? error.message : String(error));
        }
        logger.warn(`Summary model ${currentModel} failed`, { error: error instanceof Error ? error.message : String(error) });
      }
    }

    if (sawTransientFailure) {
      const retryCause = lastTransientError ?? lastError;
      const lastMessage = retryCause instanceof Error ? retryCause.message : String(retryCause ?? 'Unknown model error');
      throw new RetryableModelError(
        `All configured summary models failed; retrying later. Last error: ${lastMessage}`,
        retryCause,
      );
    }

    // As in reviewFile: guard against `throw undefined` when every summary model was skipped via
    // `continue` (all resolveModel failures or all providers unavailable) without setting lastError.
    throw lastError ?? new Error('No summary model produced a result; all configured models were skipped or unavailable.');
  }

  /**
   * MP-03 / D-05: the critic's single whole-set, ID-based, PRUNE-ONLY model call. Mirrors
   * generateSummary's fallback-chain + RetryableModelError discipline (a transient failure across the
   * whole chain defers rather than wedges), but with two critic-specific properties:
   *   1. `applySizeOverrides: false` — the critic reviews a finding SET, not a single sized file, so
   *      it MUST resolve the MAIN model chain and never a size-override model (review-verified HIGH:
   *      selectModel({ totalLineCount: 0 }) would otherwise match the first override).
   *   2. It returns only `rawText` (+ token accounting) — the id->finding mapping and
   *      `kept = deduped minus pruned-by-id` reconciliation happen in code in runCriticPhase (10-06),
   *      parsed by parseCriticPruneResponse. There is NO per-pass model override (D-02).
   * Each finding is assigned a numeric id equal to its index in the input array; the critic returns
   * ONLY { prune: [{ id, reason }] } — never a keep-list, never full findings.
   */
  async critiqueFindings(params: {
    findings: Array<{ path: string; line?: number | null; severity: string; title: string; body: string }>;
    prTitle: string | null;
    config: RepoConfig;
  }): Promise<{ rawText: string; modelUsed: string; inputTokens: number; outputTokens: number }> {
    const candidates: CriticCandidateFinding[] = params.findings.map((f, index) => ({
      id: index,
      path: f.path,
      line: f.line ?? null,
      severity: f.severity,
      title: f.title,
      body: f.body,
    }));
    const { systemPrompt, userPrompt } = buildCriticPrompts({
      findings: candidates,
      prTitle: params.prTitle,
      config: params.config.review,
    });

    // Size overrides DISABLED: resolve the MAIN chain, never a size-override model (D-05).
    const { primary, fallbacks } = this.selectModel({
      totalLineCount: 0,
      config: params.config,
      applySizeOverrides: false,
    });
    const modelsToTry = [primary, ...fallbacks];

    let lastError: unknown;
    let lastTransientError: unknown;
    let sawTransientFailure = false;
    for (const currentModel of modelsToTry) {
      let resolved: ResolvedModelConfig;
      try {
        resolved = await this.resolveModel(currentModel);
      } catch (error) {
        lastError = error;
        logger.warn(`Critic model ${currentModel} could not be resolved`, {
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }

      if (resolved.apiFormat === 'cloudflare-workers-ai' && await this.isProviderUnavailable(resolved.providerId)) {
        logger.warn(`Skipping ${resolved.providerName} critic model ${currentModel} because the provider is unavailable for job ${this.options.jobId ?? 'unknown'}`);
        continue;
      }

      try {
        const response = await this.callResolvedModel(resolved, { systemPrompt, userPrompt }, adaptiveModelTimeoutMs(0));

        if (this.tracker) {
          this.tracker.record(response.modelUsed, response.inputTokens, response.outputTokens);
        }

        return {
          rawText: response.rawText,
          modelUsed: response.modelUsed,
          inputTokens: response.inputTokens,
          outputTokens: response.outputTokens,
        };
      } catch (error) {
        lastError = error;
        if (isTransientModelFailure(error)) {
          sawTransientFailure = true;
          lastTransientError = error;
        }
        if (resolved.apiFormat === 'cloudflare-workers-ai' && isCloudflareAllocationError(error)) {
          await this.markProviderUnavailable(resolved.providerId, error instanceof Error ? error.message : String(error));
        }
        logger.warn(`Critic model ${currentModel} failed`, { error: error instanceof Error ? error.message : String(error) });
      }
    }

    if (sawTransientFailure) {
      const retryCause = lastTransientError ?? lastError;
      const lastMessage = retryCause instanceof Error ? retryCause.message : String(retryCause ?? 'Unknown model error');
      throw new RetryableModelError(
        `All configured critic models failed; retrying later. Last error: ${lastMessage}`,
        retryCause,
      );
    }

    // As in generateSummary: guard against `throw undefined` when every critic model was skipped via
    // `continue` (all resolveModel failures or all providers unavailable) without setting lastError.
    throw lastError ?? new Error('No critic model produced a result; all configured models were skipped or unavailable.');
  }

  /**
   * Phase 11, Plan 04 (QA-01/QA-02): the SINGLE public prose model path for PR Q&A. It exists
   * because the rest of the model stack cannot produce prose for core/qa.ts:
   *   - selectModel / callResolvedModel are PRIVATE (a caller outside this class cannot reach them), and
   *   - the provider adapters are JSON-only (OpenAI response_format:json_object, Anthropic '{'
   *     pre-fill), so a bare-prose request is not reliable across providers.
   * So this method owns the whole Q&A model call: it requests + parses a `{ "answer": string }` JSON
   * envelope (compatible with every JSON-only adapter) via the model-output tolerant parser, and
   * returns the answer string.
   *
   * Mirrors generateSummary/critiqueFindings' fallback-chain + RetryableModelError discipline (a
   * transient failure across the whole chain defers rather than wedges), with ONE Q&A-specific
   * property: `applySizeOverrides: false` (REVIEW: Codex 11-04 HIGH). Q&A is not a sized file review,
   * so totalLineCount is 0; with overrides applied, selectModel({ totalLineCount: 0 }) would match the
   * FIRST positive size override (0 <= any max_lines) instead of the main model — disabling overrides
   * resolves the MAIN chain, exactly like the critic.
   */
  async answerPrQuestion(params: {
    systemPrompt: string;
    userPrompt: string;
    config: RepoConfig;
  }): Promise<string> {
    // Size overrides DISABLED: resolve the MAIN chain, never a size-override model (Q&A is not sized).
    const { primary, fallbacks } = this.selectModel({
      totalLineCount: 0,
      config: params.config,
      applySizeOverrides: false,
    });
    const modelsToTry = [primary, ...fallbacks];

    let lastError: unknown;
    let lastTransientError: unknown;
    let sawTransientFailure = false;
    for (const currentModel of modelsToTry) {
      let resolved: ResolvedModelConfig;
      try {
        resolved = await this.resolveModel(currentModel);
      } catch (error) {
        lastError = error;
        logger.warn(`Q&A model ${currentModel} could not be resolved`, {
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }

      if (resolved.apiFormat === 'cloudflare-workers-ai' && await this.isProviderUnavailable(resolved.providerId)) {
        logger.warn(`Skipping ${resolved.providerName} Q&A model ${currentModel} because the provider is unavailable for job ${this.options.jobId ?? 'unknown'}`);
        continue;
      }

      try {
        const response = await this.callResolvedModel(
          resolved,
          { systemPrompt: params.systemPrompt, userPrompt: params.userPrompt },
          adaptiveModelTimeoutMs(0),
        );

        if (this.tracker) {
          this.tracker.record(response.modelUsed, response.inputTokens, response.outputTokens);
        }

        return parseAnswerResponse(response.rawText);
      } catch (error) {
        lastError = error;
        if (isTransientModelFailure(error)) {
          sawTransientFailure = true;
          lastTransientError = error;
        }
        if (resolved.apiFormat === 'cloudflare-workers-ai' && isCloudflareAllocationError(error)) {
          await this.markProviderUnavailable(resolved.providerId, error instanceof Error ? error.message : String(error));
        }
        logger.warn(`Q&A model ${currentModel} failed`, { error: error instanceof Error ? error.message : String(error) });
      }
    }

    if (sawTransientFailure) {
      const retryCause = lastTransientError ?? lastError;
      const lastMessage = retryCause instanceof Error ? retryCause.message : String(retryCause ?? 'Unknown model error');
      throw new RetryableModelError(
        `All configured Q&A models failed; retrying later. Last error: ${lastMessage}`,
        retryCause,
      );
    }

    // As in generateSummary: guard against `throw undefined` when every model was skipped via
    // `continue` (all resolveModel failures or all providers unavailable) without setting lastError.
    throw lastError ?? new Error('No Q&A model produced a result; all configured models were skipped or unavailable.');
  }

  /**
   * Phase 19 verify-fixes (THR-01 / THR-02): the provider-neutral seam the verify-fixes phase uses
   * to grade every unresolved bot thread against current head content. The method accepts the
   * caller-built system + user prompts (built by `prompts/verify-fixes.ts`) and returns the raw
   * model response for `core/verify-fixes.ts` to parse in code.
   *
   * Mirrors `critiqueFindings` / `answerPrQuestion`'s fallback-chain + RetryableModelError
   * discipline (a transient failure across the whole chain defers rather than wedges), with one
   * verify-fixes-specific property:
   *   - `applySizeOverrides: false` (D-04). Verification grades a thread SET, not a sized file;
   *     with overrides applied, selectModel({ totalLineCount: 0 }) would match the FIRST
   *     positive size override instead of using model.main.
   *   - `temperature` is OPTIONAL: when supplied (the verify-fixes default), it forwards to every
   *     provider adapter via callResolvedModel; when absent the provider's own default is used.
   *     Phase 19 keeps verification at the same default as the main review so a model configured
   *     for low-temperature review also verifies at low temperature.
   *
   * The call site (runVerifyFixesPhase) catches and degrades each call's exception to one
   * unverifiable entry per batch thread -- this method does NOT swallow errors itself so the
   * caller can record `malformedOutput=true` on the batch's classify call.
   */
  async callVerifierRaw(params: {
    systemPrompt: string;
    userPrompt: string;
    temperature?: number;
    config: RepoConfig;
  }): Promise<{
    rawText: string;
    modelUsed: string;
    inputTokens: number;
    outputTokens: number;
  }> {
    const { primary, fallbacks } = this.selectModel({
      totalLineCount: 0,
      config: params.config,
      applySizeOverrides: false,
    });
    const modelsToTry = [primary, ...fallbacks];

    let lastError: unknown;
    let lastTransientError: unknown;
    let sawTransientFailure = false;
    for (const currentModel of modelsToTry) {
      let resolved: ResolvedModelConfig;
      try {
        resolved = await this.resolveModel(currentModel);
      } catch (error) {
        lastError = error;
        logger.warn(`verify-fixes model ${currentModel} could not be resolved`, {
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }

      if (resolved.apiFormat === 'cloudflare-workers-ai' && await this.isProviderUnavailable(resolved.providerId)) {
        logger.warn(`Skipping ${resolved.providerName} verify-fixes model ${currentModel} because the provider is unavailable`);
        continue;
      }

      try {
        const response = await this.callResolvedModel(
          resolved,
          {
            systemPrompt: params.systemPrompt,
            userPrompt: params.userPrompt,
            temperature: params.temperature,
          },
          adaptiveModelTimeoutMs(0),
        );

        if (this.tracker) {
          this.tracker.record(response.modelUsed, response.inputTokens, response.outputTokens);
        }

        return {
          rawText: response.rawText,
          modelUsed: response.modelUsed,
          inputTokens: response.inputTokens,
          outputTokens: response.outputTokens,
        };
      } catch (error) {
        lastError = error;
        if (isTransientModelFailure(error)) {
          sawTransientFailure = true;
          lastTransientError = error;
        }
        if (resolved.apiFormat === 'cloudflare-workers-ai' && isCloudflareAllocationError(error)) {
          await this.markProviderUnavailable(resolved.providerId, error instanceof Error ? error.message : String(error));
        }
        logger.warn(`verify-fixes model ${currentModel} failed`, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (sawTransientFailure) {
      const retryCause = lastTransientError ?? lastError;
      const lastMessage = retryCause instanceof Error ? retryCause.message : String(retryCause ?? 'Unknown model error');
      throw new RetryableModelError(
        `All configured verify-fixes models failed; retrying later. Last error: ${lastMessage}`,
        retryCause,
      );
    }

    throw lastError ?? new Error('No verify-fixes model produced a result; all configured models were skipped or unavailable.');
  }

  /**
   * WT-03 (Plan 09-03): the OPTIONAL, best-effort Mermaid sequence-diagram call. Unlike
   * generateSummary/reviewFile this tries ONLY the selected PRIMARY model — there is NO
   * `...fallbacks` iteration — so the "one whole-diff diagram call" is literally exactly ONE outbound
   * inference request (cross-AI budget MEDIUM: "one model call" must not fan out across a fallback
   * chain in the budget-fragile finalize phase). It is fed the ACTUAL bounded whole-diff (FileDiff[]),
   * not per-file correctness summaries (cross-AI blocker 2) — see buildWalkthroughDiagramPrompt.
   *
   * The method itself may throw (resolveModel not configured / provider error) and does NOT retry;
   * the finalize call site wraps it in a best-effort try/catch and simply OMITS the diagram on any
   * failure (D-07, WT-04). Returns the raw model text plus its token counts + modelUsed so the caller
   * can fold the diagram's tokens into the job's completeJob totals (token-accounting MEDIUM).
   */
  async generateWalkthroughDiagram(params: {
    prTitle: string | null;
    files: FileDiff[];
    fileSummaries: Array<{ path: string; summary: string; verdict: string }>;
    config: RepoConfig;
  }): Promise<ModelResponse> {
    // Primary model ONLY — deliberately NOT `[primary, ...fallbacks]`. One outbound request.
    const { primary } = this.selectModel({ totalLineCount: 0, config: params.config });
    const resolved = await this.resolveModel(primary);

    const response = await this.callResolvedModel(
      resolved,
      {
        systemPrompt: WALKTHROUGH_DIAGRAM_SYSTEM_PROMPT,
        userPrompt: buildWalkthroughDiagramPrompt({
          prTitle: params.prTitle,
          files: params.files,
          fileSummaries: params.fileSummaries,
        }),
      },
      adaptiveModelTimeoutMs(0),
    );

    if (this.tracker) {
      this.tracker.record(response.modelUsed, response.inputTokens, response.outputTokens);
    }

    return response;
  }

  /**
   * Phase 19 Plan 19-08 (PASS-03, D-14..D-18): the walkthrough enrichment model call. Generates a
   * groups + confidence + effort assessment for the reviewed files. Mirrors generateWalkthroughDiagram
   * in shape: it makes EXACTLY ONE outbound request (primary model only) so the enrichment phase
   * stays inside the per-invocation subrequest budget (PASS-03 / D-13). The caller parses the raw
   * text with parseWalkthroughEnrichmentResponse (tolerant, independent per-field validation)
   * and persists the validated payload via setJobWalkthroughEnrichment. May throw on a transient
   * provider failure; the runWalkthroughEnrichmentPhase caller wraps it in a best-effort try/catch
   * and degrades to a `status: 'failed'` enrichment row (D-17 fail-open contract).
   */
  async generateWalkthroughEnrichment(params: {
    prTitle: string | null;
    files: EnrichmentFileEntry[];
    config: RepoConfig;
  }): Promise<ModelResponse> {
    // Primary model ONLY — deliberately NOT `[primary, ...fallbacks]`. One outbound request. The
    // enrichment runs AFTER critic on its own fresh invocation; widening to a fallback chain would
    // multiply the subrequest cost (D-13). A transient failure degrades to a `status: 'failed'`
    // row so finalize still posts the deterministic coverage walkthrough.
    const { primary } = this.selectModel({ totalLineCount: 0, config: params.config });
    const resolved = await this.resolveModel(primary);

    const response = await this.callResolvedModel(
      resolved,
      {
        systemPrompt: WALKTHROUGH_ENRICHMENT_SYSTEM_PROMPT,
        userPrompt: buildWalkthroughEnrichmentPrompt({
          prTitle: params.prTitle,
          files: params.files,
        }),
      },
      adaptiveModelTimeoutMs(0),
    );

    if (this.tracker) {
      this.tracker.record(response.modelUsed, response.inputTokens, response.outputTokens);
    }

    return response;
  }
}
