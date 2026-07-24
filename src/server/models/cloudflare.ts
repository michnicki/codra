import { logger } from '@server/core/logger';
import type { AppBindings } from '@server/env';
import { TimeoutError } from '@server/core/timeout';
import { ProviderRequestError, UnparseableModelResponseError, type ModelRequestInput, type ModelResponse } from './types';

/**
 * Default max wall-clock time allowed for a single Workers-AI call when the caller doesn't
 * supply a diff-size-aware budget. Kept well under the review workflow's 15-minute step
 * timeout: a model that hasn't answered a code-review prompt in this long (reasoning models
 * under strict-JSON decoding are the usual offenders -- they burn the whole token budget
 * "thinking" and never emit the JSON) is not going to, so we fail fast and let the file defer
 * to a fresh invocation instead of stalling the whole review.
 */
const CLOUDFLARE_TIMEOUT_MS = 45_000;
const CLOUDFLARE_MAX_RETRIES = 0;
const CLOUDFLARE_MAX_OUTPUT_TOKENS = 8192;
const REVIEW_RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['findings', 'overall_explanation', 'overall_correctness', 'overall_confidence_score'],
  properties: {
    findings: {
      type: 'array',
      maxItems: 10,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'body', 'priority', 'code_location'],
        properties: {
          title: { type: 'string', maxLength: 100 },
          body: { type: 'string' },
          confidence_score: { type: 'number', minimum: 0, maximum: 1 },
          priority: { type: 'integer', minimum: 0, maximum: 3 },
          code_location: {
            type: 'object',
            additionalProperties: false,
            properties: {
              absolute_file_path: { type: 'string' },
              line: { type: 'integer', minimum: 1 },
              line_range: {
                type: 'object',
                additionalProperties: false,
                required: ['start', 'end'],
                properties: {
                  start: { type: 'integer', minimum: 1 },
                  end: { type: 'integer', minimum: 1 },
                },
              },
            },
            anyOf: [
              { required: ['line'] },
              { required: ['line_range'] },
            ],
          },
          code_suggestion: { type: 'string' },
        },
      },
    },
    overall_explanation: { type: 'string' },
    overall_correctness: { type: 'string', enum: ['patch is correct', 'patch is incorrect'] },
    overall_confidence_score: { type: 'number', minimum: 0, maximum: 1 },
  },
} as const;

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null;
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function getRecord(value: unknown, key: string): UnknownRecord | null {
  if (!isRecord(value)) return null;
  const child = value[key];
  return isRecord(child) ? child : null;
}

function getNumber(value: unknown, key: string) {
  if (!isRecord(value)) return null;
  const child = value[key];
  return typeof child === 'number' ? child : null;
}

// Workers AI surfaces quota/authorization failures as an error object carrying a numeric `code`
// (e.g. 4006 = "out of daily free allocation"). Prefer that structured code over brittle message
// substrings; the substring paths below are kept only as a documented last-resort fallback for
// runtimes/paths where the error was stringified and lost its numeric code.
function getStructuredErrorCode(error: unknown): number | null {
  if (!isRecord(error)) return null;
  const code = error.code;
  if (typeof code === 'number') return code;
  if (typeof code === 'string' && /^\d+$/.test(code.trim())) return Number(code.trim());
  return null;
}

// Workers AI "out of daily free allocation" quota error code.
const CLOUDFLARE_QUOTA_EXCEEDED_CODE = 4006;

function isLocalWorkersAiBindingError(error: unknown) {
  // Structured-first: if the runtime ever attaches a code/status for the local-binding case,
  // this is where it would be checked. Wrangler's local Workers-AI shim currently throws a plain
  // Error with no numeric code/status for "binding AI ... run remotely", so we fall back to the
  // message substrings below as the documented last resort.
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  return normalized.includes('binding ai') && normalized.includes('run remotely');
}

// Persistent (non-retryable) quota exhaustion for this account/day. Prefer the structured Workers
// AI error code; fall back to message substrings only when no structured code is present.
function isCloudflareQuotaExhaustedError(error: unknown, errorMsg: string) {
  const code = getStructuredErrorCode(error);
  if (code !== null) return code === CLOUDFLARE_QUOTA_EXCEEDED_CODE;
  return errorMsg.includes('4006') || errorMsg.includes('daily free allocation');
}

function failUnparseable(model: string, reason: string): never {
  logger.warn(`Cloudflare model ${model} returned no parseable review content; failing the file review`, { reason });
  throw new UnparseableModelResponseError(model, reason);
}

