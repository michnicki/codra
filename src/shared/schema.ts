import { z } from 'zod';

export const reviewTriggers = ['auto', 'mention', 'retry'] as const;
export const jobStatuses = ['queued', 'running', 'done', 'failed', 'superseded', 'cancelled', 'stopped'] as const;
export const fileStatuses = ['pending', 'done', 'skipped', 'failed'] as const;
export const reviewVerdicts = ['approve', 'comment'] as const;
export const reviewSeverities = ['P0', 'P1', 'P2', 'P3', 'nit'] as const;
export const reviewCategories = ['security', 'bugs', 'performance', 'correctness', 'quality'] as const; // Keeping for DB compatibility but will deprecate usage in prompts
export type ReviewSeverity = typeof reviewSeverities[number];
export type ReviewCategory = typeof reviewCategories[number];

// v1.2 severity-band map (SEV-04). Maps every review severity to its PRD display band. Per the
// REQUIREMENTS.md standing decision the PRD bands are: blocker = P0/P1, warning = P2, suggestion =
// P3, nitpick = nit (no historical-row migration). Review fix (OpenCode LOW): P0 and P1 MUST resolve
// to the IDENTICAL 'blocker' band — a Record<ReviewSeverity, ...> alone permitted them to diverge,
// so both are written to the literal string 'blocker' here AND asserted equal in the contract test.
// `as const satisfies` locks the exact value shape so the type checker rejects any drift.
export const severityBandMap = {
  P0: 'blocker',
  P1: 'blocker',
  P2: 'warning',
  P3: 'suggestion',
  nit: 'nitpick',
} as const satisfies Record<ReviewSeverity, 'blocker' | 'warning' | 'suggestion' | 'nitpick'>;
export const llmApiFormats = ['openai', 'anthropic', 'gemini', 'cloudflare-workers-ai'] as const;
export const vcsProviders = ['github', 'bitbucket'] as const;
export type VcsProvider = typeof vcsProviders[number];

export const dateStringSchema = z.union([z.string(), z.date()]).transform((d) => (d instanceof Date ? d.toISOString() : d));
export const coerceNumberSchema = z.coerce.number();

export const jobStepSchema = z.object({
  name: z.string(),
  status: z.enum(['pending', 'running', 'done', 'failed']),
  startedAt: dateStringSchema.nullable(),
  finishedAt: dateStringSchema.nullable(),
  error: z.string().nullable().optional(),
});

export const parsedReviewCommentSchema = z.object({
  path: z.string().min(1),
  line: z.number().int().positive().nullable().optional(),
  position: z.number().int().positive().nullable().optional(),
  severity: z.enum(reviewSeverities),
  // D-05: default changed 'quality' -> 'correctness'. Now that category is meaningful (v1.2 severity
  // engine) rather than a universal catch-all, 'correctness' is the neutral fail-open default.
  category: z.enum(reviewCategories).default('correctness'),
  title: z.string().min(1),
  body: z.string().min(1),
  codeSuggestion: z.string().min(1).nullable().optional(),
  // v1.2: the ORIGINAL code the finding refers to (used by later phases for dedup / fix-verification
  // context). nullable + optional following the same fail-open convention as codeSuggestion/confidence
  // so a provider that omits it is representable and never throws the parse.
  existingCode: z.string().nullable().optional(),
  // Per-finding model confidence (0..1). Threaded parse -> persist -> reconstruct -> finalize.
  // nullable + optional so a provider that omits it is representable and treated fail-open.
  confidence: z.number().min(0).max(1).nullable().optional(),
});

export const fileReviewModelOutputSchema = z.object({
  findings: z.array(
    z.object({
      title: z.string().max(100),
      body: z.string().min(1),
      confidence_score: z.number().min(0).max(1).optional(),
      priority: z.number().int().min(0).max(3).optional(),
      // v1.2: the model-emitted category, kept as a LOOSE z.string() (NOT z.enum(reviewCategories))
      // on purpose — an enum here would throw the ENTIRE per-file parse when the model returns free
      // text or an invalid value. D-06 requires exact-match-or-fail-open, which is resolved downstream
      // in core/severity.ts (Plan 13-02), not at parse time.
      category: z.string().optional(),
      code_location: z.object({
        absolute_file_path: z.string(),
        line_range: z.object({
          start: z.number().int().positive(),
          end: z.number().int().positive(),
        }).optional(),
        line: z.number().int().positive().optional(),
      }),
      code_suggestion: z.string().optional(),
    }),
  ),
  overall_correctness: z.string().optional().default('patch is correct'),
  overall_explanation: z.string().optional().default('Review completed (partial output).'),
  overall_confidence_score: z.number().min(0).max(1).optional(),
});

export const summaryModelOutputSchema = z.union([
  z.array(z.object({ summary: z.string().min(1) })),
  z.object({ summary: z.string().min(1) }),
]);

export const labelsSchema = z.union([
  z.literal(false),
  z.object({
    p1: z.string().min(1),
    p2: z.string().min(1),
    p3: z.string().min(1),
  }),
]);

