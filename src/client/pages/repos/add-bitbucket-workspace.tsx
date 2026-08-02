import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { GitBranch, Plus, RefreshCw } from 'lucide-react';
import { api } from '@client/lib/api';
import { PageHeader } from '@client/components/layout/page-header';
import { Card, CardContent } from '@client/components/ui/card';
import { Button } from '@client/components/ui/button';
import { Input } from '@client/components/ui/input';
import { Alert } from '@client/components/ui/alert';
import { Badge } from '@client/components/ui/badge';
import { Checkbox } from '@client/components/ui/checkbox';
import { EmptyState } from '@client/components/shared/empty-state';
import { cn } from '@client/lib/utils';
import type { WorkspaceRepoListItem } from '@shared/bitbucket';

const DISCOVER_ERROR_TITLE = 'Could not list repositories.';
const DISCOVER_ERROR_DESCRIPTION = 'Check the workspace slug and access token, then try again.';
const FINALIZE_ERROR_TITLE = 'Could not add workspace.';
const FINALIZE_ERROR_DESCRIPTION = "Your token and webhook weren't saved. Please try again.";
const EMPTY_STATE_TITLE = 'No repositories found';
const EMPTY_STATE_DESCRIPTION =
  "This workspace doesn't have any repositories, or the token can't see any. Double-check the workspace slug and the token's scopes, then try again.";

