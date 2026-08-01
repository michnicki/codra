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
  // SEC-XDIFF-01: cross-references to other files in the PR that share a security relationship
  // with this finding (e.g. "auth middleware missing check" references "route handler no auth").
  // Optional so existing providers/findings without cross-file context parse unchanged (NREG-01).
  cross_references: z.array(z.object({
    path: z.string().min(1),
    line: z.number().int().positive().optional(),
    relationship: z.string().min(1),
  })).optional(),
  // WR-06: the persisted `review_comments.id` for this finding, projected back by
  // `getFileReviewsForJobs`. This is the stable identifier `criticPruneOutputSchema`'s comment
  // below calls out as missing ("the index-assigned ids close the gap that
  // parsedReviewCommentSchema has no stable id") -- it is now available on the finalize read path.
  //
  // A STRING, not a number: `review_comments.id` is BIGSERIAL (64-bit), and a JSON number loses
  // precision above 2^53 -- verified against Postgres, where 9007199254740993 projects back as
  // ...992. An audit identifier that is silently off by one points at a DIFFERENT comment, which is
  // worse than no identifier at all, so the projection casts to text.
  //
  // Optional because the PRODUCER side has no id: `parseFileReviewResponse` builds findings before
  // they are persisted, and the id is only assigned by the INSERT. Present on every read-back.
  commentId: z.string().min(1).nullable().optional(),
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
      // v1.2 EVID-01 (D-15): the model-emitted evidence string the soft evidence gate (Plan 15-04)
      // checks against the cleaned hunk. NULLABLE-AND-OPTIONAL, not bare .optional() (Codex 15-01 HIGH):
      // this per-file parse (model-output.ts) runs BEFORE the evidence check, so a bare .optional()
      // would throw the WHOLE response on a JSON `existing_code: null` and break the fail-open 'still
      // posts' soft-gate guarantee. null AND omission both flow to the `absent` branch (15-04), never a
      // parse failure — mirroring the loose/fail-open posture of `category` above and the already
      // nullable parsedReviewCommentSchema.existingCode.
      existing_code: z.string().nullable().optional(),
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

// Phase 34 (PRD-04 / FR-114): per-touched-file commit history entry consumed by the file-review
// prompt builder. `files` is the list of OTHER files modified in the same commit; `filesAvailable`
// distinguishes GitHub (the REST commit endpoint returns files[]) from Bitbucket (the commit-list
// endpoint omits the file manifest — files is always [] by provider limitation, review LOW-10).
// When filesAvailable is false the prompt builder renders a distinct message so the model can tell
// "commit only touched this one file" from "provider didn't tell us." Defaults to true — set to
// false only by the Bitbucket provider.
//
// WR-09 (34-REVIEW): this schema is now ENFORCED at runtime (see parseVcsCommitEntries below), not
// merely used for its inferred type. `message` deliberately has NO `.min(1)`: both adapters compute
// it as `message.split('\n')[0] ?? ''`, which is legitimately `''` for a commit whose message is
// empty or starts with a newline (git permits both — `--allow-empty-message`). A `.min(1)` here
// was unsatisfiable by the producers, so making the schema authoritative would have dropped
// entries the adapters correctly produce.
export const vcsCommitEntrySchema = z.object({
  hash: z.string().min(7).max(7),
  message: z.string(),
  files: z.array(z.string()),
  filesAvailable: z.boolean().default(true),
});
export type VcsCommitEntry = z.infer<typeof vcsCommitEntrySchema>;

/**
 * WR-09 (34-REVIEW): FAIL-OPEN validator for a commit-history list.
 *
 * Two boundaries need it and both used to be unchecked:
 *   - ADAPTER OUTPUT — `vcsCommitEntrySchema` documented the contract but nothing enforced it, so
 *     a provider-side shape drift reached the prompt builder untyped-in-practice.
 *   - THE KV ROUND-TRIP — `JSON.parse(raw) as Record<string, VcsCommitEntry[]>` is an unchecked
 *     cast. Any drift in a map persisted by an earlier deploy (the entries live for the 1-hour
 *     TTL) surfaced as a TypeError inside `buildFileHistoryBlock` during prompt construction.
 *
 * File history is ADVISORY CONTEXT, so the posture matches D-06: drop what does not validate and
 * keep going, never throw. A non-array input yields [].
 */
