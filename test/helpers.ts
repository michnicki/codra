import type { AppBindings } from '@server/env';
import { encryptLlmApiKey } from '@server/core/llm-crypto';
import { queryRows } from '@server/db/client';
import { updateModelConfig } from '@server/db/model-configs';
import { updateGlobalConfig } from '@server/core/config';

export class MemoryKV {
  private readonly store = new Map<string, string>();

  async put(key: string, value: string) {
    this.store.set(key, value);
  }

  async get(key: string, type?: 'text' | 'json' | Partial<KVNamespaceGetOptions<undefined>>) {
    const value = this.store.get(key) ?? null;
    if (value === null) return null;
    if (type === 'json') {
      return JSON.parse(value);
    }
    return value;
  }

  async getWithMetadata(key: string, type?: 'text' | 'json' | Partial<KVNamespaceGetOptions<undefined>>) {
    return {
      value: await this.get(key, type as 'text' | 'json'),
      metadata: null,
      cacheStatus: null,
    } as any;
  }

  async list() {
    return {
      keys: Array.from(this.store.keys()).map((name) => ({ name })),
      list_complete: true,
      cursor: '',
    } as any;
  }

  async delete(key: string) {
    this.store.delete(key);
  }
}

export class MockAssets {
  async fetch(input: RequestInfo | URL) {
    const request = input instanceof Request ? input : new Request(input);
    return new Response(`<html><body>${new URL(request.url).pathname}</body></html>`, {
      headers: { 'content-type': 'text/html' },
    });
  }
}

export class MockQueue {
  public readonly sent: any[] = [];

  async send(message: any, options?: { delaySeconds?: number }) {
    this.sent.push({ ...message, options });
  }
}

export class MockWorkflow {
  public readonly created: any[] = [];
  public readonly terminated: string[] = [];

  async create(opts: any) {
    this.created.push(opts);
  }

  async get(id: string) {
    return {
      terminate: async () => {
        this.terminated.push(id);
      },
    };
  }
}

function usableEnvValue(value: string | undefined) {
  return value && value !== 'undefined' && value !== 'null' ? value : null;
}

function requiredEnv(key: keyof NodeJS.ProcessEnv) {
  const value = usableEnvValue(process.env[key]);
  if (!value) {
    throw new Error(`Missing required test environment variable: ${key}`);
  }
  return value;
}

function unusedEnv(key: string): string {
  throw new Error(`${key} is not required by the current test suite. Add it to the test env only when a test exercises that path.`);
}

export function getTestDatabaseUrl() {
  return requiredEnv('TEST_DATABASE_URL');
}

export function hasConfiguredTestDatabaseUrl() {
  return Boolean(usableEnvValue(process.env.TEST_DATABASE_URL));
}

export function createTestEnv(overrides: Partial<AppBindings> = {}): AppBindings {
  return {
    AI: {
      async run() {
        return { response: '{"findings":[],"file_verdict":"approve","file_summary":"ok"}', usage: { prompt_tokens: 1, completion_tokens: 1 } };
      },
    },
    APP_KV: new MemoryKV() as unknown as KVNamespace,
    REVIEW_QUEUE: new MockQueue() as any,
    REVIEW_WORKFLOW: new MockWorkflow() as any,
    // Phase 29 / QA-IDX-01 (D-06). Load-bearing Wave-0 scaffolding: the binding is not USED until
    // plan 29-05, but every later plan that constructs the full binding set reads createTestEnv(),
    // and adding the key in the wave that first uses it would make three later plans edit this
    // shared helper concurrently. Deliberately added early (29-REVIEWS.md, OpenCode 29-01 LOW).
    INDEX_WORKFLOW: new MockWorkflow() as any,
    ASSETS: new MockAssets() as any,
    HYPERDRIVE: {
      connectionString: getTestDatabaseUrl(),
    },
    get APP_PRIVATE_KEY() { return unusedEnv('APP_PRIVATE_KEY'); },
    get GITHUB_APP_ID() { return unusedEnv('GITHUB_APP_ID'); },
    GITHUB_APP_SLUG: requiredEnv('GITHUB_APP_SLUG'),
    GITHUB_APP_WEBHOOK_SECRET: requiredEnv('GITHUB_APP_WEBHOOK_SECRET'),
    GITHUB_CLIENT_ID: requiredEnv('GITHUB_CLIENT_ID'),
    GITHUB_CLIENT_SECRET: requiredEnv('GITHUB_CLIENT_SECRET'),
    AUTH_CALLBACK_URL: requiredEnv('AUTH_CALLBACK_URL'),
    APP_URL: requiredEnv('APP_URL'),
    DASHBOARD_ALLOWED_USERS: requiredEnv('DASHBOARD_ALLOWED_USERS'),
    LLM_CONFIG_ENCRYPTION_KEY: 'test-llm-config-encryption-key',
    BITBUCKET_CLIENT_ID: requiredEnv('BITBUCKET_CLIENT_ID'),
    BITBUCKET_CLIENT_SECRET: requiredEnv('BITBUCKET_CLIENT_SECRET'),
    BITBUCKET_AUTH_CALLBACK_URL: requiredEnv('BITBUCKET_AUTH_CALLBACK_URL'),
    BOT_USERNAME: requiredEnv('BOT_USERNAME'),
    ENVIRONMENT: 'test',
    get CF_API_TOKEN() { return unusedEnv('CF_API_TOKEN'); },
    get CF_ACCOUNT_ID() { return unusedEnv('CF_ACCOUNT_ID'); },
    ...overrides,
  };
}