export function AddBitbucketWorkspacePage() {
  const navigate = useNavigate();
  const [workspace, setWorkspace] = useState('');
  const [accessToken, setAccessToken] = useState('');
  const [webhookSecret, setWebhookSecret] = useState('');
  const [tokenExpiresAt, setTokenExpiresAt] = useState('');
  const [discovering, setDiscovering] = useState(false);
  const [discoverError, setDiscoverError] = useState<string | null>(null);
  const [repos, setRepos] = useState<WorkspaceRepoListItem[] | null>(null);
  const [selectedSlugs, setSelectedSlugs] = useState<Set<string>>(new Set());
  const [finalizing, setFinalizing] = useState(false);
  const [finalizeError, setFinalizeError] = useState(false);

  // Client-side only, mirroring add-bitbucket.tsx's established derivation: no server-side env
  // var has a client-exposure path, and window.location.origin is exactly the URL the operator is
  // viewing.
  const webhookUrl = `${window.location.origin}/webhook/bitbucket`;

  const canDiscover = Boolean(workspace.trim() && accessToken.trim() && webhookSecret.trim());
  const selectedCount = selectedSlugs.size;
  const submitLabel =
    selectedCount === 0
      ? 'Select repositories to add'
      : selectedCount === 1
        ? 'Add 1 repository'
        : `Add ${selectedCount} repositories`;

  const handleDiscover = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!canDiscover || discovering) return;

    setDiscovering(true);
    try {
      const result = await api.discoverBitbucketWorkspaceRepos({
        workspace: workspace.trim(),
        accessToken: accessToken.trim(),
      });
      setRepos(result.repos);
      setSelectedSlugs(new Set());
      setDiscoverError(null);
    } catch {
      // Deliberately fixed, generic copy (UI-SPEC): Bitbucket does not reliably distinguish
      // bad-token/bad-workspace/no-access at this call. The user's typed values are NOT cleared.
      setDiscoverError(DISCOVER_ERROR_TITLE);
    } finally {
      setDiscovering(false);
    }
  };

  const toggleRepo = (slug: string, checked: boolean) => {
    setSelectedSlugs((prev) => {
      const next = new Set(prev);
      if (checked) {
        next.add(slug);
      } else {
        next.delete(slug);
      }
      return next;
    });
  };

  const selectAll = () => {
    if (!repos) return;
    setSelectedSlugs(new Set(repos.map((repo) => repo.slug)));
  };

  const selectNone = () => {
    setSelectedSlugs(new Set());
  };

  const handleFinalize = async () => {
    if (selectedCount === 0 || finalizing) return;

    setFinalizing(true);
    setFinalizeError(false);
    try {
      const result = await api.addBitbucketWorkspace({
        workspace: workspace.trim(),
        accessToken: accessToken.trim(),
        webhookSecret: webhookSecret.trim(),
        // Omit the key entirely when blank so an untouched field means "leave untouched" (D-11),
        // not an explicit clear -- this field is never prefilled from a stored value, so a
        // resubmission-to-sync (D-06) must not wipe a previously-recorded expiry every time.
        ...(tokenExpiresAt ? { tokenExpiresAt } : {}),
        // SORTED (not raw Set insertion order) for a deterministic payload regardless of which
        // order the operator checked rows in (OpenCode review finding, MEDIUM).
        selectedRepoSlugs: Array.from(selectedSlugs).sort(),
      });
      // Clear the credential material from component state as soon as it's been persisted --
      // mirrors add-bitbucket.tsx's plaintext-clearing convention.
      setAccessToken('');
      setWebhookSecret('');
      const n = result.repositoryCount;
      toast.success('Bitbucket workspace added', {
        description: `${n} ${n === 1 ? 'repository' : 'repositories'} added. OpenCodra will review pull requests as they arrive.`,
      });
      navigate('/repos');
    } catch {
      // Selection is deliberately PRESERVED (not reset) on failure so the operator can retry
      // without re-picking repos.
      setFinalizeError(true);
    } finally {
      setFinalizing(false);
    }
  };

  return (
    <section className="page-enter flex flex-col gap-5">
      <PageHeader
        category="Repositories"
        title="Add Bitbucket workspace"
        description="Store a workspace access token and webhook secret so OpenCodra can discover and review pull requests across the whole workspace."
      />

      <Card>
        <CardContent className="p-5">
          <Alert variant="default" className="mb-4">
            <div className="flex flex-col gap-1">
              <p>
                Before submitting: create a Workspace Access Token at workspace settings → Access
                tokens with at least <code>pullrequest:write</code>, <code>repository</code>,{' '}
                <code>repository:write</code>, and <code>webhook</code> scopes. Unlike the per-repo
                flow, you do not need to create the webhook yourself — Codra creates a workspace
                webhook pointing to <code>{webhookUrl}</code> automatically when you finish this
                form.
              </p>
            </div>
          </Alert>

          {discoverError && (
            <Alert variant="destructive" className="mb-4">
              <div className="flex flex-col gap-1">
                <p className="font-semibold">{DISCOVER_ERROR_TITLE}</p>
                <p>{DISCOVER_ERROR_DESCRIPTION}</p>
              </div>
            </Alert>
          )}

          <form className="flex flex-col gap-3" onSubmit={handleDiscover}>
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-semibold text-foreground">Workspace</span>
              <Input
                type="text"
                value={workspace}
                onChange={(e) => setWorkspace(e.target.value)}
                placeholder="my-workspace"
                autoComplete="off"
                disabled={discovering || finalizing}
              />
              <span className="text-xs text-muted-foreground">Lowercase only.</span>
            </label>

            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-semibold text-foreground">Workspace access token</span>
              <Input
                type="password"
                value={accessToken}
                onChange={(e) => setAccessToken(e.target.value)}
                placeholder="Workspace Access Token"
                autoComplete="off"
                disabled={discovering || finalizing}
              />
              <span className="text-xs text-muted-foreground">
                Bearer token from Bitbucket's workspace settings. Stored encrypted; never shown
                again.
              </span>
            </label>

            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-semibold text-foreground">Webhook secret</span>
              <Input
                type="password"
                value={webhookSecret}
                onChange={(e) => setWebhookSecret(e.target.value)}
                placeholder="Workspace webhook secret"
                autoComplete="off"
                disabled={discovering || finalizing}
              />
              <span className="text-xs text-muted-foreground">
                Used to verify incoming Bitbucket webhooks. Collected here in Step 1 so the
                finalize step later has it, even though discovery itself never reads it.
              </span>
            </label>

            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-semibold text-foreground">Token expires at (optional)</span>
              <Input
                type="date"
                value={tokenExpiresAt}
                onChange={(e) => setTokenExpiresAt(e.target.value)}
                disabled={discovering || finalizing}
              />
              <span className="text-xs text-muted-foreground">
                Copy from Bitbucket's token screen. Leave blank if the token has no expiry.
              </span>
            </label>

            <div className="mt-2 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button
                type="button"
                variant="outline"
                onClick={() => navigate('/repos')}
                disabled={discovering || finalizing}
              >
                Back to repositories
              </Button>
              <Button type="submit" disabled={!canDiscover || discovering || finalizing} className="gap-2">
                <RefreshCw size={14} className={cn(discovering && 'animate-spin')} />
                {discovering ? 'Discovering repositories…' : 'Discover repositories'}
              </Button>
            </div>
          </form>

          {finalizeError && (
            <Alert variant="destructive" className="mt-4">
              <div className="flex flex-col gap-1">
                <p className="font-semibold">{FINALIZE_ERROR_TITLE}</p>
                <p>{FINALIZE_ERROR_DESCRIPTION}</p>
              </div>
            </Alert>
          )}

          {repos !== null && repos.length === 0 && (
            <EmptyState
              icon={<GitBranch />}
              title={EMPTY_STATE_TITLE}
              description={EMPTY_STATE_DESCRIPTION}
            />
          )}

          {repos !== null && repos.length > 0 && (
            <div className="mt-5 flex min-w-0 flex-col gap-3">
              <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    className="text-xs font-semibold text-primary hover:underline disabled:pointer-events-none disabled:opacity-50"
                    onClick={selectAll}
                    disabled={finalizing}
                  >
                    Select all
                  </button>
                  <button
                    type="button"
                    className="text-xs font-semibold text-primary hover:underline disabled:pointer-events-none disabled:opacity-50"
                    onClick={selectNone}
                    disabled={finalizing}
                  >
                    Select none
                  </button>
                </div>
                <span className="text-xs text-muted-foreground">{selectedCount} selected</span>
              </div>

              <div className="flex min-w-0 flex-col gap-2">
                {repos.map((repo) => (
                  <article
                    key={repo.slug}
                    className="surface surface-static-shadow flex min-w-0 items-center gap-3 px-3 py-3"
                  >
                    <Checkbox
                      checked={selectedSlugs.has(repo.slug)}
                      onCheckedChange={(checked) => toggleRepo(repo.slug, checked)}
                      disabled={finalizing}
                      aria-label={`Select ${repo.name}`}
                    />
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                      {repo.name}
                    </span>
                    {repo.alreadyOnboarded && <Badge variant="secondary">Already added</Badge>}
                  </article>
                ))}
              </div>

              <div className="mt-2 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => navigate('/repos')}
                  disabled={finalizing}
                >
                  Back to repositories
                </Button>
                <Button
                  type="button"
                  onClick={handleFinalize}
                  disabled={selectedCount === 0 || finalizing}
                  className="gap-2"
                >
                  {finalizing ? (
                    <RefreshCw size={14} className="animate-spin" />
                  ) : (
                    <Plus size={14} />
                  )}
                  {finalizing ? 'Adding workspace…' : submitLabel}
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
