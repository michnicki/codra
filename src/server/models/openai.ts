import { logger } from '@server/core/logger';
import { withTimeout } from '@server/core/timeout';
import { isValidPublicUrl } from '@server/core/ssrf';
import { ProviderRequestError, providerErrorMessage, type ModelRequestInput, type ModelResponse } from './types';

const OPENAI_TIMEOUT_MS = 80_000;
const OPENAI_MAX_OUTPUT_TOKENS = 4096;

export interface OpenAIResponse {
  choices?: Array<{
    message?: {
      content?: string | Array<{ text?: string }>;
    };
  }>;
  output_text?: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    input_tokens?: number;
    output_tokens?: number;
  };
}

function extractOpenAiText(data: OpenAIResponse) {
  const messageContent = data?.choices?.[0]?.message?.content;
  if (typeof messageContent === 'string') return messageContent.trim();
  if (Array.isArray(messageContent)) {
    return messageContent.map((part) => typeof part?.text === 'string' ? part.text : '').join('').trim();
  }
  const outputText = data?.output_text;
  if (typeof outputText === 'string') return outputText.trim();
  return '';
}

export async function reviewWithOpenAI(
  config: { apiKey: string | null; baseUrl: string; providerName: string; timeoutMs?: number },
  model: string,
  input: ModelRequestInput,
  tracker?: { incrementSubrequests(count?: number): void },
): Promise<ModelResponse> {
  logger.info(`Calling OpenAI-format model: ${model}`);
  const timeoutMs = config.timeoutMs ?? OPENAI_TIMEOUT_MS;
  
  if (!isValidPublicUrl(config.baseUrl)) {
    throw new ProviderRequestError(config.providerName, 400, 'Invalid provider base URL.');
  }
  
  const url = `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`;

  if (tracker) tracker.incrementSubrequests(1);
  const response = await withTimeout('OpenAI API', timeoutMs, (signal) =>
    fetch(url, {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'system',
            content: `${input.systemPrompt}\n\nReturn only the JSON object. Do not include chain-of-thought, analysis, markdown, code fences, or explanatory prose.`,
          },
          { role: 'user', content: `${input.userPrompt}\n\nRespond with the required JSON object only.` },
        ],
        temperature: input.temperature ?? 0,
        max_tokens: OPENAI_MAX_OUTPUT_TOKENS,
        response_format: { type: 'json_object' },
      }),
    }),
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new ProviderRequestError(config.providerName, response.status, providerErrorMessage(errorText));
  }

  const data = await response.json() as OpenAIResponse;
  const rawText = extractOpenAiText(data);
  if (!rawText) {
    throw new Error('OpenAI provider returned an empty response.');
  }

  return {
    rawText,
    inputTokens: data?.usage?.prompt_tokens ?? data?.usage?.input_tokens ?? 0,
    outputTokens: data?.usage?.completion_tokens ?? data?.usage?.output_tokens ?? 0,
    modelUsed: model,
    provider: config.providerName,
  };
}