export const reviewConfigSchema = z.object({
  on: z.array(z.enum(['opened', 'synchronize', 'ready_for_review', 'reopened', 'closed'])).default(['opened', 'synchronize', 'ready_for_review', 'reopened']),
  ignore_drafts: z.boolean().default(true),
  mention_trigger: z.union([z.literal(false), z.string().min(1)]).default('@codra-app'),
  skip_files: z
    .array(z.string().min(1))
    .default(['**/*.lock', 'dist/**', 'build/**', '.next/**', '*.generated.*', 'coverage/**']),
  max_files: z.number().int().min(1).max(150).default(150),
  large_file_threshold_lines: z.number().int().min(1).max(5_000).default(200),
  max_diff_lines_per_file: z.number().int().min(1).max(5_000).default(800),
  max_total_diff_chars: z.number().int().min(1).max(500_000).default(150_000),
  max_comments: z.number().int().min(1).max(150).default(10),
  min_severity: z.enum(reviewSeverities).default('nit'),
  // Finalize confidence floor: findings whose per-finding confidence is below this are dropped
  // (fail-open — a finding with null/undefined confidence is always kept). Default 0.7.
  min_confidence: z.number().min(0).max(1).default(0.7),
  focus: z.array(z.enum(reviewCategories)).default([...reviewCategories]),
  // Bounded at the config-write boundary so a malicious/oversized custom rule cannot
  // dominate the review prompt (prompt-injection hardening, Group D-1): each rule is
  // capped at 500 chars and the list at 50 entries. Field name/shape unchanged.
  custom_rules: z.array(z.string().min(1).max(500)).max(50).default([]),
  labels: labelsSchema.default({
    p1: 'review: needs-attention',
    p2: 'review: approved',
    p3: 'review: approved',
  }),
  exec: z
    .object({
      enabled: z.boolean().default(false),
      on_file_types: z.array(z.string().min(1)).default(['.ts', '.tsx', '.js']),
      command: z.string().min(1).default('npm run lint && npm run typecheck'),
    })
    .default({
      enabled: false,
      on_file_types: ['.ts', '.tsx', '.js'],
      command: 'npm run lint && npm run typecheck',
    }),
  // Phase 7 contract-first feature toggles (D-04/D-05/D-06). Every block and every `enabled`
  // carries an explicit `false` default so `repoConfigSchema.parse({})` yields all-off (NREG-01
  // inertness). Grouped (never a flat boolean namespace, never a single master switch) so later
  // phases (8-11) can wire each capability behind its own toggle without a breaking contract edit.
  // Uniform `{ enabled: boolean }` shape leaves room for per-toggle config fields later.
  // D-09: `sequence_diagram` defaults ON so that enabling the walkthrough gets a Mermaid diagram on
  // GitHub by default — it stays inert while `walkthrough.enabled` is false (the whole feature is off),
  // and is additionally hard-gated at render time by provider (Bitbucket never emits a Mermaid fence).
  // So the sub-toggle's `true` default cannot regress NREG-01: `repoConfigSchema.parse({})` still has
  // `walkthrough.enabled === false`, i.e. no walkthrough is produced at all.
  walkthrough: z
    .object({
      enabled: z.boolean().default(false),
      sequence_diagram: z.object({ enabled: z.boolean().default(true) }).default({ enabled: true }),
    })
    .default({ enabled: false, sequence_diagram: { enabled: true } }),
  passes: z
    .object({
      security: z.object({ enabled: z.boolean().default(false) }).default({ enabled: false }),
      // `skip_threshold` / `input_char_budget` are OPTIONAL critic tuning knobs (review suggestion):
      // when unset, 10-06 falls back to its in-code constants, so absence is behavior-identical.
      // Additive optional fields keep `passes.critic` all-off by default (NREG-01 inertness).
      critic: z
        .object({
          enabled: z.boolean().default(false),
          skip_threshold: z.number().int().nonnegative().optional(),
          input_char_budget: z.number().int().positive().optional(),
        })
        .default({ enabled: false }),
      // v1.2 ensemble pass (PASS-02, consumed by Phase 19). `runs: 1` is the INERT default — no
      // extra ensemble model calls fire at the default, so NREG-01 holds. Bounds guard against an
      // authenticated-but-malicious config write (T-13-01-01): runs 1-5, temperature 0-2.
      ensemble: z
        .object({
          runs: z.number().int().min(1).max(5).default(1),
          temperature: z.number().min(0).max(2).default(0.7),
        })
        .default({ runs: 1, temperature: 0.7 }),
    })
    .default({ security: { enabled: false }, critic: { enabled: false }, ensemble: { runs: 1, temperature: 0.7 } }),
  interactive: z
    .object({
      commands: z
        .object({
          enabled: z.boolean().default(false),
          // REVIEW (A1 authorization redesign, D-06): the deterministic per-repo Bitbucket
          // authorization allow-list the Bitbucket authz path now depends on. Additive + defaulted
          // to [] so repoConfigSchema.parse({}) is byte-identical to today (NREG-01).
          bitbucket_allowed_account_ids: z.array(z.string()).default([]),
          // CMD-07 (Layer 2): the IMMUTABLE Bitbucket account_id of the bot user. A Repository
          // Access Token 403s on `GET /2.0/user`, so a configured id lets the Bitbucket bot-identity
          // resolver self-filter WITHOUT that call. Nullable + defaulted to null so
          // repoConfigSchema.parse({}) stays byte-identical to today (NREG-01).
          bitbucket_bot_account_id: z.string().nullable().default(null),
        })
        .default({ enabled: false, bitbucket_allowed_account_ids: [], bitbucket_bot_account_id: null }),
      qa: z
        .object({
          enabled: z.boolean().default(false),
          // REVIEW (OpenCode 11-04): the Q&A hourly cap as a config knob, not a hardcoded constant.
          // Additive + defaulted so an existing config parses byte-identically (NREG-01).
          rate_limit_per_hour: z.number().int().positive().default(10),
        })
        .default({ enabled: false, rate_limit_per_hour: 10 }),
    })
    .default({
      commands: { enabled: false, bitbucket_allowed_account_ids: [], bitbucket_bot_account_id: null },
      qa: { enabled: false, rate_limit_per_hour: 10 },
    }),
  // v1.2 severity/category engine + lifecycle toggle blocks (SEV-01..04, consumed by Phases 14/18/19).
  // Follows the existing uniform `{ enabled: boolean }` toggle-block shape.
  // DELIBERATE DEFAULT EXCEPTION (D-01/D-02): every other Phase-7 toggle defaults `false` for NREG-01
  // inertness, but `severity_engine.enabled` and `dedup.enabled` default `true` — they are documented
  // correctness-fix / always-on exceptions (FILT-03), not new opt-in features.
  severity_engine: z.object({ enabled: z.boolean().default(true) }).default({ enabled: true }),
  dedup: z.object({ enabled: z.boolean().default(true) }).default({ enabled: true }),
  // Priority file selection + generated-file detection toggle (PRIO-01/PRIO-02, consumed by Plan 15-03's
  // core/diff.ts selection routine). DELIBERATE DEFAULT EXCEPTION (D-01/D-02): defaults `true` — it is
  // the documented NREG-01 always-on exception #3, alongside severity_engine and dedup, framed as a
  // correctness improvement (review the highest-signal files first, skip generated noise) rather than a
  // new opt-in feature. ONE combined key governs BOTH the priority sort AND the generated detector
  // (D-02) — deliberately NOT split into two toggles; the single escape hatch reverts both at once.
  file_selection: z.object({ enabled: z.boolean().default(true) }).default({ enabled: true }),
  // Per-category confidence-floor overrides (FILT-02, consumed by Phase 14). MUST be z.partialRecord,
  // NOT z.record: under this repo's Zod 4 (4.4.3) `z.record(z.enum(reviewCategories), ...)` demands
  // EVERY enum key, so a sparse override like `{ security: 0.85 }` throws for the other four
  // categories. z.partialRecord accepts the sparse object and leaves absent keys genuinely absent.
  // Empty {} is the inert default (no per-category override; global `min_confidence` still governs).
  // Value bounds 0-1 guard against an out-of-range malicious config write (T-13-01-01).
  category_confidence: z.partialRecord(z.enum(reviewCategories), z.number().min(0).max(1)).default({}),
  // Phase 19 fix-threading toggles (THR-01/THR-02). Both default false for NREG-01 inertness.
  threads: z
    .object({
      verify_fixes: z.boolean().default(false),
      auto_resolve: z.boolean().default(false),
    })
    .default({ verify_fixes: false, auto_resolve: false }),
  // Phase 18 incremental-round toggles. `incremental` defaults false per ROADMAP Phase 18's stated
  // default; `escalate_floors` defaults true but is inert at the schema level since it only takes
  // effect once `rounds.incremental` is also true (Phase 18's concern, not this phase's).
  rounds: z
    .object({
      incremental: z.boolean().default(false),
      escalate_floors: z.boolean().default(true),
    })
    .default({ incremental: false, escalate_floors: true }),
});

