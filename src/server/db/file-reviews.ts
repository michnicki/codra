import { ensembleResultSchema, type FileReviewPass, type ParsedReviewComment } from '@shared/schema';
import type { AppBindings } from '@server/env';
import { parseJsonColumn, queryRows, queryTransaction } from './client';

export async function insertFileReview(
  env: Pick<AppBindings, 'HYPERDRIVE'>,
  input: {
    jobId: string;
    filePath: string;
    // Optional review pass, defaults to 'main'. Existing call sites omit it -> the persisted row is
    // identical to today (NREG-01). Only Phase 10's security scheduling passes 'security'. (Binding
    // pass explicitly changes the SQL TEXT but not the persisted row — no byte-identical-SQL claim.)
    pass?: FileReviewPass;
    fileStatus: 'pending' | 'done' | 'skipped' | 'failed';
    modelUsed: string;
    modelProvider?: string | null;
    diffLineCount: number;
    diffInput: string | null;
    rawAiOutput: string | null;
    parsedComments: ParsedReviewComment[];
    inputTokens: number | null;
    outputTokens: number | null;
    durationMs: number | null;
    verdict: 'approve' | 'comment' | null;
    fileSummary: string | null;
    overallCorrectness?: string | null;
    confidenceScore?: number | null;
    errorMessage: string | null;
  },
) {
  await queryTransaction(env, async (tx) => {
    const [review] = await tx.query<{ id: string }>(
      `
        INSERT INTO file_reviews (
          job_id,
          file_path,
          file_status,
          model_used,
          diff_line_count,
          diff_input,
          raw_ai_output,
          input_tokens,
          output_tokens,
          duration_ms,
          verdict,
          file_summary,
          overall_correctness,
          confidence_score,
          error_msg,
          model_provider,
          pass
        )
        VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
        RETURNING id
      `,
      [
        input.jobId,
        input.filePath,
        input.fileStatus,
        input.modelUsed,
        input.diffLineCount,
        input.diffInput,
        input.rawAiOutput,
        input.inputTokens,
        input.outputTokens,
        input.durationMs,
        input.verdict,
        input.fileSummary,
        input.overallCorrectness ?? null,
        input.confidenceScore ?? null,
        input.errorMessage,
        input.modelProvider ?? null,
        input.pass ?? 'main',
      ],
    );

    if (input.parsedComments.length > 0) {
      const paths = input.parsedComments.map(c => c.path);
      const lines = input.parsedComments.map(c => c.line ?? null);
      const positions = input.parsedComments.map(c => c.position ?? null);
      const severities = input.parsedComments.map(c => c.severity);
      const categories = input.parsedComments.map(c => c.category);
      const titles = input.parsedComments.map(c => c.title);
      const bodies = input.parsedComments.map(c => c.body);
      const codeSuggestions = input.parsedComments.map(c => c.codeSuggestion ?? null);
      const confidences = input.parsedComments.map(c => c.confidence ?? null);

      await tx.query(
        `
          INSERT INTO review_comments (
            file_review_id, path, line, position, severity, category, title, body, code_suggestion, confidence
          )
          SELECT $1::uuid, * FROM UNNEST($2::text[], $3::int[], $4::int[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[], $10::real[])
        `,
        [review.id, paths, lines, positions, severities, categories, titles, bodies, codeSuggestions, confidences]
      );
    }
  });
}

