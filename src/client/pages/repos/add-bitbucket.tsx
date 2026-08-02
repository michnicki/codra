import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Plus } from 'lucide-react';
import { api } from '@client/lib/api';
import { PageHeader } from '@client/components/layout/page-header';
import { Card, CardContent } from '@client/components/ui/card';
import { Button } from '@client/components/ui/button';
import { Input } from '@client/components/ui/input';
import { Alert } from '@client/components/ui/alert';

export function AddBitbucketRepoPage() {
  const navigate = useNavigate();
  const [workspace, setWorkspace] = useState('');
  const [repoSlug, setRepoSlug] = useState('');
  const [accessToken, setAccessToken] = useState('');
  const [webhookSecret, setWebhookSecret] = useState('');
  const [tokenExpiresAt, setTokenExpiresAt] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Client-side only (06-REVIEWS.md MEDIUM finding, OpenCode): the equivalent server-side env
  // var has no client-exposure path, and window.location.origin is exactly the URL the operator
  // is currently viewing the dashboard on -- no new server plumbing needed.
  const webhookUrl = `${window.location.origin}/webhook/bitbucket`;

  const canSubmit = Boolean(workspace.trim() && repoSlug.trim() && accessToken && webhookSecret);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!canSubmit || submitting) return;

    setError(null);
    setSubmitting(true);
    try {
      await api.addBitbucketRepo({
        workspace: workspace.trim(),
        repoSlug: repoSlug.trim(),
        accessToken: accessToken.trim(),
        webhookSecret: webhookSecret.trim(),
        tokenExpiresAt: tokenExpiresAt || null,
      });
      // Drop the credential material from component state as soon as it's been
      // persisted — no reason to keep the plaintext access token / webhook
      // secret resident in memory for the remainder of the page lifetime.
      setAccessToken('');
      setWebhookSecret('');
      toast.success('Bitbucket repository added', {
        description: 'OpenCodra will review pull requests on this repo as soon as webhooks arrive.',
      });
      navigate('/repos');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Could not add repository.';
      setError(msg);
      toast.error('Could not add repository', { description: msg });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="page-enter flex flex-col gap-5">
      <PageHeader
        category="Repositories"
        title="Add Bitbucket repository"
        description="Store a Bitbucket access token and webhook secret so OpenCodra can review pull requests on this repository."
      />

      {error && <Alert variant="destructive">{error}</Alert>}

      <Card>
        <CardContent className="p-5">
          <Alert variant="default" className="mb-4">
            <div className="flex flex-col gap-1">
              <p>
                Before submitting: (1) Create a Repository Access Token at repo settings → Security
                with at least <code>pullrequest:write</code> scope. (2) At repo settings → Webhooks,
                add a webhook pointing to <code>{webhookUrl}</code> with the secret above. When
                choosing the webhook&apos;s triggers, include the repository push event alongside
                the pull request events.
              </p>
              <p>
                If you already created this webhook, edit the existing subscription to add the push
                event: Bitbucket webhook subscriptions are created by hand, and without the push
                event the codebase index will silently never refresh when the default branch moves.
              </p>
            </div>
          </Alert>

          <form className="flex flex-col gap-3" onSubmit={handleSubmit}>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1.5">
                <span className="text-sm font-semibold text-foreground">Workspace</span>
                <Input
                  type="text"
                  value={workspace}
                  onChange={(e) => setWorkspace(e.target.value)}
                  placeholder="my-workspace"
                  autoComplete="off"
                />
                <span className="text-xs text-muted-foreground">
                  The Bitbucket workspace that owns the repository. Lowercase only.
                </span>
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-sm font-semibold text-foreground">Repo slug</span>
                <Input
                  type="text"
                  value={repoSlug}
                  onChange={(e) => setRepoSlug(e.target.value)}
                  placeholder="my-repo"
                  autoComplete="off"
                />
                <span className="text-xs text-muted-foreground">
                  Lowercase repository slug as it appears in the Bitbucket URL.
                </span>
              </label>
            </div>

            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-semibold text-foreground">Bitbucket access token</span>
              <Input
                type="password"
                value={accessToken}
                onChange={(e) => setAccessToken(e.target.value)}
                placeholder="Repository or Workspace Access Token"
                autoComplete="off"
              />
              <span className="text-xs text-muted-foreground">
                Bearer token from Bitbucket's repository settings. Stored encrypted; never shown
                again.
              </span>
            </label>

            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-semibold text-foreground">Webhook secret</span>
              <Input
                type="password"
                value={webhookSecret}
                onChange={(e) => setWebhookSecret(e.target.value)}
                placeholder="Per-repo webhook secret"
                autoComplete="off"
              />
              <span className="text-xs text-muted-foreground">
                Used to verify incoming Bitbucket webhooks. Must match the secret configured in the
                Bitbucket repository's webhooks.
              </span>
            </label>

            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-semibold text-foreground">Token expires at (optional)</span>
              <Input
                type="date"
                value={tokenExpiresAt}
                onChange={(e) => setTokenExpiresAt(e.target.value)}
              />
              <span className="text-xs text-muted-foreground">
                Copy from Bitbucket's token screen. Leave blank if the token has no expiry.
              </span>
            </label>

            <div className="mt-2 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button type="button" variant="outline" onClick={() => navigate('/repos')} disabled={submitting}>
                Back to repositories
              </Button>
              <Button type="submit" disabled={!canSubmit || submitting} className="gap-2">
                <Plus size={14} />
                Add repository
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </section>
  );
}