export const repoConfigSchema = z.object({
  review: reviewConfigSchema.default({
    on: ['opened', 'synchronize', 'ready_for_review', 'reopened'],
    ignore_drafts: true,
    mention_trigger: '@codra-app',
    skip_files: ['**/*.lock', 'dist/**', 'build/**', '.next/**', '*.generated.*', 'coverage/**'],
    max_files: 150,
    large_file_threshold_lines: 200,
    max_diff_lines_per_file: 800,
    max_total_diff_chars: 150_000,
    max_comments: 10,
    min_severity: 'nit',
    min_confidence: 0.7,
    focus: [...reviewCategories],
    custom_rules: [],
    labels: {
      p1: 'review: needs-attention',
      p2: 'review: approved',
      p3: 'review: approved',
    },
    exec: {
      enabled: false,
      on_file_types: ['.ts', '.tsx', '.js'],
      command: 'npm run lint && npm run typecheck',
    },
    // Mirror the toggle blocks in the inline literal default too, so `repoConfigSchema.parse({})`
    // yields each toggle at its documented default regardless of Zod default short-circuit semantics
    // for the nested `review` object (RESEARCH Open Q2). All Phase-7 toggles remain OFF here, but the
    // two documented always-on v1.2 exceptions — `severity_engine.enabled` and `dedup.enabled` —
    // deliberately default `true` (D-01/D-02, FILT-03), so this is no longer an "all-off" literal.
    walkthrough: { enabled: false, sequence_diagram: { enabled: true } },
    passes: { security: { enabled: false }, critic: { enabled: false }, ensemble: { runs: 1, temperature: 0.7 } },
    interactive: {
      commands: { enabled: false, bitbucket_allowed_account_ids: [], bitbucket_bot_account_id: null },
      qa: { enabled: false, rate_limit_per_hour: 10 },
    },
    severity_engine: { enabled: true },
    dedup: { enabled: true },
    file_selection: { enabled: true },
    category_confidence: {},
    threads: { verify_fixes: false, auto_resolve: false },
    rounds: { incremental: false, escalate_floors: true },
  }),
  model: z
    .object({
      main: z.string().nullable().default(null),
      fallbacks: z.array(z.string()).nullable().default([]),
      size_overrides: z
        .array(
          z.object({
            max_lines: z.number().int().positive(),
            model: z.string(),
            fallbacks: z.array(z.string()).optional(),
          }),
        )
        .nullable()
        .optional(),
    })
    .default({
      main: null,
      fallbacks: [],
      size_overrides: [],
    }),
});