export async function upsertFileReview(
  env: Pick<AppBindings, 'HYPERDRIVE'>,
  jobId: string,
  input: {
    filePath: string;
    // Optional review pass, defaults to 'main' (NREG-01: existing call sites omit it and persist an
    // identical row). The ON CONFLICT (job_id, file_path, pass) arbiter distinguishes the passes.
    pass?: FileReviewPass;
    fileStatus: 'pending' | 'done' | 'skipped' | 'failed';
    modelUsed: string;
    modelProvider?: string | null;
    diffLineCount: number;
    diffInput: string | null;
    rawAiOutput: string | null;
    parsedComments: ParsedReviewComment[];
    inputTokens: number | null;
    outputTokens: number | null;
    durationMs: number | null;
    verdict: 'approve' | 'comment' | null;
    fileSummary: string | null;
    overallCorrectness?: string | null;
    confidenceScore?: number | null;
    errorMessage: string | null;
    // Async batch bookkeeping: set when a review is submitted to the Workers AI queue (status
    // 'pending'), cleared (null) once the batch completes and a terminal review is persisted.
    asyncRequestId?: string | null;
    asyncModel?: string | null;
  },
) {
  await queryTransaction(env, async (tx) => {
    const [review] = await tx.query<{ id: string }>(
      `
        INSERT INTO file_reviews (
          job_id,
          file_path,
          file_status,
          model_used,
          diff_line_count,
          diff_input,
          raw_ai_output,
          input_tokens,
          output_tokens,
          duration_ms,
          verdict,
          file_summary,
          overall_correctness,
          confidence_score,
          error_msg,
          model_provider,
          async_request_id,
          async_model,
          pass
        )
        VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
        ON CONFLICT (job_id, file_path, pass) DO UPDATE SET
          file_status = EXCLUDED.file_status,
          model_used = EXCLUDED.model_used,
          diff_line_count = EXCLUDED.diff_line_count,
          diff_input = EXCLUDED.diff_input,
          raw_ai_output = EXCLUDED.raw_ai_output,
          input_tokens = EXCLUDED.input_tokens,
          output_tokens = EXCLUDED.output_tokens,
          duration_ms = EXCLUDED.duration_ms,
          verdict = EXCLUDED.verdict,
          file_summary = EXCLUDED.file_summary,
          overall_correctness = EXCLUDED.overall_correctness,
          confidence_score = EXCLUDED.confidence_score,
          error_msg = EXCLUDED.error_msg,
          model_provider = EXCLUDED.model_provider,
          async_request_id = EXCLUDED.async_request_id,
          async_model = EXCLUDED.async_model,
          transient_error_count = 0
        RETURNING id
      `,
      [
        jobId,
        input.filePath,
        input.fileStatus,
        input.modelUsed,
        input.diffLineCount,
        input.diffInput,
        input.rawAiOutput,
        input.inputTokens,
        input.outputTokens,
        input.durationMs,
        input.verdict,
        input.fileSummary,
        input.overallCorrectness ?? null,
        input.confidenceScore ?? null,
        input.errorMessage,
        input.modelProvider ?? null,
        input.asyncRequestId ?? null,
        input.asyncModel ?? null,
        input.pass ?? 'main',
      ],
    );

    await tx.query('DELETE FROM review_comments WHERE file_review_id = $1::uuid', [review.id]);

    if (input.parsedComments.length > 0) {
      await tx.query(
        `
          INSERT INTO review_comments (
            file_review_id, path, line, position, severity, category, title, body, code_suggestion, confidence
          )
          SELECT $1::uuid, * FROM UNNEST($2::text[], $3::int[], $4::int[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[], $10::real[])
        `,
        [
          review.id,
          input.parsedComments.map(c => c.path),
          input.parsedComments.map(c => c.line ?? null),
          input.parsedComments.map(c => c.position ?? null),
          input.parsedComments.map(c => c.severity),
          input.parsedComments.map(c => c.category),
          input.parsedComments.map(c => c.title),
          input.parsedComments.map(c => c.body),
          input.parsedComments.map(c => c.codeSuggestion ?? null),
          input.parsedComments.map(c => c.confidence ?? null),
        ],
      );
    }
  });
}

