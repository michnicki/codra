import type {
  AuthSessionResponse,
  AuthSessionUser,
  JobDetailResponse,
  JobsResponse,
  ModelConfigsResponse,
  RepoConfigResponse,
  RepoConfigsResponse,
  RetryJobResponse,
  StatsResponse,
  SyncReposResponse,
} from '@shared/api';
import type {
  LlmApiFormat,
  LlmProvider,
  RepoConfig,
  ReviewSettings,
  VcsCredentialStatus,
  VcsCredentialStoreInput,
  VcsProvider,
  VcsWorkspaceCredentialStatus,
} from '@shared/schema';
import type { AddBitbucketWorkspaceInput, WorkspaceRepoListItem } from '@shared/bitbucket';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function pathSegment(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error('Path segment cannot be empty.');
  }
  return encodeURIComponent(trimmed);
}

type QueryValue = string | number | boolean | null | undefined;
export type ProviderPayload = {
  name: string;
  apiFormat: LlmApiFormat;
  baseUrl: string | null;
  apiKey?: string;
  clearApiKey?: boolean;
  enabled: boolean;
};
type RepoConfigPatch = Partial<Pick<RepoConfig, 'review' | 'model'> & { enabled: boolean }>;

// Phase 29 (QA-IDX-01): wire shapes of the code-index endpoints. CamelCase to match the
// dashboard convention the handler projects (`mapJob`), not the `code_index_state` column names.
export interface CodeIndexStatus {
  status: 'idle' | 'building' | 'ready' | 'failed';
  /** What produced the current index: 'full' = dashboard rebuild, 'incremental' = push refresh, null = never built. */
  mode: 'full' | 'incremental' | null;
  indexedSha: string | null;
  indexedAt: string | null;
  fileCount: number;
  chunkCount: number;
  truncated: boolean;
  /** Already redacted at the server write site (AUD-01) — render as-is, never re-process. */
  lastError: string | null;
}

export interface CodeIndexStatusResponse {
  index: CodeIndexStatus;
}

export interface CodeIndexBuildResponse {
  ok: boolean;
  /** True when the press coalesced against a live build (already_exists / lease_held) — informational, not an error. */
  coalesced: boolean;
  build: { mode: 'full'; workflowInstanceId: string };
}

async function request<T>(input: string, init?: RequestInit) {
  const method = init?.method?.toUpperCase() ?? 'GET';
  const headers = new Headers(init?.headers);

  if (!headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }

  if (!SAFE_METHODS.has(method)) {
    headers.set('x-requested-with', 'XMLHttpRequest');
  }

  const response = await fetch(input, {
    credentials: 'same-origin',
    ...init,
    headers,
  });

  if (response.status === 401) {
    if (location.pathname !== '/login') {
      location.href = '/login';
    }
    throw new Error('Unauthorized');
  }

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(payload?.error ?? `Request failed with ${response.status}`);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

async function requestWithMeta<T>(input: string, init?: RequestInit) {
  const method = init?.method?.toUpperCase() ?? 'GET';
  const headers = new Headers(init?.headers);

  if (!headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }

  if (!SAFE_METHODS.has(method)) {
    headers.set('x-requested-with', 'XMLHttpRequest');
  }

  const response = await fetch(input, {
    credentials: 'same-origin',
    ...init,
    headers,
  });

  if (response.status === 401) {
    if (location.pathname !== '/login') {
      location.href = '/login';
    }
    throw new Error('Unauthorized');
  }

  const etag = response.headers.get('etag');
  const lastModified = response.headers.get('last-modified');

  if (response.status === 304) {
    return { status: response.status, etag, lastModified, notModified: true as const };
  }

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(payload?.error ?? `Request failed with ${response.status}`);
  }

  return {
    status: response.status,
    etag,
    lastModified,
    notModified: false as const,
    data: (await response.json()) as T,
  };
}