export const reviewJobMessageSchema = z.object({
  jobId: z.uuid().optional(),
  deliveryId: z.string().min(1),
  // WIRE contract widened with 'critic' (D-07). The INTERNAL ReviewJobRunResult.phase union
  // (review.ts:57) and the dispatch switch (review.ts:412-417) intentionally stay
  // prepare|review|finalize — Phase 10 owns critic dispatch. A stray phase:'critic' message is
  // REJECTED at the resolveQueuedJob boundary (return null → acked), never coerced/run.
  phase: z.enum(['prepare', 'review', 'finalize', 'critic']).optional(),
  // Optional multi-pass routing fields (D-07). Kept `.optional()` (no default) so every
  // pre-widening producer/fixture — and ReviewJobMessage = z.input<...> — keeps compiling.
  kind: z.enum(['review', 'qa', 'command']).optional(),
  reviewScope: z.enum(['all', 'rest', 'head']).optional(),
  eventName: z.string().min(1).optional(),
  payload: z.unknown().optional(),
  installationId: z.string().min(1).optional(),
  owner: z.string().min(1).optional(),
  repo: z.string().min(1).optional(),
  prNumber: z.number().int().positive().optional(),
  commitSha: z.string().min(1).optional(),
  trigger: z.enum(reviewTriggers).optional(),
  requestId: z.string().optional(),
  // The actual Cloudflare Workflow instance id, injected by the workflow so runReviewJob can bind
  // it to the resolved job row (webhook jobs can't be bound at instance-create time).
  workflowInstanceId: z.string().optional(),
  // Set by lease recovery so the queue consumer creates a FRESH instance (keyed on deliveryId)
  // instead of colliding with the dead instance that is still keyed on jobId.
  forceFreshInstance: z.boolean().optional(),
  // Optional + defaulted so a queue message enqueued by code that predates this field (no
  // `provider` key at all) still validates and resolves to 'github' (NREG-03/Pitfall 10).
  provider: z.enum(vcsProviders).optional().default('github'),
  // Phase 11 (D-09/D-12): the classified command/Q&A context for kind='command'|'qa' messages. The
  // WHOLE object is `.optional()` (no default) so every pre-widening producer — and
  // ReviewJobMessage = z.input<typeof reviewJobMessageSchema> — keeps validating byte-identically
  // (NREG-01). Within it, authorId + body + workspace are REQUIRED so a consumer can reconstruct a
  // full CommentContext downstream (a reject persists reason=body, D-09). The superRefine below
  // tightens ONLY the kind ∈ {command, qa} branch to require this object + those identity fields.
  interactive: z
    .object({
      commandName: z.enum(['review', 'review-rest', 'pause', 'resume', 'help', 'reject']).optional(),
      question: z.string().optional(),
      authorId: z.string().min(1),
      authorLogin: z.string().optional(),
      body: z.string(),
      workspace: z.string().min(1),
      commentRef: z.string().optional(),
      parentRef: z.string().optional(),
      findingRef: z.string().optional(),
      sourceCommentRef: z.string().optional(),
      // Phase 12 (D-01): whether the originating comment can be threaded via a provider-native
      // reply. GitHub threads ONLY inline review comments (in_reply_to); a top-level issue comment
      // is NOT threadable, so the CALLER decides via this flag and falls back to createPrComment.
      // Additive + optional (no default) so reviewJobMessageSchema and ReviewJobMessage =
      // z.input<...> stay byte-identical (NREG-01).
      threadable: z.boolean().optional(),
      // Phase 11 (WR-01): the PROVIDER-SAFE per-repo config the webhook route already resolved at
      // classification time (GitHub via loadRepoConfig; Bitbucket via getRepoConfigByRepositoryId +
      // global-model overlay). Carried on the message so the INLINE consumer
      // (index.ts::dispatchInteractiveMessage) uses it directly instead of re-deriving via the
      // owner/repo path — which for Bitbucket collides across providers (getRepoConfigRecord has no
      // vcs_provider filter) and also triggers loadRepoConfig's GitHub-shaped getOrCreateRepository
      // side effect. Optional so pre-Phase-11 producers and in-flight messages still validate
      // (NREG-01); the consumer falls back to the legacy load only when it is absent.
      configSnapshot: repoConfigSchema.optional(),
    })
    .optional(),
}).superRefine((message, ctx) => {
  // Phase 11 (REVIEW: Codex 11-01 MED — weak interactive validation): an INTERNAL command/qa message
  // MUST carry a full interactive identity payload so a malformed message fails fast at parse rather
  // than deep in the consumer. This branch is checked FIRST and returns, so the no-kind path below is
  // never reached for these kinds (a command/qa message legitimately has no jobId/eventName).
  if (message.kind === 'command' || message.kind === 'qa') {
    const interactive = message.interactive;
    if (!interactive || !interactive.authorId || !interactive.body || !interactive.workspace) {
      ctx.addIssue({
        code: 'custom',
        message:
          "Interactive messages (kind 'command'|'qa') require interactive.authorId, interactive.body, and interactive.workspace.",
        path: ['interactive'],
      });
    }
    return;
  }

  // Unchanged no-kind path (NREG-01 byte-identity — do NOT touch).
  if (message.jobId || message.eventName) {
    return;
  }

  ctx.addIssue({
    code: 'custom',
    message: 'Queue message must include either jobId or eventName.',
    path: ['jobId'],
  });
});

// Critic-pass result (D-08). The critic re-judges main-review findings, keeping some and pruning
// others (each pruned finding carries a human-readable reason). `.passthrough()` so Phase 10 can
// add prune/audit metadata fields WITHOUT a breaking contract edit (the D-08 additive guardrail).
// Metadata scalars are optional/tolerant for the same reason. Reuses parsedReviewCommentSchema for
// kept/pruned findings so the critic speaks the same finding vocabulary as the main review.
export const criticResultSchema = z
  .object({
    kept: z.array(parsedReviewCommentSchema),
    pruned: z.array(
      z.object({
        finding: parsedReviewCommentSchema,
        reason: z.string(),
      }),
    ),
    model: z.string().optional(),
    inputTokens: z.number().int().optional(),
    outputTokens: z.number().int().optional(),
    // D-08 additive-only refinement (never touch the locked fields above). `skipped` is true when
    // 10-06 bypasses the critic model call (skip-threshold / input-char-budget / fail-open), so the
    // stored critic-result blob records that no pruning ran rather than looking like an empty prune.
    // `dedupedCount` records the deduped candidate-set size the critic was shown. Both optional so
    // every existing critic-result blob (and `criticResultSchema.parse({ kept: [], pruned: [] })`)
    // still parses unchanged.
    skipped: z.boolean().optional(),
    dedupedCount: z.number().int().optional(),
  })
  .passthrough();
export type CriticResult = z.infer<typeof criticResultSchema>;

// D-05 ID-based critic MODEL-OUTPUT contract (distinct from the DB-persisted criticResultSchema
// above). The critic returns ONLY opaque numeric ids to DROP plus a reason per id — never full
// findings, never a keep-list — which 10-06 reconciles back to findings in code (the index-assigned
// ids close the gap that parsedReviewCommentSchema has no stable id). `.passthrough()` so a critic
// that emits extra metadata still parses fail-soft.
export const criticPruneOutputSchema = z
  .object({
    prune: z.array(
      z.object({
        id: z.number().int().nonnegative(),
        reason: z.string(),
      }),
    ),
  })
  .passthrough();
export type CriticPruneOutput = z.infer<typeof criticPruneOutputSchema>;

