import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { Database, DatabaseZap, RefreshCw } from 'lucide-react';
import { Switch } from '@client/components/ui/switch';
import { Button } from '@client/components/ui/button';
import { Alert } from '@client/components/ui/alert';
import { api, type CodeIndexStatus } from '@client/lib/api';
import { usePolling } from '@client/hooks/use-polling';
import type { RepoConfig, VcsProvider } from '@shared/schema';

type CodeIndexConfig = RepoConfig['review']['interactive']['qa']['index'];

interface CodeIndexPanelProps {
  owner: string;
  repo: string;
  vcsProvider?: VcsProvider;
  /** The `review.interactive.qa.index` config sub-object. */
  config: CodeIndexConfig | undefined;
  /** Lifts a toggle edit to the parent for dirty tracking — the toggle is never posted directly. */
  onIndexChange: (index: CodeIndexConfig) => void;
  /** Triggers the parent to re-fetch the full config from the server (the sibling panel's C7 pattern). */
  onRefreshed: () => void;
}

/**
 * Codebase Index section for the repo config modal (QA-IDX-01 / D-16). Renders:
 * - Toggle for qa.index.enabled (dirty-tracked by parent via onIndexChange)
 * - "Build index" action (D-07: posts immediately, then refetches status from the server)
 * - Three branch states, each with visible content: config-disabled, enabled-but-never-built, built
 * - Built state: short indexed commit, last-built time, file/chunk counts, build status
 * - Freshness source from `mode`: dashboard rebuild / push refresh / never built (review #15)
 * - Bitbucket-only push-subscription hint while `mode` is still `full` (Antigravity S-04 / C-03)
 * - Truncated flag as an explicit partial-index indication (never presented as complete)
 * - Recorded build failure in an inline alert, message passed through unchanged (already redacted)
 *
 * Status is SERVER state (unlike the learned-rules sibling's config state), so the panel owns a
 * status read and refreshes it on a polling interval while a build is in progress. This phase
 * shipped with the UI design contract waived (--skip-ui): every visual choice not fixed here is
 * structural mimicry of learned-rules-panel.tsx, and the panel's only visual review is the human
 * checkpoint at the end of the plan.
 */
