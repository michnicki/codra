import { describe, it, expect } from 'vitest';
import {
  getPrReviewState,
  markPrPaused,
  markPrResumed,
  setLastReviewedSha,
  type PrReviewStateKey,
} from '@server/db/pr-review-state';
import { queryRows } from '@server/db/client';
import { createTestEnv, hasConfiguredTestDatabaseUrl } from './helpers';

// SC1 (pause portion): prove the pr_review_state accessors behave as the Phase 11 pause substrate
// requires -- null when the PR has never been paused (lazy creation), one row per PR keyed on the
// immutable account_id, and (REVIEW FIX, Codex HIGH #2) exactly one row per GitHub PR because the
// NOT NULL canonical workspace + UNIQUE(vcs_provider, workspace, repo_slug, pr_number) enforces
// D-01's one-row-per-PR even for GitHub. Runs against the migrated TEST_DATABASE_URL (007 applied by
// `npm test`).
const dbDescribe = hasConfiguredTestDatabaseUrl() ? describe : describe.skip;

// Unique per-test tuples so parallel-safe repeat runs never collide on the UNIQUE key.
function githubKey(suffix: string): PrReviewStateKey {
  return { vcsProvider: 'github', workspace: 'test-owner', repoSlug: `repo-${suffix}`, prNumber: 7 };
}

async function countRows(env: ReturnType<typeof createTestEnv>, key: PrReviewStateKey): Promise<number> {
  const rows = await queryRows<{ n: string }>(
    env,
    `
      SELECT COUNT(*)::text AS n
      FROM pr_review_state
      WHERE vcs_provider = $1 AND workspace = $2 AND repo_slug = $3 AND pr_number = $4
    `,
    [key.vcsProvider, key.workspace, key.repoSlug, key.prNumber],
  );
  return Number(rows[0].n);
}

dbDescribe('pr_review_state pause accessors (SC1 pause portion)', () => {
  const env = createTestEnv();

  it('returns null for a never-paused PR (no row until first pause)', async () => {
    const key = githubKey(`never-${Date.now()}`);
    expect(await getPrReviewState(env, key)).toBeNull();
  });

  it('pauses with the immutable account_id and lazily creates the row', async () => {
    const key = githubKey(`pause-${Date.now()}`);
    const accountId = 'account-id-abc-123';

    await markPrPaused(env, key, accountId);

    const state = await getPrReviewState(env, key);
    expect(state).not.toBeNull();
    expect(state!.paused).toBe(true);
    expect(state!.paused_by).toBe(accountId);
  });

  it('re-pausing the same tuple updates in place (single row, lazy creation + ON CONFLICT)', async () => {
    const key = githubKey(`repause-${Date.now()}`);

    await markPrPaused(env, key, 'account-first');
    await markPrPaused(env, key, 'account-second');

    expect(await countRows(env, key)).toBe(1);
    const state = await getPrReviewState(env, key);
    expect(state!.paused).toBe(true);
    expect(state!.paused_by).toBe('account-second');
  });

  it('resume clears paused in place WITHOUT clobbering paused_by (IN-02)', async () => {
    const key = githubKey(`resume-${Date.now()}`);

    await markPrPaused(env, key, 'account-pauser');
    const resumed = await markPrResumed(env, key, 'account-resumer');

    // Single row, cleared in place.
    expect(await countRows(env, key)).toBe(1);
    expect(resumed).not.toBeNull();
    expect(resumed!.paused).toBe(false);
    const state = await getPrReviewState(env, key);
    expect(state!.paused).toBe(false);
    // IN-02: paused_by preserves the PAUSER's immutable account_id (NREG-02 intent), NOT the
    // resumer -- the previous upsert-based implementation overwrote it with 'account-resumer'.
    expect(state!.paused_by).toBe('account-pauser');
  });

  it('resuming a never-paused PR is a no-op: no row is created and null is returned (IN-02)', async () => {
    const key = githubKey(`resume-noop-${Date.now()}`);

    // IN-02: resume must NOT route through the upsert (which would INSERT a spurious paused=false
    // row and break the "no row until first pause" lazy-creation invariant).
    const resumed = await markPrResumed(env, key, 'account-resumer');

    expect(resumed).toBeNull();
    expect(await countRows(env, key)).toBe(0);
    expect(await getPrReviewState(env, key)).toBeNull();
  });

  it('two pause attempts on the same GitHub PR tuple yield exactly one row (D-01 one-row-per-PR for GitHub)', async () => {
    // REVIEW FIX (Codex HIGH #2): a nullable workspace would let Postgres treat the two GitHub rows
    // as distinct under the default UNIQUE and permit a duplicate. The NOT NULL canonical workspace
    // (owner/login) + UNIQUE(vcs_provider, workspace, repo_slug, pr_number) collapses both attempts
    // onto one row.
    const key = githubKey(`onerow-${Date.now()}`);

    await markPrPaused(env, key, 'account-a');
    await markPrPaused(env, key, 'account-b');

    expect(await countRows(env, key)).toBe(1);
  });
});

