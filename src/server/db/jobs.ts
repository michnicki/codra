import type { AppBindings } from '@server/env';
import { parseJsonColumn, queryRows } from './client';
import { criticResultSchema, defaultRepoConfig, jobAuditEventSchema, jobDetailSchema, jobSummarySchema, repoConfigSchema, type CriticResult, type JobAuditEvent, type RepoConfig } from '@shared/schema';
import { logger } from '@server/core/logger';
import { getOrCreateRepository } from './repositories';

export type JobRow = {
  id: string;
  workflow_instance_id: string | null;
  // REV-C-3 / R-01: nullable so Bitbucket rows (which carry no installation_id after migration 005)
  // map to `installationId: null` on the JobSummary without throwing. GitHub rows continue to
  // carry a non-null string; the byte-identity guarantee for the GitHub call chain is preserved.
  installation_id: string | null;
  owner: string;
  repo: string;
  pr_number: number;
  pr_title: string | null;
  pr_author: string | null;
  commit_sha: ByteaValue;
  base_sha: ByteaValue;
  trigger: 'auto' | 'mention' | 'retry';
  status: 'queued' | 'running' | 'done' | 'failed' | 'superseded' | 'cancelled' | 'stopped';
  config_snapshot: { review?: RepoConfig['review']; model?: RepoConfig['model'] } | string | null;
  check_run_id: number | null;
  check_run_completed_at: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  lease_owner: string | null;
  lease_expires_at: string | null;
  heartbeat_at: string | null;
  recovery_count: number | null;
  continuation_count: number | null;
  last_queue_message_at: string | null;
  total_input_tokens: number | null;
  total_output_tokens: number | null;
  verdict: 'approve' | 'comment' | null;
  file_count: number | null;
  comment_count: number | null;
  error_msg: string | null;
  head_ref: string | null;
  base_ref: string | null;
  summary_markdown: string | null;
  review_id: number | null;
  retry_of_job_id: string | null;
  summary_model: string | null;
  overall_confidence_score: number | null;
  overall_correctness: string | null;
  steps: JobStep[] | string | null;
  // R-01: exposed on the row so mapJob can publish repositoryVcsProvider / repositoryWorkspace on
  // the JobSummary without a separate query (VcsService.forRepo reads it in Wave 2).
  repositoryVcsProvider: string;
  repositoryWorkspace: string | null;
  // REV-R-E: pass-through for the status_check_ref column. The DB column was added in migration
  // 003; this is the first row-type exposure so mapJob can surface it on the JobSummary and
  // updateJobStatusCheckRef can write it without Number(ref) coercion.
  status_check_ref: string | null;
  // Pattern 5 (status_check_ref precedent): pass-through for the migration-007 jobs columns.
  // Both are NULLABLE and NOT written by insertJob's explicit column list, so every existing
  // insert reads them back as null (behaviorally inert). walkthrough_comment_ref is the Phase 9
  // streamed-walkthrough comment ref (opaque VCS ref, TEXT); critic_result is the Phase 10 critic
  // pass result, stored JSONB -- parsed on read via parseJsonColumn and validated against
  // criticResultSchema. In Phase 7 no writer is wired, so critic_result is always null.
  walkthrough_comment_ref: string | null;
  critic_result: CriticResult | string | null;
  // Phase 11 (migration 009, REVIEW: Codex 11-05 HIGH): durable review-rest scope. Both NULLABLE and
  // NOT written by insertJob's explicit column list unless a caller supplies them, so every existing
  // insert reads them back as null (behaviorally inert, NREG-01). review_scope mirrors
  // reviewJobMessageSchema.reviewScope ('all'|'rest'|'head'); scope_source_job_id links a review-rest
  // job back to the original full-review job whose skips it re-reviews. They flow in via the SELECT
  // j.* / SELECT i.* the existing accessors already use.
  review_scope: 'all' | 'rest' | 'head' | null;
  scope_source_job_id: string | null;
  // Phase 13 (migration 010, AUD-01): durable per-job audit trail. Both NULLABLE / defaulted and NOT
  // written by insertJob's explicit column list, so every existing insert reads them back inert
  // (audit === NULL, audit_truncated === false) until appendJobAuditEvents runs (NREG-01). `audit` is
  // a raw JSONB array parsed on read; the per-element parse + exposure lives in getJobDetail ONLY
  // (D-11 — never on mapJob's summary/lease-claim hot path). `audit_truncated` is the ring-buffer
  // eviction flag set by appendJobAuditEvents when the 500-event cap trims the oldest entries.
  audit: unknown;
  audit_truncated: boolean | null;
  // Phase 18 (migration 011, RND-01 / D-02 / D-16 widened): durable round/mode snapshot persisted
  // by the prepare-time round detection (Phase 18 Plan 02). review_round is the resolved round
  // (>= 1); review_mode is the selected diff source ('full' | 'incremental' | 'fallback' |
  // 'no_changes' | 'rest'). Both NULLABLE because Plan 01 has no writer wired and Phase 18 Plan 02
  // populates them on the prepare-phase path. rounds_incremental is the durable snapshot of
  // config.review.rounds.incremental at insert time — NOT NULL DEFAULT false in the DB.
  review_round: number | null;
  review_mode: string | null;
  rounds_incremental: boolean;
  // Phase 18 (migration 012, RND-02 / D-08 widened): the immutable diff-selection descriptor.
  // rounds_from_sha is the prepare-time anchor SHA (the prior PR head, or '' for full / rest).
  // rounds_to_sha is the prepare-time head SHA captured BEFORE the review started — finalize
  // never anchors a freshly-fetched live head. Both NULLABLE so pre-Phase-18 rows read back
  // without throwing, and the consumer helpers treat NULL as "no descriptor recorded" (the
  // existing full-diff path stays byte-identical, NREG-01).
  rounds_from_sha: string | null;
  rounds_to_sha: string | null;
};

type JobStep = {
  name: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  startedAt: string | null;
  finishedAt: string | null;
  error?: string | null;
};

type JobDetailRow = JobRow & {
  files_json: unknown[] | string | null;
};

type ByteaValue = ArrayBuffer | ArrayBufferView | string;

export type JobLeaseClaim =
  | { status: 'claimed'; row: JobRow }
  | { status: 'busy'; row: JobRow; retryAfterSeconds: number }
  | { status: 'terminal'; row: JobRow }
  | { status: 'missing' };

export function hexToBytes(hex: string) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