export function CodeIndexPanel({
  owner,
  repo,
  vcsProvider,
  config,
  onIndexChange,
  onRefreshed,
}: CodeIndexPanelProps) {
  const enabled = config?.enabled ?? false;

  const [building, setBuilding] = useState(false);
  const [status, setStatus] = useState<CodeIndexStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const buildInProgress = building || status?.status === 'building';

  const refreshStatus = useCallback(async () => {
    if (!enabled) return;
    try {
      const result = await api.getCodeIndexStatus(owner, repo, vcsProvider);
      setStatus(result.index);
    } catch {
      // Best-effort: keep the last known status. The next poll (or the next build press) retries.
    }
  }, [enabled, owner, repo, vcsProvider]);

  // Initial status read on mount; while a build is live, refresh on the shared polling idiom so
  // the pending affordance clears itself when the server leaves the building state.
  usePolling(refreshStatus, buildInProgress ? 5_000 : null, [enabled, buildInProgress]);

  const handleBuild = async () => {
    setBuilding(true);
    setError(null);
    try {
      const result = await api.buildCodeIndex(owner, repo, vcsProvider);
      if (result.coalesced) {
        toast.info('An index build is already running for this repository.');
      } else {
        toast.success('Index build started.');
      }
      // Never patch local status optimistically — refetch from the server so the panel shows the
      // authoritative state (the stale-view hazard the sibling panel's refresh callback exists to
      // avoid). onRefreshed additionally re-reads config from the server, matching the sibling.
      await refreshStatus();
      onRefreshed();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Index build failed to start.';
      setError(msg);
      toast.error('Could not start the index build. Please try again.');
    } finally {
      setBuilding(false);
    }
  };

  const hasIndex = status?.indexedSha != null;
  const isBitbucket = vcsProvider === 'bitbucket';

  return (
    <div className="flex flex-col gap-4" aria-busy={buildInProgress}>
      {/* Section heading */}
      <h3 className="text-base font-semibold text-foreground">Codebase Index</h3>

      {/* Toggle — the change is lifted to the parent, never posted directly. */}
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">Codebase index</p>
          <p className="text-xs text-muted-foreground">
            Let pull-request Q&amp;A look up files outside the diff.
          </p>
        </div>
        <Switch
          checked={enabled}
          onCheckedChange={(checked) => {
            onIndexChange({
              enabled: checked,
              max_files: config?.max_files ?? 500,
              chunk_lines: config?.chunk_lines ?? 50,
              top_k: config?.top_k ?? 8,
            });
          }}
          aria-label="Enable codebase index"
        />
      </div>

      {/* State: disabled by config */}
      {!enabled && (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-border/60 bg-background/40 px-4 py-8 text-center">
          <Database size={24} className="text-muted-foreground" />
          <p className="text-sm font-medium text-foreground">Codebase index is disabled</p>
          <p className="text-xs text-muted-foreground">
            Enable the codebase index toggle, then apply the settings, before building an index.
          </p>
        </div>
      )}

      {enabled && (
        <>
          {/* Build action + action error */}
          <div className="flex flex-col gap-2">
            <div className="flex justify-end">
              <Button
                variant="default"
                disabled={buildInProgress}
                onClick={handleBuild}
                aria-label="Build codebase index"
                className="gap-2"
              >
                {buildInProgress ? (
                  <RefreshCw size={14} className="animate-spin" />
                ) : (
                  <DatabaseZap size={14} />
                )}
                {buildInProgress ? 'Building...' : 'Build index'}
              </Button>
            </div>
            {error && (
              <Alert variant="destructive">
                {error}
              </Alert>
            )}
          </div>

          {/* Recorded build failure: the message was already redacted where it was written
              (AUD-01), so it is rendered unchanged and unenriched. */}
          {status?.lastError && (
            <Alert variant="destructive">
              {status.lastError}
            </Alert>
          )}

          {/* Freshness source (review: OpenCode 29-09 #15). Three distinct strings so an operator
              diagnosing a stale index can tell whether the push-refresh path has ever fired. */}
          {status && (
            <p className="text-xs text-muted-foreground">
              {status.mode === 'full'
                ? 'Last refresh: dashboard rebuild'
                : status.mode === 'incremental'
                  ? 'Last refresh: push refresh'
                  : 'Last refresh: never built'}
            </p>
          )}

          {/* Bitbucket-only hint: `mode` stuck at `full` is the only observable signature of a
              webhook subscription that was never edited to include the push event (Bitbucket
              subscriptions are created by hand). Absent for GitHub and once a push refresh has
              occurred, so it points at a real condition rather than nagging. */}
          {isBitbucket && status?.mode === 'full' && (
            <Alert variant="default">
              This index has only ever been built from the dashboard. Edit this repository&apos;s
              Bitbucket webhook subscription to include the repository push event, or the index
              will never refresh on push.
            </Alert>
          )}

          {/* State: enabled but never built */}
          {!hasIndex && (
            <div className="flex flex-col items-center gap-2 rounded-lg border border-border/60 bg-background/40 px-4 py-8 text-center">
              <DatabaseZap size={24} className="text-muted-foreground" />
              <p className="text-sm font-medium text-foreground">No index built yet</p>
              <p className="text-xs text-muted-foreground">
                Build the index to let pull-request Q&amp;A reference files outside the diff.
              </p>
              <Button
                variant="default"
                size="sm"
                disabled={buildInProgress}
                onClick={handleBuild}
                aria-label="Build codebase index"
                className="mt-2 gap-2"
              >
                {buildInProgress ? (
                  <RefreshCw size={13} className="animate-spin" />
                ) : (
                  <DatabaseZap size={13} />
                )}
                {buildInProgress ? 'Building...' : 'Build index'}
              </Button>
            </div>
          )}

          {/* State: built */}
          {hasIndex && status && (
            <div className="flex flex-col gap-2 rounded-lg border border-border/60 bg-background/40 px-4 py-4">
              <div className="flex items-center justify-between gap-4">
                <span className="text-xs font-medium text-muted-foreground">Status</span>
                <span className="text-sm text-foreground">
                  {status.status === 'ready'
                    ? 'Ready'
                    : status.status === 'building'
                      ? 'Building'
                      : status.status === 'failed'
                        ? 'Build failed'
                        : 'Idle'}
                </span>
              </div>
              <div className="flex items-center justify-between gap-4">
                <span className="text-xs font-medium text-muted-foreground">Indexed commit</span>
                <span className="font-mono text-sm text-foreground">{status.indexedSha?.slice(0, 7)}</span>
              </div>
              <div className="flex items-center justify-between gap-4">
                <span className="text-xs font-medium text-muted-foreground">Last built</span>
                <span className="text-sm text-foreground">
                  {status.indexedAt ? new Date(status.indexedAt).toLocaleString() : '—'}
                </span>
              </div>
              <div className="flex items-center justify-between gap-4">
                <span className="text-xs font-medium text-muted-foreground">Coverage</span>
                <span className="text-sm text-foreground">
                  {status.fileCount} {status.fileCount === 1 ? 'file' : 'files'} / {status.chunkCount}{' '}
                  {status.chunkCount === 1 ? 'chunk' : 'chunks'}
                </span>
              </div>

              {/* Truncated: the copy must convey that coverage is partial, that the provider chose
                  the omitted part (not priority), and that a rebuild truncates identically — the
                  remedy is a smaller scope, not a rebuild. */}
              {status.truncated && (
                <Alert variant="default">
                  Partial index: this index covers only part of the repository. Which files were
                  omitted was decided by the provider&apos;s tree listing, not by priority — and
                  rebuilding will truncate the same way. Narrow the scope (for example the max-files
                  setting) to cover the repository fully.
                </Alert>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
