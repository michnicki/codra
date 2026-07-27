import { GitHubClient, type GitHubReviewComment } from '../core/github';
import type { AppBindings } from '../env';

export class GitHubService {
  private client: GitHubClient;

  constructor(env: AppBindings, installationId: string, tracker?: { incrementSubrequests(count?: number): void }) {
    // Fail fast on a missing/blank installation id: a misconfigured (empty) value must not
    // silently reach the GitHub App auth flow and risk authenticating the wrong installation.
    // Presence-only — installation ids are opaque strings here, not necessarily numeric.
    if (!installationId || installationId.trim().length === 0) {
      throw new Error('GitHubService: installationId is required.');
    }
    this.client = new GitHubClient(env, installationId, tracker);
  }

  async getPullRequest(owner: string, repo: string, prNumber: number) {
    return this.client.getPullRequest(owner, repo, prNumber);
  }

  async getPullRequestDiff(owner: string, repo: string, prNumber: number) {
    return this.client.getPullRequestDiff(owner, repo, prNumber);
  }

  // PROV-01 (D-08): ref-aware file content primitive. The seam accepts the optional ref so
  // callers can pass branch / tag / commit SHA; omitting it preserves the legacy no-ref behavior.
  async getRepoFileContent(owner: string, repo: string, path: string, ref: string) {
    return this.client.getRepoFileOrNull(owner, repo, path, ref);
  }

  // PROV-01 (D-09): compare-diff primitive. BASE...HEAD with `application/vnd.github.diff`.
  async getCompareDiff(owner: string, repo: string, base: string, head: string) {
    return this.client.getCompareDiff(owner, repo, base, head);
  }

  // QA-IDX-01 (D-09): the two reads the index build's tree enumeration needs. Declared HERE and not
  // only on GitHubClient because `GithubAdapter` holds a `GitHubService`, never a `GitHubClient` --
  // that module boundary is load-bearing for the three specs that `vi.mock('@server/services/github')`
  // (see the GithubAdapter class comment). A method missing from this pass-through seam is
  // unreachable from the adapter.
  async getRepositoryMetadata(owner: string, repo: string) {
    return this.client.getRepositoryMetadata(owner, repo);
  }

  async getTree(owner: string, repo: string, treeIsh: string) {
    return this.client.getTree(owner, repo, treeIsh);
  }

  // PROV-02: GraphQL thread listing (D-05..D-07, R-2). Cursor-paged via the client; the optional
  // tracker is forwarded so the search consumer (Phase 19) can gate pagination near the Workers
  // subrequest cap (R-9). REQUIRED here so the vi.mock('@server/services/github') seam intercepts.
  async getReviewThreads(
    owner: string,
    repo: string,
    prNumber: number,
    tracker?: { hasRemainingSafeBudget?(needed?: number): boolean },
  ) {
    return this.client.getReviewThreads(owner, repo, prNumber, tracker);
  }

  // PROV-02: resolve a review thread (R-2). Returns the resolved thread payload on success;
  // throws `GitHubError` on any GraphQL errors envelope or missing data so the adapter can
  // convert to a neutral `false`. REQUIRED here so the vi.mock seam intercepts.
  async resolveReviewThread(threadId: string) {
    return this.client.resolveReviewThread(threadId);
  }

  async createCheckRun(owner: string, repo: string, params: { headSha: string; title: string; summary: string }) {
    return this.client.createCheckRun(owner, repo, params);
  }

  async updateCheckRun(owner: string, repo: string, checkRunId: number, params: { title: string; summary: string; status?: 'in_progress' | 'completed'; conclusion?: 'success' | 'neutral' | 'failure' | 'cancelled' }) {
    return this.client.updateCheckRun(owner, repo, checkRunId, params);
  }

  async createReview(owner: string, repo: string, prNumber: number, params: { commitSha: string; event: 'APPROVE' | 'COMMENT'; body: string; comments: GitHubReviewComment[] }) {
    return this.client.createReview(owner, repo, prNumber, params);
  }

  async findBotReviewForCommit(owner: string, repo: string, prNumber: number, commitSha: string, botLogin: string) {
    return this.client.findBotReviewForCommit(owner, repo, prNumber, commitSha, botLogin);
  }

  // Comment-primitive pass-throughs (Pitfall 1): REQUIRED so the GithubAdapter can reach the client
  // AND so the vi.mock('@server/services/github') seam intercepts. Each is a one-line delegate.
  async createIssueComment(owner: string, repo: string, issueNumber: number, body: string) {
    return this.client.createIssueComment(owner, repo, issueNumber, body);
  }

  async listIssueComments(owner: string, repo: string, issueNumber: number) {
    return this.client.listIssueComments(owner, repo, issueNumber);
  }

  async createReviewCommentReply(owner: string, repo: string, pullNumber: number, body: string, inReplyToId: number) {
    return this.client.createReviewCommentReply(owner, repo, pullNumber, body, inReplyToId);
  }

  async updateIssueComment(owner: string, repo: string, commentId: number, body: string) {
    return this.client.updateIssueComment(owner, repo, commentId, body);
  }

  // Phase 28 (LRN-01): fetch a single pull request review comment by id. Pass-through to the
  // client's getReviewComment. REQUIRED here so the vi.mock('@server/services/github') seam
  // intercepts (same pattern as the other comment-primitive pass-throughs above).
  async getReviewComment(owner: string, repo: string, commentId: number) {
    return this.client.getReviewComment(owner, repo, commentId);
  }

  // Command-authorization pass-through (Phase 11, CMD-08): the adapter re-verifies the returned
  // immutable id against the authorId before trusting the permission. REQUIRED here so the
  // vi.mock('@server/services/github') seam intercepts.
  async getUserRepoPermission(owner: string, repo: string, authorLogin: string) {
    return this.client.getUserRepoPermission(owner, repo, authorLogin);
  }

  // Bot-identity pass-through (Phase 11, CMD-07): the adapter surfaces this on the VcsProvider seam
  // so the Plan 06 dispatch layer builds a BotIdentityResolver from the provider. REQUIRED here so
  // the vi.mock('@server/services/github') seam intercepts.
  async resolveBotUserIdentity() {
    return this.client.resolveBotUserIdentity();
  }

  async ensureLabel(owner: string, repo: string, name: string, color: string) {
    return this.client.ensureLabel(owner, repo, name, color);
  }

  async addIssueLabels(owner: string, repo: string, prNumber: number, labels: string[]) {
    return this.client.addIssueLabels(owner, repo, prNumber, labels);
  }

  async removeIssueLabelsIfPresent(owner: string, repo: string, prNumber: number, labels: string[]) {
    return this.client.removeIssueLabelsIfPresent(owner, repo, prNumber, labels);
  }

  async removeIssueLabel(owner: string, repo: string, prNumber: number, label: string) {
    return this.client.removeIssueLabel(owner, repo, prNumber, label);
  }
}
