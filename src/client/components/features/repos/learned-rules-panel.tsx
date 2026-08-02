import { useState } from 'react';
import { toast } from 'sonner';
import { LightbulbOff, Sparkles, RefreshCw } from 'lucide-react';
import { Switch } from '@client/components/ui/switch';
import { Button } from '@client/components/ui/button';
import { Alert } from '@client/components/ui/alert';
import { api } from '@client/lib/api';
import type { RepoConfig, VcsProvider } from '@shared/schema';
import { RuleCard } from './rule-card';

type LearningConfig = NonNullable<RepoConfig['review']['learning']>;
type LearnedRule = LearningConfig['learned_rules'][number];

// Group rules by status: pending first, then active, then disabled.
function groupByStatus(rules: LearnedRule[]): { pending: LearnedRule[]; active: LearnedRule[]; disabled: LearnedRule[] } {
  const pending: LearnedRule[] = [];
  const active: LearnedRule[] = [];
  const disabled: LearnedRule[] = [];
  for (const rule of rules) {
    switch (rule.status) {
      case 'pending': pending.push(rule); break;
      case 'active': active.push(rule); break;
      case 'disabled': disabled.push(rule); break;
    }
  }
  return { pending, active, disabled };
}

interface LearnedRulesPanelProps {
  config: LearningConfig | undefined;
  onLearningChange: (learning: LearningConfig) => void;
  /** Triggers parent to re-fetch full config from server (C7). */
  onSynthesized: () => void;
  repoId: string;
  owner: string;
  repo: string;
  vcsProvider?: VcsProvider;
}

/**
 * Learned Rules section for the repo config modal. Renders:
 * - Toggle for learning.enabled (dirty-tracked by parent via onLearningChange)
 * - "Synthesize rules" button (fires POST directly)
 * - Rule list grouped by status (pending first, active, disabled)
 * - Empty states when feature is off or no rules exist
 *
 * [C7] Config refresh after synthesis/rule changes: calls onSynthesized which
 * triggers parent to re-fetch config from server. This avoids stale-draft-overwrites-rules.
 *
 * [C9] UI test gap acknowledged: runtime tests require browser environment (nix-shell).
 */