// Phase 18 (RND-05 / D-14 / D-15): the migration-011 anchor accessors. Pause fields are
// PRESERVED across anchor writes (Phase 18 Plan 02 D-13), the anchor is MONOTONIC (a stale
// redelivery cannot regress the anchor below a newer one), and an empty head SHA is a no-op
// guarded by an explicit `rounds.anchor_skipped` audit event emitted by the caller.
dbDescribe('pr_review_state anchor accessors (RND-05 / D-14)', () => {
  const env = createTestEnv();
  const sha = (ch: string) => ch.repeat(40);

  it('setLastReviewedSha: first write lazy-creates the row with anchor + round', async () => {
    const key = githubKey(`anchor-first-${Date.now()}`);
    const row = await setLastReviewedSha(env, key, { headSha: sha('a'), reviewRound: 2 });
    expect(row).not.toBeNull();
    expect(row!.last_reviewed_sha).toBe(sha('a'));
    expect(row!.last_review_round).toBe(2);
  });

  it('setLastReviewedSha: a monotonic round advance (round 2 -> 3) updates the row', async () => {
    const key = githubKey(`anchor-mono-${Date.now()}`);
    await setLastReviewedSha(env, key, { headSha: sha('b'), reviewRound: 2 });
    const after = await setLastReviewedSha(env, key, { headSha: sha('c'), reviewRound: 3 });
    expect(after).not.toBeNull();
    expect(after!.last_reviewed_sha).toBe(sha('c'));
    expect(after!.last_review_round).toBe(3);
  });

  it('setLastReviewedSha: a stale round (round 3 -> 2) is rejected -- no anchor regression', async () => {
    const key = githubKey(`anchor-stale-${Date.now()}`);
    await setLastReviewedSha(env, key, { headSha: sha('d'), reviewRound: 3 });
    const after = await setLastReviewedSha(env, key, { headSha: sha('e'), reviewRound: 2 });
    // The UPDATE was rejected by the WHERE clause so RETURNING is empty.
    expect(after).toBeNull();
    const state = await getPrReviewState(env, key);
    expect(state!.last_reviewed_sha).toBe(sha('d'));
    expect(state!.last_review_round).toBe(3);
  });

  it('setLastReviewedSha: empty / whitespace head SHA is a no-op (D-15 defensive guard)', async () => {
    const key = githubKey(`anchor-empty-${Date.now()}`);
    const result = await setLastReviewedSha(env, key, { headSha: '', reviewRound: 1 });
    expect(result).toBeNull();
    const resultWs = await setLastReviewedSha(env, key, { headSha: '   ', reviewRound: 1 });
    expect(resultWs).toBeNull();
    expect(await getPrReviewState(env, key)).toBeNull();
  });

  it('anchor writes DO NOT clobber an existing pause state (pause columns preserved)', async () => {
    // Phase 18 Plan 02 D-13: the anchor setter writes ONLY the anchor columns. A pre-existing
    // pause must survive (no overwriting paused / paused_by / paused_at).
    const key = githubKey(`anchor-pause-${Date.now()}`);
    await markPrPaused(env, key, 'account-pauser');
    const beforeAnchor = await getPrReviewState(env, key);
    expect(beforeAnchor!.paused).toBe(true);
    expect(beforeAnchor!.paused_by).toBe('account-pauser');

    await setLastReviewedSha(env, key, { headSha: sha('f'), reviewRound: 1 });

    const afterAnchor = await getPrReviewState(env, key);
    expect(afterAnchor!.last_reviewed_sha).toBe(sha('f'));
    expect(afterAnchor!.last_review_round).toBe(1);
    expect(afterAnchor!.paused).toBe(true);
    expect(afterAnchor!.paused_by).toBe('account-pauser');
  });
});
