import { z } from 'zod';
import {
  ANNOTATION_SEVERITY_VALUES,
  BUILD_STATUS_STATE,
  LINE_TYPES,
  REPORT_RESULT,
  REPORT_TYPE_VALUES,
} from '@server/bitbucket/constants';

// These schemas lock the Bitbucket fields Codra consumes or emits. Inbound webhook objects preserve
// documented provider fields Codra does not consume, while outbound request objects stay strict so
// malformed API writes fail at the boundary. REV-M-1 keeps eventName outside the raw body: the route
// injects X-Event-Key after capturing and parsing the raw body. REV-M-2 keeps comments
// Bitbucket-native, while REV-M-4 imports every emitted API enum from the server constants module.
// Any upstream contract change requires updating this versioned seam.
const workspaceSchema = z.looseObject({
  slug: z.string().min(1),
});

const repositorySchema = z.looseObject({
  full_name: z.string().min(1),
  workspace: workspaceSchema,
  uuid: z.string().min(1),
});

const branchSchema = z.looseObject({
  name: z.string().min(1),
});

const commitSchema = z.looseObject({
  hash: z.string().min(1),
});

const pullRequestSideSchema = z.looseObject({
  branch: branchSchema,
  commit: commitSchema,
});

const pullRequestSchema = z.looseObject({
  id: z.number().int().positive(),
  source: pullRequestSideSchema,
  destination: pullRequestSideSchema,
  title: z.string(),
  state: z.string().min(1),
});

export const bitbucketPullRequestWebhookBaseSchema = z.looseObject({
  repository: repositorySchema,
  pullrequest: pullRequestSchema,
});

export const pullRequestCreatedPayloadSchema = bitbucketPullRequestWebhookBaseSchema.extend({
  eventName: z.literal('pullrequest:created'),
}).passthrough();

export const pullRequestUpdatedPayloadSchema = bitbucketPullRequestWebhookBaseSchema.extend({
  eventName: z.literal('pullrequest:updated'),
}).passthrough();

// Phase 11 (D-12): the `pullrequest:comment_created` webhook variant. A reply left under an inline
// review finding carries `comment.parent.id` (the finding's comment id) — the same reply-under-finding
// linkage GitHub derives from `in_reply_to_id` — so a `reject` reaches the same parentRef/findingRef
// capture. `z.looseObject` on the comment sub-objects mirrors the inbound-webhook convention above
// (preserve documented provider fields Codra does not consume); `.passthrough()` on the payload keeps
// undocumented top-level fields. `parent` and `inline` are optional so a top-level comment (no parent,
// not inline) still parses (CMD-06 edge). Every field addition is additive — the existing created/
// updated variants are untouched (NREG-01).
const bitbucketCommentUserSchema = z.looseObject({
  account_id: z.string().min(1),
  nickname: z.string().optional(),
});

const bitbucketCommentInlineSchema = z.looseObject({
  path: z.string(),
  from: z.number().optional(),
  to: z.number().optional(),
});

const bitbucketWebhookCommentSchema = z.looseObject({
  id: z.number().int().positive(),
  content: z.looseObject({ raw: z.string() }),
  user: bitbucketCommentUserSchema,
  parent: z.looseObject({ id: z.number().int().positive() }).optional(),
  inline: bitbucketCommentInlineSchema.optional(),
});

export const pullRequestCommentCreatedPayloadSchema = bitbucketPullRequestWebhookBaseSchema.extend({
  eventName: z.literal('pullrequest:comment_created'),
  comment: bitbucketWebhookCommentSchema,
}).passthrough();

// Phase 29 (QA-IDX-01, D-08): the `repo:push` webhook variant — the Bitbucket half of index
// freshness. A push to the repository's main branch triggers an incremental index build carrying
// the old/new target hashes; the changed-file set is derived from the existing `getCompareDiff`
// primitive, not from the payload's `commits[]` list.
//
// ASSUMPTION A2 — the `push.changes[]` field shape is COMMUNITY-SOURCED rather than confirmed by
// the official Atlassian docs (the docs page is truncated), which is exactly why the inbound
// convention here is `z.looseObject`: an unexpected extra field does not fail the parse. The
// residual risk is a RENAMED field (e.g. `new.target.hash` under a different path), which degrades
// to a parse failure and an ignored acknowledgement — indistinguishable from a correctly-ignored
// delivery. The first real delivery in acceptance testing is what confirms the guess.
//
// `new` is null on a ref deletion, `old` is null on a ref creation (no ancestor to compare
// against), and `repo:push` fires for tags too — consumers must filter on `new.type === 'branch'`
// plus the branch name. The repository sub-object keeps the shape the base schema already uses.
const repoPushRefSchema = z.looseObject({
  type: z.string().min(1),
  name: z.string().min(1),
  target: z.looseObject({
    hash: z.string().min(1),
  }),
});

