import { logger } from '@server/core/logger';
import { withTimeout } from '@server/core/timeout';
import { isValidPublicUrl } from '@server/core/ssrf';
import { ProviderRequestError, UnparseableModelResponseError, providerErrorMessage, type ModelRequestInput, type ModelResponse } from './types';

/** Default max wall-clock time for a single Google AI Studio call when the caller doesn't
 * supply a diff-size-aware budget. */
const GEMINI_TIMEOUT_MS = 45_000;
// Retry transient upstream failures (Gemini's frequent 5xx "Internal error encountered.") a
// couple of times with backoff so a momentary blip doesn't fail an otherwise-fine gemma review.
const GEMINI_MAX_RETRIES = 2;
// Headroom so reasoning/"thinking" models (the gemma-4 family) can spend tokens thinking and
// still emit the JSON answer instead of getting truncated at the limit with an empty body.
const GEMINI_MAX_OUTPUT_TOKENS = 8192;
// Hard cap on any single in-call retry sleep. A 429 can carry a `retry-after` of 30-60s on the
// Free tier; sleeping that long in-call would pin a model-call-gate slot and burn the chunk's
// wall-clock budget for a retry that will just 429 again. Cap it low -- if the provider needs a
// longer cool-off, the file is deferred and resumes in a fresh invocation (which is the real,
// budget-resetting backoff), so a long in-call sleep buys nothing.
const GEMINI_MAX_RETRY_DELAY_MS = 5_000;
const DEFAULT_GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

function isRetryableGeminiStatus(status: number) {
  return status === 408 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504 || status === 524;
}

function defaultRetryDelayMs(attempt: number) {
  // Snappy backoff: a transient Gemini 5xx usually clears within a second or two, and long sleeps
  // just eat into the caller's wall-clock and subrequest budget. ~0.8s then ~1.6s for the retries.
  return Math.pow(2, attempt) * 800 + Math.random() * 400;
}

function retryAfterDelayMs(value: string | null) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }

  const dateMs = Date.parse(value);
  if (Number.isFinite(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }

  return null;
}

function isRetryableTransportError(error: unknown) {
  if (!(error instanceof Error)) return false;
  // Deliberately do NOT retry timeouts: the caller already grants a diff-size-aware budget (up to
  // 2 minutes), so a call that blows it is a genuinely slow/stuck generation -- retrying just
  // burns more wall-clock and subrequests into the same wall. Fail fast and let the fallback chain
  // (or a fresh-budget continuation) take over. Only genuine transport blips are worth a retry.
  if (error.name === 'TimeoutError' || error.message.toLowerCase().includes('timed out')) return false;
  if (error.message.includes('fetch failed')) return true;
  return error instanceof TypeError;
}

export async function reviewWithGoogle(
  config: { apiKey: string; baseUrl?: string | null; providerName?: string; timeoutMs?: number },
  model: string,
  input: ModelRequestInput,
  tracker?: { incrementSubrequests(count?: number): void },
): Promise<ModelResponse> {
  const timeoutMs = config.timeoutMs ?? GEMINI_TIMEOUT_MS;
  logger.info(`Calling Google model: ${model}`);
  
  if (config.baseUrl && !isValidPublicUrl(config.baseUrl)) {
    throw new ProviderRequestError(config.providerName ?? 'Google', 400, 'Invalid provider base URL.');
  }

  const startTime = Date.now();
  const baseUrl = (config.baseUrl || DEFAULT_GEMINI_BASE_URL).replace(/\/+$/, '');
  const url = `${baseUrl}/models/${encodeURIComponent(model)}:generateContent`;
  const maxRetries = GEMINI_MAX_RETRIES;
  let lastError: unknown;
  let delayBeforeAttemptMs = 0;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (delayBeforeAttemptMs > 0) {
      logger.info(`Retrying Gemini request (attempt ${attempt}/${maxRetries}) in ${Math.round(delayBeforeAttemptMs)}ms`);
      await new Promise(resolve => setTimeout(resolve, delayBeforeAttemptMs));
      delayBeforeAttemptMs = 0;
    }

    let response: Response;
    try {
      if (tracker) tracker.incrementSubrequests(1);
      response = await withTimeout('Gemini API', timeoutMs, (signal) =>
        fetch(url, {
          method: 'POST',
          signal,
          headers: {
            'content-type': 'application/json',
            'x-goog-api-key': config.apiKey,
          },
          body: JSON.stringify({
            systemInstruction: {
              role: 'system',
              parts: [{ text: input.systemPrompt }],
            },
            contents: [
              {
                role: 'user',
                parts: [{ text: input.userPrompt }],
              },
            ],
            generationConfig: {
              ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
              ...(model.toLowerCase().includes('gemma') ? {} : { responseMimeType: 'application/json' }),
              maxOutputTokens: GEMINI_MAX_OUTPUT_TOKENS,
            },
          }),
        }),
      );
    } catch (error) {
      lastError = error;
      if (isRetryableTransportError(error) && attempt < maxRetries) {
        delayBeforeAttemptMs = defaultRetryDelayMs(attempt);
        continue;
      }
      throw error;
    }

    if (!response.ok) {
      const errorText = await response.text();
      const message = providerErrorMessage(errorText);
      const isRetryable = isRetryableGeminiStatus(response.status);
      const retryDelayMs = Math.min(
        GEMINI_MAX_RETRY_DELAY_MS,
        response.status === 429
          ? retryAfterDelayMs(response.headers.get('retry-after')) ?? defaultRetryDelayMs(attempt)
          : defaultRetryDelayMs(attempt),
      );

      const logData = {
        error: message,
        attempt,
        willRetry: isRetryable && attempt < maxRetries,
        retryDelayMs: isRetryable && attempt < maxRetries ? retryDelayMs : undefined,
      };
      if (isRetryable && attempt < maxRetries) {
        logger.warn(`Gemini request failed with ${response.status}; retrying`, logData);
        lastError = new ProviderRequestError(config.providerName ?? 'Google', response.status, message);
        delayBeforeAttemptMs = retryDelayMs;
        continue;
      }

      logger.error(`Gemini request failed with ${response.status}`, logData);
      throw new ProviderRequestError(config.providerName ?? 'Google', response.status, message);
    }

    const durationMs = Date.now() - startTime;
    logger.info(`AI model ${model} responded in ${durationMs}ms`);

    const data = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
      usageMetadata?: {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
      };
    };

    const candidate = data.candidates?.[0];
    const rawText = candidate?.content?.parts?.map((part) => part.text ?? '').join('')?.trim();
    if (!rawText) {
      const finishReason = candidate?.finishReason;
      // A reasoning/"thinking" model can consume its whole output budget before emitting any
      // answer text, returning empty parts with finishReason MAX_TOKENS (or a safety/RECITATION
      // block). That's deterministic, so fail the file permanently rather than deferring it for a
      // retry that would hit the same wall. A truly empty STOP response is treated as transient.
      if (finishReason && finishReason !== 'STOP') {
        throw new UnparseableModelResponseError(model, `finishReason=${finishReason}`);
      }
      throw new Error('Gemini returned an empty response.');
    }

    return {
      rawText,
      inputTokens: data.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
      modelUsed: model,
      provider: config.providerName ?? 'Google',
    };
  }

  throw lastError;
}