// The Gemini test fixtures reviewers reach for (`gemma-4-31b-it`, `gemma-4-26b-a4b-it`) are NOT real
// catalog entries, so migrations/ensureModelCatalog never seed them -- only Cloudflare models are
// seeded. Tests must therefore create these Google model_configs themselves; relying on them being
// left over in a dev DB makes the suite pass locally but fail on a fresh CI database ("Model ... is
// not configured"). Seeding them alongside enabling the Google provider keeps the setup in one place.
const GOOGLE_TEST_MODEL_IDS = ['gemma-4-31b-it', 'gemma-4-26b-a4b-it'];

export async function saveTestProviderApiKey(env: AppBindings, providerName = 'Google', apiKey = 'test-key') {
  const encrypted = await encryptLlmApiKey(env, apiKey);
  await queryRows(
    env,
    `
    UPDATE llm_providers
    SET encrypted_api_key = $1, enabled = TRUE, updated_at = now()
    WHERE name = $2
    `,
    [encrypted, providerName],
  );

  if (providerName === 'Google') {
    for (const modelId of GOOGLE_TEST_MODEL_IDS) {
      await queryRows(
        env,
        `
        INSERT INTO model_configs (model_id, provider, provider_id, model_name, updated_at)
        SELECT $1, 'gemini', p.id, $1, now()
        FROM llm_providers p
        WHERE p.name = 'Google'
        ON CONFLICT (model_id) DO UPDATE SET
          provider = EXCLUDED.provider,
          provider_id = EXCLUDED.provider_id,
          model_name = EXCLUDED.model_name,
          updated_at = now()
        `,
        [modelId],
      );
    }
  }
}

/**
 * Generates a mock Unified Diff string for testing.
 */
export function generateMockDiff(files: { path: string; content: string }[]): string {
  return files
    .map((f) => {
      const lines = f.content.split('\n');
      return `diff --git a/${f.path} b/${f.path}
index 1234567..890abcd 100644
--- a/${f.path}
+++ b/${f.path}
@@ -1,${lines.length} +1,${lines.length} @@
${lines.map((l) => `+${l}`).join('\n')}`;
    })
    .join('\n');
}

/**
 * Seeds a cached installation token so the real GitHubClient (core/github.ts)
 * can run without touching APP_PRIVATE_KEY/GITHUB_APP_ID (which throw in
 * createTestEnv). GitHubClient.getInstallationToken() checks this cache key
 * before doing any JWT signing.
 */
export async function seedInstallationToken(env: AppBindings, installationId: string, token = 'test-installation-token') {
  await env.APP_KV.put(
    `install:${installationId}`,
    JSON.stringify({
      token,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    }),
  );
}

/**
 * Registers a model as the global review strategy so the real ModelService
 * (services/model.ts) can resolve a model instead of throwing "No review
 * model strategy is configured".
 */
export async function seedDefaultModelStrategy(env: AppBindings, modelId: string, providerName = 'Cloudflare') {
  const [provider] = await queryRows<{ id: string }>(
    env,
    `SELECT id FROM llm_providers WHERE name = $1`,
    [providerName],
  );
  if (!provider) {
    throw new Error(`Test provider "${providerName}" not found; check that migrations seeded it.`);
  }

  await updateModelConfig(env, {
    modelId,
    providerId: provider.id,
    modelName: modelId,
  });
  await updateGlobalConfig(env, { main: modelId, fallbacks: [], size_overrides: [] });
}

/**
 * Signs a raw webhook body the same way GitHub does, for driving /webhook directly.
 */
export async function signWebhookPayload(secret: string, payload: string) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  return `sha256=${Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')}`;
}

/**
 * Creates a mock GitHub Webhook payload for a PR opened event.
 */
export function createMockPRWebhook(overrides: any = {}) {
  return {
    action: 'opened',
    installation: { id: 12345 },
    repository: {
      name: 'test-repo',
      owner: { login: 'test-owner' },
    },
    pull_request: {
      number: 1,
      title: 'Initial PR',
      body: 'Testing PR body',
      user: { login: 'dev-author' },
      head: { sha: 'headsha', ref: 'feature' },
      base: { sha: 'basesha', ref: 'main' },
      draft: false,
    },
    ...overrides,
  };
}
