import { useState } from 'react';
import { Badge } from '@client/components/ui/badge';
import { Button } from '@client/components/ui/button';
import { ConfirmDialog } from '@client/components/ui/confirm-dialog';
import type { RepoConfig } from '@shared/schema';

type LearnedRule = NonNullable<RepoConfig['review']['learning']>['learned_rules'][number];

// Map rule status to Badge variant per UI-SPEC: pending=info, active=success, disabled=neutral.
const STATUS_VARIANT: Record<LearnedRule['status'], 'info' | 'success' | 'neutral'> = {
  pending: 'info',
  active: 'success',
  disabled: 'neutral',
};

const STATUS_LABEL: Record<LearnedRule['status'], string> = {
  pending: 'Pending',
  active: 'Active',
  disabled: 'Disabled',
};

interface RuleCardProps {
  rule: LearnedRule;
  onApprove: (id: string) => void;
  onDisable: (id: string) => void;
  onReEnable: (id: string) => void;
  actionLoading: string | null;
}

/**
 * Individual learned-rule display card. Renders status badge, category,
 * file_pattern, rejection count, and contextual action buttons.
 *
 * - Pending rules: "Approve rule" button
 * - Active rules: "Disable rule" button (with confirmation dialog)
 * - Disabled rules: "Re-enable rule" button
 *
 * [C9] UI test gap acknowledged: runtime tests require browser environment (nix-shell).
 */
export function RuleCard({ rule, onApprove, onDisable, onReEnable, actionLoading }: RuleCardProps) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const isLoading = actionLoading === rule.id;

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-border bg-card p-4 shadow-md">
      {/* Top row: status badge + category */}
      <div className="flex items-center gap-2">
        <Badge variant={STATUS_VARIANT[rule.status]} className="capitalize">
          {STATUS_LABEL[rule.status]}
        </Badge>
        <span className="text-sm font-medium text-foreground">{rule.category}</span>
      </div>

      {/* File pattern */}
      <p className="font-mono text-xs text-muted-foreground break-all">{rule.file_pattern}</p>

      {/* Bottom row: rejection count + action buttons */}
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">
          {rule.source_rejection_ids.length} {rule.source_rejection_ids.length === 1 ? 'rejection' : 'rejections'}
        </span>

        <div className="flex items-center gap-2">
          {rule.status === 'pending' && (
            <Button
              variant="default"
              size="sm"
              disabled={isLoading}
              onClick={() => onApprove(rule.id)}
              aria-label="Approve rule"
            >
              Approve rule
            </Button>
          )}

          {rule.status === 'active' && (
            <>
              <Button
                variant="destructive-outline"
                size="sm"
                disabled={isLoading}
                onClick={() => setConfirmOpen(true)}
                aria-label="Disable rule"
              >
                Disable rule
              </Button>
              <ConfirmDialog
                open={confirmOpen}
                onOpenChange={setConfirmOpen}
                title="Disable rule"
                description="This rule will stop suppressing findings. You can re-enable it later."
                confirmLabel="Disable rule"
                confirmVariant="destructive"
                onConfirm={() => onDisable(rule.id)}
              />
            </>
          )}

          {rule.status === 'disabled' && (
            <Button
              variant="default"
              size="sm"
              disabled={isLoading}
              onClick={() => onReEnable(rule.id)}
              aria-label="Re-enable rule"
            >
              Re-enable rule
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