export async function recordRetryableFileReviewFailure(
  env: Pick<AppBindings, 'HYPERDRIVE'>,
  jobId: string,
  input: {
    filePath: string;
    // Optional review pass, defaults to 'main' (NREG-01). A missing security unit records its OWN
    // retryable failure row keyed on (job_id, file_path, 'security') rather than colliding with main.
    pass?: FileReviewPass;
    modelUsed: string;
    modelProvider?: string | null;
    diffLineCount: number;
    diffInput: string | null;
    durationMs: number | null;
    errorMessage: string;
  },
) {
  return await queryTransaction(env, async (tx) => {
    const [review] = await tx.query<{ id: string; transient_error_count: number }>(
      `
        INSERT INTO file_reviews (
          job_id,
          file_path,
          file_status,
          model_used,
          model_provider,
          diff_line_count,
          diff_input,
          raw_ai_output,
          input_tokens,
          output_tokens,
          duration_ms,
          verdict,
          file_summary,
          overall_correctness,
          confidence_score,
          error_msg,
          transient_error_count,
          pass
        )
        VALUES ($1::uuid, $2, 'failed', $3, $4, $5, $6, NULL, NULL, NULL, $7, NULL, NULL, NULL, NULL, $8, 1, $9)
        ON CONFLICT (job_id, file_path, pass) DO UPDATE SET
          file_status = 'failed',
          model_used = EXCLUDED.model_used,
          model_provider = EXCLUDED.model_provider,
          diff_line_count = EXCLUDED.diff_line_count,
          diff_input = EXCLUDED.diff_input,
          raw_ai_output = NULL,
          input_tokens = NULL,
          output_tokens = NULL,
          duration_ms = EXCLUDED.duration_ms,
          verdict = NULL,
          file_summary = NULL,
          overall_correctness = NULL,
          confidence_score = NULL,
          error_msg = EXCLUDED.error_msg,
          transient_error_count = file_reviews.transient_error_count + 1
        RETURNING id, transient_error_count
      `,
      [
        jobId,
        input.filePath,
        input.modelUsed,
        input.modelProvider ?? null,
        input.diffLineCount,
        input.diffInput,
        input.durationMs,
        input.errorMessage,
        input.pass ?? 'main',
      ],
    );

    await tx.query('DELETE FROM review_comments WHERE file_review_id = $1::uuid', [review.id]);
    return review.transient_error_count;
  });
}

/**
 * Copy every still-needed, inheritable parent review (and its comments) into `jobId` in a single
 * cheap DB pass. A retry that can reuse the parent's completed reviews would otherwise re-persist
 * them one file at a time through the budget-limited review loop (~5 files/chunk, hibernating a
 * fresh invocation between chunks), turning a fully-inheritable retry into a many-minute crawl.
 * This collapses all of them into one transaction (a couple of subrequests total, regardless of
 * file count) so the review phase finishes in a single invocation. `units` must already be
 * filtered to (file_path, pass) UNITS that are inheritable under the current model strategy and have
 * no row yet in the target job. Returns the units that were actually inserted.
 *
 * UNIT-keyed (not path-keyed) so a file's 'main' and 'security' rows never conflate: the copy SELECTs
 * and RETURNs pass, the WHERE matches the requested (file_path, pass) tuples, and the comment
 * re-attach JOIN matches parent rows on BOTH file_path AND pass. A main parent's comments therefore
 * can never attach to an inherited security row (or vice-versa), and a security-disabled retry that
 * passes only its 'main' unit provably inherits no security row.
 */