function extractMessageContent(content: unknown): string | null {
  if (isText(content)) return content.trim();

  if (Array.isArray(content)) {
    const text = content
      .map((part) => {
        if (isText(part)) return part;
        if (isRecord(part) && isText(part.text)) return part.text;
        return '';
      })
      .join('')
      .trim();
    return text || null;
  }

  return null;
}

// A model's completion arrives in `response`, but the type varies by model: most return a
// plain string, while models honoring `response_format`/structured output (e.g.
// @cf/qwen/qwen2.5-coder-32b-instruct) return an already-parsed JSON object or array. Accept
// both -- stringify structured values so the downstream repair/parse pipeline can consume them
// instead of the extractor discarding a perfectly good review as an "empty response".
function extractResponseField(container: unknown): string | null {
  if (!isRecord(container)) return null;
  const value = container.response;
  if (isText(value)) return value.trim();
  if (value && typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return null;
    }
  }
  return null;
}

function extractCloudflareText(result: unknown, model: string): string {
  if (isText(result)) return result.trim();
  const response = extractResponseField(result);
  if (response) return response;

  const nestedResult = getRecord(result, 'result');
  const nestedResponse = extractResponseField(nestedResult);
  if (nestedResponse) return nestedResponse;

  const choices = isRecord(result) && Array.isArray(result.choices) ? result.choices : null;
  const choice = choices?.[0];
  const message = getRecord(choice, 'message');
  const content = extractMessageContent(message?.content);
  if (content) return content;

  const finishReason = isRecord(choice) ? choice.finish_reason ?? choice.stop_reason : null;
  const reasoning = isText(message?.reasoning) ? message.reasoning : isText(message?.reasoning_content) ? message.reasoning_content : null;
  if (reasoning) {
    return failUnparseable(model, `reasoning-only response${finishReason ? `, finish_reason=${String(finishReason)}` : ''}`);
  }

  if (finishReason) {
    return failUnparseable(model, `finish_reason=${String(finishReason)}`);
  }

  return failUnparseable(model, 'empty response');
}

function extractCloudflareUsage(result: unknown) {
  const usage = getRecord(result, 'usage') ?? getRecord(getRecord(result, 'result'), 'usage');
  return {
    inputTokens: getNumber(usage, 'prompt_tokens') ?? 0,
    outputTokens: getNumber(usage, 'completion_tokens') ?? 0,
  };
}

/**
 * The single-request inference payload sent to Workers AI. Shared by the synchronous path and
 * the asynchronous batch path so both send an identical prompt/schema/decoding configuration.
 */
function buildCloudflareInferenceRequest(input: ModelRequestInput) {
  return {
    messages: [
      {
        role: 'system',
        content: `${input.systemPrompt}\n\nReturn only the JSON object. Do not include chain-of-thought, analysis, markdown, code fences, or explanatory prose.`,
      },
      { role: 'user', content: `${input.userPrompt}\n\nRespond with the required JSON object only.` },
    ],
    max_completion_tokens: CLOUDFLARE_MAX_OUTPUT_TOKENS,
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'codra_file_review',
        strict: true,
        schema: REVIEW_RESPONSE_SCHEMA,
      },
    },
    temperature: input.temperature ?? 0,
    top_p: 0.1,
  } as const;
}

/**
 * Result of polling an async batch request. `pending` means the batch is still queued/running
 * on Workers AI (poll again later); `done` carries the extracted review.
 */
export type CloudflareBatchPollResult =
  | { status: 'pending' }
  | { status: 'done'; response: ModelResponse };

function extractBatchStatus(result: unknown): string | null {
  if (!isRecord(result)) return null;
  const status = result.status ?? getRecord(result, 'result')?.status;
  return typeof status === 'string' ? status.toLowerCase() : null;
}

/**
 * Finds the single inference result inside a completed batch poll response. Workers AI has
 * returned a few shapes for this over time (a top-level `responses` array, a nested
 * `result.responses`, or a bare single result), so probe defensively and fall back to treating
 * the whole payload as one result.
 */
function extractBatchInnerResult(result: unknown): unknown {
  const containers = [result, isRecord(result) ? result.result : undefined];
  for (const container of containers) {
    if (!isRecord(container)) continue;
    const responses = container.responses ?? container.results;
    if (Array.isArray(responses) && responses.length > 0) {
      const first = responses[0];
      // Each entry may wrap the model output under `result`/`response`, or be it directly.
      if (isRecord(first)) return first.result ?? first;
      return first;
    }
  }
  return result;
}

/**
 * Submit a single review as an asynchronous batch request. Returns the queue `request_id` to
 * poll later. Throws if the model/account does not support async queueing (the caller is
 * expected to fall back to the synchronous path on any failure).
 */