export function LearnedRulesPanel({
  config,
  onLearningChange,
  onSynthesized,
  owner,
  repo,
  vcsProvider,
}: LearnedRulesPanelProps) {
  const enabled = config?.enabled ?? false;
  const rules = config?.learned_rules ?? [];

  const [synthesizing, setSynthesizing] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleSynthesize = async () => {
    setSynthesizing(true);
    setError(null);
    try {
      const result = await api.synthesizeLearnedRules(owner, repo, vcsProvider);
      const newRules = result.rules ?? [];
      if (newRules.length === 0) {
        toast.info('No new rule candidates found. Need at least 2 rejections for the same category and file pattern.');
      } else {
        toast.success('Rules synthesized. Review pending rules below.');
      }
      // C7: refresh config from server to pick up the new rules
      onSynthesized();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Synthesis failed.';
      setError(msg);
      toast.error('Synthesis failed. Check that reject feedback exists for this repository and try again.');
    } finally {
      setSynthesizing(false);
    }
  };

  const handleApprove = async (id: string) => {
    setActionLoading(id);
    try {
      await api.updateLearnedRule(owner, repo, id, 'active', vcsProvider);
      toast.success('Rule approved.');
      // C7: refresh config from server
      onSynthesized();
    } catch (err) {
      toast.error('Failed to update rule. Please try again.');
    } finally {
      setActionLoading(null);
    }
  };

  const handleDisable = async (id: string) => {
    setActionLoading(id);
    try {
      await api.updateLearnedRule(owner, repo, id, 'disabled', vcsProvider);
      toast.success('Rule disabled.');
      onSynthesized();
    } catch (err) {
      toast.error('Failed to update rule. Please try again.');
    } finally {
      setActionLoading(null);
    }
  };

  const handleReEnable = async (id: string) => {
    setActionLoading(id);
    try {
      await api.updateLearnedRule(owner, repo, id, 'active', vcsProvider);
      toast.success('Rule re-enabled.');
      onSynthesized();
    } catch (err) {
      toast.error('Failed to update rule. Please try again.');
    } finally {
      setActionLoading(null);
    }
  };

  const grouped = groupByStatus(rules);

  return (
    <div className="flex flex-col gap-4" aria-busy={synthesizing}>
      {/* Section heading */}
      <h3 className="text-base font-semibold text-foreground">Learned Rules</h3>

      {/* Toggle */}
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">Learned rules</p>
          <p className="text-xs text-muted-foreground">
            Suppress findings that match patterns from reject feedback.
          </p>
        </div>
        <Switch
          checked={enabled}
          onCheckedChange={(checked) => {
            onLearningChange({
              ...config,
              enabled: checked,
              learned_rules: config?.learned_rules ?? [],
            });
          }}
          aria-label="Enable learned rules"
        />
      </div>

      {/* Content when disabled */}
      {!enabled && (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-border/60 bg-background/40 px-4 py-8 text-center">
          <LightbulbOff size={24} className="text-muted-foreground" />
          <p className="text-sm font-medium text-foreground">Learned rules are disabled</p>
          <p className="text-xs text-muted-foreground">
            Enable the learning toggle to synthesize suppression rules from reject feedback.
          </p>
        </div>
      )}

      {/* Content when enabled */}
      {enabled && (
        <>
          {/* Synthesize button + error */}
          <div className="flex flex-col gap-2">
            <div className="flex justify-end">
              <Button
                variant="default"
                disabled={synthesizing}
                onClick={handleSynthesize}
                aria-label="Synthesize learned rules"
                className="gap-2"
              >
                {synthesizing ? (
                  <RefreshCw size={14} className="animate-spin" />
                ) : (
                  <Sparkles size={14} />
                )}
                {synthesizing ? 'Synthesizing...' : 'Synthesize rules'}
              </Button>
            </div>
            {error && (
              <Alert variant="destructive">
                Synthesis failed. Check that reject feedback exists for this repository and try again.
              </Alert>
            )}
          </div>

          {/* Rule list or empty state */}
          {rules.length === 0 ? (
            <div className="flex flex-col items-center gap-2 rounded-lg border border-border/60 bg-background/40 px-4 py-8 text-center">
              <Sparkles size={24} className="text-muted-foreground" />
              <p className="text-sm font-medium text-foreground">No learned rules yet</p>
              <p className="text-xs text-muted-foreground">
                Rejections from code review feedback will be clustered into suppression rules. Synthesize rules to see candidates.
              </p>
              <Button
                variant="default"
                size="sm"
                disabled={synthesizing}
                onClick={handleSynthesize}
                className="mt-2 gap-2"
              >
                <Sparkles size={13} />
                Synthesize rules
              </Button>
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              {/* Pending rules */}
              {grouped.pending.length > 0 && (
                <div className="flex flex-col gap-2" role="group" aria-label="Pending rules">
                  {grouped.pending.map((rule) => (
                    <RuleCard
                      key={rule.id}
                      rule={rule}
                      onApprove={handleApprove}
                      onDisable={handleDisable}
                      onReEnable={handleReEnable}
                      actionLoading={actionLoading}
                    />
                  ))}
                </div>
              )}

              {/* Active rules */}
              {grouped.active.length > 0 && (
                <div className="flex flex-col gap-2" role="group" aria-label="Active rules">
                  {grouped.active.map((rule) => (
                    <RuleCard
                      key={rule.id}
                      rule={rule}
                      onApprove={handleApprove}
                      onDisable={handleDisable}
                      onReEnable={handleReEnable}
                      actionLoading={actionLoading}
                    />
                  ))}
                </div>
              )}

              {/* Disabled rules */}
              {grouped.disabled.length > 0 && (
                <div className="flex flex-col gap-2" role="group" aria-label="Disabled rules">
                  {grouped.disabled.map((rule) => (
                    <RuleCard
                      key={rule.id}
                      rule={rule}
                      onApprove={handleApprove}
                      onDisable={handleDisable}
                      onReEnable={handleReEnable}
                      actionLoading={actionLoading}
                    />
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
