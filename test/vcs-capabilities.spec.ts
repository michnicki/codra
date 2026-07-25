import { describe, expect, it } from 'vitest';
import { GithubAdapter } from '@server/vcs/github';
import { BitbucketAdapter } from '@server/vcs/bitbucket';
import { BitbucketClient } from '@server/core/bitbucket';
import { createTestEnv } from './helpers';
import { installBitbucketFetchMock } from './bitbucket-fetch-mock';

// SC3 (capability portion): a provider-capability flag (supportsMermaid) reports true for GitHub
// and false for Bitbucket, declared per-adapter on the VcsProvider interface (D-09). Constructing
// each adapter touches no network — `capabilities` is a plain class-field initializer.

const INSTALLATION_ID = '123456';

const WORKSPACE = 'acme';
const BB_REPO = 'backend';
const BB_PR_NUMBER = 49;

// Bitbucket's real entry point is the async `create` factory; its per-method contract (and its
// static capability flag) is independent of credential reading, so we exercise the private
// constructor shape via the same pass-through cast the bitbucket-adapter spec uses.
function buildBitbucketAdapter() {
  const env = createTestEnv();
  const client = new BitbucketClient(env, 'test-token-bearer');
  const job = {
    id: 'job-cap-1',
    owner: 'acme',
    repo: BB_REPO,
    prNumber: BB_PR_NUMBER,
    repositoryVcsProvider: 'bitbucket',
    repositoryWorkspace: WORKSPACE,
  };
  return new (BitbucketAdapter as unknown as new (
    env: ReturnType<typeof createTestEnv>,
    client: BitbucketClient,
    jobArg: typeof job,
  ) => BitbucketAdapter)(env, client, job);
}

describe('VcsProvider capabilities', () => {
  it('GitHub reports supportsMermaid === true', () => {
    const adapter = new GithubAdapter(createTestEnv(), INSTALLATION_ID);
    expect(adapter.capabilities.supportsMermaid).toBe(true);
  });

  it('Bitbucket reports supportsMermaid === false', () => {
    const adapter = buildBitbucketAdapter();
    expect(adapter.capabilities.supportsMermaid).toBe(false);
  });
});

// SC3 (D-03/D-04): the full capability triple on freshly constructed adapters.
// GitHub is static across all three flags (D-04: observed-downgrade is Bitbucket-only).
// Bitbucket's `supportsThreadResolution` starts optimistic and is the ONE flag that mutates
// after a real 403/404/501 resolve attempt — the remainder of the triple is static.
describe('VcsProvider capability triple (D-03)', () => {
  it('GitHub reports the full triple as {true, true, true} on a fresh adapter', () => {
    const adapter = new GithubAdapter(createTestEnv(), INSTALLATION_ID);
    expect(adapter.capabilities).toEqual({
      supportsMermaid: true,
      supportsThreadListing: true,
      supportsThreadResolution: true,
    });
  });

  it('Bitbucket reports the full triple as {false, true, true} on a fresh adapter', () => {
    const adapter = buildBitbucketAdapter();
    expect(adapter.capabilities).toEqual({
      supportsMermaid: false,
      supportsThreadListing: true,
      supportsThreadResolution: true,
    });
  });
});

// SC3 (D-04): Bitbucket's `supportsThreadResolution` is OBSERVED-DOWNGRADE.
// The first real 403/404/501 flips the backing field to false, and subsequent calls
// short-circuit WITHOUT issuing a fetch. The OTHER two capability flags are unaffected
// — `supportsThreadListing` MUST remain true after the downgrade (D-04 + SC3).
describe('Bitbucket observed-downgrade semantics (D-04)', () => {
  it('downgrades supportsThreadResolution to false on a 403, leaves listing unchanged, and short-circuits subsequent calls', async () => {
    const mock = installBitbucketFetchMock({
      resolveCommentStatuses: [{ status: 403 }],
    });

    try {
      const adapter = buildBitbucketAdapter();
      // Before any call: optimistic.
      expect(adapter.capabilities.supportsThreadResolution).toBe(true);
      expect(adapter.capabilities.supportsThreadListing).toBe(true);

      // First call: 403 -> resolve returns false, capability flips.
      await expect(
        adapter.resolveThread(WORKSPACE, BB_REPO, `${BB_PR_NUMBER}:7`),
      ).resolves.toBe(false);
      expect(adapter.capabilities.supportsThreadResolution).toBe(false);
      // D-04: ONLY `supportsThreadResolution` mutates; listing stays true.
      expect(adapter.capabilities.supportsThreadListing).toBe(true);

      // Second call: short-circuits WITHOUT a fetch (D-04 short-circuit).
      const resolveCallsBefore = mock.calls.filter(
        (call) => call.method === 'POST' && /\/comments\/\d+\/resolve/.test(call.path),
      );
      const fetchCountBefore = resolveCallsBefore.length;
      await expect(
        adapter.resolveThread(WORKSPACE, BB_REPO, `${BB_PR_NUMBER}:7`),
      ).resolves.toBe(false);
      const resolveCallsAfter = mock.calls.filter(
        (call) => call.method === 'POST' && /\/comments\/\d+\/resolve/.test(call.path),
      );
      expect(resolveCallsAfter.length).toBe(fetchCountBefore);
    } finally {
      mock.restore();
    }
  });

  it('per-instance isolation: downgrading one adapter does NOT affect a separate instance', async () => {
    const mock = installBitbucketFetchMock({
      resolveCommentStatuses: [{ status: 403 }],
    });

    try {
      const downgradedAdapter = buildBitbucketAdapter();
      const untouchedAdapter = buildBitbucketAdapter();

      // Both start optimistic.
      expect(downgradedAdapter.capabilities.supportsThreadResolution).toBe(true);
      expect(untouchedAdapter.capabilities.supportsThreadResolution).toBe(true);

      // Trigger the downgrade on the first adapter.
      await expect(
        downgradedAdapter.resolveThread(WORKSPACE, BB_REPO, `${BB_PR_NUMBER}:7`),
      ).resolves.toBe(false);
      expect(downgradedAdapter.capabilities.supportsThreadResolution).toBe(false);

      // A separately constructed adapter MUST remain optimistic — the downgrade is
      // per-instance, not module-level (D-04, SC3).
      expect(untouchedAdapter.capabilities.supportsThreadResolution).toBe(true);
    } finally {
      mock.restore();
    }
  });
});