export const api = {
  getSession() {
    return request<AuthSessionResponse>('/api/auth/session');
  },
  /**
   * Side-effect-free session probe for unauthenticated pages (landing/login).
   * Unlike `getSession`, a missing/invalid session resolves to `null` instead of
   * redirecting to /login — so calling it from `/` never bounces an anonymous
   * visitor. Used to auto-forward an already-authenticated user to the dashboard,
   * which also recovers the post-OAuth case where the immediate server-side
   * /dashboard session read lost the Cloudflare KV read-after-write race.
   */
  async probeSession(): Promise<AuthSessionUser | null> {
    try {
      const response = await fetch('/api/auth/session', {
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
      });
      if (!response.ok) {
        return null;
      }
      const data = (await response.json()) as AuthSessionResponse;
      return data.user ?? null;
    } catch {
      return null;
    }
  },
  logout() {
    return request<{ ok: boolean }>('/auth/logout', {
      method: 'POST',
    });
  },
  getJobs(params: Record<string, QueryValue> = {}) {
    const searchParams = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') {
        searchParams.set(key, String(value));
      }
    }
    const query = searchParams.toString();
    return request<JobsResponse>(`/api/jobs${query ? `?${query}` : ''}`);
  },
  getJob(id: string, options: { etag?: string | null } = {}) {
    const headers = new Headers();
    if (options.etag) {
      headers.set('if-none-match', options.etag);
    }
    return requestWithMeta<JobDetailResponse>(`/api/jobs/${id}`, { headers });
  },
  retryJob(id: string) {
    return request<RetryJobResponse>(`/api/jobs/${id}/retry`, {
      method: 'POST',
    });
  },
  rerunJob(id: string) {
    return request<RetryJobResponse>(`/api/jobs/${pathSegment(id)}/rerun`, {
      method: 'POST',
    });
  },
  stopJob(id: string) {
    return request<RetryJobResponse>(`/api/jobs/${pathSegment(id)}/stop`, {
      method: 'POST',
    });
  },
  deleteJob(id: string) {
    return request<void>(`/api/jobs/${pathSegment(id)}`, {
      method: 'DELETE',
    });
  },
  getRepos() {
    return request<RepoConfigsResponse>('/api/repos');
  },
  getRepo(owner: string, repo: string, vcsProvider?: VcsProvider) {
    const query = vcsProvider ? `?provider=${vcsProvider}` : '';
    return request<RepoConfigResponse>(`/api/repos/${pathSegment(owner)}/${pathSegment(repo)}/config${query}`);
  },
  getStats(days?: number) {
    const query = days ? `?days=${days}` : '';
    return request<StatsResponse>(`/api/stats${query}`);
  },
  syncRepos() {
    return request<SyncReposResponse>('/api/repos/sync', {
      method: 'POST',
    });
  },
  updateRepoConfig(owner: string, repo: string, config: RepoConfigPatch, vcsProvider?: VcsProvider) {
    const query = vcsProvider ? `?provider=${vcsProvider}` : '';
    return request<{ ok: boolean }>(`/api/repos/${pathSegment(owner)}/${pathSegment(repo)}/config${query}`, {
      method: 'PATCH',
      body: JSON.stringify(config),
    });
  },
  getModelConfigs() {
    return request<ModelConfigsResponse>('/api/models');
  },
  refreshModelCatalog() {
    return request<ModelConfigsResponse>('/api/models/sync', {
      method: 'POST',
    });
  },
  createProvider(config: ProviderPayload) {
    return request<{ provider: LlmProvider }>('/api/models/providers', {
      method: 'POST',
      body: JSON.stringify(config),
    });
  },
  updateProvider(id: string, config: ProviderPayload) {
    return request<{ provider: LlmProvider }>(`/api/models/providers/${pathSegment(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(config),
    });
  },
  deleteProvider(id: string) {
    return request<{ ok: boolean }>(`/api/models/providers/${pathSegment(id)}`, {
      method: 'DELETE',
    });
  },
  getGlobalConfig() {
    return request<{ config: RepoConfig['model'] }>('/api/models/global');
  },
  updateGlobalConfig(config: RepoConfig['model']) {
    return request<{ ok: boolean }>('/api/models/global', {
      method: 'PATCH',
      body: JSON.stringify(config),
    });
  },
  getReviewSettings() {
    return request<{ settings: ReviewSettings }>('/api/settings');
  },
  updateReviewSettings(settings: ReviewSettings) {
    return request<{ ok: boolean; settings: ReviewSettings }>('/api/settings', {
      method: 'PATCH',
      body: JSON.stringify(settings),
    });
  },
  getVcsCredentials() {
    return request<{ credentials: VcsCredentialStatus[] }>('/api/vcs-credentials');
  },
  storeVcsCredential(input: VcsCredentialStoreInput) {
    return request<{ credential: VcsCredentialStatus }>('/api/vcs-credentials', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },
  addBitbucketRepo(input: {
    workspace: string;
    repoSlug: string;
    accessToken: string;
    webhookSecret: string;
    tokenExpiresAt?: string | null;
  }) {
    return request<{ credential: VcsCredentialStatus }>('/api/repos/bitbucket', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },
  discoverBitbucketWorkspaceRepos(input: { workspace: string; accessToken: string }) {
    return request<{ repos: WorkspaceRepoListItem[] }>('/api/repos/bitbucket/workspaces/discover', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },
  addBitbucketWorkspace(input: AddBitbucketWorkspaceInput) {
    return request<{ credential: VcsWorkspaceCredentialStatus; repositoryCount: number }>(
      '/api/repos/bitbucket/workspaces',
      {
        method: 'POST',
        body: JSON.stringify(input),
      },
    );
  },
  deleteVcsCredential(key: { vcsProvider: string; workspace: string; repoSlug: string }) {
    return request<{ ok: boolean }>(
      `/api/vcs-credentials/${pathSegment(key.vcsProvider)}/${pathSegment(key.workspace)}/${pathSegment(key.repoSlug)}`,
      { method: 'DELETE' },
    );
  },
  // Phase 28 (LRN-01): learned-rule synthesis and status transitions.
  synthesizeLearnedRules(owner: string, repo: string, vcsProvider?: VcsProvider) {
    const query = vcsProvider ? `?provider=${vcsProvider}` : '';
    return request<{ ok: boolean; rules: unknown[]; message?: string }>(
      `/api/repos/${pathSegment(owner)}/${pathSegment(repo)}/learned-rules/synthesize${query}`,
      { method: 'POST' },
    );
  },
  updateLearnedRule(owner: string, repo: string, ruleId: string, status: 'pending' | 'active' | 'disabled', vcsProvider?: VcsProvider) {
    const query = vcsProvider ? `?provider=${vcsProvider}` : '';
    return request<{ ok: boolean }>(
      `/api/repos/${pathSegment(owner)}/${pathSegment(repo)}/learned-rules/${pathSegment(ruleId)}${query}`,
      { method: 'PATCH', body: JSON.stringify({ status }) },
    );
  },
  // Phase 29 (QA-IDX-01, D-07): the dashboard build trigger and the operator status read.
  // Neither sets the CSRF header by hand — the shared `request` helper sets `x-requested-with`
  // on every non-safe method (T-29-09-01).
  buildCodeIndex(owner: string, repo: string, vcsProvider?: VcsProvider) {
    const query = vcsProvider ? `?provider=${vcsProvider}` : '';
    return request<CodeIndexBuildResponse>(
      `/api/repos/${pathSegment(owner)}/${pathSegment(repo)}/code-index/build${query}`,
      { method: 'POST' },
    );
  },
  getCodeIndexStatus(owner: string, repo: string, vcsProvider?: VcsProvider) {
    const query = vcsProvider ? `?provider=${vcsProvider}` : '';
    return request<CodeIndexStatusResponse>(
      `/api/repos/${pathSegment(owner)}/${pathSegment(repo)}/code-index/status${query}`,
    );
  },
};
