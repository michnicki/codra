import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { buildWalkthroughData, type WalkthroughReviewRow } from '@server/core/walkthrough';
import {
  classifyVerifyFixesVerdict,
  shouldAttemptResolution,
} from '@server/core/verify-fixes';
import { FormatterService } from '@server/services/formatter';
import type { VcsProvider, VcsReviewThread } from '@server/vcs/types';
import type { ThreadVerifications } from '@shared/schema';

const formatter = new FormatterService('https://open-codra.example.com');
const providers = ['github', 'bitbucket'] as const;

const reviews: WalkthroughReviewRow[] = [
  {
    file_path: 'src/example.ts',
    file_summary: 'Updates the example.',
    file_status: 'done',
    error_msg: null,
    verdict: 'approve',
    diff_line_count: 12,
    pass: 'main',
  },
];

function verification(
  overrides: Partial<ThreadVerifications> = {},
): ThreadVerifications {
  return {
    version: 1,
    status: 'completed',
    entries: [],
    totals: {
      fixed: 2,
      unfixed: 1,
      unverifiable: 1,
      resolved: 1,
    },
    ...overrides,
  };
}

function render(result?: ThreadVerifications | null, provider: (typeof providers)[number] = 'github') {
  const data = buildWalkthroughData({
    reviews,
    finalComments: [],
    threadVerification: result,
  });
  return formatter.formatWalkthrough(data, { provider });
}

describe('D-04 durable thread verification walkthrough projection', () => {
  it.each(providers)('renders completed enabled totals from persisted data on %s', (provider) => {
    expect(render(verification(), provider)).toContain(
      '**Thread verification:** Fixed 2 · Unfixed 1 · Unverifiable 1 · Resolved 1',
    );
  });

  it.each(providers)('renders verify-only fixed results with resolved zero on %s', (provider) => {
    const result = verification({
      totals: { fixed: 2, unfixed: 0, unverifiable: 0, resolved: 0 },
    });

    expect(render(result, provider)).toContain(
      '**Thread verification:** Fixed 2 · Unfixed 0 · Unverifiable 0 · Resolved 0',
    );
  });

  it.each(providers)('renders only confirmed auto-resolve successes on %s', (provider) => {
    const result = verification({
      totals: { fixed: 3, unfixed: 1, unverifiable: 1, resolved: 2 },
    });

    expect(render(result, provider)).toContain(
      '**Thread verification:** Fixed 3 · Unfixed 1 · Unverifiable 1 · Resolved 2',
    );
  });

  it.each(providers)('renders fail-open as unavailable without successful zero counts on %s', (provider) => {
    const result = verification({
      status: 'fail_open',
      reason: 'provider_unavailable',
      totals: { fixed: 0, unfixed: 0, unverifiable: 0, resolved: 0 },
    });
    const body = render(result, provider);

    expect(body).toContain('**Thread verification:** Unavailable (degraded)');
    expect(body).not.toContain('Fixed 0');
  });

  it.each(providers)('emits no verification block for absent or disabled data on %s', (provider) => {
    expect(render(undefined, provider)).not.toContain('Thread verification');
    expect(render(null, provider)).not.toContain('Thread verification');
  });

  it.each(providers)('degrades logically invalid resolved totals instead of claiming impossible success on %s', (provider) => {
    const result = verification({
      totals: { fixed: 1, unfixed: 0, unverifiable: 0, resolved: 2 },
    });
    const body = render(result, provider);

    expect(body).toContain('**Thread verification:** Unavailable (degraded)');
    expect(body).not.toContain('Resolved 2');
  });

  it('preserves provider-gated Mermaid behavior when verification totals are present', () => {
    const data = buildWalkthroughData({
      reviews,
      finalComments: [],
      threadVerification: verification(),
    });
    const mermaid = 'sequenceDiagram\n  Reviewer->>PR: verify fixes';

    expect(formatter.formatWalkthrough({ ...data, mermaid }, { provider: 'github' })).toContain('```mermaid');
    expect(formatter.formatWalkthrough({ ...data, mermaid }, { provider: 'bitbucket' })).not.toContain('```mermaid');
  });
});

type LifecycleScenario = {
  file: 'present' | 'deleted' | 'failed';
  modelVerdict?: 'fixed' | 'unfixed';
  autoResolve?: boolean;
  supportsResolution?: boolean;
  resolution?: 'success' | 'failure';
};

