import type { ParsedReviewComment } from '@shared/schema';
import { matchCompositeRule, pickSurvivor, SEVERITY_RANK } from './dedup';

/**
 * Phase 19 (PASS-02) — deterministic ensemble voting.
 *
 * Pure, zero-I/O helpers that turn N ensemble runs (each a parsed main-pass result) into a
 * single consensus finding list. LOCKED semantics from D-10..D-12:
 *
 *   D-10: Failed ensemble calls are removed from the denominator. A finding wins when its vote
 *         count is strictly greater than half of successful runs. One survivor degrades to that
 *         run's output; zero survivors follows the existing per-file failure/retry path.
 *   D-11: Findings across runs form vote clusters using the Phase-14 composite dedup vocabulary
 *         (`matchCompositeRule`), and each run contributes at most one vote to a cluster.
 *   D-12: A winning cluster uses the primary run's finding when the primary belongs to that
 *         cluster. If the winner exists only in extra runs, select its representative using the
 *         established severity → confidence → stable-first survivor ranking (`pickSurvivor`).
 *
 * This module is deliberately orchestration-free: budget scheduling, model fan-out, and the
 * `(file, 'security')` unit live in review.ts. The whole module is PURE — every export returns
 * derived data without touching env / db / network.
 */

// ---------------------------------------------------------------------------
// Run shape — typed once so the contract is obvious to every consumer.
// ---------------------------------------------------------------------------

export type EnsembleRun =
  | {
      runIndex: number;
      findings: ParsedReviewComment[];
      failed?: false;
      reason?: never;
    }
  | {
      runIndex: number;
      // failed runs always carry no findings; typed as a permissive readonly array so callers can
      // pass an object literal (`findings: []`) without a tuple-vs-never[] mismatch.
      findings: readonly ParsedReviewComment[];
      failed: true;
      reason: string;
    };

// ---------------------------------------------------------------------------
// Cluster shape — provenance tracked per member so D-12's primary-first rule is correct.
// ---------------------------------------------------------------------------

type ClusterMember = { finding: ParsedReviewComment; sourceRun: number };

export type EnsembleCluster = {
  id: string;
  voters: number[];
  members: ClusterMember[];
};

// ---------------------------------------------------------------------------
// Reconciliation output — winners carry cluster context so the audit builder is direct.
// ---------------------------------------------------------------------------

export type EnsembleWinner = {
  cluster: EnsembleCluster;
  finding: ParsedReviewComment;
};

export type EnsembleReconciliation = {
  successfulRuns: number;
  failedRuns: number;
  clusters: EnsembleCluster[];
  winners: EnsembleWinner[];
  droppedClusters: EnsembleCluster[];
};

// ---------------------------------------------------------------------------
// Audit projection — the builder lives in audit.ts (matches the `buildFinalizeDropEvents` /
// `buildFileSkipEvents` convention). The reconciliation output type is exported so callers can
// thread it through without re-importing the audit builder.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// D-11: cluster each run's findings using the Phase-14 composite matcher.
// ---------------------------------------------------------------------------

/**
 * D-11: cluster each run's findings against the already-clustered members using the Phase-14
 * 4-rule composite matcher (`matchCompositeRule`). A run contributes AT MOST ONE vote per
 * cluster (T-19-05-01 vote stuffing mitigation). The cluster id is deterministic for identical
 * inputs so re-running the same reconciliation produces byte-identical audit samples.
 *
 * Clusters are built greedy in stable run order: run 0 establishes its findings as the first
 * clusters, then each subsequent run either casts a vote on an existing cluster (one per run
 * max) or opens a new cluster for each of its otherwise-unmatched findings. This mirrors the
 * `dedupeComposite` strategy.
 */
export function clusterEnsembleRuns(runs: EnsembleRun[]): { clusters: EnsembleCluster[] } {
  const clusters: EnsembleCluster[] = [];

  for (const run of runs) {
    if (run.failed) continue;
    // T-19-05-01: a single run contributes AT MOST ONE vote per cluster. Track every cluster index
    // this run touches — both matched and freshly created — so the inner match loop cannot pick a
    // cluster that already holds a vote from this same run (vote-stuffing mitigation).
    const usedInThisRun = new Set<number>();

    for (const finding of run.findings) {
      let matchedIndex = -1;
      for (let i = 0; i < clusters.length; i++) {
        if (usedInThisRun.has(i)) continue;
        const existing = clusters[i].members;
        let member = false;
        for (const m of existing) {
          if (matchCompositeRule(m.finding, finding) !== null) {
            member = true;
            break;
          }
        }
        if (member) {
          matchedIndex = i;
          break;
        }
      }

      if (matchedIndex >= 0) {
        clusters[matchedIndex].voters.push(run.runIndex);
        clusters[matchedIndex].members.push({ finding, sourceRun: run.runIndex });
        usedInThisRun.add(matchedIndex);
      } else {
        const newIndex = clusters.length;
        const id = buildClusterId(newIndex, run.runIndex, finding);
        clusters.push({
          id,
          voters: [run.runIndex],
          members: [{ finding, sourceRun: run.runIndex }],
        });
        usedInThisRun.add(newIndex);
      }
    }
  }

  return { clusters };
}

