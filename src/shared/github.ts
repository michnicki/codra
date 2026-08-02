export const supportedGitHubWebhookEvents = ['pull_request', 'issue_comment', 'pull_request_review_comment', 'push'] as const;

export type GitHubWebhookEventName = typeof supportedGitHubWebhookEvents[number];

export function isSupportedGitHubWebhookEvent(eventName: string): eventName is GitHubWebhookEventName {
  return (supportedGitHubWebhookEvents as readonly string[]).includes(eventName);
}

export type PullRequestWebhookPayload = {
  action: 'opened' | 'synchronize' | 'ready_for_review' | 'reopened' | 'closed';
  installation?: { id: number };
  repository: {
    owner: { login: string };
    name: string;
  };
  pull_request: {
    number: number;
    title: string;
    user: { login: string };
    head: { sha: string; ref: string };
    base: { sha: string; ref: string };
    draft: boolean;
    body: string | null;
  };
};

export type IssueCommentWebhookPayload = {
  action: 'created';
  installation?: { id: number };
  repository: {
    owner: { login: string };
    name: string;
  };
  issue: {
    number: number;
    pull_request?: {
      url: string;
    };
  };
  // Phase 11 (D-12, Pitfall 5): additively widened from `{ body }` to carry the immutable comment id
  // and the author's IMMUTABLE numeric id + login, so command classification can self-filter the
  // bot's own comments on the immutable id (NREG-02) and key authorization off it — never the mutable
  // login. `in_reply_to_id` is present on issue-comment replies; kept optional so a top-level comment
  // (no parent) still parses. Existing `pull_request` parsing is untouched.
  comment: {
    id: number;
    body: string;
    user: { id: number; login: string };
    in_reply_to_id?: number;
  };
};

// Phase 11 (D-09, OQ2 RESOLVED): a reply left UNDER an inline review finding arrives as a
// `pull_request_review_comment` event (not `issue_comment`). Modeling it additively — with the same
// immutable author id + `in_reply_to_id` linkage Bitbucket derives from `comment.parent.id` — gives
// GitHub reply-under-finding `reject` full parity with Bitbucket. `path` is the file the inline
// comment hangs on. All feature wiring (route + parity tests) lands in Plan 07; this is the inert
// contract shape. With the feature disabled a delivery parses but produces no job / no side effect
// (NREG-01).
export type PullRequestReviewCommentWebhookPayload = {
  action: 'created';
  installation?: { id: number };
  repository: {
    owner: { login: string };
    name: string;
  };
  pull_request: {
    number: number;
  };
  comment: {
    id: number;
    body: string;
    user: { id: number; login: string };
    in_reply_to_id?: number;
    path?: string;
  };
};

// Phase 29 (QA-IDX-01, D-08): the `push` event payload contract. A default-branch push is the index
// freshness trigger — the webhook route filters to the repository's default branch and hands the
// `before`/`after` pair to an incremental index build (the changed-file set is derived from the
// existing `getCompareDiff` primitive, not from this payload's `commits` list, which GitHub caps at
// 2048 anyway). With the index toggle off the delivery parses but produces no build (NREG-01).
//
// ASSUMPTION A1 — `repository.default_branch` is NOT documented for the push event (the docs list
// `master_branch` only for the `create` event). Consumers MUST read `default_branch ?? master_branch`
// and skip rather than guess when both are absent — a guessed conventional branch name would index a
// branch the operator did not choose. The both-absent path emits a warning so the skip is observable;
// the field's real presence is confirmable with one real delivery in acceptance testing.
export type PushWebhookPayload = {
  /** Full git ref, e.g. `refs/heads/main` or `refs/tags/v3.14.1`. */
  ref: string;
  /** The sha of the ref before the push. All zeros when `created` is true — never a compare operand. */
  before: string;
  /** The sha of the ref after the push. All zeros when `deleted` is true. */
  after: string;
  created: boolean;
  deleted: boolean;
  forced: boolean;
  installation?: { id: number };
  repository: {
    owner: { login: string };
    name: string;
    /** See ASSUMPTION A1 above — optional because it is undocumented for this event. */
    default_branch?: string;
    master_branch?: string;
  };
};

export type GitHubWebhookPayload =
  | PullRequestWebhookPayload
  | IssueCommentWebhookPayload
  | PullRequestReviewCommentWebhookPayload
  | PushWebhookPayload;