export const jobSummarySchema = z.object({
  id: z.uuid(),
  workflowInstanceId: z.string().nullable().optional(),
  owner: z.string(),
  repo: z.string(),
  // REV-C-3: nullable for Bitbucket rows (which carry no installation_id after migration 005).
  // GitHub rows continue to carry a non-null string. `.nullable().optional()` so existing
  // pre-widening fixtures (which never supply it) still parse and the GitHub call chain in
  // test/webhook-handling.spec.ts stays byte-identical.
  installationId: z.string().nullable().optional(),
  prNumber: z.number().int(),
  prTitle: z.string().nullable(),
  prAuthor: z.string().nullable(),
  commitSha: z.string(),
  trigger: z.enum(reviewTriggers),
  status: z.enum(jobStatuses),
  verdict: z.enum(reviewVerdicts).nullable(),
  fileCount: z.number().int(),
  commentCount: z.number().int(),
  totalInputTokens: z.number().int(),
  totalOutputTokens: z.number().int(),
  createdAt: dateStringSchema,
  updatedAt: dateStringSchema,
  nextRetryAt: dateStringSchema.nullable().optional(),
  startedAt: dateStringSchema.nullable(),
  finishedAt: dateStringSchema.nullable(),
  errorMessage: z.string().nullable(),
  overallConfidenceScore: z.number().nullable().optional(),
  overallCorrectness: z.string().nullable().optional(),
  steps: z.array(jobStepSchema).default([]),
  checkRunId: coerceNumberSchema.nullable().optional(),
  configSnapshot: repoConfigSchema.nullable().optional(),
  retryOfJobId: z.uuid().nullable().optional(),
  // R-01: expose the parent repository's provider + workspace so VcsService.forRepo can branch
  // without a separate query. Optional so pre-widening fixtures still parse.
  repositoryVcsProvider: z.enum(vcsProviders).optional(),
  repositoryWorkspace: z.string().nullable().optional(),
  // REV-R-E: pass-through for the new jobs.status_check_ref column (Bitbucket Code Insights
  // report key / generic status reference). Used by Plan 03's runPreparePhase writer and the
  // runFinalizePhase gate widening. Optional so pre-widening fixtures still parse.
  statusCheckRef: z.string().nullable().optional(),
  // Phase 7 pass-through for the new jobs.walkthrough_comment_ref / jobs.critic_result columns
  // (Plan 04 adds the accessors; Phase 8/10 wire the writers). Optional so pre-widening fixtures
  // still parse; `.nullable()` because the DB columns are nullable and unset until a later phase.
  walkthroughCommentRef: z.string().nullable().optional(),
  criticResult: criticResultSchema.nullable().optional(),
  // Phase 11 (REVIEW: Codex 11-05 HIGH): pass-through for the migration-009 jobs.review_scope /
  // jobs.scope_source_job_id columns so the review-rest scope lives on the PERSISTED job row and
  // survives fresh-instance handoff + lease recovery (not the transient queue message). Both are
  // null on every existing insert (no writer wired this plan) — additive, behaviorally inert
  // (NREG-01). `.nullable().optional()` so pre-widening fixtures still parse.
  reviewScope: z.enum(['all', 'rest', 'head']).nullable().optional(),
  scopeSourceJobId: z.uuid().nullable().optional(),
});

export const jobsQuerySchema = z.object({
  owner: z.string().optional(),
  repo: z.string().optional(),
  status: z.enum(jobStatuses).optional(),
  verdict: z.enum(reviewVerdicts).optional(),
  search: z.string().optional(),
  limit: z.preprocess((v) => Number(v), z.number().int().min(1).max(100)).default(20),
  offset: z.preprocess((v) => Number(v), z.number().int().min(0)).default(0),
});

export type JobsQuery = z.infer<typeof jobsQuerySchema>;
export type JobStep = z.infer<typeof jobStepSchema>;

// D-07 pass value-set, locked contract-first (closes the file_reviews.pass gap so Phase 10 needs
// no cross-layer contract edit). 'main' is today's single review pass; 'security' is Phase 10's
// dedicated pass. Widen this enum when a new pass is introduced.
export const fileReviewPassSchema = z.enum(['main', 'security']);
export type FileReviewPass = z.infer<typeof fileReviewPassSchema>;

// Canonical (file_path, pass) tuple identity for the multi-pass engine. The review-consensus HIGH
// finding was that the engine introduced a second `pass` dimension while keeping identity path-only,
// which conflates a file's main and security units. This helper is the single source of truth the
// review maps / completion / inheritance in 10-05/10-06 key on. The separator is NUL ('\0'), which
// cannot occur in a POSIX file path, so the key is injective over (file_path, pass).
export type ReviewUnitKey = string;
export function reviewUnitKey(filePath: string, pass: FileReviewPass): ReviewUnitKey {
  // Separator is NUL, written as the readable `\0` escape (an invisible literal NUL byte here is
  // easily misread as a space). NUL cannot occur in a POSIX file path, so the key is injective
  // over (file_path, pass) for ANY future pass value. Used purely as an opaque in-memory Map/Set
  // key — never persisted, split, or serialized.
  return `${filePath}\0${pass}`;
}

export const fileReviewRecordSchema = z.object({
  id: z.uuid(),
  jobId: z.uuid(),
  filePath: z.string(),
  // `.default('main')` is REQUIRED for inertness: jobDetailSchema.parse (jobs.ts) builds `files`
  // from a JSON_BUILD_OBJECT that omits `pass`, so a required-no-default field would break that
  // parse — with the default it resolves to 'main' and the job-detail read path stays byte-identical
  // (Plan 02 surfaces the real value via getFileReviewsForJobs; Phase 10 may then emit `pass`).
  pass: fileReviewPassSchema.default('main'),
  fileStatus: z.enum(fileStatuses),
  modelUsed: z.string(),
  modelProvider: z.string().optional(),
  diffLineCount: z.number().int().nullable(),
  diffInput: z.string().nullable(),
  rawAiOutput: z.string().nullable(),
  parsedComments: z.array(parsedReviewCommentSchema),
  inputTokens: z.number().int().nullable(),
  outputTokens: z.number().int().nullable(),
  durationMs: z.number().int().nullable(),
  verdict: z.enum(reviewVerdicts).nullable(),
  fileSummary: z.string().nullable(),
  overallCorrectness: z.string().nullable().optional(),
  confidenceScore: z.number().nullable().optional(),
  errorMessage: z.string().nullable(),
  createdAt: dateStringSchema,
});

