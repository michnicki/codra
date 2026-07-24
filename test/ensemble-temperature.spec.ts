import { afterEach, describe, expect, it, vi } from 'vitest';
import { reviewWithAnthropic } from '@server/models/anthropic';
import { reviewWithCloudflare } from '@server/models/cloudflare';
import { reviewWithGoogle } from '@server/models/google';
import { reviewWithOpenAI } from '@server/models/openai';

const input = { systemPrompt: 'system', userPrompt: 'user' };

function successfulGoogleResponse() {
  return new Response(
    JSON.stringify({
      candidates: [{ content: { parts: [{ text: '{"findings":[]}' }] } }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function successfulOpenAIResponse() {
  return new Response(
    JSON.stringify({ choices: [{ message: { content: '{"findings":[]}' } }] }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function successfulAnthropicResponse() {
  return new Response(
    JSON.stringify({ content: [{ text: '"findings":[]}' }] }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function requestBody(call: [RequestInfo | URL, RequestInit?]) {
  return JSON.parse(String(call[1]?.body)) as Record<string, any>;
}

describe('ensemble temperature provider requests', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('preserves each provider default request when temperature is undefined', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(successfulOpenAIResponse())
      .mockResolvedValueOnce(successfulAnthropicResponse())
      .mockResolvedValueOnce(successfulGoogleResponse());
    const cloudflareRequests: Array<Record<string, any>> = [];
    const env = {
      AI: {
        async run(_model: string, request: Record<string, any>) {
          cloudflareRequests.push(request);
          return { response: '{"findings":[]}' };
        },
      },
    } as any;

    await reviewWithOpenAI(
      { apiKey: 'key', baseUrl: 'https://openai.example/v1', providerName: 'OpenAI' },
      'openai-model',
      input,
    );
    await reviewWithAnthropic(
      { apiKey: 'key', baseUrl: 'https://anthropic.example/v1', providerName: 'Anthropic' },
      'anthropic-model',
      input,
    );
    await reviewWithGoogle(
      { apiKey: 'key', baseUrl: 'https://google.example/v1beta', providerName: 'Google' },
      'google-model',
      input,
    );
    await reviewWithCloudflare(env, 'cloudflare-model', input);

    expect(requestBody(fetchMock.mock.calls[0]).temperature).toBe(0);
    expect(requestBody(fetchMock.mock.calls[1]).temperature).toBe(0);
    expect(requestBody(fetchMock.mock.calls[2]).generationConfig).not.toHaveProperty('temperature');
    expect(cloudflareRequests[0].temperature).toBe(0);
  });

  it('forwards an explicit ensemble temperature to every provider request', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(successfulOpenAIResponse())
      .mockResolvedValueOnce(successfulAnthropicResponse())
      .mockResolvedValueOnce(successfulGoogleResponse());
    const cloudflareRequests: Array<Record<string, any>> = [];
    const env = {
      AI: {
        async run(_model: string, request: Record<string, any>) {
          cloudflareRequests.push(request);
          return { response: '{"findings":[]}' };
        },
      },
    } as any;
    const extraInput = { ...input, temperature: 0.73 };

    await reviewWithOpenAI(
      { apiKey: 'key', baseUrl: 'https://openai.example/v1', providerName: 'OpenAI' },
      'openai-model',
      extraInput,
    );
    await reviewWithAnthropic(
      { apiKey: 'key', baseUrl: 'https://anthropic.example/v1', providerName: 'Anthropic' },
      'anthropic-model',
      extraInput,
    );
    await reviewWithGoogle(
      { apiKey: 'key', baseUrl: 'https://google.example/v1beta', providerName: 'Google' },
      'google-model',
      extraInput,
    );
    await reviewWithCloudflare(env, 'cloudflare-model', extraInput);

    expect(requestBody(fetchMock.mock.calls[0]).temperature).toBe(0.73);
    expect(requestBody(fetchMock.mock.calls[1]).temperature).toBe(0.73);
    expect(requestBody(fetchMock.mock.calls[2]).generationConfig.temperature).toBe(0.73);
    expect(cloudflareRequests[0].temperature).toBe(0.73);
  });
});
