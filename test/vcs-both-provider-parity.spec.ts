import { describe, expect, it } from 'vitest';
import { GithubAdapter } from '@server/vcs/github';
import { BitbucketAdapter } from '@server/vcs/bitbucket';
import { BitbucketClient } from '@server/core/bitbucket';
import { createTestEnv } from './helpers';

// NREG-02: Phase 17 widens the VcsProvider seam with four new methods + a thread-listing
// capability flag. NREG-02 requires BOTH providers to expose the same seam surface; this
// spec is the explicit both-provider contract that proves the seam is symmetric, not
// GitHub-only. Pure type-shape assertions — no network is touched.

const INSTALLATION_ID = '123456';
const WORKSPACE = 'acme';
const BB_REPO = 'backend';
const BB_PR_NUMBER = 49;

const SEAM_METHODS = [
  'getFileContent',
  'getCompareDiff',
  'getUnresolvedBotThreads',
  'resolveThread',
] as const;

function buildBitbucketAdapter() {
  const env = createTestEnv();
  const client = new BitbucketClient(env, 'test-token-bearer');
  const job = {
    id: 'job-parity-1',
    owner: WORKSPACE,
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

function buildGitHubAdapter() {
  return new GithubAdapter(createTestEnv(), INSTALLATION_ID);
}

describe('NREG-02: both-provider VcsProvider seam parity', () => {
  it('GitHub adapter exposes all four new seam methods as callable functions', () => {
    const adapter = buildGitHubAdapter();
    for (const method of SEAM_METHODS) {
      const value = (adapter as unknown as Record<string, unknown>)[method];
      expect(typeof value).toBe('function');
    }
  });

  it('Bitbucket adapter exposes all four new seam methods as callable functions', () => {
    const adapter = buildBitbucketAdapter();
    for (const method of SEAM_METHODS) {
      const value = (adapter as unknown as Record<string, unknown>)[method];
      expect(typeof value).toBe('function');
    }
  });

  it('both providers report supportsThreadListing === true (D-03 / NREG-02)', () => {
    const github = buildGitHubAdapter();
    const bitbucket = buildBitbucketAdapter();
    expect(github.capabilities.supportsThreadListing).toBe(true);
    expect(bitbucket.capabilities.supportsThreadListing).toBe(true);
  });

  it('both providers report the full capability triple-shape (D-03, D-04)', () => {
    const github = buildGitHubAdapter();
    const bitbucket = buildBitbucketAdapter();
    for (const adapter of [github, bitbucket]) {
      const caps = adapter.capabilities;
      expect(caps).toEqual(
        expect.objectContaining({
          supportsMermaid: expect.any(Boolean),
          supportsThreadListing: expect.any(Boolean),
          supportsThreadResolution: expect.any(Boolean),
        }),
      );
      // The triple is EXACTLY three booleans — no extraneous fields, no missing fields.
      expect(Object.keys(caps).sort()).toEqual(
        ['supportsMermaid', 'supportsThreadListing', 'supportsThreadResolution'].sort(),
      );
    }
  });
});
