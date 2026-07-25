import { useEffect, useMemo, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { api } from '@client/lib/api';
import { Skeleton } from '@client/components/shared/skeleton';
import { EmptyState } from '@client/components/shared/empty-state';
import { Button } from '@client/components/ui/button';
import { Alert } from '@client/components/ui/alert';
import { PageHeader } from '@client/components/layout/page-header';
import { Switch } from '@client/components/ui/switch';
import { Input } from '@client/components/ui/input';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@client/components/ui/dropdown-menu';
import { GithubMark } from '@client/components/shared/github-mark';
import { BitbucketMark } from '@client/components/shared/bitbucket-mark';
import { VcsProviderMark } from '@client/components/shared/vcs-provider-mark';
import {
  GitBranch,
  RefreshCw,
  Save,
  Plus,
  RotateCcw,
  Settings2,
  X,
} from 'lucide-react';
import { cn } from '@client/lib/utils';
import type { RepoConfig, RepoConfigRecord } from '@shared/schema';
import {
  describeModelRoute,
  ModelRouteEditor,
  type ModelOption,
  type ModelRouteConfig,
  type ProviderOption,
} from '@client/components/features/models/model-chain';
import { ReviewSettingsPanel } from '@client/components/features/repos/review-settings-panel';
import { mergeReviewPatch, type ReviewSettingsDraft } from '@client/lib/review-config-draft';

const EMPTY_MODEL_ROUTE: ModelRouteConfig = {
  main: null,
  fallbacks: [],
  size_overrides: [],
};

type GlobalModelConfig = RepoConfig['model'];

function repoId(repo: Pick<RepoConfigRecord, 'vcsProvider' | 'owner' | 'repo'>) {
  return `${repo.vcsProvider}:${repo.owner}/${repo.repo}`;
}

function hasStoredModelStrategy(repo: RepoConfigRecord) {
  return repo.mainModel !== null || repo.fallbackModels !== null || repo.sizeOverrides !== null;
}

function normalizeRoute(config: GlobalModelConfig | ModelRouteConfig | null | undefined): ModelRouteConfig {
  return {
    main: typeof config?.main === 'string' && config.main.trim() ? config.main : null,
    fallbacks: Array.isArray(config?.fallbacks) ? config.fallbacks : EMPTY_MODEL_ROUTE.fallbacks,
    size_overrides: Array.isArray(config?.size_overrides)
      ? config.size_overrides
      : EMPTY_MODEL_ROUTE.size_overrides,
  };
}

function getGlobalRoute(globalConfig: GlobalModelConfig | ModelRouteConfig | null): ModelRouteConfig {
  return normalizeRoute(globalConfig);
}

function getStoredRepoRoute(repo: RepoConfigRecord): ModelRouteConfig | null {
  if (!hasStoredModelStrategy(repo)) return null;

  return {
    main: repo.mainModel ?? null,
    fallbacks: repo.fallbackModels ?? [],
    size_overrides: Array.isArray(repo.sizeOverrides) ? repo.sizeOverrides : [],
  };
}

function stringArraysEqual(a: string[] = [], b: string[] = []) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function tiersEqual(a: ModelRouteConfig['size_overrides'] = [], b: ModelRouteConfig['size_overrides'] = []) {
  return a.length === b.length && a.every((tier, index) => {
    const other = b[index];
    return Boolean(
      tier && other &&
      tier.max_lines === other.max_lines &&
      tier.model === other.model &&
      stringArraysEqual(tier.fallbacks ?? [], other.fallbacks ?? []),
    );
  });
}

function routesEqual(a: ModelRouteConfig, b: ModelRouteConfig) {
  return (
    a.main === b.main &&
    stringArraysEqual(a.fallbacks ?? [], b.fallbacks ?? []) &&
    tiersEqual(a.size_overrides ?? [], b.size_overrides ?? [])
  );
}

function hasMeaningfulCustomStrategy(repo: RepoConfigRecord, globalConfig: GlobalModelConfig | ModelRouteConfig | null) {
  const storedRoute = getStoredRepoRoute(repo);
  if (!storedRoute) return false;

  return (
    !routesEqual(storedRoute, getGlobalRoute(globalConfig)) &&
    !routesEqual(storedRoute, EMPTY_MODEL_ROUTE)
  );
}

function getRepoRoute(repo: RepoConfigRecord, globalConfig: GlobalModelConfig | ModelRouteConfig | null): ModelRouteConfig {
  if (!hasMeaningfulCustomStrategy(repo, globalConfig)) {
    return getGlobalRoute(globalConfig);
  }

  return getStoredRepoRoute(repo) ?? getGlobalRoute(globalConfig);
}

function formatLastActivity(value: string | Date | null) {
  if (!value) return null;
  return new Date(value).toLocaleDateString();
}

interface RepoRowProps {
  repo: RepoConfigRecord;
  globalConfig: GlobalModelConfig | ModelRouteConfig | null;
  modelOptions: ModelOption[];
  togglePending: boolean;
  onToggleEnabled: (repo: RepoConfigRecord, enabled: boolean) => void;
  onEdit: (repo: RepoConfigRecord) => void;
}

function RepoRow({
  repo,
  globalConfig,
  modelOptions,
  togglePending,
  onToggleEnabled,
  onEdit,
}: RepoRowProps) {
  const route = getRepoRoute(repo, globalConfig);
  const custom = hasMeaningfulCustomStrategy(repo, globalConfig);
  const lastActivity = formatLastActivity(repo.lastJobCreatedAt);

  return (
    <article className="surface surface-static-shadow min-w-0 px-3 py-3 sm:px-4">
      <div className="grid min-w-0 grid-cols-1 gap-3 lg:grid-cols-[minmax(180px,1.1fr)_minmax(220px,1.4fr)_auto] lg:items-center">
        <div className="flex min-w-0 items-center gap-3">
          <span
            className={cn(
              'h-2.5 w-2.5 shrink-0 rounded-full',
              repo.enabled ? 'bg-success' : 'bg-muted-foreground/35',
            )}
          />
          <div className="min-w-0">
            <h2 className="flex min-w-0 items-center gap-2 text-sm font-semibold text-foreground">
              <VcsProviderMark provider={repo.vcsProvider} size={15} className="text-muted-foreground" />
              <span className="truncate">{repo.owner}/{repo.repo}</span>
            </h2>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <span
                className={cn(
                  'rounded border px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider',
                  repo.enabled
                    ? 'border-success-border bg-success-bg text-success'
                    : 'border-border bg-muted/40 text-muted-foreground',
                )}
              >
                {repo.enabled ? 'Enabled' : 'Paused'}
              </span>
              <span
                className={cn(
                  'rounded border px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider',
                  custom
                    ? 'border-primary/25 bg-primary/10 text-primary'
                    : 'border-border bg-secondary text-secondary-foreground',
                )}
              >
                {custom ? 'Custom strategy' : 'Global strategy'}
              </span>
              {lastActivity && (
                <span className="text-[11px] text-muted-foreground">
                  Last {lastActivity}
                </span>
              )}
            </div>
          </div>
        </div>

        <p className="min-w-0 truncate text-xs text-muted-foreground lg:px-2">
          {describeModelRoute(route, modelOptions)}
        </p>

        <div className="flex min-w-0 flex-wrap items-center gap-2 lg:justify-end">
          <div className="flex items-center gap-2 rounded-md border border-border/60 bg-background/60 px-2.5 py-1.5">
            <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
              Reviews
            </span>
            <Switch
              checked={repo.enabled}
              disabled={togglePending}
              aria-label={`${repo.enabled ? 'Pause' : 'Enable'} reviews for ${repo.owner}/${repo.repo}`}
              onCheckedChange={(nextEnabled) => onToggleEnabled(repo, nextEnabled)}
            />
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onEdit(repo)}
            className="h-8 shrink-0 gap-1.5"
          >
            <Settings2 size={13} />
            Edit
          </Button>
        </div>
      </div>
    </article>
  );
}

