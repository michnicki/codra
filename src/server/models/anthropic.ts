import { logger } from '@server/core/logger';
import { withTimeout } from '@server/core/timeout';
import { isValidPublicUrl } from '@server/core/ssrf';
import { ProviderRequestError, providerErrorMessage, type ModelRequestInput, type ModelResponse } from './types';

const ANTHROPIC_TIMEOUT_MS = 80_000;
const ANTHROPIC_MAX_OUTPUT_TOKENS = 4096;
const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1';

export interface AnthropicResponse {
  content?: Array<{ text?: string }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
}

export async function reviewWithAnthropic(
  config: { apiKey: string; baseUrl?: string | null; providerName: string; timeoutMs?: number },
  model: string,
  input: ModelRequestInput,
  tracker?: { incrementSubrequests(count?: number): void },
): Promise<ModelResponse> {
  logger.info(`Calling Anthropic model: ${model}`);

  if (config.baseUrl && !isValidPublicUrl(config.baseUrl)) {
    throw new ProviderRequestError(config.providerName, 400, 'Invalid provider base URL.');
  }

  const baseUrl = (config.baseUrl || DEFAULT_ANTHROPIC_BASE_URL).replace(/\/+$/, '');
  const timeoutMs = config.timeoutMs ?? ANTHROPIC_TIMEOUT_MS;

  if (tracker) tracker.incrementSubrequests(1);
  const response = await withTimeout('Anthropic API', timeoutMs, (signal) =>
    fetch(`${baseUrl}/messages`, {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        system: `${input.systemPrompt}\n\nReturn only the JSON object. Do not include chain-of-thought, analysis, markdown, code fences, or explanatory prose.`,
        messages: [
          { role: 'user', content: `${input.userPrompt}\n\nRespond with the required JSON object only.` },
          { role: 'assistant', content: '{' }
        ],
        max_tokens: ANTHROPIC_MAX_OUTPUT_TOKENS,
        temperature: input.temperature ?? 0,
      }),
    }),
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new ProviderRequestError(config.providerName, response.status, providerErrorMessage(errorText));
  }

  const data = (await response.json()) as AnthropicResponse;
  let rawText = Array.isArray(data.content)
    ? data.content.map((part) => typeof part?.text === 'string' ? part.text : '').join('').trim()
    : '';

  if (!rawText && (!data.content || data.content.length === 0)) {
    throw new Error('Anthropic provider returned an empty response.');
  }

  // Prepend the '{' that we pre-filled in the assistant message
  rawText = '{' + rawText;

  return {
    rawText,
    inputTokens: data?.usage?.input_tokens ?? 0,
    outputTokens: data?.usage?.output_tokens ?? 0,
    modelUsed: model,
    provider: config.providerName,
  };
}