export async function bulkInheritFileReviews(
  env: Pick<AppBindings, 'HYPERDRIVE'>,
  input: { jobId: string; parentJobId: string; units: Array<{ filePath: string; pass: FileReviewPass }> },
): Promise<Array<{ filePath: string; pass: FileReviewPass }>> {
  if (input.units.length === 0) return [];

  const filePaths = input.units.map((u) => u.filePath);
  const passes = input.units.map((u) => u.pass);

  return await queryTransaction(env, async (tx) => {
    const inserted = await tx.query<{ id: string; file_path: string; pass: FileReviewPass }>(
      `
        INSERT INTO file_reviews (
          job_id, file_path, pass, file_status, model_used, diff_line_count, diff_input,
          raw_ai_output, input_tokens, output_tokens, duration_ms, verdict,
          file_summary, overall_correctness, confidence_score, error_msg, model_provider
        )
        SELECT $1::uuid, file_path, pass, file_status, model_used, diff_line_count, diff_input,
          raw_ai_output, input_tokens, output_tokens, duration_ms, verdict,
          file_summary, overall_correctness, confidence_score, error_msg, model_provider
        FROM file_reviews
        WHERE job_id = $2::uuid AND file_status = 'done'
          AND (file_path, pass) IN (SELECT * FROM UNNEST($3::text[], $4::text[]))
        ON CONFLICT (job_id, file_path, pass) DO NOTHING
        RETURNING id, file_path, pass
      `,
      [input.jobId, input.parentJobId, filePaths, passes],
    );

    if (inserted.length > 0) {
      // Re-attach each inherited review's comments, mapping parent rows to the new ids by (path, pass)
      // so a comment is only ever attached to the SAME pass it came from.
      await tx.query(
        `
          INSERT INTO review_comments (
            file_review_id, path, line, position, severity, category, title, body, code_suggestion, confidence
          )
          SELECT nw.new_id, rc.path, rc.line, rc.position, rc.severity, rc.category, rc.title, rc.body, rc.code_suggestion, rc.confidence
          FROM UNNEST($1::uuid[], $2::text[], $3::text[]) AS nw(new_id, file_path, pass)
          JOIN file_reviews pf ON pf.job_id = $4::uuid AND pf.file_path = nw.file_path AND pf.pass = nw.pass
          JOIN review_comments rc ON rc.file_review_id = pf.id
        `,
        [inserted.map((r) => r.id), inserted.map((r) => r.file_path), inserted.map((r) => r.pass), input.parentJobId],
      );
    }

    return inserted.map((r) => ({ filePath: r.file_path, pass: r.pass }));
  });
}

/**
 * Phase 19 (PASS-02): update the per-file ensemble result (ensembleResultSchema-shaped) on the
 * (job_id, file_path, pass) row. Mirrors `updateJobCriticResult` (jobs.ts): a single UPDATE
 * writes the JSONB column with the versioned blob, treating the column as a fully-owned durable
 * cursor. The caller owns the reconciliation logic and the runOutcomes array; this function is
 * the single write boundary.
 *
 * `result` MUST validate against `ensembleResultSchema`; the schema's additive `.passthrough()`
 * means future Phase-19 fields are accepted by older readers (NREG-01) and any new fields are
 * already-shaped at the call site. Returns the number of rows updated.
 */
export async function updateFileReviewEnsembleResult(
  env: Pick<AppBindings, 'HYPERDRIVE'>,
  input: {
    jobId: string;
    filePath: string;
    pass: FileReviewPass;
    result: unknown;
  },
): Promise<number> {
  const rows = await queryRows<{ count: number }>(
    env,
    `
      UPDATE file_reviews
      SET ensemble_result = $4::jsonb
      WHERE job_id = $1::uuid AND file_path = $2 AND pass = $3
      RETURNING 1::int AS count
    `,
    [input.jobId, input.filePath, input.pass, JSON.stringify(input.result)],
  );
  return rows.length;
}

/**
 * Mark many files 'failed' in a single INSERT. Finalize backfills reviews for files that never got
 * one (e.g. files that appeared mid-review, or unrecoverable ones); doing that one-by-one through
 * upsertFileReview runs a transaction per file (several Hyperdrive round-trips each), which for a
 * large/growing PR can blow the per-invocation subrequest budget right before the review is posted.
 * This collapses the whole backfill into one statement (one subrequest). Skips files that already
 * have a row (ON CONFLICT DO NOTHING) so it never clobbers a real review.
 *
 * UNIT-keyed: each entry carries its own `pass`, so a missing 'security' unit gets its OWN failed
 * backfill row keyed on (job_id, file_path, 'security') rather than being silently absorbed by the
 * existing 'main' row for the same file.
 */