export function bytesToHex(value: ByteaValue) {
  if (typeof value === 'string') {
    return value.startsWith('\\x') ? value.slice(2).toLowerCase() : value.toLowerCase();
  }

  const bytes = ArrayBuffer.isView(value)
    ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    : new Uint8Array(value);

  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function latestTimestamp(...values: Array<string | null | undefined>) {
  const now = Date.now();
  return values.reduce<string | null>((latest, value) => {
    if (!value) return latest;
    if (new Date(value).getTime() > now) return latest;
    if (!latest) return value;
    return new Date(value).getTime() > new Date(latest).getTime() ? value : latest;
  }, null);
}

export function mapJob(row: JobRow) {
  const lastQueueMessageAt = row.last_queue_message_at ? new Date(row.last_queue_message_at).getTime() : null;
  const nextRetryAt =
    row.status === 'running' &&
    row.lease_owner === null &&
    lastQueueMessageAt !== null &&
    Number.isFinite(lastQueueMessageAt) &&
    lastQueueMessageAt > Date.now()
      ? row.last_queue_message_at
      : null;
  const updatedAt = latestTimestamp(
    row.created_at,
    row.started_at,
    row.finished_at,
    row.heartbeat_at,
    row.last_queue_message_at,
  ) ?? row.created_at;

  // WR-01: fail-soft the critic_result read. mapJob is on every hot read path (listJobs,
  // getJobDetail, the runReviewJob claim). Once Phase 10 persists LLM-derived critic output into
  // this JSONB column, a single malformed blob (or a finding missing a required field) would make
  // the strict jobSummarySchema.parse THROW and fail the ENTIRE job-list page / detail read / job
  // claim -- not just this field. Validate it out-of-band with safeParse and degrade a bad blob to
  // null (logged) rather than poisoning the whole row parse. critic_result is always null in Phase
  // 7 (no writer wired), so this stays behaviorally inert until a writer lands.
  const rawCritic = parseJsonColumn<unknown>(row.critic_result, null);
  const criticParsed = rawCritic === null ? null : criticResultSchema.safeParse(rawCritic);
  let criticResult: CriticResult | null = null;
  if (criticParsed !== null) {
    if (criticParsed.success) {
      criticResult = criticParsed.data;
    } else {
      logger.warn(`Ignoring unparseable critic_result for job ${row.id}`);
    }
  }

  return jobSummarySchema.parse({
    id: row.id,
    owner: row.owner,
    repo: row.repo,
    // REV-C-3: Bitbucket rows have installation_id === null (no GitHub-App-equivalent numeric id).
    // The schema's now-nullable `installationId` accepts it; GitHub rows continue to carry the
    // non-null string. This is the read-side companion to the getOrCreateRepository bitbucket
    // branch's bind-NULL write side.
    installationId: row.installation_id,
    prNumber: row.pr_number,
    prTitle: row.pr_title,
    prAuthor: row.pr_author,
    commitSha: bytesToHex(row.commit_sha),
    trigger: row.trigger,
    status: row.status,
    verdict: row.verdict,
    fileCount: row.file_count ?? 0,
    commentCount: row.comment_count ?? 0,
    totalInputTokens: row.total_input_tokens ?? 0,
    totalOutputTokens: row.total_output_tokens ?? 0,
    createdAt: row.created_at,
    updatedAt,
    nextRetryAt,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    errorMessage: row.error_msg,
    overallConfidenceScore: row.overall_confidence_score,
    overallCorrectness: row.overall_correctness,
    steps: parseJsonColumn(row.steps, []),
    checkRunId: row.check_run_id,
    configSnapshot: row.config_snapshot ? repoConfigSchema.parse(parseJsonColumn(row.config_snapshot, defaultRepoConfig)) : null,
    retryOfJobId: row.retry_of_job_id,
    workflowInstanceId: row.workflow_instance_id,
    // R-01: surface parent repository's provider + workspace so VcsService.forRepo can branch
    // without a separate query. Always present on the JobSummary now -- mapJob is the single
    // publisher; GitHub rows carry repositoryWorkspace=null, Bitbucket rows carry it.
    repositoryVcsProvider: row.repositoryVcsProvider,
    repositoryWorkspace: row.repositoryWorkspace,
    // REV-R-E: pass-through for jobs.status_check_ref (Bitbucket Code Insights report key /
    // generic status reference). Plan 03's runFinalizePhase gate reads it via this field.
    statusCheckRef: row.status_check_ref,
    // Pattern 5: publish the migration-007 jobs columns. walkthrough_comment_ref is a plain TEXT
    // ref; critic_result is JSONB, parsed on read (mirroring config_snapshot/steps) then validated
    // by jobSummarySchema against criticResultSchema. Both are null on every existing insert this
    // phase (no writer wired) -- additive, behaviorally inert.
    walkthroughCommentRef: row.walkthrough_comment_ref,
    // WR-01: pass the out-of-band-validated value (see above); a bad blob has already degraded to
    // null so the strict schema field never throws on the whole-row parse.
    criticResult,
    // Phase 11: surface the migration-009 review-rest scope columns. Both are null on every existing
    // insert (no writer supplies them) -- additive, behaviorally inert (NREG-01).
    reviewScope: row.review_scope,
    scopeSourceJobId: row.scope_source_job_id,
    // Phase 18 (RND-01 / D-02 / D-16 widened): surface the durable round/mode snapshot. reviewRound
    // and reviewMode are NULL until Phase 18 Plan 02 wires the prepare-time writer; roundsIncremental
    // is the durable config snapshot at insert time (NOT NULL DEFAULT false in the DB, so this
    // resolves to false for every pre-Phase-18 insert and every future insert where the config is
    // inert at the schema-default).
    reviewRound: row.review_round,
    reviewMode: row.review_mode,
    roundsIncremental: row.rounds_incremental,
    // Phase 18 (RND-02 / D-08, migration 012): surface the immutable diff-selection descriptor.
    // Both NULL when no descriptor was written (pre-Phase-18 rows + a fresh job whose prepare
    // phase hasn't run yet). The consumer helpers (getCachedRawDiff / runFinalizePhase's no_changes
    // branch) treat NULL as "no incremental selection recorded" and fall through to the existing
    // full-diff path (NREG-01).
    roundsFromSha: row.rounds_from_sha,
    roundsToSha: row.rounds_to_sha,
  });
}

export async function setJobWorkflowInstance(env: Pick<AppBindings, 'HYPERDRIVE'>, jobId: string, workflowInstanceId: string) {
  await queryRows(
    env,
    `
      UPDATE jobs
      SET workflow_instance_id = $2::uuid
      WHERE id = $1
    `,
    [jobId, workflowInstanceId],
  );
}

/**
 * Refresh a job's cached PR title/author from the live pull request. The values are snapshotted at
 * job-creation time (and copied verbatim onto retries), so a title edited on GitHub afterwards would
 * otherwise keep showing stale on the dashboard. Called during prepare once the PR is fetched.
 */
export async function setJobPullRequestMeta(
  env: Pick<AppBindings, 'HYPERDRIVE'>,
  jobId: string,
  meta: { prTitle: string | null; prAuthor: string | null },
) {
  await queryRows(
    env,
    `
      UPDATE jobs
      SET pr_title = $2,
          pr_author = COALESCE($3, pr_author)
      WHERE id = $1
    `,
    [jobId, meta.prTitle, meta.prAuthor],
  );
}

export async function markSystemActive(env: Pick<AppBindings, 'APP_KV'>) {
  try {
    // claimJobLease() calls this on every review chunk, so a single large PR (dozens of chunks) used
    // to issue dozens of identical KV writes -- enough to blow through the Workers-Free daily KV
    // write quota. KV reads are far cheaper and have a much higher quota, so read first and only
    // write when the flag is actually missing (expired, or the first job after an idle period). The
    // 20-minute TTL means an active job refreshes it at most ~once per 20 minutes, not per chunk.
    const existing = await env.APP_KV.get('system:active_jobs');
    if (existing) return;
    await env.APP_KV.put('system:active_jobs', '1', { expirationTtl: 20 * 60 });
  } catch (error) {
    // Ignore KV errors to avoid failing the DB transaction
  }
}

export async function clearSystemActive(env: Pick<AppBindings, 'APP_KV'>) {
  try {
    await env.APP_KV.delete('system:active_jobs');
  } catch (error) {
    // Best-effort: the 20-minute TTL on the flag is the backstop if this delete fails.
  }
}

/**
 * Whether the scheduled maintenance loop still has anything to do: any job that could still be
 * running/recoverable (queued/running) or any terminal job whose GitHub check run hasn't been
 * completed yet. When this is false the cron can clear the `system:active_jobs` flag so subsequent
 * ticks skip the DB entirely and the serverless Postgres is allowed to suspend.
 */
export async function hasPendingMaintenanceWork(env: Pick<AppBindings, 'HYPERDRIVE'>): Promise<boolean> {
  const rows = await queryRows<{ has_work: boolean }>(
    env,
    `
      SELECT EXISTS (
        SELECT 1 FROM jobs
        WHERE status IN ('queued', 'running')
           -- REV-M-8: OR status_check_ref IS NOT NULL widens the maintenance work predicate so
           -- Bitbucket jobs (which populate only status_check_ref, never check_run_id) keep
           -- the cron 'system:active_jobs' flag alive until the terminal reconciliation runs.
           OR (status IN ('done', 'failed', 'superseded', 'cancelled') AND (check_run_id IS NOT NULL OR status_check_ref IS NOT NULL) AND check_run_completed_at IS NULL)
      ) AS has_work
    `,
  );
  return rows[0]?.has_work === true;
}

export async function insertJob(
  env: Pick<AppBindings, 'HYPERDRIVE' | 'APP_KV'>,
  input: {
    // REV-C-3: nullable for the Bitbucket path (which passes `repositoryId` instead of
    // `installationId`). The GitHub path always passes a non-null string; the byte-identity
    // guarantee for the GitHub call chain is preserved because callers that pass a string still
    // pass a string.
    installationId: string | null;
    owner: string;
    repo: string;
    prNumber: number;
    prTitle: string | null;
    prAuthor: string | null;
    commitSha: string;
    baseSha: string;
    trigger: 'auto' | 'mention' | 'retry';
    headRef: string | null;
    baseRef: string | null;
    configSnapshot?: RepoConfig | null;
    retryOfJobId?: string | null;
    // REV-C-1 / REV-R-B: provider-aware repository resolution. When `repositoryId` is supplied
    // (the Bitbucket route passes the id resolved by findRepositoryByBitbucketIdentity),
    // getOrCreateRepository is BYPASSED entirely so the bitbucket branch's NULL installation_id
    // binding is never touched and the row's existing installation_id stays NULL. The GitHub
    // path (no repositoryId, no vcsProvider/workspace) continues to call getOrCreateRepository
    // with the existing (installationId, owner, repo) shape byte-identically (D-02 byte-identity).
    repositoryId?: number;
    vcsProvider?: 'github' | 'bitbucket' | string;
    workspace?: string | null;
    // Phase 11 (REVIEW: Codex 11-05 HIGH): optional review-rest scope persisted on the job row.
    // Omitted by every existing caller -> bound as NULL -> byte-identical inserts (NREG-01). A
    // review-rest job passes reviewScope:'rest' + scopeSourceJobId = the original full-review job id.
    reviewScope?: 'all' | 'rest' | 'head' | null;
    scopeSourceJobId?: string | null;
  },
) {
  // REV-C-1: when repositoryId is supplied, the caller has already resolved the row id (typically
  // via findRepositoryByBitbucketIdentity in the Bitbucket route) -- we MUST NOT invoke
  // getOrCreateRepository, even with empty-string installationId, because the bitbucket branch
  // would do an ON CONFLICT DO UPDATE on a different UNIQUE key and could (in the worst case)
  // mutate a Phase-6-created row. Bypass is the safe path.
  let repositoryId = input.repositoryId;
  if (!repositoryId) {
    // GitHub path (default): installationId must be a non-null string here -- callers that
    // bypass getOrCreateRepository via repositoryId pass installationId as null, and they
    // never reach this branch. The non-null assertion is safe.
    repositoryId = await getOrCreateRepository(env, {
      installationId: input.installationId ?? '',
      owner: input.owner,
      repo: input.repo,
      vcsProvider: input.vcsProvider,
      workspace: input.workspace,
    });
  }

  const [row] = await queryRows<JobRow>(
    env,
    `
      WITH inserted AS (
        INSERT INTO jobs (
          repository_id,
          pr_number,
          pr_title,
          pr_author,
          commit_sha,
          base_sha,
          trigger,
          status,
          config_snapshot,
          head_ref,
          base_ref,
          retry_of_job_id,
          review_scope,
          scope_source_job_id,
          rounds_incremental
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'queued', $8::jsonb, $9, $10, $11::uuid, $12, $13::uuid, $14)
        RETURNING *
      )
      SELECT i.*, r.owner, r.repo, r.installation_id, r.vcs_provider AS "repositoryVcsProvider", r.workspace AS "repositoryWorkspace", i.status_check_ref
      FROM inserted i
      JOIN repositories r ON i.repository_id = r.id
    `,
    [
      repositoryId,
      input.prNumber,
      input.prTitle,
      input.prAuthor,
      hexToBytes(input.commitSha),
      hexToBytes(input.baseSha),
      input.trigger,
      JSON.stringify(input.configSnapshot ?? defaultRepoConfig),
      input.headRef,
      input.baseRef,
      input.retryOfJobId ?? null,
      input.reviewScope ?? null,
      input.scopeSourceJobId ?? null,
      // Phase 18 (D-02 / D-16): capture the durable rounds_incremental snapshot from the config at
      // insert time so every subsequent read (mapJob's hot path, the lease-claim path, the
      // audit-trail read) sees the same value the webhook route saw. Default-false on the
      // schema-resolved config (review.rounds.incremental defaults false) means a pre-Phase-18
      // configSnapshot without rounds.* is inert -- false here, false in the DB, no behavior change.
      // Using a triple-null coalesce so the bitwise comparison stays a non-null boolean column.
      Boolean(input.configSnapshot?.review?.rounds?.incremental ?? false),
    ],
  );

  await markSystemActive(env);
  return mapJob(row);
}

export async function listJobs(
  env: Pick<AppBindings, 'HYPERDRIVE'>,
  query: {
    owner?: string;
    repo?: string;
    status?: string;
    verdict?: string;
    search?: string;
    limit: number;
    offset: number;
  },
) {
  const conditions: string[] = [];
  const params: any[] = [];

  if (query.owner) {
    params.push(query.owner);
    conditions.push(`r.owner = $${params.length}`);
  }
  if (query.repo) {
    params.push(query.repo);
    conditions.push(`r.repo = $${params.length}`);
  }
  if (query.status) {
    params.push(query.status);
    conditions.push(`j.status = $${params.length}`);
  }
  if (query.verdict) {
    params.push(query.verdict);
    conditions.push(`j.verdict = $${params.length}`);
  }
  if (query.search) {
    params.push(`%${query.search}%`);
    conditions.push(`(j.pr_title ILIKE $${params.length} OR CAST(j.pr_number AS TEXT) LIKE $${params.length})`);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  params.push(query.limit);
  const limitIdx = params.length;
  params.push(query.offset);
  const offsetIdx = params.length;

  const rows = await queryRows<JobRow>(
    env,
    `
      SELECT j.*, r.owner, r.repo, r.installation_id, r.vcs_provider AS "repositoryVcsProvider", r.workspace AS "repositoryWorkspace", j.status_check_ref
      FROM jobs j
      JOIN repositories r ON j.repository_id = r.id
      ${whereClause}
      ORDER BY j.created_at DESC
      LIMIT $${limitIdx} OFFSET $${offsetIdx}
    `,
    params,
  );

  const [totalResult] = await queryRows<{ count: string }>(
    env,
    `
      SELECT COUNT(*) as count
      FROM jobs j
      JOIN repositories r ON j.repository_id = r.id
      ${whereClause}
    `,
    params.slice(0, -2),
  );

  return {
    jobs: rows.map(mapJob),
    total: parseInt(totalResult.count, 10),
  };
}

export async function getJobForProcessing(env: Pick<AppBindings, 'HYPERDRIVE'>, jobId: string) {
  if (!jobId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(jobId)) {
    return null;
  }
  const [row] = await queryRows<JobRow>(
    env,
    `
      SELECT j.*, r.owner, r.repo, r.installation_id, r.vcs_provider AS "repositoryVcsProvider", r.workspace AS "repositoryWorkspace", j.status_check_ref
      FROM jobs j
      JOIN repositories r ON j.repository_id = r.id
      WHERE j.id = $1
      LIMIT 1
    `,
    [jobId],
  );

  return row ?? null;
}

export async function getJobDetail(env: Pick<AppBindings, 'HYPERDRIVE'>, jobId: string) {
  if (!jobId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(jobId)) {
    return null;
  }

  const [row] = await queryRows<JobDetailRow>(
    env,
    `
      SELECT
        j.*,
        r.owner,
        r.repo,
        r.installation_id,
        r.vcs_provider AS "repositoryVcsProvider",
        r.workspace AS "repositoryWorkspace",
        COALESCE(
          (
            SELECT JSON_AGG(
              JSON_BUILD_OBJECT(
                'id', fr.id,
                'jobId', fr.job_id,
                'filePath', fr.file_path,
                'fileStatus', fr.file_status,
                'modelUsed', fr.model_used,
                'diffLineCount', fr.diff_line_count,
                'diffInput', fr.diff_input,
                'rawAiOutput', fr.raw_ai_output,
                'inputTokens', fr.input_tokens,
                'outputTokens', fr.output_tokens,
                'durationMs', fr.duration_ms,
                'verdict', fr.verdict,
                'fileSummary', fr.file_summary,
                'errorMessage', fr.error_msg,
                'createdAt', fr.created_at,
                'parsedComments', COALESCE(
                  (
                    SELECT JSON_AGG(
                      JSON_BUILD_OBJECT(
                        'path', rc.path,
                        'line', rc.line,
                        'position', rc.position,
                        'severity', rc.severity,
                        'category', rc.category,
                        'title', rc.title,
                        'body', rc.body,
                        'codeSuggestion', rc.code_suggestion,
                        'confidence', rc.confidence
                      )
                      ORDER BY rc.id ASC
                    ) FROM review_comments rc WHERE rc.file_review_id = fr.id
                  ),
                  '[]'::json
                )
              )
              ORDER BY fr.created_at ASC
            )
            FROM file_reviews fr
            WHERE fr.job_id = j.id
          ),
          '[]'::json
        ) AS files_json
      FROM jobs j
      JOIN repositories r ON j.repository_id = r.id
      WHERE j.id = $1
    `,
    [jobId],
  );

  if (!row) return null;

  // AUD-01 / D-11 fail-soft PER-ELEMENT audit read. This lives in getJobDetail ONLY (NOT mapJob), so
  // listJobs and the workflow lease-claim (both via mapJob) never read, validate, or return the audit
  // array — keeping the summary/list/lease-claim hot path audit-free (review fix: Codex, Divergent
  // Views). Parse each element individually through jobAuditEventSchema.safeParse: a single malformed
  // or future-`stage` event is dropped (and warned once) while every valid event is retained, so one
  // bad entry never erases the whole trail (review fix: Codex MEDIUM — a whole-array safeParse would
  // discard all valid audit evidence, and the "open union" would be closed at read time). Mirrors the
  // critic_result degrade-and-warn posture in mapJob above.
  const rawAudit = parseJsonColumn<unknown>(row.audit, []);
  const auditEvents: JobAuditEvent[] = [];
  let droppedAuditCount = 0;
  if (Array.isArray(rawAudit)) {
    for (const element of rawAudit) {
      const parsed = jobAuditEventSchema.safeParse(element);
      if (parsed.success) {
        auditEvents.push(parsed.data);
      } else {
        droppedAuditCount += 1;
      }
    }
  } else {
    // A non-array stored value (should never happen — appendJobAuditEvents only ever writes arrays)
    // degrades to an empty trail rather than throwing.
    droppedAuditCount += 1;
  }
  if (droppedAuditCount > 0) {
    logger.warn(`Ignoring ${droppedAuditCount} unparseable audit event(s) for job ${row.id}`);
  }

  return jobDetailSchema.parse({
    ...mapJob(row),
    baseSha: bytesToHex(row.base_sha),
    headRef: row.head_ref,
    baseRef: row.base_ref,
    summaryMarkdown: row.summary_markdown,
    configSnapshot: repoConfigSchema.parse(parseJsonColumn(row.config_snapshot, defaultRepoConfig)),
    reviewId: row.review_id,
    retryOfJobId: row.retry_of_job_id,
    summaryModel: row.summary_model,
    files: parseJsonColumn(row.files_json, []),
    // AUD-01: valid, per-element-parsed events (oldest first) + the ring-buffer eviction flag.
    audit: auditEvents,
    auditTruncated: row.audit_truncated ?? false,
  });
}

export async function claimJobLease(
  env: Pick<AppBindings, 'HYPERDRIVE' | 'APP_KV'>,
  jobId: string,
  leaseOwner: string,
  leaseSeconds: number,
): Promise<JobLeaseClaim> {
  const [claimed] = await queryRows<JobRow>(
    env,
    `
      WITH claimed AS (
        UPDATE jobs
        SET status = CASE WHEN status = 'queued' THEN 'running' ELSE status END,
            started_at = COALESCE(started_at, now()),
            lease_owner = $2,
            lease_expires_at = now() + ($3 || ' seconds')::interval,
            heartbeat_at = now(),
            last_queue_message_at = now()
        WHERE id = $1
          AND status IN ('queued', 'running')
          AND (
            lease_expires_at IS NULL
            OR lease_expires_at < now()
            OR lease_owner = $2
          )
          AND NOT (
            status = 'running'
            AND lease_owner IS NULL
            AND last_queue_message_at IS NOT NULL
            AND last_queue_message_at > now()
          )
        RETURNING *
      )
      SELECT c.*, r.owner, r.repo, r.installation_id, r.vcs_provider AS "repositoryVcsProvider", r.workspace AS "repositoryWorkspace", c.status_check_ref
      FROM claimed c
      JOIN repositories r ON c.repository_id = r.id
    `,
    [jobId, leaseOwner, String(leaseSeconds)],
  );

  if (claimed) {
    await markSystemActive(env);
    return { status: 'claimed', row: claimed };
  }

  const row = await getJobForProcessing(env, jobId);
  if (!row) {
    return { status: 'missing' };
  }

  if (!['queued', 'running'].includes(row.status)) {
    return { status: 'terminal', row };
  }

  const leaseExpiresAt = row.lease_expires_at ? new Date(row.lease_expires_at).getTime() : 0;
  const delayedUntil = row.lease_owner === null && row.last_queue_message_at ? new Date(row.last_queue_message_at).getTime() : 0;
  const retryAt = Math.max(leaseExpiresAt, delayedUntil);
  const secondsUntilExpiry = Math.ceil((retryAt - Date.now()) / 1000);
  return {
    status: 'busy',
    row,
    retryAfterSeconds: Math.max(15, Math.min(60, Number.isFinite(secondsUntilExpiry) ? secondsUntilExpiry : 60)),
  };
}

export async function heartbeatJobLease(
  env: Pick<AppBindings, 'HYPERDRIVE' | 'APP_KV'>,
  jobId: string,
  leaseOwner: string,
  leaseSeconds: number,
) {
  await queryRows(
    env,
    `
      UPDATE jobs
      SET heartbeat_at = now(),
          lease_expires_at = now() + ($3 || ' seconds')::interval
      WHERE id = $1
        AND lease_owner = $2
        AND status = 'running'
    `,
    [jobId, leaseOwner, String(leaseSeconds)],
  );
  await markSystemActive(env);
}

export async function releaseJobLease(env: Pick<AppBindings, 'HYPERDRIVE'>, jobId: string, leaseOwner: string) {
  await queryRows(
    env,
    `
      UPDATE jobs
      SET lease_owner = NULL,
          lease_expires_at = NULL
      WHERE id = $1
        AND lease_owner = $2
    `,
    [jobId, leaseOwner],
  );
}

// Records that a job is rescheduling the same phase (a continuation) and returns the resulting
// no-progress continuation count. The counter is bumped here and cleared by
// resetJobContinuationCount() whenever a chunk actually completes a file, so a healthy job that
// keeps making headway stays near zero while a job that can never progress climbs toward the
// MAX_JOB_CONTINUATIONS ceiling and is failed terminally.
export async function markJobContinuationQueued(env: Pick<AppBindings, 'HYPERDRIVE'>, jobId: string, delaySeconds = 0) {
  const rows = await queryRows<{ continuation_count: number }>(
    env,
    `
      UPDATE jobs
      SET heartbeat_at = now(),
          continuation_count = continuation_count + 1,
          last_queue_message_at = CASE
            WHEN $2::int > 0 THEN now() + ($2::text || ' seconds')::interval
            ELSE now()
          END
      WHERE id = $1
        AND status = 'running'
      RETURNING continuation_count
    `,
    [jobId, delaySeconds],
  );
  return rows[0]?.continuation_count ?? 0;
}

// Clears the no-progress continuation counter after a chunk completes at least one file review,
// so slow-but-progressing jobs never trip the MAX_JOB_CONTINUATIONS safety net.
export async function resetJobContinuationCount(env: Pick<AppBindings, 'HYPERDRIVE'>, jobId: string) {
  await queryRows(
    env,
    `
      UPDATE jobs
      SET continuation_count = 0
      WHERE id = $1
        AND status = 'running'
        AND continuation_count <> 0
    `,
    [jobId],
  );
}

export async function updateJobCheckRun(env: Pick<AppBindings, 'HYPERDRIVE'>, jobId: string, checkRunId: number) {
  await queryRows(
    env,
    `
      UPDATE jobs
      SET check_run_id = $2
      WHERE id = $1
    `,
    [jobId, checkRunId],
  );
}

export async function completeJob(
  env: Pick<AppBindings, 'HYPERDRIVE'>,
  jobId: string,
  input: {
    verdict: 'approve' | 'comment';
    fileCount: number;
    commentCount: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    summaryMarkdown: string;
    reviewId: number | null;
    summaryModel: string | null;
    overallConfidenceScore?: number | null;
    overallCorrectness?: string | null;
    errorMessage?: string | null;
  },
) {
  const now = new Date().toISOString();
  await queryRows(
    env,
    `
      UPDATE jobs
      SET status = 'done',
          finished_at = now(),
          -- NOTE: check_run_completed_at is intentionally NOT set here. It's set only once the
          -- GitHub check run has actually been updated (markJobCheckRunCompleted, called after the
          -- best-effort updateCheckRun in finalize). That way, if finalize couldn't update the
          -- check run (e.g. subrequest budget spent on a huge PR), it stays NULL and the maintenance
          -- sweep (completeTerminalCheckRuns) reconciles it -- the check run always ends 'completed'.
          lease_owner = NULL,
          lease_expires_at = NULL,
          verdict = $2,
          file_count = $3,
          comment_count = $4,
          total_input_tokens = $5,
          total_output_tokens = $6,
          summary_markdown = $7,
          review_id = $8,
          summary_model = $9,
          overall_confidence_score = $10,
          overall_correctness = $11,
          error_msg = $12,
          steps = CASE
            WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(steps, '[]'::jsonb)) s WHERE s->>'name' = 'Completing')
            THEN (
              SELECT jsonb_agg(
                CASE
                  WHEN s->>'name' = 'Completing'
                  THEN s || jsonb_build_object('status', 'done', 'finishedAt', $13::text, 'error', NULL)
                  ELSE s
                END
              ) FROM jsonb_array_elements(COALESCE(steps, '[]'::jsonb)) s
            )
            ELSE COALESCE(steps, '[]'::jsonb) || jsonb_build_array(
              jsonb_build_object(
                'name', 'Completing',
                'status', 'done',
                'startedAt', $13::text,
                'finishedAt', $13::text,
                'error', NULL
              )
            )
          END
      WHERE id = $1
    `,
    [
      jobId,
      input.verdict,
      input.fileCount,
      input.commentCount,
      input.totalInputTokens,
      input.totalOutputTokens,
      input.summaryMarkdown,
      input.reviewId,
      input.summaryModel,
      input.overallConfidenceScore ?? null,
      input.overallCorrectness ?? null,
      input.errorMessage ?? null,
      now
    ],
  );
}

export async function failJob(env: Pick<AppBindings, 'HYPERDRIVE' | 'APP_KV'>, jobId: string, errorMessage: string) {
  await queryRows(
    env,
    `
      UPDATE jobs
      SET status = 'failed',
          finished_at = now(),
          lease_owner = NULL,
          lease_expires_at = NULL,
          error_msg = $2,
          steps = CASE
            WHEN steps IS NOT NULL THEN (
              SELECT jsonb_agg(
                CASE
                  WHEN s->>'status' = 'running'
                  THEN s || jsonb_build_object('status', 'failed', 'finishedAt', now(), 'error', $2::text)
                  ELSE s
                END
              ) FROM jsonb_array_elements(steps) s
            )
            ELSE steps
          END
      WHERE id = $1
    `,
    [jobId, errorMessage],
  );
  await markSystemActive(env);
}

/**
 * Stop an ongoing (queued/running) job at the user's request: mark it terminal as 'cancelled',
 * clear the lease (so lease-recovery won't requeue it) and mark any running steps failed. Returns
 * true if a job was actually transitioned (false if it was already terminal). The caller is
 * responsible for terminating the Cloudflare Workflow instance.
 */
export async function cancelJob(env: Pick<AppBindings, 'HYPERDRIVE' | 'APP_KV'>, jobId: string): Promise<boolean> {
  const rows = await queryRows<{ id: string }>(
    env,
    `
      UPDATE jobs
      SET status = 'cancelled',
          finished_at = now(),
          lease_owner = NULL,
          lease_expires_at = NULL,
          error_msg = COALESCE(error_msg, 'Stopped by user.'),
          steps = CASE
            WHEN steps IS NOT NULL THEN (
              SELECT jsonb_agg(
                CASE
                  WHEN s->>'status' = 'running'
                  THEN s || jsonb_build_object('status', 'failed', 'finishedAt', now(), 'error', 'Stopped by user.')
                  ELSE s
                END
              ) FROM jsonb_array_elements(steps) s
            )
            ELSE steps
          END
      WHERE id = $1 AND status IN ('queued', 'running')
      RETURNING id
    `,
    [jobId],
  );
  // Keep the maintenance flag set so the cron completes the GitHub check run for the cancelled job.
  if (rows.length > 0) await markSystemActive(env);
  return rows.length > 0;
}

/**
 * TOCTOU guard for the /retry and /rerun replacement flow. Atomically transitions an *active*
 * (queued/running) source out of its active state -- into the same 'superseded' end-state that
 * supersedeOlderJobs applies once the replacement is inserted -- so two concurrent retry/rerun
 * requests for the same source cannot both spawn a replacement job. The conditional UPDATE takes a
 * row lock: exactly one caller observes RETURNING rows (returns true), the loser sees the row is no
 * longer queued/running and returns false, so the handler can respond 409 instead of double-inserting.
 *
 * Only active sources are claimed here. Retrying an already-terminal job (done/failed/cancelled)
 * stays allowed and unguarded: supersedeOlderJobs collapses concurrent replacements of a terminal
 * source to the newest job, so no exclusive claim is required for that path. The columns written
 * mirror supersedeOlderJobs exactly (status/finished_at/lease/error_msg, steps untouched) so a
 * single-caller retry of a queued source reaches byte-identical row state whether the source is
 * superseded here first or by supersedeOlderJobs after the insert.
 */
export async function claimActiveJobForReplacement(env: Pick<AppBindings, 'HYPERDRIVE'>, jobId: string): Promise<boolean> {
  const rows = await queryRows<{ id: string }>(
    env,
    `
      UPDATE jobs
      SET status = 'superseded',
          finished_at = now(),
          lease_owner = NULL,
          lease_expires_at = NULL,
          error_msg = COALESCE(error_msg, 'Superseded by a newer commit or job.')
      WHERE id = $1 AND status IN ('queued', 'running')
      RETURNING id
    `,
    [jobId],
  );
  return rows.length > 0;
}

/**
 * Permanently delete a job. file_reviews and review_comments cascade automatically (ON DELETE
 * CASCADE); child retry jobs have their retry_of_job_id nulled (ON DELETE SET NULL). Returns true
 * if a row was deleted.
 */
export async function deleteJob(env: Pick<AppBindings, 'HYPERDRIVE'>, jobId: string): Promise<boolean> {
  const rows = await queryRows<{ id: string }>(
    env,
    `DELETE FROM jobs WHERE id = $1 RETURNING id`,
    [jobId],
  );
  return rows.length > 0;
}

export async function markJobCheckRunCompleted(env: Pick<AppBindings, 'HYPERDRIVE'>, jobId: string) {
  await queryRows(
    env,
    `
      UPDATE jobs
      SET check_run_completed_at = now()
      WHERE id = $1
    `,
    [jobId],
  );
}

export async function updateJobFileCount(env: Pick<AppBindings, 'HYPERDRIVE'>, jobId: string, fileCount: number) {
  await queryRows(
    env,
    `
      UPDATE jobs
      SET file_count = $2
      WHERE id = $1
    `,
    [jobId, fileCount],
  );
}

export async function completePreparationStep(env: Pick<AppBindings, 'HYPERDRIVE'>, jobId: string, fileCount: number) {
  const now = new Date().toISOString();
  await queryRows(
    env,
    `
      UPDATE jobs
      SET file_count = $2,
          steps = (
            SELECT jsonb_agg(
              CASE
                WHEN s->>'name' = 'Preparation'
                THEN s || jsonb_build_object('status', 'done', 'finishedAt', $3::text)
                ELSE s
              END
            ) FROM jsonb_array_elements(steps) s
          )
      WHERE id = $1
    `,
    [jobId, fileCount, now],
  );
}

export async function findExistingJobForHead(
  env: Pick<AppBindings, 'HYPERDRIVE'>,
  input: {
    owner: string;
    repo: string;
    prNumber: number;
    commitSha: string;
    trigger: 'auto' | 'mention';
    // D-02: optional vcsProvider filter. Defaults to 'github' so the existing GitHub-only call
    // sites (which never supply it) produce the byte-identical SQL WHERE -- the no-arg path stays
    // unchanged (NREG-02 byte-identity guarantee). When 'bitbucket' is passed, the WHERE adds an
    // explicit r.vcs_provider='bitbucket' guard so a Bitbucket commit never collides with a
    // GitHub commit at the same owner/repo (the leading vcs_provider column differentiates them,
    // but the explicit predicate makes intent obvious and avoids surprises on future provider
    // additions).
    vcsProvider?: 'github' | 'bitbucket';
  },
) {
  const vcsProvider = input.vcsProvider ?? 'github';

  const [row] = await queryRows<JobRow>(
    env,
    `
      SELECT j.*, r.owner, r.repo, r.installation_id, r.vcs_provider AS "repositoryVcsProvider", r.workspace AS "repositoryWorkspace", j.status_check_ref
      FROM jobs j
      JOIN repositories r ON j.repository_id = r.id
      WHERE r.vcs_provider = $6
        AND r.owner = $1
        AND r.repo = $2
        AND j.pr_number = $3
        AND j.commit_sha = $4
        AND j.trigger = $5
      ORDER BY j.created_at DESC
      LIMIT 1
    `,
    [input.owner, input.repo, input.prNumber, hexToBytes(input.commitSha), input.trigger, vcsProvider],
  );

  return row ? mapJob(row) : null;
}

export async function updateJobStep(
  env: Pick<AppBindings, 'HYPERDRIVE'>,
  jobId: string,
  stepName: string,
  update: {
    status: 'pending' | 'running' | 'done' | 'failed';
    startedAt?: string | null;
    finishedAt?: string | null;
    error?: string | null;
  },
) {
  const now = new Date().toISOString();
  const startedAt = update.status === 'running' ? now : (update.startedAt ?? null);
  const finishedAt = update.status === 'done' || update.status === 'failed' ? now : (update.finishedAt ?? null);
  const error = update.error ?? null;

  // Single query that either updates existing step or appends a new one
  await queryRows(
    env,
    `
      UPDATE jobs
      SET heartbeat_at = now(),
          steps = CASE
        WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(steps, '[]'::jsonb)) s WHERE s->>'name' = $2)
        THEN (
          SELECT jsonb_agg(
            CASE
              WHEN s->>'name' = $2
              THEN s || jsonb_build_object(
                'status', $3::text,
                -- Preserve the FIRST start time. A phase (e.g. "Reviewing Files") re-enters
                -- 'running' once per hibernated chunk; overwriting startedAt each time would make
                -- the displayed duration reflect only the last chunk (~seconds) instead of the full
                -- multi-minute wall-clock. Keep the existing start; only seed it when absent.
                'startedAt', COALESCE(s->>'startedAt', $4::text),
                -- 'running' clears any stale finish (step is back in progress). Otherwise keep the
                -- FIRST finish already recorded for this run -- so re-marking a step 'done' (e.g.
                -- finalize defensively re-confirming "Reviewing Files") doesn't push the timestamp
                -- later and inflate the displayed duration. A re-run resets it via the 'running' clear.
                'finishedAt', CASE WHEN $3::text = 'running' THEN NULL ELSE COALESCE(s->>'finishedAt', $5::text) END,
                'error', COALESCE($6::text, s->>'error')
              )
              ELSE s
            END
          ) FROM jsonb_array_elements(COALESCE(steps, '[]'::jsonb)) s
        )
        ELSE COALESCE(steps, '[]'::jsonb) || jsonb_build_array(
          jsonb_build_object(
            'name', $2::text,
            'status', $3::text,
            'startedAt', $4::text,
            'finishedAt', $5::text,
            'error', $6::text
          )
        )
      END
      WHERE id = $1
    `,
    [jobId, stepName, update.status, startedAt, finishedAt, error],
  );
}

export async function recoverExpiredJobLeases(
  env: Pick<AppBindings, 'HYPERDRIVE'>,
  maxRecoveryCount = 3,
  unleasedGraceSeconds = 300,
) {
  const requeued = await queryRows<{ id: string }>(
    env,
    `
      WITH expired AS (
        SELECT id
        FROM jobs
        WHERE status = 'running'
          AND (
            (
              lease_expires_at IS NOT NULL
              AND lease_expires_at < now()
            )
            OR (
              lease_expires_at IS NULL
              AND COALESCE(last_queue_message_at, heartbeat_at, started_at, created_at) < now() - ($2 || ' seconds')::interval
            )
          )
          AND recovery_count < $1
        ORDER BY COALESCE(lease_expires_at, last_queue_message_at, heartbeat_at, started_at, created_at) ASC
        LIMIT 25
        FOR UPDATE SKIP LOCKED
      )
      UPDATE jobs j
      SET lease_owner = NULL,
          lease_expires_at = NULL,
          heartbeat_at = NULL,
          recovery_count = recovery_count + 1,
          last_queue_message_at = now(),
          error_msg = NULL
      FROM expired
      WHERE j.id = expired.id
      RETURNING j.id
    `,
    [maxRecoveryCount, String(unleasedGraceSeconds)],
  );

  const failed = await queryRows<JobRow>(
    env,
    `
      WITH expired AS (
        SELECT id
        FROM jobs
        WHERE status = 'running'
          AND (
            (
              lease_expires_at IS NOT NULL
              AND lease_expires_at < now()
            )
            OR (
              lease_expires_at IS NULL
              AND COALESCE(last_queue_message_at, heartbeat_at, started_at, created_at) < now() - ($2 || ' seconds')::interval
            )
          )
          AND recovery_count >= $1
        ORDER BY COALESCE(lease_expires_at, last_queue_message_at, heartbeat_at, started_at, created_at) ASC
        LIMIT 25
        FOR UPDATE SKIP LOCKED
      ),
      updated AS (
        UPDATE jobs j
        SET status = 'failed',
            finished_at = now(),
            lease_owner = NULL,
            lease_expires_at = NULL,
            heartbeat_at = NULL,
            error_msg = 'Job timed out: worker crashed or was evicted.',
            steps = CASE
              WHEN steps IS NOT NULL THEN (
                SELECT jsonb_agg(
                  CASE
                    WHEN s->>'status' = 'running'
                    THEN s || jsonb_build_object('status', 'failed', 'finishedAt', now(), 'error', 'Job timed out: worker crashed or was evicted.')
                    ELSE s
                  END
                ) FROM jsonb_array_elements(steps) s
              )
              ELSE steps
            END
        FROM expired
        WHERE j.id = expired.id
        RETURNING j.*
      )
      SELECT u.*, r.owner, r.repo, r.installation_id, r.vcs_provider AS "repositoryVcsProvider", r.workspace AS "repositoryWorkspace", u.status_check_ref
      FROM updated u
      JOIN repositories r ON u.repository_id = r.id
    `,
    [maxRecoveryCount, String(unleasedGraceSeconds)],
  );

  return {
    requeuedJobIds: requeued.map((row) => row.id),
    failedJobs: failed,
  };
}

export async function getTerminalJobsNeedingCheckRunCompletion(
  env: Pick<AppBindings, 'HYPERDRIVE'>,
  limit = 25,
) {
  return queryRows<JobRow>(
    env,
    `
      SELECT j.*, r.owner, r.repo, r.installation_id, r.vcs_provider AS "repositoryVcsProvider", r.workspace AS "repositoryWorkspace", j.status_check_ref
      FROM jobs j
      JOIN repositories r ON j.repository_id = r.id
      WHERE j.status IN ('done', 'failed', 'superseded', 'cancelled')
        -- REV-M-8: widened to OR status_check_ref IS NOT NULL so Bitbucket jobs (which only
        -- populate the TEXT status_check_ref column via updateJobStatusCheckRef, never the
        -- numeric check_run_id) are eligible for the terminal reconciliation sweep. The
        -- reconciliation routes through VcsService.forRepo (REV-M-8) so a Bitbucket job
        -- triggers the adapter's updateStatusCheck (PUT Code Insights + POST build status).
        AND (j.check_run_id IS NOT NULL OR j.status_check_ref IS NOT NULL)
        AND j.check_run_completed_at IS NULL
      ORDER BY COALESCE(j.finished_at, j.started_at, j.created_at) ASC
      LIMIT $1
    `,
    [limit],
  );
}

/**
 * REV-R-E: write the jobs.status_check_ref column directly. This is the single writer of
 * status_check_ref -- Plan 03's runPreparePhase calls it with the string ref from
 * createStatusCheck (Bitbucket Code Insights report key / generic status reference) instead of
 * `Number(ref)` to check_run_id (which would fail for non-numeric refs). Plan 03's
 * runFinalizePhase gate reads `job.statusCheckRef` via the JobRow widening in this file.
 *
 * Single UPDATE statement, parameterized; no string interpolation.
 */
export async function updateJobStatusCheckRef(
  env: Pick<AppBindings, 'HYPERDRIVE'>,
  jobId: string,
  statusCheckRef: string | null,
) {
  await queryRows(
    env,
    `UPDATE jobs SET status_check_ref = $2 WHERE id = $1`,
    [jobId, statusCheckRef],
  );
}

/**
 * Pattern 5 (status_check_ref precedent): single writer of jobs.walkthrough_comment_ref. Phase 9's
 * streamed walkthrough persists the created comment's opaque VCS ref here so a fresh Workflow
 * instance can idempotently edit-or-repost it across hibernation. No consumer is wired in Phase 7;
 * this establishes the typed writer surface. Single parameterized UPDATE, no string interpolation.
 */
export async function updateJobWalkthroughCommentRef(
  env: Pick<AppBindings, 'HYPERDRIVE'>,
  jobId: string,
  walkthroughCommentRef: string | null,
) {
  await queryRows(
    env,
    `UPDATE jobs SET walkthrough_comment_ref = $2 WHERE id = $1`,
    [jobId, walkthroughCommentRef],
  );
}

/**
 * Pattern 5: single writer of jobs.critic_result. Phase 10's critic pass persists its result blob
 * here (JSONB). The value is JSON.stringify'd on write and cast $2::jsonb; mapJob parses it back and
 * validates against criticResultSchema on read. No consumer is wired in Phase 7. Single
 * parameterized UPDATE, no string interpolation.
 */
export async function updateJobCriticResult(
  env: Pick<AppBindings, 'HYPERDRIVE'>,
  jobId: string,
  criticResult: CriticResult | null,
) {
  await queryRows(
    env,
    `UPDATE jobs SET critic_result = $2::jsonb WHERE id = $1`,
    [jobId, criticResult === null ? null : JSON.stringify(criticResult)],
  );
}

/**
 * Phase 18 (RND-01 / D-02 / D-16 widened): write the resolved round + selected review mode onto
 * the job row. Plan 02's runPreparePhase calls this once per job with the pure resolveRoundContext
 * result so the durable round/mode snapshot survives fresh-instance handoff + lease recovery
 * (audit is intentionally excluded from mapJob). Both values are NULL-able, so a pre-Phase-18
 * insert reads them back as null without throwing (NREG-01). The CHECK constraints installed by
 * migration 011 (review_round >= 1, review_mode in 'full'|'incremental'|'fallback'|'no_changes'|
 * 'rest') reject out-of-vocabulary mode strings at the DB layer; this setter trusts the schema
 * surface and does not revalidate. Single parameterized UPDATE, no string interpolation.
 */
export async function setJobReviewRoundAndMode(
  env: Pick<AppBindings, 'HYPERDRIVE'>,
  jobId: string,
  state: { reviewRound: number; reviewMode: 'full' | 'incremental' | 'fallback' | 'no_changes' | 'rest' },
): Promise<void> {
  await queryRows(
    env,
    `
      UPDATE jobs
      SET review_round = $2,
          review_mode = $3
      WHERE id = $1
    `,
    [jobId, state.reviewRound, state.reviewMode],
  );
}

/**
 * Phase 18 (RND-02 / D-08, migration 012): persist the IMMUTABLE diff-selection descriptor on
 * the job row so the review/finalize phases re-fetch the EXACT same compare range the prepare
 * phase selected (D-08: finalize never anchors a freshly-fetched live head). The descriptor
 * is the durable fact; the KV diff cache is only a best-effort accelerator and is NEVER allowed
 * to silently switch the source (Codex/Antigravity HIGH consensus — incremental-mode cache miss
 * MUST NOT call the implicit full-diff helper).
 *
 * `fromSha` / `toSha` are populated for modes 'incremental' / 'fallback' / 'no_changes' (the
 * cases where the prepare phase made a non-trivial selection against the prior anchor). For
 * 'full' / 'rest' the descriptor is just the mode (the consumer uses the existing full-diff
 * path, byte-identically with NREG-01). The writer is idempotent — re-calling with the same
 * descriptor overwrites with the same values — and never throws into the caller (a failed
 * write is logged + swallowed by the caller's try/catch so the prepare phase can continue).
 * Single parameterized UPDATE; no string interpolation.
 */
export async function setJobDiffSelection(
  env: Pick<AppBindings, 'HYPERDRIVE'>,
  jobId: string,
  descriptor:
    | { mode: 'full' | 'rest' }
    | { mode: 'incremental' | 'fallback' | 'no_changes'; fromSha: string; toSha: string },
): Promise<void> {
  const fromSha: string | null = descriptor.mode === 'full' || descriptor.mode === 'rest'
    ? null
    : (descriptor as { fromSha: string; toSha: string }).fromSha;
  const toSha: string | null = descriptor.mode === 'full' || descriptor.mode === 'rest'
    ? null
    : (descriptor as { fromSha: string; toSha: string }).toSha;
  await queryRows(
    env,
    `
      UPDATE jobs
      SET rounds_from_sha = $2,
          rounds_to_sha = $3
      WHERE id = $1
    `,
    [jobId, fromSha, toSha],
  );
}

/**
 * D-04: return the most recent job for a given (vcs_provider, workspace, owner, repo, prNumber)
 * tuple. Used by the Bitbucket webhook route's `pullrequest:updated` commit-hash dedup -- when a
 * push to the same PR head brings a new commit, the route looks up the prior job and skips
 * re-enqueueing if its commit_sha matches.
 *
 * Per REV-R-C, the Bitbucket dual-filter on (workspace, owner) is intentional: both columns are
 * populated with the workspace slug for Bitbucket rows, so the query matches uniformly. The
 * `ORDER BY created_at DESC LIMIT 1` is a single-row scan over the (repository_id, pr_number)
 * index; no full scan risk (T-05-03).
 *
 * Returns `JobRow | null`. The route can read `commit_sha` directly via `bytesToHex(...)`.
 */
export async function mostRecentJobForPullRequest(
  env: Pick<AppBindings, 'HYPERDRIVE'>,
  input: {
    vcsProvider: 'github' | 'bitbucket';
    workspace: string;
    owner: string;
    repo: string;
    prNumber: number;
  },
): Promise<JobRow | null> {
  const [row] = await queryRows<JobRow>(
    env,
    `
      SELECT j.*, r.owner, r.repo, r.installation_id, r.vcs_provider AS "repositoryVcsProvider", r.workspace AS "repositoryWorkspace", j.status_check_ref
      FROM jobs j
      JOIN repositories r ON j.repository_id = r.id
      WHERE r.vcs_provider = $1
        AND r.workspace = $2
        AND r.owner = $3
        AND r.repo = $4
        AND j.pr_number = $5
      ORDER BY j.created_at DESC
      LIMIT 1
    `,
    [input.vcsProvider, input.workspace, input.owner, input.repo, input.prNumber],
  );

  return row ?? null;
}

export async function supersedeOlderJobs(
  env: Pick<AppBindings, 'HYPERDRIVE'>,
  input: {
    // REV-C-4: widened to { installationId?, workspace?, owner, repo, prNumber, newJobId, vcsProvider? }.
    // The GitHub branch reads `installationId`; the Bitbucket branch reads `workspace` and
    // IGNORES `installationId` entirely (no read of installation_id in the WHERE). The
    // no-arg-GitHub path stays byte-identical because the default vcsProvider='github' branch
    // builds the original SQL WHERE.
    installationId?: string;
    workspace?: string;
    owner: string;
    repo: string;
    prNumber: number;
    newJobId: string;
    vcsProvider?: 'github' | 'bitbucket';
  },
): Promise<number> {
  const vcsProvider = input.vcsProvider ?? 'github';

  if (vcsProvider === 'bitbucket') {
    // Bitbucket branch: filter by (vcs_provider='bitbucket', workspace, owner, repo). The
    // `installationId` parameter is IGNORED in this branch -- a Phase-5 caller never supplies
    // one (Bitbucket has no installation_id), and silently falling back to the GitHub shape
    // would match no rows anyway. Per REV-R-C, the dual-filter on (workspace, owner) is
    // intentional: both columns are populated with the workspace slug for Bitbucket rows.
    const rows = await queryRows<{ id: string }>(
      env,
      `
        UPDATE jobs j
        SET status = 'superseded',
            finished_at = now(),
            lease_owner = NULL,
            lease_expires_at = NULL,
            error_msg = 'Superseded by a newer commit or job.'
        FROM repositories r
        WHERE j.repository_id = r.id
          AND r.vcs_provider = 'bitbucket'
          AND r.workspace = $1
          AND r.owner = $2
          AND r.repo = $3
          AND j.pr_number = $4
          AND j.id != $5
          AND j.status IN ('queued', 'running')
        RETURNING j.id
      `,
      [input.workspace ?? '', input.owner, input.repo, input.prNumber, input.newJobId],
    );

    return rows.length;
  }

  // GitHub branch (default): byte-identical to the original query when caller supplies
  // installationId. The no-arg path defaults here too (vcsProvider='github'), so existing
  // call sites (webhook-ingest.ts) keep producing the same SQL.
  if (!input.installationId) {
    // Defensive: a github call without installationId cannot match a row (every github repo
    // has a non-null installation_id), so we short-circuit to zero updates instead of
    // generating SQL with a NULL filter that would silently match nothing.
    return 0;
  }

  const rows = await queryRows<{ id: string }>(
    env,
    `
      UPDATE jobs j
      SET status = 'superseded',
          finished_at = now(),
          lease_owner = NULL,
          lease_expires_at = NULL,
          error_msg = 'Superseded by a newer commit or job.'
      FROM repositories r
      WHERE j.repository_id = r.id
        AND r.installation_id = $1
        AND r.owner = $2
        AND r.repo = $3
        AND j.pr_number = $4
        AND j.id != $5
        AND j.status IN ('queued', 'running')
      RETURNING j.id
    `,
    [input.installationId, input.owner, input.repo, input.prNumber, input.newJobId],
  );

  return rows.length;
}

/**
 * AUD-01 (D-12/D-13/D-14): atomically append audit events onto jobs.audit, capped at the most-recent
 * 500 by a server-side drop-oldest ring buffer, tracking eviction in jobs.audit_truncated.
 *
 * Concurrency (T-13-03-01 / lost-update safety): multiple (file, pass) units can complete and call
 * this in the same Promise.all-chunked invocation. This is a SINGLE atomic `UPDATE ... SET audit =
 * <expr over the old row>` — there is NO application-level read-modify-write, so every concurrent
 * caller's events survive (each UPDATE serializes on the row and composes onto the prior value).
 *
 * Security (T-13-03-02): event content is bound as a single `$2` parameter (`JSON.stringify(events)`),
 * never string-concatenated into the SQL text — mirroring updateJobCriticResult / completeJob's
 * parameterized JSONB style. It is referenced as `$2::text::jsonb` (NOT `$2::jsonb`): postgres.js
 * infers the bind OID from the first cast it sees, and `::jsonb` makes it send a double-encoded jsonb
 * *string* scalar (the same double-encoding this codebase's config uses — see repo_configs), which
 * would make jsonb_array_length/jsonb_array_elements fail with "cannot get array length of a scalar".
 * Forcing `::text` first sends the raw JSON array text, so `::text::jsonb` parses to a real jsonb array.
 *
 * Ordering (review fix, OpenCode MEDIUM): the trim re-aggregates with an EXPLICIT ordinality so the
 * stored array always ends oldest-first (ascending chronological / insertion order): the combined
 * `old || new` array is expanded WITH ORDINALITY, the newest 500 selected via `ORDER BY ord DESC
 * LIMIT 500`, then re-aggregated with `jsonb_agg(elem ORDER BY ord ASC)`.
 *
 * `audit_truncated` uses integer array lengths (jsonb_array_length), never a fractional threshold, so
 * there is no rounding/precision mode at the 500 boundary; it is set once true and never cleared
 * (`audit_truncated OR ...`). The 500-boundary case (total === 500) does NOT set the flag.
 */
export async function appendJobAuditEvents(
  env: Pick<AppBindings, 'HYPERDRIVE'>,
  jobId: string,
  events: JobAuditEvent[],
): Promise<void> {
  // No-op fast path: zero events means zero DB work (never issue an empty UPDATE).
  if (events.length === 0) return;

  await queryRows(
    env,
    `
      UPDATE jobs
      SET audit = (
            SELECT COALESCE(jsonb_agg(elem ORDER BY ord ASC), '[]'::jsonb)
            FROM (
              SELECT elem, ord
              FROM jsonb_array_elements(COALESCE(audit, '[]'::jsonb) || $2::text::jsonb)
                WITH ORDINALITY AS combined(elem, ord)
              ORDER BY ord DESC
              LIMIT 500
            ) recent
          ),
          audit_truncated = audit_truncated
            OR (jsonb_array_length(COALESCE(audit, '[]'::jsonb)) + jsonb_array_length($2::text::jsonb) > 500)
      WHERE id = $1
    `,
    [jobId, JSON.stringify(events)],
  );
}

export async function getOtherRunningJobsCount(env: Pick<import('@server/env').AppBindings, 'HYPERDRIVE'>, excludeJobId: string): Promise<number> {
  const [result] = await queryRows<{ count: string }>(
    env,
    `SELECT count(*) as count FROM jobs WHERE status = 'running' AND id != $1`,
    [excludeJobId]
  );
  return parseInt(result?.count ?? '0', 10);
}