// ---------------------------------------------------------------------------
// D-12: representative selection (primary-first, then severity/confidence/stable-first).
// ---------------------------------------------------------------------------

/**
 * D-12: pick the single representative finding for one cluster. Primary-first — when the
 * primary run's finding is part of the cluster we keep that exact object reference (no synthesis
 * rewrite per D-12). Otherwise we fall back to the established severity → confidence →
 * stable-first ranking used by `pickSurvivor`.
 */
export function pickClusterRepresentative(
  cluster: EnsembleCluster,
  primaryRunIndex: number,
): ParsedReviewComment {
  // Primary-first short-circuit: if the primary run voted in this cluster, return that exact
  // finding (no rewrite). The primary's finding object is preserved by reference.
  const primaryMember = cluster.members.find((m) => m.sourceRun === primaryRunIndex);
  if (primaryMember) return primaryMember.finding;

  // Fallback: severity → confidence → stable-first via pickSurvivor seeded with the first member.
  let rep = cluster.members[0].finding;
  for (let i = 1; i < cluster.members.length; i++) {
    rep = pickSurvivor(rep, cluster.members[i].finding);
  }
  return rep;
}

// ---------------------------------------------------------------------------
// D-10 / D-11 / D-12: full reconciliation.
// ---------------------------------------------------------------------------

/**
 * D-10 / D-11 / D-12: full reconciliation. Returns the winning findings (each paired with its
 * cluster for audit projection), dropped clusters, and canonical run counts. Pure: identical
 * inputs produce identical outputs.
 *
 * Strict majority is `votes > successfulRuns / 2`. With one successful run, NO cluster can
 * strictly exceed half (0.5), so the result is empty and the caller follows the per-file
 * degrade-to-primary path; with zero successful runs the empty result signals the per-file
 * failure/retry path.
 */
export function reconcileEnsembleRuns(runs: EnsembleRun[]): EnsembleReconciliation {
  const successfulRuns = runs.filter((r) => !r.failed).length;
  const failedRuns = runs.length - successfulRuns;

  const { clusters } = clusterEnsembleRuns(runs);

  const winners: EnsembleWinner[] = [];
  const droppedClusters: EnsembleCluster[] = [];

  // D-10: with successfulRuns <= 1 there is no majority to compute — the caller falls back to the
  // per-file degrade-to-primary (one survivor) or failure/retry (zero survivors) path, and
  // reconcile must NOT classify any cluster as a winner. Strict majority `votes > successfulRuns / 2`
  // alone would technically classify a single successful run's cluster as a winner (1 > 0.5), but
  // D-10 explicitly reserves that case for degradation.
  if (successfulRuns >= 2) {
    for (const cluster of clusters) {
      const votes = cluster.voters.length;
      if (votes > successfulRuns / 2) {
        // D-12: representative selection (primary-first, then severity/confidence/stable-first).
        winners.push({ cluster, finding: pickClusterRepresentative(cluster, /* primaryRunIndex */ 0) });
      } else {
        droppedClusters.push(cluster);
      }
    }
  } else {
    // All clusters from a single (or zero) successful run fall through as dropped — the caller
    // reads `successfulRuns` to decide whether to degrade to that run's output or to fail the file.
    for (const cluster of clusters) {
      droppedClusters.push(cluster);
    }
  }

  return { successfulRuns, failedRuns, clusters, winners, droppedClusters };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Deterministic cluster id. Combines the cluster's stable index with the run index and the
 * finding's path/line so two reconciliations of identical inputs produce identical ids. Used by
 * the audit projection so re-runs are byte-comparable. (The 100-char cap matches the
 * `jobAuditEventSchema` 'ensemble.voted'.winningSample[].clusterId` constraint.)
 */
function buildClusterId(clusterIndex: number, runIndex: number, finding: ParsedReviewComment): string {
  const linePart = finding.line ?? 'null';
  return `c${clusterIndex}-r${runIndex}-${finding.path}:${linePart}`.slice(0, 100);
}

// Re-export so downstream call sites can `import { SEVERITY_RANK } from '@server/core/ensemble'`
// if they only consume the ensemble helpers (D-11/D-12 reference this constant in comments).
export { SEVERITY_RANK };
