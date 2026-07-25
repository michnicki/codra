import { describe, it, expect, vi } from 'vitest';
import type { ParsedReviewComment } from '@shared/schema';
import { insertJob, getJobDetail } from '@server/db/jobs';
import * as jobsModule from '@server/db/jobs';
import { logger } from '@server/core/logger';
import {
  buildEnsembleVoteAuditEvent,
  recordEnsembleAudit,
} from '@server/core/audit';
import {
  clusterEnsembleRuns,
  pickClusterRepresentative,
  reconcileEnsembleRuns,
  type EnsembleRun,
} from '@server/core/ensemble';
import { matchCompositeRule, type CompositeMatch } from '@server/core/dedup';
import { redactErrorMessage, MACHINE_ERROR_REASONS } from '@server/core/audit-redact';
import { createTestEnv, hasConfiguredTestDatabaseUrl } from './helpers';
import { defaultRepoConfig } from '@shared/schema';

// Pure, no-DB unit spec (mirrors test/dedup.spec.ts): ensemble voting is a deterministic
// function over run outputs, so every D-10/D-11/D-12 edge the cross-AI review flagged is pinned
// here against the REAL exported matcher — not a hand-crafted fixture string.

function finding(overrides: Partial<ParsedReviewComment> = {}): ParsedReviewComment {
  return {
    path: 'src/a.ts',
    line: 5,
    severity: 'P2',
    category: 'quality',
    title: 'null check on user id',
    body: 'default finding body text',
    ...overrides,
  };
}

function run(index: number, findings: ParsedReviewComment[]): EnsembleRun {
  return { runIndex: index, findings };
}

// ---------------------------------------------------------------------------
// matchCompositeRule is now an exported pure helper (Phase 19, D-11).
// ---------------------------------------------------------------------------

describe('matchCompositeRule (exported)', () => {
  it('returns null when no rule matches', () => {
    const a = finding({ title: 'completely unrelated title words', body: 'body alpha' });
    const b = finding({ path: 'src/other.ts', title: 'totally different words here', body: 'body beta' });
    expect(matchCompositeRule(a, b)).toBeNull();
  });

  it('returns a CompositeMatch-shaped object with the rule and similarity scores', () => {
    const a = finding({ path: 'src/a.ts', line: 5, title: 'null check on user id' });
    const b = finding({ path: 'src/a.ts', line: 5, title: 'null check user identifier' });
    const match: CompositeMatch | null = matchCompositeRule(a, b);
    expect(match).not.toBeNull();
    expect(match!.rule).toBe('rule1');
    expect(match!.titleSimilarity === null || typeof match!.titleSimilarity === 'number').toBe(true);
    expect(match!.bodySimilarity === null || typeof match!.bodySimilarity === 'number').toBe(true);
  });
});

// ---------------------------------------------------------------------------
// clusterEnsembleRuns: D-11 — Phase-14 composite dedup vocabulary + one vote per run.
// ---------------------------------------------------------------------------