const repoPushChangeSchema = z.looseObject({
  new: repoPushRefSchema.nullable().optional(),
  old: repoPushRefSchema.nullable().optional(),
  created: z.boolean().optional(),
  closed: z.boolean().optional(),
  forced: z.boolean().optional(),
  truncated: z.boolean().optional(),
});

export const repoPushPayloadSchema = z
  .object({
    eventName: z.literal('repo:push'),
    repository: repositorySchema,
    push: z.looseObject({
      changes: z.array(repoPushChangeSchema),
    }),
  })
  // NOTE on the catchall: the plan's inbound convention is `z.looseObject` ("an unexpected extra
  // field does not fail the parse"), and this catchall is RUNTIME-IDENTICAL to it — unknown keys
  // are validated against `z.any()` (always succeeds) and preserved in the output. It is not
  // written as `z.looseObject(...)` for one type-level reason: `z.looseObject` infers an
  // `[k: string]: unknown` index signature, and adding a member with that signature to the
  // discriminated union below degrades every UNNARROWED union property access (e.g.
  // `result.data.pullrequest` in test/bitbucket-schema.spec.ts, which must pass unmodified) to
  // `unknown`, failing the typecheck. The `z.any()` catchall infers `[k: string]: any` instead, so
  // the union access resolves exactly as it did with three members. The inner objects keep the
  // `z.looseObject` convention; only the union-member top level needs this.
  .catchall(z.any());

export const pullRequestWebhookPayloadSchema = z.discriminatedUnion('eventName', [
  pullRequestCreatedPayloadSchema,
  pullRequestUpdatedPayloadSchema,
  pullRequestCommentCreatedPayloadSchema,
  repoPushPayloadSchema,
]);

const commentContentSchema = z.object({
  raw: z.string(),
}).strict();

const topLevelPrCommentSchema = z.object({
  content: commentContentSchema,
}).strict();

const inlinePrCommentSchema = z.object({
  path: z.string().min(1),
  line: z.number().int().positive(),
  line_type: z.enum(LINE_TYPES),
  content: commentContentSchema,
}).strict();

export const prCommentSchema = z.union([
  topLevelPrCommentSchema,
  inlinePrCommentSchema,
]);

const reportDataTypeSchema = z.enum([
  'BOOLEAN',
  'DATE',
  'DURATION',
  'LINK',
  'NUMBER',
  'PERCENTAGE',
  'TEXT',
]);

const reportDataSchema = z.object({
  title: z.string().min(1),
  type: reportDataTypeSchema,
  value: z.union([z.boolean(), z.number(), z.string()]),
}).strict();

export const codeInsightsReportSchema = z.object({
  title: z.string().min(1),
  details: z.string(),
  report_type: z.enum(REPORT_TYPE_VALUES),
  result: z.enum(REPORT_RESULT),
  link: z.url().optional(),
  data: z.array(reportDataSchema).max(10).optional(),
}).strict();

export const commitBuildStatusSchema = z.object({
  key: z.string().min(1),
  state: z.enum(BUILD_STATUS_STATE),
  description: z.string(),
  url: z.url(),
}).strict();

// Phase 30 (ANNO-01, D-01/D-04/D-05/D-06): the outbound per-annotation payload posted to
// Bitbucket's Code Insights bulk annotations endpoint. `.strict()` mirrors codeInsightsReportSchema/
// commitBuildStatusSchema's outbound-write convention so a future caller cannot smuggle unexpected
// keys into the wire payload. `annotation_type` and `result` reuse the existing REPORT_TYPE_VALUES/
// REPORT_RESULT enums (D-05/D-02) rather than inventing new ones; `severity` imports its literal
// value set from ANNOTATION_SEVERITY_VALUES (bitbucket/constants.ts) so the client and schema
// cannot drift apart. `path`/`line` are optional — an overview-modal annotation (no inline anchor)
// omits both, per 30-RESEARCH.md. No `.max()` length bound on title/summary/details/external_id:
// Bitbucket's swagger.json does not document one (30-RESEARCH.md Assumptions Log).
export const reportAnnotationSchema = z.object({
  external_id: z.string().min(1),
  title: z.string().optional(),
  annotation_type: z.enum(REPORT_TYPE_VALUES).optional(),
  summary: z.string().optional(),
  details: z.string().optional(),
  result: z.enum(REPORT_RESULT).optional(),
  severity: z.enum(ANNOTATION_SEVERITY_VALUES),
  path: z.string().optional(),
  line: z.number().int().positive().optional(),
  link: z.url().optional(),
}).strict();