interface InteractiveDraft {
  interactive: RepoConfig['review']['interactive'];
  dirty: boolean;
  valid: boolean;
}

interface InteractivePanelProps {
  repo: RepoConfigRecord;
  onChange: (draft: InteractiveDraft) => void;
}

function InteractivePanel({ repo, onChange }: InteractivePanelProps) {
  const interactive = repo.parsedJson.review.interactive;
  const isBitbucket = repo.vcsProvider === 'bitbucket';

  const [commandsEnabled, setCommandsEnabled] = useState(interactive.commands.enabled);
  const [accountIds, setAccountIds] = useState<string[]>(
    interactive.commands.bitbucket_allowed_account_ids ?? [],
  );
  const [newAccountId, setNewAccountId] = useState('');
  const [botAccountId, setBotAccountId] = useState(
    interactive.commands.bitbucket_bot_account_id ?? '',
  );
  // Optional/nullable opaque account_id: trim, and an empty/whitespace-only value persists as null
  // (not '') to preserve the schema's z.string().nullable().default(null) contract. No format validation.
  const normalizedBotAccountId = botAccountId.trim() || null;
  const [qaEnabled, setQaEnabled] = useState(interactive.qa.enabled);
  // Kept as a string so the number input stays editable; parsed on save.
  const [rateLimit, setRateLimit] = useState(String(interactive.qa.rate_limit_per_hour));

  const rateLimitNum = Number.parseInt(rateLimit, 10);
  const rateLimitValid = Number.isInteger(rateLimitNum) && rateLimitNum >= 1;

  const initialAccountIds = interactive.commands.bitbucket_allowed_account_ids ?? [];
  const dirty =
    commandsEnabled !== interactive.commands.enabled ||
    qaEnabled !== interactive.qa.enabled ||
    !stringArraysEqual(accountIds, initialAccountIds) ||
    normalizedBotAccountId !== interactive.commands.bitbucket_bot_account_id ||
    (rateLimitValid && rateLimitNum !== interactive.qa.rate_limit_per_hour);

  // Controlled sub-editor: report the current interactive draft up to the parent modal so its
  // single "Apply" button persists model + interactive together in one PATCH — no local save button.
  // Deps include `dirty`/`rateLimitValid` so a repo-prop refresh after save re-reports dirty:false.
  useEffect(() => {
    onChange({
      interactive: {
        commands: {
          enabled: commandsEnabled,
          bitbucket_allowed_account_ids: accountIds,
          // Editable Bitbucket bot account_id (D-06): report the trimmed value, empty→null.
          bitbucket_bot_account_id: normalizedBotAccountId,
        },
        qa: {
          enabled: qaEnabled,
          rate_limit_per_hour: rateLimitValid ? rateLimitNum : interactive.qa.rate_limit_per_hour,
        },
      },
      dirty,
      valid: rateLimitValid,
    });
    // onChange is a stable setter from the parent; re-report only when an editable field/derived flag changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commandsEnabled, accountIds, botAccountId, qaEnabled, rateLimit, dirty, rateLimitValid]);

  const addAccountId = () => {
    const trimmed = newAccountId.trim();
    if (!trimmed || accountIds.includes(trimmed)) {
      setNewAccountId('');
      return;
    }
    setAccountIds((current) => [...current, trimmed]);
    setNewAccountId('');
  };

  const removeAccountId = (id: string) => {
    setAccountIds((current) => current.filter((value) => value !== id));
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="min-w-0">
        <h3 className="text-sm font-semibold text-foreground">Interactive (Commands &amp; Q&amp;A)</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Control in-PR bot commands and pull-request Q&amp;A for this repository.
        </p>
      </div>

      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">Commands</p>
          <p className="text-xs text-muted-foreground">
            Respond to in-PR bot commands (e.g. review, pause).
          </p>
        </div>
        <Switch
          checked={commandsEnabled}
          onCheckedChange={setCommandsEnabled}
          aria-label="Toggle in-PR commands"
        />
      </div>

      {isBitbucket && (
        <div className="flex flex-col gap-2 rounded-md border border-border/60 bg-background/40 p-3">
          <label htmlFor="bitbucket-bot-account-id" className="text-sm font-medium text-foreground">
            Bitbucket bot account ID
          </label>
          <p className="text-xs text-muted-foreground">
            The immutable account_id of the bot user. Lets Codra recognize its own comments on
            Bitbucket without an API call that repository access tokens can't make. Leave blank if
            unset.
          </p>
          <Input
            id="bitbucket-bot-account-id"
            value={botAccountId}
            onChange={(event) => setBotAccountId(event.target.value)}
            placeholder="e.g. 557058:1a2b3c4d-…"
            className="font-mono text-xs"
          />
          {(commandsEnabled || qaEnabled) && !normalizedBotAccountId && (
            <p className="text-warning text-xs">
              {'Without the bot account ID, Codra cannot verify its identity, so Bitbucket commands and Q&A are ignored.'}
            </p>
          )}
        </div>
      )}

      {isBitbucket && (
        <div className="flex flex-col gap-2 rounded-md border border-border/60 bg-background/40 p-3">
          <p className="text-sm font-medium text-foreground">Allowed Bitbucket account IDs</p>
          <p className="text-xs text-muted-foreground">
            These are immutable Bitbucket <code>account_id</code>s authorized to run commands. GitHub
            uses live repository permissions instead, so this allow-list is Bitbucket-only.
          </p>
          <div className="flex items-center gap-2">
            <Input
              value={newAccountId}
              onChange={(event) => setNewAccountId(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  addAccountId();
                }
              }}
              placeholder="e.g. 5b10a…"
              aria-label="New allowed Bitbucket account ID"
            />
            <Button type="button" variant="outline" size="sm" onClick={addAccountId} className="gap-1.5">
              <Plus size={13} />
              Add
            </Button>
          </div>
          {accountIds.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No account IDs added yet. Add at least one to authorize command use on Bitbucket.
            </p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {accountIds.map((id) => (
                <li
                  key={id}
                  className="flex items-center justify-between gap-2 rounded border border-border/60 bg-card px-2.5 py-1.5"
                >
                  <span className="truncate font-mono text-xs text-foreground">{id}</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => removeAccountId(id)}
                    aria-label={`Remove ${id}`}
                    className="h-6 w-6 shrink-0 text-muted-foreground hover:text-foreground"
                  >
                    <X size={13} />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">Q&amp;A</p>
          <p className="text-xs text-muted-foreground">
            Answer questions asked on the pull request.
          </p>
        </div>
        <Switch checked={qaEnabled} onCheckedChange={setQaEnabled} aria-label="Toggle pull-request Q&A" />
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="qa-rate-limit" className="text-sm font-medium text-foreground">
          Q&amp;A rate limit (per hour)
        </label>
        <Input
          id="qa-rate-limit"
          type="number"
          min={1}
          step={1}
          value={rateLimit}
          onChange={(event) => setRateLimit(event.target.value)}
          className="max-w-[160px]"
          aria-invalid={!rateLimitValid}
        />
        {!rateLimitValid && (
          <p className="text-xs text-destructive">Enter a positive whole number (1 or more).</p>
        )}
      </div>
    </div>
  );
}

interface RepoModelModalProps {
  repo: RepoConfigRecord | null;
  globalConfig: GlobalModelConfig | ModelRouteConfig | null;
  modelOptions: ModelOption[];
  providerOptions: ProviderOption[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onModelApplied: (repo: RepoConfigRecord, route: ModelRouteConfig) => void;
  onModelReset: (repo: RepoConfigRecord) => void;
  onReviewSaved: (repo: RepoConfigRecord, review: RepoConfig['review']) => void;
}

function RepoModelModal({
  repo,
  globalConfig,
  modelOptions,
  providerOptions,
  open,
  onOpenChange,
  onModelApplied,
  onModelReset,
  onReviewSaved,
}: RepoModelModalProps) {
  const selectedRepoId = repo ? repoId(repo) : null;
  const globalRouteKey = useMemo(
    () => JSON.stringify(getGlobalRoute(globalConfig)),
    [globalConfig],
  );
  const [route, setRoute] = useState<ModelRouteConfig>(EMPTY_MODEL_ROUTE);
  const [initialRoute, setInitialRoute] = useState<ModelRouteConfig>(EMPTY_MODEL_ROUTE);
  const [saving, setSaving] = useState<'apply' | 'reset' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [interactiveDraft, setInteractiveDraft] = useState<InteractiveDraft | null>(null);
  const [reviewSettingsDraft, setReviewSettingsDraft] = useState<ReviewSettingsDraft | null>(null);

  useEffect(() => {
    if (!repo) return;
    const nextRoute = getRepoRoute(repo, globalConfig);
    setRoute(nextRoute);
    setInitialRoute(nextRoute);
    setSaving(null);
    setError(null);
    setInteractiveDraft(null);
    setReviewSettingsDraft(null);
  }, [selectedRepoId, globalRouteKey]);

  const modelDirty = useMemo(() => !routesEqual(route, initialRoute), [initialRoute, route]);
  const interactiveDirty = interactiveDraft?.dirty ?? false;
  const interactiveValid = interactiveDraft?.valid ?? true;
  const reviewSettingsDirty = reviewSettingsDraft?.dirty ?? false;
  const reviewSettingsValid = reviewSettingsDraft?.valid ?? true;
  const dirty = modelDirty || interactiveDirty || reviewSettingsDirty;
  const canApply = !!repo && dirty && interactiveValid && reviewSettingsValid && saving === null;
  const hasStoredStrategy = repo ? hasStoredModelStrategy(repo) : false;

  // Single save action: persists the model strategy and the interactive (commands/Q&A) settings
  // together in one PATCH. Each key is sent only when its section changed; `review` spreads the
  // full current review so mention_trigger/max_files/etc. survive the server's shallow merge.
  const handleApply = async () => {
    if (!repo || !dirty || !interactiveValid || !reviewSettingsValid) return;
    setSaving('apply');
    setError(null);
    const tid = toast.loading('Saving repository settings…');
    try {
      // Merge both review sub-editors into ONE review object (NREG-02): mergeReviewPatch spreads
      // the full current review first, overlays the settings draft, then applies the fresh
      // interactive draft LAST so a simultaneous Interactive edit wins over the settings draft's
      // own (stale) interactive block (REVIEW #4). Null when neither sub-editor is dirty.
      const nextReview =
        interactiveDirty || reviewSettingsDirty
          ? mergeReviewPatch(
              repo.parsedJson.review,
              interactiveDirty && interactiveDraft ? interactiveDraft.interactive : null,
              reviewSettingsDirty && reviewSettingsDraft ? reviewSettingsDraft.review : null,
            )
          : null;
      const patch: Parameters<typeof api.updateRepoConfig>[2] = {};
      if (modelDirty) {
        patch.model = {
          main: route.main,
          fallbacks: route.fallbacks,
          size_overrides: route.size_overrides,
        };
      }
      if (nextReview) {
        patch.review = nextReview;
      }
      await api.updateRepoConfig(repo.owner, repo.repo, patch, repo.vcsProvider);
      if (modelDirty) {
        setInitialRoute(route);
        onModelApplied(repo, route);
      }
      if (nextReview) {
        onReviewSaved(repo, nextReview);
      }
      toast.success('Settings saved', {
        id: tid,
        description: `${repo.owner}/${repo.repo} settings updated.`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to save settings.';
      setError(msg);
      toast.error('Could not save settings', { id: tid, description: 'Your changes were not applied. Please try again.' });
    } finally {
      setSaving(null);
    }
  };

  const handleReset = async () => {
    if (!repo) return;
    setSaving('reset');
    setError(null);
    const tid = toast.loading('Resetting to global defaults…');
    try {
      await api.updateRepoConfig(repo.owner, repo.repo, {
        model: {
          main: null,
          fallbacks: null,
          size_overrides: null,
        },
      }, repo.vcsProvider);
      const globalRoute = getGlobalRoute(globalConfig);
      setRoute(globalRoute);
      setInitialRoute(globalRoute);
      onModelReset(repo);
      toast.success('Reset to global strategy', { id: tid, description: `${repo.owner}/${repo.repo} will inherit account defaults.` });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to reset model strategy.';
      setError(msg);
      toast.error('Reset failed', { id: tid, description: 'Could not remove the custom strategy. Try again.' });
    } finally {
      setSaving(null);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-background/75 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:fade-in data-[state=closed]:fade-out" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[92vh] w-[calc(100vw-1.5rem)] max-w-5xl -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-lg border border-border bg-card shadow-2xl data-[state=open]:animate-in data-[state=open]:fade-in data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out data-[state=closed]:zoom-out-95">
          <div className="flex shrink-0 items-start justify-between gap-4 border-b border-border px-4 py-4 sm:px-6">
            <div className="min-w-0">
              <Dialog.Title className="text-base font-semibold text-foreground">
                Edit repository settings
              </Dialog.Title>
              <Dialog.Description className="mt-1 flex items-center gap-2 truncate text-sm text-muted-foreground">
                {repo ? (
                  <>
                    <VcsProviderMark provider={repo.vcsProvider} size={14} />
                    <span className="truncate">{repo.owner}/{repo.repo}</span>
                  </>
                ) : 'Repository routing'}
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <Button variant="ghost" size="icon" aria-label="Close modal" className="h-8 w-8 shrink-0">
                <X size={15} />
              </Button>
            </Dialog.Close>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6">
            {error && <Alert variant="destructive" className="mb-4">{error}</Alert>}
            <ModelRouteEditor
              value={route}
              onChange={setRoute}
              models={modelOptions}
              providers={providerOptions}
              density="comfortable"
            />
            {repo && (
              <>
                <div className="my-6 border-t border-border" />
                <InteractivePanel key={selectedRepoId} repo={repo} onChange={setInteractiveDraft} />
                <div className="my-6 border-t border-border" />
                <ReviewSettingsPanel key={`${selectedRepoId}-review`} repo={repo} onChange={setReviewSettingsDraft} />
              </>
            )}
          </div>

          <div className="flex shrink-0 flex-col-reverse gap-2 border-t border-border bg-muted/10 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
            <Button
              variant="ghost"
              onClick={handleReset}
              disabled={!repo || saving !== null || !hasStoredStrategy}
              className="gap-2 text-muted-foreground hover:text-foreground"
            >
              {saving === 'reset' ? <RefreshCw size={14} className="animate-spin" /> : <RotateCcw size={14} />}
              Use global
            </Button>
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Dialog.Close asChild>
                <Button variant="outline" disabled={saving !== null}>Cancel</Button>
              </Dialog.Close>
              <Button onClick={handleApply} disabled={!canApply} className="gap-2">
                {saving === 'apply' ? <RefreshCw size={14} className="animate-spin" /> : <Save size={14} />}
                Apply
              </Button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function ReposPage() {
  const navigate = useNavigate();
  const [repos, setRepos] = useState<RepoConfigRecord[]>([]);
  const [globalConfig, setGlobalConfig] = useState<ModelRouteConfig>(EMPTY_MODEL_ROUTE);
  const [modelOptions, setModelOptions] = useState<ModelOption[]>([]);
  const [providerOptions, setProviderOptions] = useState<ProviderOption[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [editingRepoId, setEditingRepoId] = useState<string | null>(null);
  const [pendingToggles, setPendingToggles] = useState<Set<string>>(() => new Set());

  const editingRepo = repos.find(repo => repoId(repo) === editingRepoId) ?? null;

  const loadRepos = () => {
    setLoading(true);
    Promise.all([
      api.getRepos(),
      api.getGlobalConfig(),
      api.getModelConfigs(),
    ])
      .then(([reposRes, globalRes, modelsRes]) => {
        const nextRepos = Array.isArray(reposRes?.repos) ? reposRes.repos : [];
        const providers = Array.isArray(modelsRes?.providers) ? modelsRes.providers : [];
        const configs = Array.isArray(modelsRes?.configs) ? modelsRes.configs : [];

        setRepos(nextRepos);
        setGlobalConfig(normalizeRoute(globalRes?.config));
        setProviderOptions(providers.map(provider => ({ value: provider.id, label: provider.name })));
        setModelOptions(configs.map(config => ({
          value: config.modelId,
          label: `${config.providerName} / ${config.modelName}`,
          providerId: config.providerId,
        })));
        setLoading(false);
      })
      .catch(e => {
        setError(e instanceof Error ? e.message : 'Failed to load repositories.');
        setLoading(false);
      });
  };

  useEffect(() => { loadRepos(); }, []);

  const mergeRepo = (targetId: string, updates: Partial<RepoConfigRecord>) => {
    setRepos(current =>
      current.map(repo =>
        repoId(repo) === targetId ? { ...repo, ...updates } : repo,
      ),
    );
  };

  const handleToggleEnabled = async (repo: RepoConfigRecord, nextEnabled: boolean) => {
    const targetId = repoId(repo);
    setPendingToggles(current => new Set(current).add(targetId));
    const tid = toast.loading(nextEnabled ? 'Enabling code reviews…' : 'Pausing code reviews…');
    try {
      await api.updateRepoConfig(repo.owner, repo.repo, { enabled: nextEnabled }, repo.vcsProvider);
      mergeRepo(targetId, { enabled: nextEnabled });
      toast.success(
        nextEnabled ? 'Reviews active' : 'Reviews paused',
        { id: tid, description: nextEnabled
          ? `${targetId} will receive automated review comments.`
          : `${targetId} is now quiet — no new reviews will be posted.`
        },
      );
    } catch (err) {
      toast.error('Could not update repository', { id: tid, description: 'The change did not go through. Please try again.' });
    } finally {
      setPendingToggles(current => {
        const next = new Set(current);
        next.delete(targetId);
        return next;
      });
    }
  };

  const handleModelApplied = (repo: RepoConfigRecord, route: ModelRouteConfig) => {
    mergeRepo(repoId(repo), {
      mainModel: route.main,
      fallbackModels: route.fallbacks,
      sizeOverrides: route.size_overrides,
    });
  };

  const handleModelReset = (repo: RepoConfigRecord) => {
    mergeRepo(repoId(repo), {
      mainModel: null,
      fallbackModels: null,
      sizeOverrides: null,
    });
  };

  const handleReviewSaved = (repo: RepoConfigRecord, review: RepoConfig['review']) =>
    mergeRepo(repoId(repo), { parsedJson: { ...repo.parsedJson, review } });

  const handleSync = async () => {
    if (syncing) return;
    setSyncing(true);
    setError(null);
    const tid = toast.loading('Syncing with GitHub…');
    try {
      const result = await api.syncRepos();
      const syncedCount = result?.synced?.length ?? 0;
      toast.success('Repositories up to date', {
        id: tid,
        description: syncedCount > 0
          ? `${syncedCount} ${syncedCount === 1 ? 'repository' : 'repositories'} refreshed from GitHub.`
          : 'Everything is already in sync.',
      });
      loadRepos();
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Sync failed.';
      setError(msg);
      toast.error('Sync failed', { id: tid, description: 'Could not reach GitHub. Check your connection and try again.' });
    } finally {
      setSyncing(false);
    }
  };

  if (loading && repos.length === 0) {
    return (
      <section className="page-enter flex flex-col gap-5">
        <PageHeader title="Repositories" />
        <div className="surface overflow-hidden">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="px-5 py-4 border-b border-border/50 last:border-0">
              <Skeleton height={20} />
            </div>
          ))}
        </div>
      </section>
    );
  }

  return (
    <section className="page-enter flex flex-col gap-5">
      <PageHeader
        title="Repositories"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handleSync}
              disabled={syncing}
              className="gap-2"
            >
              <RefreshCw size={13} className={cn(syncing && 'animate-spin')} />
              Sync Repositories
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" className="gap-2">
                  <Plus size={13} />
                  Add Repositories
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" sideOffset={6}>
                <DropdownMenuItem
                  className="py-2"
                  onClick={() => window.open('/api/repos/install', '_blank', 'noopener,noreferrer')}
                >
                  <GithubMark size={14} />
                  Install via GitHub App
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="py-2"
                  onClick={() => navigate('/repos/add/bitbucket')}
                >
                  <BitbucketMark size={14} />
                  Add Bitbucket repository
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        }
      />

      {error && <Alert variant="destructive">{error}</Alert>}

      {repos.length === 0 ? (
        <EmptyState
          icon={<GitBranch />}
          title="No Repositories Added"
          description="Add your repositories to get started with OpenCodra"
          hints={[
            'Add repositories here to automatically enable PR analysis',
            'You can enable/disable PR analysis for each repo from its settings',
          ]}
          linkAction={{
            label: 'See how to interact with OpenCodra',
            href: 'https://github.com/michnicki/opencodra#readme',
          }}
        />
      ) : (
        <div className="flex min-w-0 flex-col gap-2.5">
          {repos.map(repo => {
            const id = repoId(repo);
            return (
              <RepoRow
                key={id}
                repo={repo}
                globalConfig={globalConfig}
                modelOptions={modelOptions}
                togglePending={pendingToggles.has(id)}
                onToggleEnabled={handleToggleEnabled}
                onEdit={(nextRepo) => setEditingRepoId(repoId(nextRepo))}
              />
            );
          })}
        </div>
      )}

      <RepoModelModal
        repo={editingRepo}
        globalConfig={globalConfig}
        modelOptions={modelOptions}
        providerOptions={providerOptions}
        open={editingRepo !== null}
        onOpenChange={(open) => {
          if (!open) setEditingRepoId(null);
        }}
        onModelApplied={handleModelApplied}
        onModelReset={handleModelReset}
        onReviewSaved={handleReviewSaved}
      />
    </section>
  );
}