// v1.2 job audit trail (AUD-01). A discriminated union on `stage` — two variants this phase:
//   - `drafted`: a per-file review pass was drafted. REUSES the canonical fileReviewPassSchema for
//     its `pass` field (Codex LOW: pass validation was previously duplicated inline) (D-10).
//   - `severity_adjusted`: a severity rule promoted/demoted a finding (D-09).
// Each variant ends with `.passthrough()`, mirroring criticResultSchema's additive-extension
// precedent (D-08) so Phases 14/15/18/19 can ADD new fields non-breakingly. This union deliberately
// REJECTS an unknown `stage` at the single-event level so a malformed event is detectable (Codex
// MEDIUM): AUD-01's "open event union" is served by later phases ADDING new `stage` variants AND by
// Plan 13-03's READ side parsing the stored array PER-ELEMENT so one unknown/future event never
// erases the whole trail — do NOT loosen this schema to a catch-all here.
export const jobAuditEventSchema = z.discriminatedUnion('stage', [
  z
    .object({
      stage: z.literal('drafted'),
      file: z.string(),
      pass: fileReviewPassSchema,
      timestamp: dateStringSchema,
    })
    .passthrough(),
  z
    .object({
      stage: z.literal('severity_adjusted'),
      rule: z.string(),
      matched: z.string(),
      from: z.enum(reviewSeverities),
      to: z.enum(reviewSeverities),
      timestamp: dateStringSchema,
    })
    .passthrough(),
  // Phase 14 FILT-04 drop events. `filtered` is an AGGREGATE event (one per rule; for
  // confidence_floor one per DISTINCT effective floor — 14-02 finding #2) recording how many
  // findings a noise-filter rule dropped, with a bounded (<=20 downstream) `sample` of the
  // findings it dropped. `deduped` is a PER-MERGE event (one per near-duplicate merge). Both are
  // additive per D-06 (the two variants above are byte-unchanged) and privacy-bounded per the
  // Phase 13 T-13-03-03 posture: the `sample` / `survivor` / `suppressed` identifiers admit ONLY
  // { path, line, title } and NEVER body / diff / existingCode / codeSuggestion. The extra
  // severity/category/confidence (on filtered.sample) and titleSimilarity/bodySimilarity (on
  // deduped) fields are non-sensitive DECISION METRICS — "the values that dropped it" — added for
  // FILT-04 explainability (review finding #4), not raw finding content.
  z
    .object({
      stage: z.literal('filtered'),
      rule: z.enum(['confidence_floor', 'severity_floor', 'cap']),
      count: z.number().int(),
      // The effective threshold the rule applied: the confidence floor max(global, category) as a
      // float, a min_severity band, or the effectiveMaxComments integer.
      threshold: z.union([z.number(), z.enum(reviewSeverities)]),
      sample: z.array(
        z.object({
          path: z.string(),
          line: z.number().nullable().optional(),
          title: z.string(),
          // Non-sensitive decision metrics explaining WHY each sampled finding fell below the rule
          // (review finding #4) — optional; never body/diff/existingCode/codeSuggestion.
          severity: z.enum(reviewSeverities).optional(),
          category: z.enum(reviewCategories).optional(),
          confidence: z.number().min(0).max(1).nullable().optional(),
        }),
      ),
      timestamp: dateStringSchema,
    })
    .passthrough(),
  z
    .object({
      stage: z.literal('deduped'),
      rule: z.enum(['rule1', 'rule2', 'rule3', 'rule4']),
      survivor: z.object({ path: z.string(), line: z.number().nullable().optional(), title: z.string() }),
      suppressed: z.object({ path: z.string(), line: z.number().nullable().optional(), title: z.string() }),
      // The word-Jaccard scores that caused the merge (review finding #4) — nullable because rule1
      // has no title check and only rule4 uses a body measure.
      titleSimilarity: z.number().nullable().optional(),
      bodySimilarity: z.number().nullable().optional(),
      timestamp: dateStringSchema,
    })
    .passthrough(),
  // Phase 15 drop events. Both additive per D-08 (the four variants above stay byte-unchanged) and
  // privacy-bounded per the Phase 13 T-13-03-03 posture: the sample / identifier objects admit ONLY
  // { path, line?, title? } and NEVER body / diff / existingCode / codeSuggestion. Privacy is
  // ultimately enforced by exact PRODUCER construction (audit.ts 15-05 / model-output.ts 15-04); the
  // .passthrough() here preserves additive-compat but does not by itself strip an extra top-level key.
  //
  // `file_skipped` (D-11/D-12): an AGGREGATE event — priority file selection skipped `count` files for
  // one `reason`, with a bounded `sample` of the skipped paths. `reason` is `generated` (content-based
  // generated-file detector) or `over_cap` (below the priority cut). `skip_glob` is deliberately NOT a
  // reason value (D-12) — glob-skipped files never enter the selection routine. NOTE: `line` and
  // `title` on the sample are kept ONLY for event-shape consistency with the other audit variants —
  // they are unused for file-level skips (a skipped file has no finding line or title) (Antigravity LOW).
  z
    .object({
      stage: z.literal('file_skipped'),
      reason: z.enum(['generated', 'over_cap']),
      count: z.number().int(),
      sample: z.array(
        z.object({
          path: z.string(),
          line: z.number().nullable().optional(),
          title: z.string().optional(),
        }),
      ),
      timestamp: dateStringSchema,
    })
    .passthrough(),
  // `evidence_missing` (D-17, EVID-01): a PER-FINDING event — the soft evidence gate could not confirm
  // a finding's model-emitted `existing_code` against the cleaned hunk. `reason` discriminates `absent`
  // (no/empty evidence string emitted) from `not_in_hunk` (evidence present but not found in the diff).
  z
    .object({
      stage: z.literal('evidence_missing'),
      reason: z.enum(['absent', 'not_in_hunk']),
      path: z.string(),
      line: z.number().nullable().optional(),
      title: z.string(),
      timestamp: dateStringSchema,
    })
    .passthrough(),
]);
export type JobAuditEvent = z.infer<typeof jobAuditEventSchema>;