export async function bulkMarkFilesFailed(
  env: Pick<AppBindings, 'HYPERDRIVE'>,
  jobId: string,
  files: Array<{ filePath: string; pass: FileReviewPass; diffLineCount: number }>,
  opts: { modelUsed: string; errorMessage: string },
): Promise<void> {
  if (files.length === 0) return;
  await queryRows(
    env,
    `
      INSERT INTO file_reviews (job_id, file_path, pass, file_status, model_used, diff_line_count, diff_input, error_msg, duration_ms)
      SELECT $1::uuid, u.file_path, u.pass, 'failed', $2, u.diff_line_count, '', $3, 0
      FROM UNNEST($4::text[], $5::text[], $6::int[]) AS u(file_path, pass, diff_line_count)
      ON CONFLICT (job_id, file_path, pass) DO NOTHING
    `,
    [jobId, opts.modelUsed, opts.errorMessage, files.map((f) => f.filePath), files.map((f) => f.pass), files.map((f) => f.diffLineCount)],
  );
}

export async function getModelUsageStats(env: Pick<AppBindings, 'HYPERDRIVE'>) {
  return queryRows<{
    model_used: string;
    model_provider: string | null;
    calls: number;
    input_tokens: number | null;
    output_tokens: number | null;
  }>(
    env,
    `
      SELECT
        model_used,
        MIN(model_provider) AS model_provider,
        COUNT(*)::int AS calls,
        COALESCE(SUM(input_tokens), 0)::int AS input_tokens,
        COALESCE(SUM(output_tokens), 0)::int AS output_tokens
      FROM file_reviews
      GROUP BY model_used
      ORDER BY calls DESC, model_used ASC
    `,
  );
}

export async function getFileReviewsForJobs(env: Pick<AppBindings, 'HYPERDRIVE'>, jobIds: string[]) {
  if (jobIds.length === 0) return [];

  const rows = await queryRows<{
    id: string;
    job_id: string;
    file_path: string;
    pass: 'main' | 'security';
    file_status: 'pending' | 'done' | 'skipped' | 'failed';
    model_used: string;
    diff_line_count: number;
    diff_input: string | null;
    raw_ai_output: string | null;
    parsed_comments: ParsedReviewComment[] | string;
    input_tokens: number | null;
    output_tokens: number | null;
    duration_ms: number | null;
    verdict: 'approve' | 'comment' | null;
    file_summary: string | null;
    overall_correctness: string | null;
    confidence_score: number | null;
    error_msg: string | null;
    model_provider: string | null;
    transient_error_count: number;
    async_request_id: string | null;
    async_model: string | null;
    // Phase 19 (PASS-02): per-file ensemble result (ensemble_resultSchema) — read alongside the
    // other columns so a downstream review-flow consumer can read the durable cursor in one
    // round-trip. Defaulted to null (parseJsonColumn degrades) for the runs:1 inert path.
    ensemble_result: unknown;
  }>(
    env,
    `
      SELECT
        fr.*,
        COALESCE(
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
        ) AS parsed_comments
      FROM file_reviews fr
      WHERE fr.job_id = ANY($1::uuid[])
      ORDER BY fr.created_at ASC
    `,
    [jobIds],
  );

  return rows.map((row) => {
    const rawEnsembleResult = parseJsonColumn<unknown>(row.ensemble_result, null);
    const ensembleParsed = rawEnsembleResult === null
      ? null
      : ensembleResultSchema.safeParse(rawEnsembleResult);
    return {
      ...row,
      parsed_comments: parseJsonColumn(row.parsed_comments, []),
      // A malformed durable ensemble cursor must not poison the file-review list; the reconciler
      // can treat null as an absent cursor and recover from the persisted comments row.
      ensemble_result: ensembleParsed?.success ? ensembleParsed.data : null,
    };
  });
}