function makeLifecycleProvider(name: (typeof providers)[number], scenario: LifecycleScenario) {
  const thread: VcsReviewThread = {
    ref: `${name}-opaque-thread-ref`,
    path: 'src/example.ts',
    lineStart: 8,
    lineEnd: 10,
    rootBody: 'provider-private thread body',
    outdated: false,
  };
  const listThreads = vi.fn(async () => [thread]);
  const getFileContent = vi.fn(async () => {
    if (scenario.file === 'failed') throw new Error(`${name} provider unavailable`);
    return scenario.file === 'deleted' ? null : 'export const fixed = true;';
  });
  const resolveThread = vi.fn(async () => {
    if (scenario.resolution === 'failure') throw new Error(`${name} resolution failed`);
    return true;
  });
  const provider = {
    name,
    capabilities: {
      supportsMermaid: name === 'github',
      supportsThreadListing: true,
      supportsThreadResolution: scenario.supportsResolution ?? true,
    },
    getUnresolvedBotThreads: listThreads,
    getFileContent,
    resolveThread,
  } as unknown as VcsProvider;
  return { provider, listThreads, getFileContent, resolveThread };
}

async function runLogicalLifecycle(provider: VcsProvider, scenario: LifecycleScenario) {
  const [thread] = await provider.getUnresolvedBotThreads('owner', 'repo', 19);
  let content: string | null = null;
  let fetchFailed = false;
  try {
    content = await provider.getFileContent('owner', 'repo', thread!.path, 'head-sha');
  } catch {
    fetchFailed = true;
  }
  const classification = classifyVerifyFixesVerdict({
    modelVerdict: scenario.modelVerdict ?? 'fixed',
    fetchFailed,
    deletedAtHead: content === null && !fetchFailed,
    malformedOutput: false,
    outdated: thread!.outdated,
    reason: scenario.modelVerdict === 'unfixed' ? 'issue_still_present' : 'model_confirmed_fix',
  });

  let resolved = false;
  if (
    scenario.autoResolve &&
    provider.capabilities.supportsThreadResolution &&
    shouldAttemptResolution(classification.verdict, classification.reason)
  ) {
    try {
      resolved = await provider.resolveThread('owner', 'repo', thread!.ref);
    } catch {
      resolved = false;
    }
  }

  return {
    verdict: classification.verdict,
    reason: classification.reason,
    resolved,
  };
}

describe('NREG-02 verify-fixes lifecycle parity through VcsProvider', () => {
  it.each([
    ['fixed verify-only', { file: 'present', modelVerdict: 'fixed', autoResolve: false }],
    ['deleted/unverifiable', { file: 'deleted', modelVerdict: 'fixed', autoResolve: true }],
    ['auto-resolve success', { file: 'present', modelVerdict: 'fixed', autoResolve: true, resolution: 'success' }],
    ['capability downgrade', { file: 'present', modelVerdict: 'fixed', autoResolve: true, supportsResolution: false }],
    ['provider resolve failure', { file: 'present', modelVerdict: 'fixed', autoResolve: true, resolution: 'failure' }],
    ['provider content failure', { file: 'failed', modelVerdict: 'fixed', autoResolve: true }],
  ] as const)('produces equivalent %s outcomes on GitHub and Bitbucket', async (_label, scenario) => {
    const outcomes = [];
    for (const name of providers) {
      const { provider, listThreads, getFileContent, resolveThread } = makeLifecycleProvider(name, scenario);
      outcomes.push(await runLogicalLifecycle(provider, scenario));
      expect(listThreads).toHaveBeenCalledWith('owner', 'repo', 19);
      expect(getFileContent).toHaveBeenCalledWith('owner', 'repo', 'src/example.ts', 'head-sha');
      if (
        !scenario.autoResolve ||
        scenario.file !== 'present' ||
        ('supportsResolution' in scenario && scenario.supportsResolution === false)
      ) {
        expect(resolveThread).not.toHaveBeenCalled();
      }
    }

    expect(outcomes[0]).toEqual(outcomes[1]);
  });

  it('pins the expected logical outcomes across degradation modes', async () => {
    const scenarios: Array<[LifecycleScenario, Awaited<ReturnType<typeof runLogicalLifecycle>>]> = [
      [
        { file: 'present', modelVerdict: 'fixed', autoResolve: false },
        { verdict: 'fixed', reason: 'model_confirmed_fix', resolved: false },
      ],
      [
        { file: 'present', modelVerdict: 'fixed', autoResolve: true, resolution: 'success' },
        { verdict: 'fixed', reason: 'model_confirmed_fix', resolved: true },
      ],
      [
        { file: 'deleted', modelVerdict: 'fixed', autoResolve: true },
        { verdict: 'unverifiable', reason: 'file_deleted_at_head', resolved: false },
      ],
      [
        { file: 'failed', modelVerdict: 'fixed', autoResolve: true },
        { verdict: 'unverifiable', reason: 'file_fetch_failed', resolved: false },
      ],
    ];

    for (const [scenario, expected] of scenarios) {
      const { provider } = makeLifecycleProvider('github', scenario);
      await expect(runLogicalLifecycle(provider, scenario)).resolves.toEqual(expected);
    }
  });

  it('keeps verify-fixes core free of provider-name branches', () => {
    const source = readFileSync(new URL('../src/server/core/verify-fixes.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/vcs\.name\s*(?:===|!==)/);
    expect(source).not.toMatch(/['"](?:github|bitbucket)['"]/);
  });
});