export const jobDetailSchema = jobSummarySchema.extend({
  baseSha: z.string(),
  headRef: z.string().nullable(),
  baseRef: z.string().nullable(),
  summaryMarkdown: z.string().nullable(),
  configSnapshot: repoConfigSchema.nullable(),
  reviewId: coerceNumberSchema.nullable(),
  retryOfJobId: z.uuid().nullable(),
  summaryModel: z.string().nullable(),
  files: z.array(fileReviewRecordSchema),
  // v1.2 audit trail (D-11). These live on the DETAIL contract ONLY, never on jobSummarySchema.
  // Review fix (Codex, Divergent Views): jobSummarySchema is mapped by listJobs (every row on a
  // 100-job page) AND by the workflow lease-claim (getJobForProcessing) via mapJob — placing the
  // audit array there would fetch + Zod-validate up to ~50,000 events per page and on every lease
  // claim. On jobDetailSchema (a single-job getJobDetail read) the array is parsed exactly once when
  // a user opens one job. Defaults ([] / false) so a pre-Phase-13 job object with neither key parses.
  audit: z.array(jobAuditEventSchema).default([]),
  auditTruncated: z.boolean().default(false),
});

export const repoConfigRecordSchema = z.object({
  // D-04: nullable so a Bitbucket record (NULL installation_id — Bitbucket has no GitHub-App
  // installation concept) parses without throwing the Zod error that 500s the config read.
  installationId: z.string().nullable(),
  owner: z.string(),
  repo: z.string(),
  // OPTIONAL (not a bare nullable): the collision-proof source for the provider-aware PATCH
  // threaded in Plan 04. `mapRepo` (db/repo-configs.ts, 12-04 scope) and the RepoConfigRecord
  // fixtures at test/browser/repos.spec.tsx + test/repository-provider-contract.spec.ts all OMIT
  // workspace today, so a required nullable key would make every parse throw and fail this plan's
  // own typecheck/test gate before 12-04 populates it (review: Codex HIGH #2).
  workspace: z.string().nullable().optional(),
  vcsProvider: z.enum(vcsProviders),
  parsedJson: repoConfigSchema,
  updatedAt: dateStringSchema,
  lastJobCreatedAt: dateStringSchema.nullable(),
  lastJobVerdict: z.enum(reviewVerdicts).nullable(),
  mainModel: z.string().nullable(),
  fallbackModels: z.array(z.string()).nullable(),
  sizeOverrides: z.any().nullable(),
  enabled: z.boolean(),
});

export const statsSchema = z.object({
  totals: z.object({
    jobs: z.number().int(),
    inputTokens: z.number().int(),
    outputTokens: z.number().int(),
    comments: z.number().int(),
  }),
  trend: z.array(
    z.object({
      day: z.string(),
      jobs: z.number().int(),
      inputTokens: z.number().int(),
      outputTokens: z.number().int(),
      comments: z.number().int(),
    }),
  ),
  verdicts: z.array(
    z.object({
      verdict: z.enum(reviewVerdicts).nullable(),
      count: z.number().int(),
    }),
  ),
  models: z.array(
    z.object({
      modelUsed: z.string(),
      provider: z.string().optional(),
      calls: z.number().int(),
      inputTokens: z.number().int(),
      outputTokens: z.number().int(),
    }),
  ),
  topRepos: z.array(
    z.object({
      owner: z.string(),
      repo: z.string(),
      vcsProvider: z.enum(vcsProviders),
      jobs: z.number().int(),
    }),
  ),
  statuses: z.array(
    z.object({
      status: z.enum(jobStatuses),
      count: z.number().int(),
    }),
  ),
  triggers: z.array(
    z.object({
      trigger: z.enum(reviewTriggers),
      count: z.number().int(),
    }),
  ),
  severities: z.array(
    z.object({
      severity: z.enum(reviewSeverities),
      count: z.number().int(),
    }),
  ),
  categories: z.array(
    z.object({
      category: z.enum(reviewCategories),
      count: z.number().int(),
    }),
  ),
  performance: z.object({
    avgDurationMs: z.number().nullable(),
    p95DurationMs: z.number().nullable(),
    avgConfidence: z.number().nullable(),
  }),
});

export type ParsedReviewComment = z.infer<typeof parsedReviewCommentSchema>;
export type FileReviewModelOutput = z.infer<typeof fileReviewModelOutputSchema>;
export type RepoConfig = z.infer<typeof repoConfigSchema>;
export const KIMI_K2_5_MODEL = '@cf/moonshotai/kimi-k2.5';
export const KIMI_K2_6_MODEL = '@cf/moonshotai/kimi-k2.6';
export const DEPRECATED_MODEL_ALIASES: Record<string, string> = {
  [KIMI_K2_5_MODEL]: KIMI_K2_6_MODEL,
};

export function normalizeModelId(model: string) {
  return DEPRECATED_MODEL_ALIASES[model] ?? model;
}

export function normalizeRepoModelConfig(model: RepoConfig['model']): RepoConfig['model'] {
  return {
    ...model,
    main: model.main ? normalizeModelId(model.main) : null,
    fallbacks: model.fallbacks === null
      ? null
      : Array.isArray(model.fallbacks)
        ? model.fallbacks.map(normalizeModelId)
        : [],
    size_overrides: model.size_overrides === null || model.size_overrides === undefined
      ? model.size_overrides
      : model.size_overrides.map((tier) => ({
          ...tier,
          model: normalizeModelId(tier.model),
          fallbacks: tier.fallbacks?.map(normalizeModelId),
        })),
  };
}

export function normalizeRepoConfig(config: RepoConfig): RepoConfig {
  return {
    ...config,
    model: normalizeRepoModelConfig(config.model),
  };
}

