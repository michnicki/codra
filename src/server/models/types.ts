export type ModelRequestInput = {
  systemPrompt: string;
  userPrompt: string;
  temperature?: number;
};

export type ModelResponse = {
  rawText: string;
  inputTokens: number;
  outputTokens: number;
  modelUsed: string;
  provider: string;
};

export class ProviderRequestError extends Error {
  constructor(
    public readonly provider: string,
    public readonly status: number,
    message: string,
  ) {
    super(`${provider} request failed with ${status}: ${message}`);
    this.name = 'ProviderRequestError';
  }
}

/**
 * Thrown when a model responds but produces no reviewable output -- reasoning/thinking only, a
 * response truncated at the token limit, or an empty body. The file was NOT actually reviewed, so
 * rather than synthesizing a fake "inconclusive" pass we throw: the fallback chain tries the next
 * model, and if none succeed the file is honestly marked `failed`. Treated as a PERMANENT failure
 * (not transient) because the outcome is deterministic -- retrying the same model just burns quota.
 */
export class UnparseableModelResponseError extends Error {
  constructor(public readonly model: string, public readonly reason: string) {
    super(`Model ${model} produced no reviewable output (${reason}); the file review failed.`);
    this.name = 'UnparseableModelResponseError';
  }
}

export function providerErrorMessage(errorText: string) {
  try {
    const parsed = JSON.parse(errorText) as unknown;
    if (typeof parsed === 'object' && parsed !== null) {
      const obj = parsed as Record<string, unknown>;
      let message: unknown;

      if (typeof obj.error === 'object' && obj.error !== null) {
        message = (obj.error as Record<string, unknown>).message ?? obj.error;
      } else {
        message = obj.message ?? obj.error;
      }

      if (typeof message === 'string' && message.trim()) {
        return message.trim();
      }
    }
  } catch {
    // Fall back to the provider body below.
  }

  return errorText.trim() || 'The provider returned an error.';
}
