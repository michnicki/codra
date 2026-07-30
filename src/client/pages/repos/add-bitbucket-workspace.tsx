import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { GitBranch, RefreshCw } from 'lucide-react';
import { api } from '@client/lib/api';
import { PageHeader } from '@client/components/layout/page-header';
import { Card, CardContent } from '@client/components/ui/card';
import { Button } from '@client/components/ui/button';
import { Input } from '@client/components/ui/input';
import { Alert } from '@client/components/ui/alert';
import { Badge } from '@client/components/ui/badge';
import { EmptyState } from '@client/components/shared/empty-state';
import { cn } from '@client/lib/utils';
import type { WorkspaceRepoListItem } from '@shared/bitbucket';

const DISCOVER_ERROR_TITLE = 'Could not list repositories.';
const DISCOVER_ERROR_DESCRIPTION = 'Check the workspace slug and access token, then try again.';
const EMPTY_STATE_TITLE = 'No repositories found';
const EMPTY_STATE_DESCRIPTION =
  "This workspace doesn't have any repositories, or the token can't see any. Double-check the workspace slug and the token's scopes, then try again.";

export function AddBitbucketWorkspacePage() {
  const navigate = useNavigate();
  const [workspace, setWorkspace] = useState('');
  const [accessToken, setAccessToken] = useState('');
  const [webhookSecret, setWebhookSecret] = useState('');
  const [discovering, setDiscovering] = useState(false);
  const [discoverError, setDiscoverError] = useState<string | null>(null);
  const [repos, setRepos] = useState<WorkspaceRepoListItem[] | null>(null);

  // Client-side only, mirroring add-bitbucket.tsx's established derivation: no server-side env
  // var has a client-exposure path, and window.location.origin is exactly the URL the operator is
  // viewing.
  const webhookUrl = `${window.location.origin}/webhook/bitbucket`;

  const canDiscover = Boolean(workspace.trim() && accessToken.trim() && webhookSecret.trim());

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
      setDiscoverError(null);
    } catch {
      // Deliberately fixed, generic copy (UI-SPEC): Bitbucket does not reliably distinguish
      // bad-token/bad-workspace/no-access at this call. The user's typed values are NOT cleared.
      setDiscoverError(DISCOVER_ERROR_TITLE);
    } finally {
      setDiscovering(false);
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
                disabled={discovering}
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
                disabled={discovering}
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
                disabled={discovering}
              />
              <span className="text-xs text-muted-foreground">
                Used to verify incoming Bitbucket webhooks. Collected here in Step 1 so the
                finalize step later has it, even though discovery itself never reads it.
              </span>
            </label>

            <div className="mt-2 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button
                type="button"
                variant="outline"
                onClick={() => navigate('/repos')}
                disabled={discovering}
              >
                Back to repositories
              </Button>
              <Button type="submit" disabled={!canDiscover || discovering} className="gap-2">
                <RefreshCw size={14} className={cn(discovering && 'animate-spin')} />
                {discovering ? 'Discovering repositories…' : 'Discover repositories'}
              </Button>
            </div>
          </form>

          {repos !== null && repos.length === 0 && (
            <EmptyState
              icon={<GitBranch />}
              title={EMPTY_STATE_TITLE}
              description={EMPTY_STATE_DESCRIPTION}
            />
          )}

          {repos !== null && repos.length > 0 && (
            <div className="mt-5 flex min-w-0 flex-col gap-2">
              {repos.map((repo) => (
                <article
                  key={repo.slug}
                  className="surface surface-static-shadow flex min-w-0 items-center justify-between gap-2 px-3 py-2.5"
                >
                  <span className="min-w-0 truncate text-sm font-medium text-foreground">
                    {repo.name}
                  </span>
                  {repo.alreadyOnboarded && <Badge variant="secondary">Already added</Badge>}
                </article>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