export function parseVcsCommitEntries(value: unknown): VcsCommitEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: VcsCommitEntry[] = [];
  for (const candidate of value) {
    const result = vcsCommitEntrySchema.safeParse(candidate);
    if (result.success) entries.push(result.data);
  }
  return entries;
}

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
      security: z.object({
        enabled: z.boolean().default(false),
        // SEC-XDIFF-01: enable the cross-file security reasoning pass. Default-off so existing
        // behavior is byte-identical (NREG-01). When enabled, a whole-diff security pass runs
        // after the per-file review phase and before verify_fixes.
        cross_file: z.boolean().default(false),
      }).default({ enabled: false, cross_file: false }),
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
    .default({ security: { enabled: false, cross_file: false }, critic: { enabled: false }, ensemble: { runs: 1, temperature: 0.7 } }),
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
          // Phase 29 (QA-IDX-01, D-16 / D-16-R): codebase-index-backed Q&A. `enabled` is
          // REQUIREMENTS' `qa.index_enabled` expressed at the PRE-EXISTING `review.interactive.qa`
          // config path rather than as a new top-level `qa` block, so Q&A configuration is not split
          // across two places. Default-off for NREG-01 inertness: `repoConfigSchema.parse({})` yields
          // `review.interactive.qa.index.enabled === false`, so a repository whose operator has not
          // explicitly opted in sees no retrieval, no index storage and no build activity.
          //
          // Every numeric key carries a `.max()` bound because these values later size provider
          // fetches, stored rows and prompt bytes — the bound is what stops an authenticated-but-
          // malicious config write from requesting an unbounded build or an unbounded retrieval
          // (T-29-02-01, following the Phase 13 bounds precedent on `ensemble.runs` and the
          // `.max(20)` on `evidence.hard_drop_exempt_categories`).
          //
          // ONE-WAY (D-16): these keys enter `repo_configs.parsed_json` for any repository that sets
          // them, so removing one after it ships risks breaking config parsing for those repos. The
          // key path, the four defaults and the `max_files` ceiling were confirmed by the developer
          // at the Plan 29-02 Task 1 checkpoint (recorded as D-16-R in 29-CONTEXT.md).
          index: z
            .object({
              enabled: z.boolean().default(false),
              // Caps FETCHES, not stored files. Generated-file detection is content-based (D-09), so
              // a file must be fetched before it can be dropped — a build that fetches `max_files`
              // files therefore stores at most, and usually fewer than, `max_files` files. The
              // schema cannot express that distinction, hence this note.
              //
              // BUILD COST — the number an operator types here is the ONLY place the build's
              // wall-clock cost is chosen, so the arithmetic belongs where the value is picked
              // (review: OpenCode 29-02 #8 / Consensus Agreed Concern 4). Derivation, entirely from
              // constants that already exist in this repository: `TokenTracker`'s
              // MAX_SUBREQUESTS = 50 minus SAFE_MARGIN = 25 leaves a fresh `remainingSafeBudget()`
              // of 25; at ESTIMATED_SUBREQUESTS_PER_INDEX_FILE = 2 that funds floor(25 / 2) = 12
              // files per invocation; and each continuation sleeps
              // INDEX_FRESH_INVOCATION_YIELD_SECONDS = 60 to force hibernation. So a build advances
              // roughly 12 FILES PER MINUTE — the 500 default is about 42 minutes and the 2 000
              // ceiling about 2.8 hours.
              //
              // A large value is SLOW, NOT SILENTLY CAPPED: MAX_INDEX_CONTINUATIONS hands off to a
              // fresh instance rather than abandoning the build, so a large request does finish; it
              // just costs hours of wall clock and provider quota. The ceiling therefore bounds how
              // long an operator can ask a build to run, NOT how much gets indexed. 2 000 was chosen
              // over a drafted 5 000 (~7 hours) because it keeps 4x headroom over the 500 default
              // while bounding the worst legal request to roughly three hours. The exact boundary is
              // pinned by a spec PAIR in test/repo-configs.spec.ts (2 000 parses, 2 001 rejects) so
              // it cannot drift looser without failing the suite.
              //
              // Deliberately NOT a `.refine()` cross-checking the budget constants: this file is
              // imported by the dashboard client, so reaching into `core/code-index-build.ts` would
              // drag server-side build constants into the browser bundle and invert the layering
              // (`shared/` depends on nothing server-side). The bound plus this documented
              // arithmetic is the whole mitigation.
              max_files: z.number().int().positive().max(2_000).default(500),
              // BAKED INTO STORED ROWS: the line window is persisted with every chunk at build time,
              // so changing this value requires a FULL RE-INDEX, not a migration. 50 deliberately
              // equals `WINDOW_LINE_COUNT` because D-10 reuses that windowing vocabulary. Bounded at
              // 500 so a config write cannot demand pathologically large chunks.
              chunk_lines: z.number().int().positive().max(500).default(50),
              // Retrieval breadth per question. Bounded at 50 because every hit spends prompt bytes
              // inside the `QA_MAX_INDEX_CHARS` retrieved-context fence (D-13).
              top_k: z.number().int().positive().max(50).default(8),
            })
            .default({ enabled: false, max_files: 500, chunk_lines: 50, top_k: 8 }),
        })
        // Zod 4 returns a `.default(literal)` value WITHOUT re-parsing it, so this literal must carry
        // `index` too — it is the value produced whenever `qa` itself is absent from a stored config.
        .default({
          enabled: false,
          rate_limit_per_hour: 10,
          index: { enabled: false, max_files: 500, chunk_lines: 50, top_k: 8 },
        }),
    })
    .default({
      commands: { enabled: false, bitbucket_allowed_account_ids: [], bitbucket_bot_account_id: null },
      qa: {
        enabled: false,
        rate_limit_per_hour: 10,
        index: { enabled: false, max_files: 500, chunk_lines: 50, top_k: 8 },
      },
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
  // Phase 26 (EVID-02): evidence quality gate config. `hard_drop` defaults off (soft gate only);
  // `hard_drop_exempt_categories` defaults to ['security'] so security findings always post
  // regardless of evidence quality. Array bound .max(20) mirrors the custom_rules .max(50) precedent
  // (line 130) and prevents unbounded config accumulation (defense-in-depth, Antigravity MEDIUM).
  evidence: z
    .object({
      hard_drop: z.boolean().default(false),
      hard_drop_exempt_categories: z.array(z.string()).max(20).default(['security']),
    })
    .default({ hard_drop: false, hard_drop_exempt_categories: ['security'] }),
  // Phase 28 (LRN-01): learned-rule synthesis from reject feedback. `learning.enabled` is the
  // master toggle gating both synthesis (on-demand clustering of reject_feedback rows) and
  // suppression (dropping findings in finalize that match active rules). `learned_rules` is the
  // in-config rule store — each rule is synthesized from a cluster of 2+ rejections sharing the
  // same (category, file_path). Rules lifecycle: pending → active → disabled. Default-off for
  // NREG-01 inertness: `repoConfigSchema.parse({})` yields `learning.enabled === false` and
  // `learning.learned_rules === []`.
  learning: z
    .object({
      enabled: z.boolean().default(false),
      learned_rules: z
        .array(
          z.object({
            id: z.uuid(),
            category: z.string(),
            file_pattern: z.string(),
            status: z.enum(['pending', 'active', 'disabled']),
            source_rejection_ids: z.array(z.string()),
            created_at: z.string(),
          }),
        )
        .default([]),
    })
    .default({ enabled: false, learned_rules: [] }),
  // Phase 34 (PRD-04 / PRD-05): context-enhancement feature toggles. `file_history` (FR-114)
  // gates the per-touched-file commit-history appendix in the review prompt; `yaml_config` (§15)
  // gates .review.yaml discovery + merge. Both default false for NREG-01 inertness — when off,
  // zero subrequests and zero behavior change.
  file_history: z
    .object({
      enabled: z.boolean().default(false),
    })
    .default({ enabled: false }),
  yaml_config: z
    .object({
      enabled: z.boolean().default(false),
    })
    .default({ enabled: false }),
  // Phase 30 (ANNO-01, D-01/D-06): Bitbucket Code Insights annotations toggle. This is the FIRST
  // purely Bitbucket-only capability toggle — no GitHub equivalent (NREG-02 by exclusion: GitHub
  // already has native inline PR comments, so this capability only makes sense for Bitbucket).
  // It is nested under `review` rather than added as a new top-level key on `repoConfigSchema` to
  // preserve that schema's single-top-level-key shape, a choice explicitly confirmed at the Task 1
  // checkpoint after cross-AI review flagged the config-key nesting question rather than defaulting
  // it silently (30-REVIEWS.md, OpenCode Concern #3). Default-off for NREG-01 inertness:
  // `repoConfigSchema.parse({})` yields `review.bitbucket.annotations_enabled === false`.
  bitbucket: z
    .object({
      annotations_enabled: z.boolean().default(false),
    })
    .default({ annotations_enabled: false }),
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
    passes: { security: { enabled: false, cross_file: false }, critic: { enabled: false }, ensemble: { runs: 1, temperature: 0.7 } },
    interactive: {
      commands: { enabled: false, bitbucket_allowed_account_ids: [], bitbucket_bot_account_id: null },
      qa: {
        enabled: false,
        rate_limit_per_hour: 10,
        // QA-IDX-01 index block, identical to the two `interactive`-level literals above. A divergence
        // between the three is a silent config bug that only surfaces for repositories whose parent
        // key happens to be absent from `parsed_json`.
        index: { enabled: false, max_files: 500, chunk_lines: 50, top_k: 8 },
      },
    },
    severity_engine: { enabled: true },
    dedup: { enabled: true },
    file_selection: { enabled: true },
    category_confidence: {},
    threads: { verify_fixes: false, auto_resolve: false },
    rounds: { incremental: false, escalate_floors: true },
    evidence: { hard_drop: false, hard_drop_exempt_categories: ['security'] },
    learning: { enabled: false, learned_rules: [] },
    bitbucket: { annotations_enabled: false },
    // Phase 34 (PRD-04 / PRD-05): mirror the toggle blocks in the inline literal default too, so
    // repoConfigSchema.parse({}) yields each at its documented default regardless of Zod default
    // short-circuit semantics for the nested `review` object (same reasoning as :409-412 above).
    file_history: { enabled: false },
    yaml_config: { enabled: false },
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

// Phase 18 (RND-01 / RND-02 / RND-03 / RND-05): the locked review-mode value-set for jobs.review_mode
// (mirrors the migration-011 review_mode CHECK constraint in db/migrations/011_*.sql). Kept in sync
// with the producer surface (Plan 01's recordRoundAudit + the future Plan 02 selectDiffForRound
// consumer) so an out-of-vocabulary mode string fails at parse rather than silently bypassing the
// contract. Matches fileReviewPassSchema's enum-of-literals shape; future modes require a coordinated
// schema + DB CHECK + producer edit.
export const reviewModes = ['full', 'incremental', 'fallback', 'no_changes', 'rest'] as const;
export type ReviewMode = typeof reviewModes[number];
export const reviewModeSchema = z.enum(reviewModes);

export const reviewJobMessageSchema = z.object({
  jobId: z.uuid().optional(),
  deliveryId: z.string().min(1),
  // WIRE contract widened with durable auxiliary phases. The INTERNAL ReviewJobRunResult.phase union
  // and dispatch switch are widened only when each phase's worker lands; accepting the values here
  // lets fresh Workflow handoffs carry their persisted cursor without another contract edit.
  phase: z.enum(['prepare', 'review', 'finalize', 'critic', 'verify_fixes', 'walkthrough_enrichment', 'cross_file_security']).optional(),
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

// Phase 19 machine reasons are persisted and rendered after Workflow hibernation. Keep them
// intentionally small and non-empty: producers store stable reason codes/descriptions, never raw
// provider responses, thread bodies, prompts, or model output (T-19-01-02).
export const phase19MachineReasonSchema = z.string().trim().min(1).max(200);

// Phase 20.1 BLOCKER 1 (D-07): the re-exported `machineErrorReasonSchema` and
// `redactedErrorReasonSchema` are defined in @shared/transient-errors (the source of truth for
// the MACHINE_ERROR_REASONS enum). They are re-exported here so callers that already depend on
// @shared/schema can resolve the audit-event reason schema without a second import. The schemas
// are identical to the source-of-truth schemas (same Zod instance via re-export).
export { machineErrorReasonSchema, redactedErrorReasonSchema } from './transient-errors';

export const threadVerificationVerdicts = ['fixed', 'unfixed', 'unverifiable'] as const;
export const threadVerificationVerdictSchema = z.enum(threadVerificationVerdicts);

// Durable identifier/location snapshot for one unresolved bot thread. The provider's opaque ref is
// retained for idempotency, but its body is deliberately absent from the persistence contract.
export const threadVerificationSnapshotSchema = z
  .object({
    threadRef: z.string().min(1).max(512),
    path: z.string().min(1).max(1_024),
    lineStart: z.number().int().positive().nullable().optional(),
    lineEnd: z.number().int().positive().nullable().optional(),
    outdated: z.boolean().optional(),
  })
  .passthrough();
export type ThreadVerificationSnapshot = z.infer<typeof threadVerificationSnapshotSchema>;

// Canonical per-thread result (D-01/D-02/D-04). Every outcome, including `fixed`, requires a
// bounded machine reason. `resolved` records a confirmed provider side effect and is independent
// from the model verdict, so verify-only and capability-degraded runs remain truthful.
export const threadVerificationEntrySchema = threadVerificationSnapshotSchema
  .extend({
    verdict: threadVerificationVerdictSchema,
    reason: phase19MachineReasonSchema,
    resolved: z.boolean(),
  })
  .passthrough();
export type ThreadVerificationEntry = z.infer<typeof threadVerificationEntrySchema>;

export const threadVerificationTotalsSchema = z
  .object({
    fixed: z.number().int().nonnegative(),
    unfixed: z.number().int().nonnegative(),
    unverifiable: z.number().int().nonnegative(),
    resolved: z.number().int().nonnegative(),
  })
  .passthrough();
export type ThreadVerificationTotals = z.infer<typeof threadVerificationTotalsSchema>;

// The same JSONB value serves as the resumable cursor and final report. Cursor fields are optional
// so completed rows remain compact and historical/pre-Phase-19 rows can omit the entire object.
export const threadVerificationsSchema = z
  .object({
    version: z.literal(1).default(1),
    status: z.enum(['pending', 'running', 'completed', 'fail_open']),
    reason: phase19MachineReasonSchema.optional(),
    threads: z.array(threadVerificationSnapshotSchema).optional(),
    contentCursor: z.number().int().nonnegative().optional(),
    modelCursor: z.number().int().nonnegative().optional(),
    resolutionCursor: z.number().int().nonnegative().optional(),
    entries: z.array(threadVerificationEntrySchema),
    totals: threadVerificationTotalsSchema,
  })
  .passthrough();
export type ThreadVerifications = z.infer<typeof threadVerificationsSchema>;

export const criticVerdictSchema = z.enum(['proven', 'plausible', 'unsupported']);
export const criticRunStatusSchema = z.enum(['completed', 'skipped', 'fail_open']);

// One immutable, bounded row per original Critic-v2 candidate. The stable numeric id is assigned by
// code before the model call; verdict/outcome reconciliation remains code-owned (D-05/D-07/D-09).
export const criticDecisionSchema = z
  .object({
    id: z.number().int().nonnegative(),
    path: z.string().min(1).max(1_024),
    line: z.number().int().positive().nullable().optional(),
    severity: z.enum(reviewSeverities),
    category: z.enum(reviewCategories),
    title: z.string().min(1).max(200),
    body: z.string().min(1).max(4_000),
    confidence: z.number().min(0).max(1).nullable(),
    verdict: criticVerdictSchema.nullable(),
    outcome: z.enum(['kept', 'dropped']),
    reason: phase19MachineReasonSchema,
  })
  .passthrough();
export type CriticDecision = z.infer<typeof criticDecisionSchema>;

// Provider-neutral Critic-v2 model output. Partial arrays are valid; reconciliation creates a
// no-verdict decision for every omitted candidate. Extra model metadata is ignored additively.
export const criticV2OutputSchema = z
  .object({
    verdicts: z.array(
      z
        .object({
          id: z.number().int().nonnegative(),
          verdict: criticVerdictSchema,
          reason: phase19MachineReasonSchema.optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();
export type CriticV2Output = z.infer<typeof criticV2OutputSchema>;

export const ensembleRunOutcomeSchema = z
  .object({
    run: z.number().int().min(0).max(4),
    status: z.enum(['succeeded', 'failed']),
    model: z.string().min(1).max(200).optional(),
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    reason: phase19MachineReasonSchema.optional(),
  })
  .passthrough();
export type EnsembleRunOutcome = z.infer<typeof ensembleRunOutcomeSchema>;

// Durable per-file ensemble metadata. Full cluster/cursor detail may extend this object in later
// plans; these canonical totals remain sufficient for reload, audit projection, and degraded-state
// reporting without persisting provider response bodies.
export const ensembleResultSchema = z
  .object({
    version: z.literal(1).default(1),
    status: z.enum(['inert', 'completed', 'partial', 'failed']),
    requestedRuns: z.number().int().min(1).max(5),
    successfulRuns: z.number().int().min(0).max(5),
    failedRuns: z.number().int().min(0).max(5),
    winnerCount: z.number().int().nonnegative(),
    droppedClusterCount: z.number().int().nonnegative(),
    runOutcomes: z.array(ensembleRunOutcomeSchema).max(5).optional(),
  })
  .passthrough();
export type EnsembleResult = z.infer<typeof ensembleResultSchema>;

export const walkthroughChangeGroupSchema = z
  .object({
    label: z.string().trim().min(1).max(200),
    paths: z.array(z.string().min(1).max(1_024)).max(150),
  })
  .passthrough();
export type WalkthroughChangeGroup = z.infer<typeof walkthroughChangeGroupSchema>;

export const walkthroughConfidenceSchema = z
  .object({
    score: z.number().int().min(1).max(5),
    label: z.string().trim().min(1).max(100),
    reason: phase19MachineReasonSchema,
  })
  .passthrough();
export type WalkthroughConfidence = z.infer<typeof walkthroughConfidenceSchema>;

export const walkthroughEffortSchema = z
  .object({
    level: z.number().int().min(1).max(5),
    label: z.string().trim().min(1).max(100),
    minutes: z.number().int().nonnegative().max(10_080),
  })
  .passthrough();
export type WalkthroughEffort = z.infer<typeof walkthroughEffortSchema>;

// Persist only validated enrichment metadata. Each optional field is independently nullable/absent
// so a tolerant parser can preserve valid groups when confidence or effort is malformed (D-17).
export const walkthroughEnrichmentSchema = z
  .object({
    version: z.literal(1).default(1),
    status: z.enum(['completed', 'partial', 'failed']),
    reason: phase19MachineReasonSchema.optional(),
    groups: z.array(walkthroughChangeGroupSchema).max(150).optional(),
    confidence: walkthroughConfidenceSchema.nullable().optional(),
    effort: walkthroughEffortSchema.nullable().optional(),
    model: z.string().min(1).max(200).optional(),
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
  })
  .passthrough();
export type WalkthroughEnrichment = z.infer<typeof walkthroughEnrichmentSchema>;

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
    // Phase 19 Critic-v2 adds a canonical one-row-per-candidate ledger. All fields stay optional so
    // historical prune-only blobs remain readable and distinguishable as legacy (D-08).
    version: z.literal(2).optional(),
    status: criticRunStatusSchema.optional(),
    reason: phase19MachineReasonSchema.optional(),
    decisions: z.array(criticDecisionSchema).optional(),
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
  // Phase 19 durable auxiliary results. Both columns are nullable JSONB and every field is optional
  // on the job contract so pre-Phase-19 rows/fixtures remain byte-compatible.
  threadVerification: threadVerificationsSchema.nullable().optional(),
  walkthroughEnrichment: walkthroughEnrichmentSchema.nullable().optional(),
  // Phase 11 (REVIEW: Codex 11-05 HIGH): pass-through for the migration-009 jobs.review_scope /
  // jobs.scope_source_job_id columns so the review-rest scope lives on the PERSISTED job row and
  // survives fresh-instance handoff + lease recovery (not the transient queue message). Both are
  // null on every existing insert (no writer wired this plan) — additive, behaviorally inert
  // (NREG-01). `.nullable().optional()` so pre-widening fixtures still parse.
  reviewScope: z.enum(['all', 'rest', 'head']).nullable().optional(),
  scopeSourceJobId: z.uuid().nullable().optional(),
  // Phase 18 (RND-01 / D-16): durable round/mode snapshot persisted by the prepare-time round
  // detection (Phase 18 Plan 02). review_round is the resolved round (>= 1); review_mode is the
  // selected diff source ('full' | 'incremental' | 'fallback' | 'no_changes' | 'rest'). Both are
  // NULL on a freshly-inserted job (Plan 01 has no writer wired — Plan 02 populates them). `.nullable()
  // .optional()` so pre-Phase-18 fixtures (and every existing insert until Plan 02's prepare change
  // lands) still parse without throwing. rounds_incremental is the durable snapshot of
  // config.review.rounds.incremental at insert time — NOT NULL DEFAULT false in the DB, surfaced as
  // boolean with `.optional()` so a pre-Phase-18 fixture (which never had the column) still parses.
  reviewRound: z.number().int().min(1).nullable().optional(),
  reviewMode: reviewModeSchema.nullable().optional(),
  roundsIncremental: z.boolean().optional(),
  // Phase 18 (migration 012, RND-02 / D-08): the immutable diff-selection descriptor (fromSha +
  // toSha). Both nullable so pre-Phase-18 jobs read back as null/undefined and the consumer
  // helpers fall through to the existing full-diff path (NREG-01). The `mode` column already
  // encodes the selection (`'full' | 'incremental' | 'fallback' | 'no_changes' | 'rest'`); these
  // two fields carry the anchor SHA range the consumer must re-fetch when mode is 'incremental' /
  // 'fallback' / 'no_changes' (D-08: finalize never anchors a freshly-fetched live head).
  roundsFromSha: z.string().nullable().optional(),
  roundsToSha: z.string().nullable().optional(),
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
export const fileReviewPassSchema = z.enum(['main', 'security', 'cross_file_security']);
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
  // Phase 19 PASS-02 durable consensus metadata. Nullable/optional keeps runs=1 and historical rows
  // inert; the file-review DB reader validates malformed JSON fail-soft before exposing this field.
  ensembleResult: ensembleResultSchema.nullable().optional(),
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
          // Phase 20.1 BLOCKER 1 (D-06): the redactor (core/audit-redact.ts redactFindingTitle)
          // caps the title to 100 chars via a length-bounded head-clamp marker. The schema cap
          // matches the redactor's ceiling so a redacted marker shape is accepted; the redactor
          // is the producer-side enforcement, not the schema parser.
          title: z.string().max(100),
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
      // Phase 20.1 BLOCKER 1 (D-06): see filtered.sample.title above — the redactor's ceiling is
      // the schema cap.
      survivor: z.object({ path: z.string(), line: z.number().nullable().optional(), title: z.string().max(100) }),
      suppressed: z.object({ path: z.string(), line: z.number().nullable().optional(), title: z.string().max(100) }),
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
          // Phase 20.1 BLOCKER 1 (D-06): see filtered.sample.title above — the redactor's ceiling is
          // the schema cap. `file_skipped` sample rows are path-only in practice (a skipped file has
          // no finding title), but the optional field keeps the variant shape consistent with the
          // other filtered/deduped audit variants.
          title: z.string().max(100).optional(),
        }),
      ),
      timestamp: dateStringSchema,
    })
    .passthrough(),
  // `evidence_missing` (D-17, EVID-01): a PER-FINDING event — the soft evidence gate could not confirm
  // a finding's model-emitted `existing_code` against the cleaned hunk. `reason` discriminates `absent`
  // (no/empty evidence string emitted) from `not_in_hunk` (evidence present but not found in the diff).
  // Phase 20.1 BLOCKER 1 (D-06): the title is redacted via redactFindingTitle (max 100 chars).
  z
    .object({
      stage: z.literal('evidence_missing'),
      reason: z.enum(['absent', 'not_in_hunk']),
      path: z.string(),
      line: z.number().nullable().optional(),
      title: z.string().max(100),
      timestamp: dateStringSchema,
    })
    .passthrough(),
  // Phase 21 (EVID-03 / D-01..D-04): AGGREGATE replacement for per-finding `evidence_missing` events.
  // One `evidence_missing_summary` event per (file, pass) unit replaces N per-finding `evidence_missing`
  // events, preventing a non-compliant model's flood of evidence-missing findings from evicting other
  // telemetry from the 500-event ring buffer.
  //
  // The legacy `evidence_missing` per-finding variant (lines 907-920 above) is kept forever — old
  // persisted events still parse; the two `stage` literals are distinct and coexist in the union.
  //
  // Counts are camelCase per D-03 (absentCount, notInHunkCount).
  // Sample entry line is nullable and carries the pre-orphan-remap original line the model cited per D-02.
  //   Implemented by Phase 22 (EVID-04).
  // Sample preserves model emission order per D-07, NOT grouped by reason.
  // Sample entries carry `reason` per D-04 for EVID-02 consumption.
  // Privacy-bounded: titles route through redactFindingTitle (max 100 char marker); never
  //   body/diff/existingCode/codeSuggestion.
  z
    .object({
      stage: z.literal('evidence_missing_summary'),
      file: z.string(),
      pass: fileReviewPassSchema,
      absentCount: z.number().int().min(0),
      notInHunkCount: z.number().int().min(0),
      sample: z.array(
        z.object({
          path: z.string(),
          line: z.number().nullable().optional(),
          title: z.string().max(100),
          reason: z.enum(['absent', 'not_in_hunk']),
        }),
      ).max(20),
      timestamp: dateStringSchema,
    })
    .passthrough(),
  // Phase 26 (EVID-02): evidence_hard_dropped audit event. AGGREGATE — one event per (file, pass)
  // when EVID-02 hard-drop removed >=1 finding from the finalize pass output. Follows the
  // `evidence_missing_summary` precedent (lines 921-963) for the per-(file, pass) aggregate shape.
  // droppedCount reflects the FULL total, NOT the capped sample length. Sample bounded to 20 entries.
  // Design: each sample entry carries a `reason` ('absent' | 'not_in_hunk') per D-06; titles route
  // through redactFindingTitle at production time (AUD-01); never body/diff/existingCode/codeSuggestion.
  // Privacy bounded: same evidence_missing_summary posture.
  z
    .object({
      stage: z.literal('evidence_hard_dropped'),
      file: z.string(),
      pass: fileReviewPassSchema,
      droppedCount: z.number().int().min(0),
      sample: z.array(
        z.object({
          path: z.string(),
          line: z.number().nullable().optional(),
          title: z.string().max(100),
          reason: z.enum(['absent', 'not_in_hunk']),
        }),
      ).max(20),
      timestamp: dateStringSchema,
    })
    .passthrough(),
  // Phase 28 (LRN-01): learned_rule_suppressed audit event. AGGREGATE — one event per (file, pass)
  // when learned-rule suppression removed >=1 finding from the finalize pass output. Follows the
  // `evidence_hard_dropped` precedent (lines 1004-1027) for the per-(file, pass) aggregate shape.
  // droppedCount reflects the FULL total, NOT the capped sample length. Sample bounded to 20 entries.
  // Each sample entry carries `matched_rule` (the rule ID, string) per D-13; titles route through
  // redactFindingTitle at production time (AUD-01); never body/diff/existingCode/codeSuggestion.
  // Privacy bounded: same evidence_hard_dropped posture.
  z
    .object({
      stage: z.literal('learned_rule_suppressed'),
      file: z.string(),
      pass: fileReviewPassSchema,
      droppedCount: z.number().int().min(0),
      sample: z.array(
        z.object({
          path: z.string(),
          line: z.number().nullable().optional(),
          title: z.string().max(100),
          matched_rule: z.string(),
        }),
      ).max(20),
      timestamp: dateStringSchema,
    })
    .passthrough(),
  // Phase 33 (PRD-02 / FR-153, D-08): suggestion_dropped audit event. AGGREGATE — one event per
  // (file, pass) when the FR-153 drop clause removed >=1 finding from the parse output (non-empty
  // suggestion + empty body). droppedCount reflects the FULL total, NOT the capped sample length.
  // Sample identifiers admit ONLY { path, line, title } (T-13-03-03) and titles route through
  // redactFindingTitle at production time (AUD-01); never body/existingCode/codeSuggestion.
  z
    .object({
      stage: z.literal('suggestion_dropped'),
      file: z.string(),
      pass: fileReviewPassSchema,
      droppedCount: z.number().int().min(0),
      sample: z.array(
        z.object({
          path: z.string(),
          line: z.number().nullable().optional(),
          title: z.string().max(100),
        }),
      ).max(20),
      timestamp: dateStringSchema,
    })
    .passthrough(),
  // Phase 18 round/anchor audit events (RND-01 / RND-02 / RND-03 / RND-05). All five variants share
  // the `rounds.` stage prefix; the client-side AuditDisplayStage normalization (see audit-grouping.ts)
  // collapses them to the single `rounds` display group while preserving the original event stage
  // and insertion order. Every variant ends with `.passthrough()` (Phase 13 D-08 pattern) so a future
  // phase can add fields non-breakingly. Privacy bounded: NEVER body / diff / existingCode /
  // thread bodies — the producer (`core/rounds.ts::recordRoundAudit`) is the only writer.
  //
  // - `rounds.detected` (RND-01 / D-02): the resolution that set this job's review_round + review_mode.
  //   `mode` is one of the locked reviewModes; `round` is the resolved integer; `incremental` records
  //   the durable config snapshot of `rounds.incremental` at prepare time. Optional `anchorSha` and
  //   `hasUnresolvedThreads` capture the two resolution signals (prior anchor / unresolved threads).
  z
    .object({
      stage: z.literal('rounds.detected'),
      mode: reviewModeSchema,
      round: z.number().int().min(1),
      incremental: z.boolean(),
      anchorSha: z.string().nullable().optional(),
      hasUnresolvedThreads: z.boolean().optional(),
      timestamp: dateStringSchema,
    })
    .passthrough(),
  // - `rounds.no_changes` (RND-02 / D-08): finalize produced a silent `no_changes` placeholder
  //   (genuinely empty incremental diff with no full-diff fallback content). The D-08 exact producer
  //   fields: { from, to, round, incremental: true }. `from`/`to` are the SHA anchors the compare
  //   ran between (from = last_reviewed_sha; to = current pr.headSha).
  z
    .object({
      stage: z.literal('rounds.no_changes'),
      from: z.string(),
      to: z.string(),
      round: z.number().int().min(1),
      incremental: z.literal(true),
      timestamp: dateStringSchema,
    })
    .passthrough(),
  // - `rounds.anchor_skipped` (D-15): finalize completed but the anchor write was skipped because
  //   the head SHA was empty / zero-length. `reason` carries the skip rationale (today: 'empty_head');
  //   kept as a free-form string so a future failure mode can extend it without a breaking edit.
  z
    .object({
      stage: z.literal('rounds.anchor_skipped'),
      reason: z.string(),
      round: z.number().int().min(1).nullable().optional(),
      timestamp: dateStringSchema,
    })
    .passthrough(),
  // - `rounds.escalated` (RND-03): the prepare-time round raised the effective confidence floor
  //   and/or severity floor. `from`/`to` are the locked value-set of round 2 (0.8/P2) and round 3+
  //   (0.85/P2). `effective` records the COMPOSED minConfidence / minSeverity the finalize actually
  //   used (max(round, global, category_confidence)) so the audit trail explains the user-visible
  //   escalation rather than only the round's own floor.
  z
    .object({
      stage: z.literal('rounds.escalated'),
      from: z.object({
        minConfidence: z.number(),
        minSeverity: z.enum(reviewSeverities),
      }),
      to: z.object({
        minConfidence: z.number(),
        minSeverity: z.enum(reviewSeverities),
      }),
      effective: z.object({
        minConfidence: z.number(),
        minSeverity: z.enum(reviewSeverities),
      }),
      round: z.number().int().min(1),
      timestamp: dateStringSchema,
    })
    .passthrough(),
  // - `rounds.suppressed` (RND-04): a per-finding event emitted on the POSTING path only when an
  //   open-thread overlap suppressed a finding. `path` / `line` / `title` mirror the privacy-bounded
  //   identifier shape used by the other variants (T-13-03-03); the thread's content / ref are
  //   NEVER persisted (the audit trail is decision telemetry, not raw thread data).
  z
    .object({
      stage: z.literal('rounds.suppressed'),
      path: z.string(),
      line: z.number().nullable().optional(),
      // Phase 20.1 BLOCKER 1 (D-06): see filtered.sample.title above — the redactor's ceiling is
      // the schema cap.
      title: z.string().max(100),
      threadPath: z.string(),
      timestamp: dateStringSchema,
    })
    .passthrough(),
  // Phase 19 verify-fixes decisions (THR-01/THR-02). These are per-thread identifier rows with a
  // mandatory bounded machine reason for every verdict, including verified-fixed (D-04). They never
  // persist the thread body, file content, prompt, or raw provider/model payload.
  z
    .object({
      stage: z.literal('threads.verified_fixed'),
      threadRef: z.string().min(1).max(512),
      path: z.string().min(1).max(1_024),
      line: z.number().int().positive().nullable().optional(),
      reason: phase19MachineReasonSchema,
      timestamp: dateStringSchema,
    })
    .passthrough(),
  z
    .object({
      stage: z.literal('threads.unfixed'),
      threadRef: z.string().min(1).max(512),
      path: z.string().min(1).max(1_024),
      line: z.number().int().positive().nullable().optional(),
      reason: phase19MachineReasonSchema,
      timestamp: dateStringSchema,
    })
    .passthrough(),
  z
    .object({
      stage: z.literal('threads.unverifiable'),
      threadRef: z.string().min(1).max(512),
      path: z.string().min(1).max(1_024),
      line: z.number().int().positive().nullable().optional(),
      reason: phase19MachineReasonSchema,
      timestamp: dateStringSchema,
    })
    .passthrough(),
  z
    .object({
      stage: z.literal('threads.resolved'),
      threadRef: z.string().min(1).max(512),
      path: z.string().min(1).max(1_024),
      line: z.number().int().positive().nullable().optional(),
      reason: phase19MachineReasonSchema,
      timestamp: dateStringSchema,
    })
    .passthrough(),
  z
    .object({
      stage: z.literal('threads.resolve_failed'),
      threadRef: z.string().min(1).max(512),
      path: z.string().min(1).max(1_024),
      line: z.number().int().positive().nullable().optional(),
      reason: phase19MachineReasonSchema,
      timestamp: dateStringSchema,
    })
    .passthrough(),
  // One aggregate Critic-v2 event per persisted ledger. The canonical result remains jobs JSONB;
  // audit receives only a privacy-bounded sample so a large candidate set cannot flood the 500-event
  // ring buffer or duplicate full finding bodies.
  // Phase 20.1 BLOCKER 1 (D-06): the sample title is redacted via redactFindingTitle (max 100 chars).
  // The prior `.min(1).max(200)` shape is relaxed to `.max(100)` so the redactor's defensive marker
  // (always non-empty, length-bounded) accepts the schema; the redactor is the producer-side
  // enforcement that ensures no raw title > 100 chars reaches audit.
  z
    .object({
      stage: z.literal('critic.decisions'),
      status: criticRunStatusSchema,
      count: z.number().int().nonnegative(),
      reason: phase19MachineReasonSchema.optional(),
      sample: z.array(
        z.object({
          id: z.number().int().nonnegative(),
          path: z.string().min(1).max(1_024),
          line: z.number().int().positive().nullable().optional(),
          title: z.string().max(100),
          verdict: criticVerdictSchema.nullable(),
          outcome: z.enum(['kept', 'dropped']),
          reason: phase19MachineReasonSchema,
        }),
      ).max(20),
      timestamp: dateStringSchema,
    })
    .passthrough(),
  // PASS-02 vote telemetry is one bounded aggregate per ensemble-enabled file. Successful/failed
  // denominator totals and both winner/drop samples are independent; failed reasons are capped by
  // the configured maximum of four extra runs and never carry provider response bodies.
  // Phase 20.1 BLOCKER 1 (D-06): winningSample and droppedSample titles are redacted via
  // redactFindingTitle (max 100 chars). failedRunReasons are already machine-enum-shaped and
  // bounded to 4.
  z
    .object({
      stage: z.literal('ensemble.voted'),
      file: z.string().min(1).max(1_024),
      requestedRuns: z.number().int().min(2).max(5),
      successfulRuns: z.number().int().min(0).max(5),
      failedRuns: z.number().int().min(0).max(5),
      winnerCount: z.number().int().nonnegative(),
      droppedClusterCount: z.number().int().nonnegative(),
      winningSample: z.array(
        z.object({
          clusterId: z.string().min(1).max(100),
          votes: z.number().int().positive(),
          path: z.string().min(1).max(1_024),
          line: z.number().int().positive().nullable().optional(),
          title: z.string().max(100),
        }),
      ).max(20),
      droppedSample: z.array(
        z.object({
          clusterId: z.string().min(1).max(100),
          votes: z.number().int().nonnegative(),
          path: z.string().min(1).max(1_024),
          line: z.number().int().positive().nullable().optional(),
          title: z.string().max(100),
        }),
      ).max(20),
      failedRunReasons: z.array(phase19MachineReasonSchema).max(4).optional(),
      timestamp: dateStringSchema,
    })
    .passthrough(),
  // Walkthrough enrichment is auxiliary/fail-open. This aggregate records whether valid metadata was
  // completed, partially recovered, or unavailable; raw grouping/model output stays out of audit.
  z
    .object({
      stage: z.literal('walkthrough.enrichment'),
      status: z.enum(['completed', 'partial', 'failed']),
      reason: phase19MachineReasonSchema.optional(),
      groupCount: z.number().int().nonnegative().optional(),
      timestamp: dateStringSchema,
    })
    .passthrough(),
  // SEC-XDIFF-01: cross-file security reasoning pass audit event. Tracks completion status,
  // finding count, and how many files were included in the whole-diff context.
  z
    .object({
      stage: z.literal('cross_file_security'),
      status: z.enum(['completed', 'skipped', 'failed']),
      reason: z.string().optional(),
      finding_count: z.number().int().nonnegative().optional(),
      files_included: z.number().int().nonnegative().optional(),
      timestamp: dateStringSchema,
    })
    .passthrough(),
  // Phase 33 (PRD-01 / FR-031, D-03/D-04): inline_comment_skipped audit event. AGGREGATE — one event
  // per review round when inline comments were skipped (422 or budget exhaustion) at posting.
  // `count` is the FULL total; the sample is capped at 20 (INLINE_COMMENT_SKIPPED_SAMPLE_CAP).
  // Sample identifiers admit ONLY { path, line, position, commentId } (T-13-03-03) —
  // never body/title/existingCode/codeSuggestion.
  //
  // WR-01: `line` (head-side line number) and `position` (diff offset) are SEPARATE fields because
  // they are not the same quantity and are not comparable across providers (G-28-3) — Bitbucket
  // fills `line`, GitHub fills `position`. Collapsing them made the viewer render a fabricated line
  // number for every GitHub skip. `position` is optional so pre-existing persisted rows still parse.
  //
  // WR-06: `title` is GONE, replaced by `commentId` (the persisted `review_comments.id`). The
  // sample used to carry a title routed through `redactFindingTitle`, which maps EVERY non-empty
  // title to one fixed marker — so the field was inert and an operator could not join a skipped
  // entry back to a finding. A digest of the title was rejected deliberately: `redactFindingTitle`'s
  // own contract forbids retaining a "source-derived prefix, digest, length, or other title
  // content", and formulaic finding titles are dictionary-attackable over a small plausible-title
  // space. The row id carries ZERO title content, so it restores operator value at no privacy cost.
  // `commentId` is optional so pre-existing persisted audit rows (which have `title` instead) still
  // parse; their now-unknown `title` key is simply stripped by this nested object.
  z
    .object({
      stage: z.literal('inline_comment_skipped'),
      // IN-01: `.min(0)` mirrors the sibling suggestion_dropped.droppedCount bound — a negative
      // skip count is never producible and must not round-trip through the audit column.
      count: z.number().int().min(0),
      sample: z.array(
        z.object({
          path: z.string(),
          line: z.number().nullable().optional(),
          position: z.number().nullable().optional(),
          commentId: z.string().max(64).nullable().optional(),
        }),
      ).max(20),
      timestamp: dateStringSchema,
    })
    .passthrough(),
  // Phase 34 (PRD-05, D-12): .review.yaml parse/validation failure → DB config fallback + this
  // audit event. `reason` carries the parse/validation error message, bounded to 500 chars (the
  // 34-03 builder slices to 500). The review always proceeds — the YAML file is advisory.
  z
    .object({
      stage: z.literal('yaml_config_parse_failed'),
      reason: z.string().min(1).max(500),
      timestamp: dateStringSchema,
    })
    .passthrough(),
  // Phase 34 WR-03 / WR-07 (34-REVIEW): a `.review.yaml` was found, parsed and MERGED. This event
  // exists because the D-09 merge is a WHOLESALE top-level replacement driven by a file read from
  // `pr.headSha` — a branch any PR author controls. A two-line file declaring `review:` resets
  // EVERY operator-configured sub-key to its Zod default (passes.security.enabled → false,
  // evidence.hard_drop → false, learning.learned_rules → [], max_files → 150, …) and that reset is
  // then persisted to jobs.config_snapshot, where every later phase observes it. Nothing in the
  // audit trail said so. `replaced_keys` names the top-level keys the YAML overrode, so the reset
  // is OBSERVABLE after the fact.
  //
  // `ignored_keys` covers WR-07: `repoConfigSchema` is non-strict, so a typo'd top-level key
  // (`reveiw:`) is silently stripped by Zod, the merge becomes an identity, and the operator gets
  // NO signal that their file did nothing. Naming the stripped keys here is that signal.
  //
  // This event is NOT a failure — it is emitted on the success path. Bounds mirror the other
  // sampled arms: at most 20 key names, each at most 64 chars.
  z
    .object({
      stage: z.literal('yaml_config_applied'),
      source: z.string().min(1).max(64),
      replaced_keys: z.array(z.string().max(64)).max(20),
      ignored_keys: z.array(z.string().max(64)).max(20),
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
  // NOTE: This function does NOT inject Zod defaults for evidence or any other nested config keys.
  // That responsibility is in config.ts's loadRepoConfig (which calls repoConfigSchema.parse() after
  // model override) to ensure DB-loaded configs always get defaults for keys added post-storage.
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

// --- VCS workspace-level bot-credential contracts (Phase 31, WS-01, D-01/D-02) ---
// Mirrors vcsCredentialStatusSchema exactly, minus repoSlug -- this is a workspace-scoped
// (not per-repo) credential. Redacted READ DTO -- never carries secrets/ciphertext (D-10 mirrored).
export const vcsWorkspaceCredentialStatusSchema = z.object({
  vcsProvider: z.literal('bitbucket'),
  workspace: z.string(),
  hasToken: z.boolean(),
  hasWebhookSecret: z.boolean(),
  tokenExpiresAt: dateStringSchema.nullable(),
  label: z.string().nullable(),
  status: credentialStatusSchema,
  createdAt: dateStringSchema,
  updatedAt: dateStringSchema,
});
export type VcsWorkspaceCredentialStatus = z.infer<typeof vcsWorkspaceCredentialStatusSchema>;

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