export type ReportAnnotation = z.infer<typeof reportAnnotationSchema>;

export type BitbucketPullRequestWebhookBase = z.infer<typeof bitbucketPullRequestWebhookBaseSchema>;
export type PullRequestCreatedPayload = z.infer<typeof pullRequestCreatedPayloadSchema>;
export type PullRequestUpdatedPayload = z.infer<typeof pullRequestUpdatedPayloadSchema>;
export type PullRequestCommentCreatedPayload = z.infer<typeof pullRequestCommentCreatedPayloadSchema>;
export type RepoPushPayload = z.infer<typeof repoPushPayloadSchema>;
export type PullRequestWebhookPayload = z.infer<typeof pullRequestWebhookPayloadSchema>;
export type PrComment = z.infer<typeof prCommentSchema>;
export type CodeInsightsReport = z.infer<typeof codeInsightsReportSchema>;
export type CommitBuildStatus = z.infer<typeof commitBuildStatusSchema>;

// Phase 6 (D-33/D-34): inbound Bitbucket OAuth /2.0/user profile response. `.passthrough()`
// preserves documented provider fields Codra does not consume, mirroring the webhook-inbound
// convention above.
export const bitbucketOAuthProfileSchema = z.looseObject({
  account_id: z.string().min(1),
  uuid: z.string().min(1),
  username: z.string().min(1),
  display_name: z.string().nullable(),
  // URL-validate the top-level `avatar` fallback the same way `links.avatar.href` is validated
  // below: it flows into `avatarUrl` (bitbucket-oauth.ts) and is rendered as an image src, so a
  // non-URL value (e.g. `javascript:`/`data:`) must not pass through. `.catch(null)` degrades a
  // malformed value to null instead of failing the whole OAuth profile parse (which would block
  // login).
  avatar: z.url().nullable().optional().catch(null),
  links: z.looseObject({
    avatar: z.object({ href: z.url() }).optional(),
  }).optional(),
  email: z.string().nullable().optional(),
});

// Phase 6 (D-32): outbound add-repo form input. `.strict()` rejects unknown keys so malformed
// API writes fail at the boundary, mirroring vcsCredentialStoreSchema (src/shared/schema.ts).
export const addBitbucketRepoInputSchema = z.object({
  workspace: z.string().trim().toLowerCase().min(1).max(100),
  repoSlug: z.string().trim().toLowerCase().min(1).max(100),
  accessToken: z.string().trim().min(1).max(4096),
  webhookSecret: z.string().trim().min(1).max(4096),
  tokenExpiresAt: z.union([z.iso.date(), z.iso.datetime({ offset: true })]).nullable().optional(),
}).strict();

export type BitbucketOAuthProfile = z.infer<typeof bitbucketOAuthProfileSchema>;
export type AddBitbucketRepoInput = z.infer<typeof addBitbucketRepoInputSchema>;

// Phase 31 (WS-01, D-05): outbound workspace-discovery input. `.strict()` rejects unknown keys,
// mirroring `addBitbucketRepoInputSchema` above. Discovery is a live, read-only, add-time-only
// call -- this schema carries no persisted-record fields (no repoSlug, no webhookSecret).
export const discoverBitbucketWorkspaceInputSchema = z.object({
  workspace: z.string().trim().toLowerCase().min(1).max(100),
  accessToken: z.string().trim().min(1).max(4096),
}).strict();

// Phase 31 (WS-01, D-04): one entry in the discover response's repo list. `alreadyOnboarded` is
// computed server-side (a `repositories` table read), never supplied by Bitbucket.
export const workspaceRepoListItemSchema = z.object({
  slug: z.string(),
  name: z.string(),
  alreadyOnboarded: z.boolean(),
});

export type DiscoverBitbucketWorkspaceInput = z.infer<typeof discoverBitbucketWorkspaceInputSchema>;
export type WorkspaceRepoListItem = z.infer<typeof workspaceRepoListItemSchema>;