export async function submitCloudflareBatch(
  env: Pick<AppBindings, 'AI'>,
  model: string,
  input: ModelRequestInput,
  tracker?: { incrementSubrequests(count?: number): void },
): Promise<string> {
  if (tracker) tracker.incrementSubrequests(1);
  logger.info(`Submitting async batch request to Cloudflare model: ${model}`);
  const result = await env.AI.run(
    model as any,
    { requests: [buildCloudflareInferenceRequest(input)] } as any,
    { queueRequest: true } as any,
  );

  const requestId = isRecord(result)
    ? (result.request_id ?? getRecord(result, 'result')?.request_id)
    : undefined;
  if (typeof requestId !== 'string' || !requestId) {
    throw new Error(`Cloudflare model ${model} did not return an async batch request_id (async queueing unsupported).`);
  }
  return requestId;
}

/**
 * Poll a previously submitted async batch request by its `request_id`. Returns `pending` while
 * the batch is still queued/running, or `done` with the extracted review once complete.
 */
export async function pollCloudflareBatch(
  env: Pick<AppBindings, 'AI'>,
  model: string,
  requestId: string,
  tracker?: { incrementSubrequests(count?: number): void },
  providerName = 'Cloudflare',
): Promise<CloudflareBatchPollResult> {
  if (tracker) tracker.incrementSubrequests(1);
  const result = await env.AI.run(model as any, { request_id: requestId } as any);

  const status = extractBatchStatus(result);
  if (status === 'queued' || status === 'running') {
    return { status: 'pending' };
  }

  const inner = extractBatchInnerResult(result);
  const rawText = extractCloudflareText(inner, model);
  const usage = extractCloudflareUsage(inner);
  return {
    status: 'done',
    response: {
      rawText,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      modelUsed: model,
      provider: providerName,
    },
  };
}

export async function reviewWithCloudflare(
  env: Pick<AppBindings, 'AI'>,
  model: string,
  input: ModelRequestInput,
  tracker?: { incrementSubrequests(count?: number): void },
  providerName = 'Cloudflare',
  options?: { timeoutMs?: number },
): Promise<ModelResponse> {
  const maxRetries = CLOUDFLARE_MAX_RETRIES;
  const timeoutMs = options?.timeoutMs ?? CLOUDFLARE_TIMEOUT_MS;
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let timer: ReturnType<typeof setTimeout> | undefined;

    // Abort the underlying Workers-AI request when the timeout fires. Promise.race on its own
    // only stops *us* awaiting -- the subrequest would keep running in the background, holding
    // this invocation's wall-clock and pushing the workflow toward its 15-minute step cap long
    // after we've given up. Aborting via the AI binding's signal actually cancels it.
    const controller = new AbortController();
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new TimeoutError(`Cloudflare (${model})`, timeoutMs));
      }, timeoutMs);
    });

    try {
      if (tracker) tracker.incrementSubrequests(1);
      if (attempt > 0) {
        const delay = Math.pow(2, attempt) * 1000 + Math.random() * 1000;
        logger.info(`Retrying Cloudflare request (attempt ${attempt}/${maxRetries}) in ${Math.round(delay)}ms`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }

      logger.info(`Calling Cloudflare model: ${model}`);
      const startTime = Date.now();
      const runPromise = env.AI.run(model as any, buildCloudflareInferenceRequest(input), { signal: controller.signal });
      // Once the timeout wins the race the aborted run still settles (as a rejection); attach a
      // no-op handler so that late rejection can't surface as an unhandled promise rejection.
      runPromise.catch(() => {});
      const result = await Promise.race([runPromise, timeoutPromise]);
      const durationMs = Date.now() - startTime;
      logger.info(`AI model ${model} responded in ${durationMs}ms`);

      const rawText = extractCloudflareText(result, model);
      const usage = extractCloudflareUsage(result);

      return {
        rawText,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        modelUsed: model,
        provider: providerName,
      };
    } catch (error) {
      lastError = error;
      const errorMsg = error instanceof Error ? error.message : String(error);

      if (isLocalWorkersAiBindingError(error)) {
        const message = 'Cloudflare Workers AI is not available in local Wrangler. Run with remote bindings or deploy the Worker to test Cloudflare models.';
        logger.warn(message, { model });
        throw new ProviderRequestError(providerName, 400, message);
      }

      logger.error(`Cloudflare request failed (attempt ${attempt}/${maxRetries})`, { error: errorMsg });

      // If we've used up our neuron quota, don't retry - it's a persistent error for this account/day
      if (isCloudflareQuotaExhaustedError(error, errorMsg)) {
        throw error;
      }

      const isTimeout = error instanceof TimeoutError;
      if ((isTimeout || attempt < maxRetries) && attempt < maxRetries) {
        continue;
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError;
}