// z.input (not z.output/z.infer) -- reviewJobMessageSchema's new `provider` field carries a
// `.default('github')`, which zod's output type treats as always-present/non-optional. Every
// consumer of ReviewJobMessage (queue producers constructing a message pre-validation, and the
// large existing test suite's hand-built fixtures) predates the `provider` field and must keep
// compiling without supplying it -- z.input models the pre-default shape (`provider` optional),
// matching how these call sites are actually used (NREG-03/Pitfall 10).
export type ReviewJobMessage = z.input<typeof reviewJobMessageSchema>;
export type JobSummary = z.infer<typeof jobSummarySchema>;
export type FileReviewRecord = z.infer<typeof fileReviewRecordSchema>;
export type JobDetail = z.infer<typeof jobDetailSchema>;
export type RepoConfigRecord = z.infer<typeof repoConfigRecordSchema>;
export const llmProviderSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  apiFormat: z.enum(llmApiFormats),
  baseUrl: z.url().nullable(),
  enabled: z.boolean(),
  hasApiKey: z.boolean(),
  createdAt: dateStringSchema,
  updatedAt: dateStringSchema,
});

export const modelConfigSchema = z.object({
  modelId: z.string(),
  providerId: z.uuid(),
  providerName: z.string(),
  apiFormat: z.enum(llmApiFormats),
  modelName: z.string(),
  updatedAt: dateStringSchema,
});

export type LlmApiFormat = z.infer<typeof llmProviderSchema>['apiFormat'];
export type LlmProvider = z.infer<typeof llmProviderSchema>;
export type ModelConfig = z.infer<typeof modelConfigSchema>;

// --- VCS bot-credential contracts (Phase 4, contract-first D-05/D-10) ---
// Four-state credential status computed server-side from token_expires_at (D-05).
export const credentialStatusSchema = z.enum(['missing', 'expired', 'expiring-soon', 'valid']);
export type CredentialStatus = z.infer<typeof credentialStatusSchema>;

// Redacted READ DTO — never carries secrets/ciphertext (D-10 / T-04-01). Only presence
// booleans, expiry, label, and computed status. `dateStringSchema` is correct here: these
// are DB-generated OUTPUT values being serialized, so the loose shape is intentional.
export const vcsCredentialStatusSchema = z.object({
  vcsProvider: z.enum(vcsProviders),
  workspace: z.string(),
  repoSlug: z.string(),
  hasToken: z.boolean(),
  hasWebhookSecret: z.boolean(),
  tokenExpiresAt: dateStringSchema.nullable(),
  label: z.string().nullable(),
  status: credentialStatusSchema,
  createdAt: dateStringSchema,
  updatedAt: dateStringSchema,
});
export type VcsCredentialStatus = z.infer<typeof vcsCredentialStatusSchema>;

// WRITE/upsert request. `.strict()` rejects unknown keys at the boundary.
export const vcsCredentialStoreSchema = z
  .object({
    // Phase 4 stores only Bitbucket bot credentials; accepting `github` here is needless
    // write surface (review finding 6). Narrow to a literal with a default.
    vcsProvider: z.literal('bitbucket').default('bitbucket'),
    // Normalize workspace/repo slugs to lowercase at the storage boundary (review finding 11).
    // RATIONALE: Bitbucket canonicalizes workspace and repo slugs to lowercase in API paths
    // and webhook payloads. Normalizing here guarantees the Phase 5 webhook lookup — which
    // keys on the lowercase payload values — matches the stored
    // (vcs_provider, workspace, repo_slug) key. Chosen over deferring to Phase 5 because the
    // storage key must equal the lookup key, and doing it once at the single write boundary is
    // the cheapest place. Forward note for Phase 5: its webhook-route lookup must also
    // lowercase before querying.
    // Length caps (IN-03): defense-in-depth against an authenticated user storing arbitrarily
    // large values in the TEXT columns. Bounds are generous relative to real Bitbucket slugs and
    // bot tokens, so they never reject legitimate input while keeping row size predictable.
    workspace: z.string().trim().toLowerCase().min(1).max(100),
    repoSlug: z.string().trim().toLowerCase().min(1).max(100),
    accessToken: z.string().max(4096).optional(),
    webhookSecret: z.string().max(4096).optional(),
    // STRICT ISO INPUT (review finding 5 / IN-02): a malformed string like `not-a-date` or a
    // non-ISO locale format (`2026/07/13`, `March 5 2099`) MUST be rejected here so it never
    // reaches the TIMESTAMPTZ insert. The prior `Date.parse` refine was permissive despite this
    // comment. We accept exactly two strict shapes: a bare `YYYY-MM-DD` date (what the dashboard's
    // `type="date"` input actually sends, via `toDateInputValue`) and a full RFC3339 datetime with
    // optional offset. The serialized OUTPUT DTO (vcsCredentialStatusSchema) keeps the loose
    // `dateStringSchema` shape.
    tokenExpiresAt: z
      .union([z.iso.date(), z.iso.datetime({ offset: true })])
      .nullable()
      .optional(),
    label: z.string().max(200).nullable().optional(),
    // Rotate-in-place semantics (D-11): omit a secret to leave it untouched, or set the
    // corresponding clear flag to null it out.
    clearToken: z.boolean().optional(),
    clearWebhookSecret: z.boolean().optional(),
  })
  .strict();
export type VcsCredentialStoreInput = z.infer<typeof vcsCredentialStoreSchema>;
export type StatsPayload = z.infer<typeof statsSchema>;

export const defaultRepoConfig = repoConfigSchema.parse({});

export const reviewConcurrencyLevels = ['low', 'medium', 'high', 'max'] as const;
export type ReviewConcurrencyLevel = typeof reviewConcurrencyLevels[number];
export const REVIEW_CONCURRENCY_LIMITS: Record<ReviewConcurrencyLevel, number> = {
  low: 1,
  medium: 2,
  high: 3,
  max: 4,
};

export const reviewMaxCommentsOptions = [5, 10, 15, 20] as const;

export const reviewSettingsSchema = z.object({
  concurrencyLevel: z.enum(reviewConcurrencyLevels).default('medium'),
  maxComments: z.union([z.literal(5), z.literal(10), z.literal(15), z.literal(20)]).default(10),
});
export type ReviewSettings = z.infer<typeof reviewSettingsSchema>;