describe('clusterEnsembleRuns', () => {
  it('produces one cluster per unique finding, each with one vote from the run it came from', () => {
    const r0 = run(0, [finding({ line: 5 })]);
    const r1 = run(1, [finding({ line: 5 })]);
    const result = clusterEnsembleRuns([r0, r1]);
    expect(result.clusters).toHaveLength(1);
    expect(result.clusters[0].voters).toEqual([0, 1]);
  });

  it('two distinct findings on the same file form two clusters', () => {
    const r0 = run(0, [finding({ line: 5, title: 'null check on user id' }), finding({ line: 20, title: 'unhandled rejection path' })]);
    const r1 = run(1, [finding({ line: 5, title: 'null check on user id' }), finding({ line: 20, title: 'unhandled rejection path' })]);
    const result = clusterEnsembleRuns([r0, r1]);
    expect(result.clusters).toHaveLength(2);
    for (const cluster of result.clusters) {
      expect(cluster.voters.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('limits a single run to one vote per cluster even when it casts multiple near-duplicates', () => {
    // Both findings on r0 collapse into one cluster against r1's one finding -> only ONE vote from r0.
    const r0 = run(0, [
      finding({ line: 5, title: 'null check on user id' }),
      finding({ line: 6, title: 'null check user identifier' }),
    ]);
    const r1 = run(1, [finding({ line: 5, title: 'null check on user id' })]);
    const result = clusterEnsembleRuns([r0, r1]);
    const cluster = result.clusters.find((c) => c.voters.includes(0));
    expect(cluster).toBeDefined();
    expect(cluster!.voters).toEqual([0, 1]);
  });

  it('cluster ids are deterministic for identical inputs', () => {
    const runs = [run(0, [finding({ line: 5 })]), run(1, [finding({ line: 5 })])];
    const a = clusterEnsembleRuns(runs);
    const b = clusterEnsembleRuns(runs);
    expect(a.clusters[0].id).toBe(b.clusters[0].id);
  });
});

// ---------------------------------------------------------------------------
// pickClusterRepresentative: D-12 — primary-first, then severity/confidence/stable-first.
// ---------------------------------------------------------------------------

describe('pickClusterRepresentative', () => {
  it('returns the primary-run finding when the primary belongs to the cluster', () => {
    const primaryFinding = finding({ line: 5, title: 'null check on user id', severity: 'P3' });
    const extraFinding = finding({ line: 5, title: 'null check on user id', severity: 'P0' });
    const cluster = {
      id: 'c1',
      voters: [0, 1],
      members: [
        { finding: primaryFinding, sourceRun: 0 },
        { finding: extraFinding, sourceRun: 1 },
      ],
    };
    expect(pickClusterRepresentative(cluster, 0)).toBe(primaryFinding);
  });

  it('falls back to severity/confidence/stable-first when the primary is not in the cluster', () => {
    const extraFindingA = finding({ line: 5, title: 'null check on user id', severity: 'P1', confidence: 0.9, body: 'a' });
    const extraFindingB = finding({ line: 5, title: 'null check on user id', severity: 'P0', confidence: null, body: 'b' });
    const primaryFinding = finding({ line: 5, title: 'unrelated primary', severity: 'P3' });
    const cluster = {
      id: 'c1',
      voters: [1, 2],
      members: [
        { finding: extraFindingA, sourceRun: 1 },
        { finding: extraFindingB, sourceRun: 2 },
      ],
    };
    // P0 wins over P1 (even with lower confidence, since null ranks -1 < 0.9) — actual pick is severity-first.
    expect(pickClusterRepresentative(cluster, 0)).toBe(extraFindingB);
    expect(pickClusterRepresentative(cluster, 0)).not.toBe(primaryFinding);
  });

  it('breaks equal-severity ties by higher confidence then stable-first', () => {
    const a = finding({ line: 5, title: 'null check on user id', severity: 'P2', confidence: 0.5, body: 'first' });
    const b = finding({ line: 5, title: 'null check on user id', severity: 'P2', confidence: 0.5, body: 'second' });
    const c = finding({ line: 5, title: 'null check on user id', severity: 'P2', confidence: 0.9, body: 'third' });
    const cluster = {
      id: 'c1',
      voters: [1, 2],
      members: [
        { finding: a, sourceRun: 1 },
        { finding: b, sourceRun: 2 },
        { finding: c, sourceRun: 3 },
      ],
    };
    // Highest confidence wins: c.
    expect(pickClusterRepresentative(cluster, 0)).toBe(c);
  });
});

// ---------------------------------------------------------------------------
// reconcileEnsembleRuns: D-10 — strict majority over successful runs only.
// ---------------------------------------------------------------------------

describe('reconcileEnsembleRuns', () => {
  it('returns zero winners and drops everything when only one run is successful (D-13 — runs:1 inert path)', () => {
    const r0 = run(0, [finding({ line: 5 })]);
    const result = reconcileEnsembleRuns([r0]);
    expect(result.winners).toEqual([]);
    expect(result.droppedClusters).toHaveLength(1);
    expect(result.successfulRuns).toBe(1);
    expect(result.failedRuns).toBe(0);
  });

  it('rejects 2-of-4 (does NOT exceed half of 4) and accepts 3-of-4', () => {
    const r0 = run(0, [finding({ line: 5, title: 'null check on user id' })]);
    const r1 = run(1, [finding({ line: 5, title: 'null check on user id' })]);
    const r2 = run(2, [finding({ line: 5, title: 'null check on user id' })]);
    const r3 = run(3, [finding({ line: 5, category: 'bugs', title: 'unrelated other concern' })]);
    const result = reconcileEnsembleRuns([r0, r1, r2, r3]);
    // "null check" cluster has 3 of 4 votes -> strictly greater than 2 -> wins.
    expect(result.winners).toHaveLength(1);
    // r3's unrelated finding forms its own cluster with 1 voter -> loses -> dropped.
    expect(result.droppedClusters).toHaveLength(1);
    expect(result.successfulRuns).toBe(4);
    expect(result.failedRuns).toBe(0);
  });

  it('drops 2-of-3 only when the cluster has fewer than half+1 votes', () => {
    const r0 = run(0, [finding({ line: 5, title: 'null check on user id' })]);
    const r1 = run(1, [finding({ line: 5, title: 'null check on user id' })]);
    const r2 = run(2, [finding({ line: 5, category: 'bugs', title: 'something completely different here' })]);
    const result = reconcileEnsembleRuns([r0, r1, r2]);
    // 2 of 3 successful -> strictly greater than 1.5 -> wins.
    expect(result.winners).toHaveLength(1);
    // r2's unrelated finding forms its own cluster with 1 voter -> loses -> dropped.
    expect(result.droppedClusters).toHaveLength(1);
  });

  it('removes failed runs from the denominator (D-10)', () => {
    const r0 = run(0, [finding({ line: 5, title: 'null check on user id' })]);
    const r1 = run(1, [finding({ line: 5, title: 'null check on user id' })]);
    const r2Failed = { runIndex: 2, findings: [], failed: true as const, reason: 'transient' };
    const r3 = run(3, [finding({ line: 5, category: 'bugs', title: 'unrelated concern other words here' })]);
    // Successful: r0, r1, r3 -> denominator is 3. "null check" cluster has 2 votes -> > 1.5 -> wins.
    const result = reconcileEnsembleRuns([r0, r1, r2Failed, r3]);
    expect(result.successfulRuns).toBe(3);
    expect(result.failedRuns).toBe(1);
    expect(result.winners).toHaveLength(1);
  });

  it('drops a cluster when only 1 of 4 successful runs casts a vote', () => {
    // Use entirely disjoint findings (different paths AND different titles) so every cluster has
    // exactly 1 voter; with successfulRuns=4 the threshold is 2 -> all clusters are dropped.
    const r0 = run(0, [finding({ path: 'src/a.ts', line: 5, title: 'null check on user id' })]);
    const r1 = run(1, [finding({ path: 'src/b.ts', line: 1, category: 'bugs', title: 'totally unrelated beta' })]);
    const r2 = run(2, [finding({ path: 'src/c.ts', line: 1, category: 'bugs', title: 'totally unrelated gamma' })]);
    const r3 = run(3, [finding({ path: 'src/d.ts', line: 1, category: 'bugs', title: 'totally unrelated delta' })]);
    const result = reconcileEnsembleRuns([r0, r1, r2, r3]);
    expect(result.winners).toEqual([]);
    expect(result.droppedClusters.length).toBe(4);
  });

  it('zero successful runs yields zero winners (not a winner from a single primary)', () => {
    const r0Failed = { runIndex: 0, findings: [], failed: true as const, reason: 'boom' };
    const r1Failed = { runIndex: 1, findings: [], failed: true as const, reason: 'boom' };
    const result = reconcileEnsembleRuns([r0Failed, r1Failed]);
    expect(result.winners).toEqual([]);
    expect(result.successfulRuns).toBe(0);
    expect(result.failedRuns).toBe(2);
  });

  it('one successful run degrades to that run output verbatim (D-10 explicit)', () => {
    const r0Failed = { runIndex: 0, findings: [], failed: true as const, reason: 'transient' };
    const r1 = run(1, [finding({ line: 5, title: 'null check on user id' })]);
    const result = reconcileEnsembleRuns([r0Failed, r1]);
    // With successfulRuns == 1 the existing per-file degradation path runs; reconcile reports the
    // primary finding as a candidate but does NOT classify it as a winner (D-10 strict-majority).
    expect(result.winners).toEqual([]);
    expect(result.successfulRuns).toBe(1);
  });

  it('produces exactly one representative finding per winning cluster (D-12)', () => {
    const r0 = run(0, [finding({ line: 5, title: 'null check on user id', severity: 'P2', confidence: 0.6 })]);
    const r1 = run(1, [finding({ line: 5, title: 'null check user identifier', severity: 'P0', confidence: 0.9 })]);
    const r2 = run(2, [finding({ line: 5, title: 'null pointer check on user', severity: 'P1', confidence: 0.7 })]);
    const result = reconcileEnsembleRuns([r0, r1, r2]);
    expect(result.winners).toHaveLength(1);
    expect(result.droppedClusters).toHaveLength(0);
  });

  it('uses the primary-run finding verbatim when the primary belongs to the winning cluster', () => {
    const primary = finding({ line: 5, title: 'null check on user id', severity: 'P3', body: 'primary body text' });
    const extra = finding({ line: 5, title: 'null check user identifier', severity: 'P0', body: 'extra body text' });
    const r0 = run(0, [primary]);
    const r1 = run(1, [extra]);
    const r2 = run(2, [extra]);
    const result = reconcileEnsembleRuns([r0, r1, r2]);
    expect(result.winners).toHaveLength(1);
    expect(result.winners[0].finding).toBe(primary);
  });
});

// ---------------------------------------------------------------------------
// buildEnsembleVoteAuditEvent: bounded audit projection (T-19-05-01 / D-12).
// ---------------------------------------------------------------------------

describe('buildEnsembleVoteAuditEvent', () => {
  it('returns a null event when runs is 1 (D-13 inert — never emit ensemble audit)', () => {
    const r0 = run(0, [finding({ line: 5 })]);
    const result = reconcileEnsembleRuns([r0]);
    const event = buildEnsembleVoteAuditEvent('src/a.ts', result);
    expect(event).toBeNull();
  });

  it('emits one bounded event with winner + dropped samples and reason list', () => {
    const r0 = run(0, [finding({ line: 5, title: 'null check on user id' })]);
    const r1 = run(1, [finding({ line: 5, title: 'null check on user id' })]);
    const r2 = run(2, [finding({ line: 5, category: 'bugs', title: 'unrelated concern alpha beta' })]);
    const result = reconcileEnsembleRuns([r0, r1, r2]);
    const event = buildEnsembleVoteAuditEvent('src/a.ts', result, ['timeout']);
    expect(event).not.toBeNull();
    expect(event!.stage).toBe('ensemble.voted');
    expect(event!.successfulRuns).toBe(3);
    expect(event!.winnerCount).toBe(1);
    expect(event!.winningSample).toHaveLength(1);
    expect(event!.winningSample[0].votes).toBe(2);
    expect(event!.failedRunReasons).toEqual(['timeout']);
  });

  it('caps the winningSample at 20 entries even when many clusters win', () => {
    // Build many distinct clusters so they all win.
    const findings = Array.from({ length: 30 }, (_, i) =>
      finding({ line: i + 1, title: `distinct concern ${i} alpha beta gamma delta epsilon` }),
    );
    const r0 = run(0, findings);
    const r1 = run(1, findings);
    const r2 = run(2, findings);
    const result = reconcileEnsembleRuns([r0, r1, r2]);
    expect(result.winners.length).toBeGreaterThan(20);
    const event = buildEnsembleVoteAuditEvent('src/a.ts', result);
    expect(event!.winningSample.length).toBeLessThanOrEqual(20);
  });

  it('caps the droppedSample at 20 entries even when many clusters lose', () => {
    // Build 30 distinct losers.
    const findings = Array.from({ length: 30 }, (_, i) =>
      finding({ line: i + 1, title: `loser concern ${i} alpha beta gamma delta epsilon` }),
    );
    const r0 = run(0, findings);
    const r1 = run(1, []); // empty extra -> every cluster has 1 of 2 -> loses
    const result = reconcileEnsembleRuns([r0, r1]);
    expect(result.droppedClusters.length).toBeGreaterThan(0);
    const event = buildEnsembleVoteAuditEvent('src/a.ts', result);
    expect(event!.droppedSample.length).toBeLessThanOrEqual(20);
  });

  it('emits failed-run reasons without raw provider response bodies', () => {
    const r0Failed = { runIndex: 0, findings: [], failed: true as const, reason: 'timeout' };
    const r1 = run(1, [finding({ line: 5, title: 'null check on user id' })]);
    const r2 = run(2, [finding({ line: 5, title: 'null check on user id' })]);
    const result = reconcileEnsembleRuns([r0Failed, r1, r2]);
    const event = buildEnsembleVoteAuditEvent('src/a.ts', result, ['timeout']);
    expect(event!.failedRuns).toBe(1);
    expect(event!.failedRunReasons).toBeDefined();
    expect(event!.failedRunReasons!.length).toBe(1);
    expect(event!.failedRunReasons![0]).toBe('timeout');
  });
});

// ---------------------------------------------------------------------------
// recordEnsembleAudit best-effort recorder (T-19-05-01 / D-12). Mirrors the
// recordRoundAudit / recordVerifyFixesAudit / recordUnitAudit shape:
//   - appends every event in ONE call (no per-event recapture)
//   - never throws — a broken append resolves undefined and logs warn
//   - empty input is a no-op (zero Phase-19 events for the inert runs:1 path)
// ---------------------------------------------------------------------------

const dbDescribe = hasConfiguredTestDatabaseUrl() ? describe : describe.skip;

const recorderJob = {
  installationId: '123',
  owner: 'test-owner',
  prTitle: 'Ensemble audit',
  prAuthor: 'author',
  trigger: 'auto' as const,
  headRef: 'feature',
  baseRef: 'main',
  configSnapshot: defaultRepoConfig,
};

let prCounter = 0;
async function freshRecorderJob(env: ReturnType<typeof createTestEnv>, label: string) {
  prCounter += 1;
  return insertJob(env, {
    ...recorderJob,
    repo: `test-repo-${Date.now()}-ensemble-${label}-${prCounter}`,
    prNumber: prCounter,
    commitSha: 'a'.repeat(40),
    baseSha: '0'.repeat(40),
  });
}

dbDescribe('recordEnsembleAudit best-effort recorder (T-19-05-01)', () => {
  const env = createTestEnv();

  it('FAILED-WRITE: recordEnsembleAudit resolves (never throws) and warns when appendJobAuditEvents rejects', async () => {
    const job = await freshRecorderJob(env, 'failed-write');
    const appendSpy = vi
      .spyOn(jobsModule, 'appendJobAuditEvents')
      .mockRejectedValue(new Error('simulated audit-write failure'));
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    await expect(recordEnsembleAudit(env, job.id, [
      {
        stage: 'ensemble.voted',
        file: 'src/a.ts',
        requestedRuns: 3,
        successfulRuns: 3,
        failedRuns: 0,
        winnerCount: 0,
        droppedClusterCount: 0,
        winningSample: [],
        droppedSample: [],
        timestamp: new Date().toISOString(),
      },
    ])).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
    appendSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('EMPTY-INPUT: recordEnsembleAudit is a no-op and never calls appendJobAuditEvents', async () => {
    const job = await freshRecorderJob(env, 'empty');
    const appendSpy = vi.spyOn(jobsModule, 'appendJobAuditEvents');
    await recordEnsembleAudit(env, job.id, []);
    expect(appendSpy).not.toHaveBeenCalled();
    appendSpy.mockRestore();
  });

  it('SUCCESS: one ensemble event is appended with the privacy-bounded sample shape', async () => {
    const job = await freshRecorderJob(env, 'success');
    const r0 = run(0, [finding({ line: 5, title: 'null check on user id' })]);
    const r1 = run(1, [finding({ line: 5, title: 'null check on user id' })]);
    const r2 = run(2, [finding({ line: 5, category: 'bugs', title: 'unrelated concern alpha beta' })]);
    const reconciliation = reconcileEnsembleRuns([r0, r1, r2]);
    const event = buildEnsembleVoteAuditEvent('src/a.ts', reconciliation, ['timeout']);
    expect(event).not.toBeNull();
    await recordEnsembleAudit(env, job.id, [event!]);
    const detail = await getJobDetail(env, job.id);
    expect(detail).not.toBeNull();
    expect(detail!.audit).toHaveLength(1);
    expect(detail!.audit[0].stage).toBe('ensemble.voted');
    const audited = detail!.audit[0] as Extract<NonNullable<typeof detail>['audit'][0], { stage: 'ensemble.voted' }>;
    expect(audited.winnerCount).toBe(1);
    expect(audited.winningSample).toHaveLength(1);
    expect(audited.winningSample[0].title).toBe('[title-redacted]');
  });

  it('BLOCKER 1 (D-06): winningSample and droppedSample titles use the fixed marker', () => {
    const sensitiveTitle = 'token ensemble-secret';
    const r0 = run(0, [finding({ line: 5, title: sensitiveTitle })]);
    const r1 = run(1, [finding({ line: 5, title: sensitiveTitle })]);
    const r2 = run(2, [finding({ line: 10, category: 'bugs', title: sensitiveTitle })]);
    const reconciliation = reconcileEnsembleRuns([r0, r1, r2]);
    const event = buildEnsembleVoteAuditEvent('src/a.ts', reconciliation, []);
    expect(event).not.toBeNull();
    for (const sample of [...event!.winningSample, ...event!.droppedSample]) {
      expect(sample.title).toBe('[title-redacted]');
      expect(sample.title).not.toContain(sensitiveTitle);
    }
  });

  it('BLOCKER 1 (D-07): failedRunReasons carries only machine-enum codes, never raw Error.message', () => {
    // The ensemble failedRunReasons derivation in services/model.ts now routes the rejected
    // reason through redactErrorMessage, which returns one of 5 MACHINE_ERROR_REASONS codes.
    // A raw Error.message('Some arbitrary provider 5xx error text here') must NOT propagate
    // to the audit event — the persisted reason is the machine-enum code.
    const rawMessage = 'Some arbitrary provider 5xx error text here that should never leak';
    const r0 = run(0, [finding({ line: 5, title: 'null check on user id' })]);
    const r1 = run(1, [finding({ line: 5, title: 'null check on user id' })]);
    const reconciliation = reconcileEnsembleRuns([r0, r1]);
    // The reconciliation result is non-trivial — we accept a non-empty sample.
    const failedReasons = [redactErrorMessage(rawMessage)];
    const event = buildEnsembleVoteAuditEvent('src/a.ts', reconciliation, failedReasons);
    expect(event).not.toBeNull();
    for (const reason of event!.failedRunReasons ?? []) {
      expect(MACHINE_ERROR_REASONS).toContain(reason);
      expect(reason).not.toBe(rawMessage);
    }
  });
});
