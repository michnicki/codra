import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LearnedRulesPanel } from '@client/components/features/repos/learned-rules-panel';
import { api } from '@client/lib/api';
import { renderPage } from './render';
import type { RepoConfig } from '@shared/schema';

/**
 * Phase 28 (LRN-01) — rule-RENDERING coverage for LearnedRulesPanel + RuleCard.
 *
 * 28-VERIFICATION.md flagged this whole surface as behavior-unverified (UAT test 1): no learned rule
 * had ever existed in any environment, so RuleCard, the pending/active/disabled grouping, and the
 * three contextual action buttons had never been mounted with data. The toggle + empty-state half was
 * already covered live (UAT test 2); everything below is the half that never ran.
 *
 * [C9] in the component source acknowledged this gap as "requires browser environment" — this spec
 * lives in the vitest `browser` project (headless Chromium), which is that environment.
 */

vi.mock('@client/lib/api', () => ({
  api: {
    synthesizeLearnedRules: vi.fn(),
    updateLearnedRule: vi.fn(),
  },
}));

const toastSuccess = vi.fn();
const toastError = vi.fn();
const toastInfo = vi.fn();

vi.mock('sonner', () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
    info: (...args: unknown[]) => toastInfo(...args),
  },
}));

type LearningConfig = NonNullable<RepoConfig['review']['learning']>;
type LearnedRule = LearningConfig['learned_rules'][number];

const PENDING_RULE: LearnedRule = {
  id: '11111111-1111-4111-8111-111111111111',
  category: 'quality',
  file_pattern: 'src/server/core/review.ts',
  status: 'pending',
  source_rejection_ids: ['rej-1', 'rej-2'],
  created_at: '2026-01-01T00:00:00.000Z',
};

const ACTIVE_RULE: LearnedRule = {
  id: '22222222-2222-4222-8222-222222222222',
  category: 'security',
  file_pattern: 'src/server/routes/api/repos.ts',
  status: 'active',
  source_rejection_ids: ['rej-3', 'rej-4', 'rej-5'],
  created_at: '2026-01-02T00:00:00.000Z',
};

const DISABLED_RULE: LearnedRule = {
  id: '33333333-3333-4333-8333-333333333333',
  category: 'performance',
  file_pattern: 'src/client/pages/repos.tsx',
  status: 'disabled',
  source_rejection_ids: ['rej-6'],
  created_at: '2026-01-03T00:00:00.000Z',
};

function mountPanel(config: LearningConfig, overrides: Partial<{
  onLearningChange: (learning: LearningConfig) => void;
  onSynthesized: () => void;
}> = {}) {
  const onLearningChange = overrides.onLearningChange ?? vi.fn();
  const onSynthesized = overrides.onSynthesized ?? vi.fn();
  const result = renderPage(
    <LearnedRulesPanel
      config={config}
      onLearningChange={onLearningChange}
      onSynthesized={onSynthesized}
      repoId="1"
      owner="michnicki"
      repo="opencodra"
      vcsProvider="github"
    />,
  );
  return { ...result, onLearningChange, onSynthesized };
}

describe('LearnedRulesPanel rule rendering (LRN-01 / UAT test 1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.updateLearnedRule).mockResolvedValue({ ok: true });
    vi.mocked(api.synthesizeLearnedRules).mockResolvedValue({ ok: true, rules: [] });
  });

  // --- empty / disabled states (the already-live half, pinned so it cannot regress) -------------

  it('shows the disabled empty state and hides the synthesize affordance when learning is off', () => {
    mountPanel({ enabled: false, learned_rules: [PENDING_RULE] });

    expect(screen.getByText('Learned rules are disabled')).toBeInTheDocument();
    // The Switch primitive wraps a native <input type="checkbox">, so its role is checkbox.
    expect(screen.getByRole('checkbox', { name: 'Enable learned rules' })).not.toBeChecked();
    // Rules must not render while the gate is off, even when the config carries them.
    expect(screen.queryByRole('button', { name: 'Approve rule' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Synthesize learned rules' })).not.toBeInTheDocument();
  });

  it('shows the no-rules empty state when enabled with an empty rule set', () => {
    mountPanel({ enabled: true, learned_rules: [] });

    expect(screen.getByText('No learned rules yet')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Enable learned rules' })).toBeChecked();
    expect(screen.getByRole('button', { name: 'Synthesize learned rules' })).toBeInTheDocument();
  });

  // --- RuleCard content ------------------------------------------------------------------------

  it('renders every RuleCard field: status badge, category, file_pattern, rejection count', () => {
    mountPanel({ enabled: true, learned_rules: [PENDING_RULE, ACTIVE_RULE, DISABLED_RULE] });

    // Status badges — one per rule, using the UI-SPEC labels.
    expect(screen.getByText('Pending')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('Disabled')).toBeInTheDocument();

    // Categories.
    expect(screen.getByText('quality')).toBeInTheDocument();
    expect(screen.getByText('security')).toBeInTheDocument();
    expect(screen.getByText('performance')).toBeInTheDocument();

    // File patterns render verbatim (the synthesized value is an exact path, not a glob).
    expect(screen.getByText('src/server/core/review.ts')).toBeInTheDocument();
    expect(screen.getByText('src/server/routes/api/repos.ts')).toBeInTheDocument();
    expect(screen.getByText('src/client/pages/repos.tsx')).toBeInTheDocument();

    // Rejection counts, including the singular/plural boundary at 1.
    expect(screen.getByText('2 rejections')).toBeInTheDocument();
    expect(screen.getByText('3 rejections')).toBeInTheDocument();
    expect(screen.getByText('1 rejection')).toBeInTheDocument();
  });

  it('offers exactly one status-appropriate action per rule', () => {
    mountPanel({ enabled: true, learned_rules: [PENDING_RULE, ACTIVE_RULE, DISABLED_RULE] });

    const pendingGroup = screen.getByRole('group', { name: 'Pending rules' });
    expect(within(pendingGroup).getByRole('button', { name: 'Approve rule' })).toBeInTheDocument();
    expect(within(pendingGroup).queryByRole('button', { name: 'Disable rule' })).not.toBeInTheDocument();
    expect(within(pendingGroup).queryByRole('button', { name: 'Re-enable rule' })).not.toBeInTheDocument();

    const activeGroup = screen.getByRole('group', { name: 'Active rules' });
    expect(within(activeGroup).getByRole('button', { name: 'Disable rule' })).toBeInTheDocument();
    expect(within(activeGroup).queryByRole('button', { name: 'Approve rule' })).not.toBeInTheDocument();

    const disabledGroup = screen.getByRole('group', { name: 'Disabled rules' });
    expect(within(disabledGroup).getByRole('button', { name: 'Re-enable rule' })).toBeInTheDocument();
    expect(within(disabledGroup).queryByRole('button', { name: 'Disable rule' })).not.toBeInTheDocument();
  });

  it('orders the groups pending -> active -> disabled in the DOM', () => {
    mountPanel({ enabled: true, learned_rules: [DISABLED_RULE, ACTIVE_RULE, PENDING_RULE] });

    // Input order is deliberately reversed — grouping, not input order, must drive the layout.
    const groups = screen.getAllByRole('group');
    expect(groups.map((g) => g.getAttribute('aria-label'))).toEqual([
      'Pending rules',
      'Active rules',
      'Disabled rules',
    ]);
  });

  it('groups multiple rules of the same status into one group', () => {
    const secondPending: LearnedRule = { ...PENDING_RULE, id: '44444444-4444-4444-8444-444444444444', category: 'bugs' };
    mountPanel({ enabled: true, learned_rules: [PENDING_RULE, secondPending] });

    const pendingGroup = screen.getByRole('group', { name: 'Pending rules' });
    expect(within(pendingGroup).getAllByRole('button', { name: 'Approve rule' })).toHaveLength(2);
    expect(screen.queryByRole('group', { name: 'Active rules' })).not.toBeInTheDocument();
  });

  // --- actions ---------------------------------------------------------------------------------

  it('approving a pending rule PATCHes it to active and refreshes the parent config', async () => {
    const onSynthesized = vi.fn();
    mountPanel({ enabled: true, learned_rules: [PENDING_RULE] }, { onSynthesized });

    await userEvent.click(screen.getByRole('button', { name: 'Approve rule' }));

    await waitFor(() => {
      expect(api.updateLearnedRule).toHaveBeenCalledWith(
        'michnicki',
        'opencodra',
        PENDING_RULE.id,
        'active',
        'github',
      );
    });
    // C7: the panel does not mutate local state — it asks the parent to re-fetch from the server.
    expect(onSynthesized).toHaveBeenCalled();
    expect(toastSuccess).toHaveBeenCalledWith('Rule approved.');
  });

  it('disabling an active rule requires confirming the dialog first', async () => {
    mountPanel({ enabled: true, learned_rules: [ACTIVE_RULE] });

    const activeGroup = screen.getByRole('group', { name: 'Active rules' });
    await userEvent.click(within(activeGroup).getByRole('button', { name: 'Disable rule' }));

    // The PATCH must NOT fire on the trigger click alone.
    expect(api.updateLearnedRule).not.toHaveBeenCalled();

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('This rule will stop suppressing findings. You can re-enable it later.')).toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole('button', { name: 'Disable rule' }));

    await waitFor(() => {
      expect(api.updateLearnedRule).toHaveBeenCalledWith(
        'michnicki',
        'opencodra',
        ACTIVE_RULE.id,
        'disabled',
        'github',
      );
    });
    expect(toastSuccess).toHaveBeenCalledWith('Rule disabled.');
  });

  it('cancelling the disable dialog leaves the rule untouched', async () => {
    mountPanel({ enabled: true, learned_rules: [ACTIVE_RULE] });

    const activeGroup = screen.getByRole('group', { name: 'Active rules' });
    await userEvent.click(within(activeGroup).getByRole('button', { name: 'Disable rule' }));

    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(api.updateLearnedRule).not.toHaveBeenCalled();
  });

  it('re-enabling a disabled rule PATCHes it back to active with no confirmation', async () => {
    mountPanel({ enabled: true, learned_rules: [DISABLED_RULE] });

    await userEvent.click(screen.getByRole('button', { name: 'Re-enable rule' }));

    await waitFor(() => {
      expect(api.updateLearnedRule).toHaveBeenCalledWith(
        'michnicki',
        'opencodra',
        DISABLED_RULE.id,
        'active',
        'github',
      );
    });
    expect(toastSuccess).toHaveBeenCalledWith('Rule re-enabled.');
  });

  it('surfaces a failed transition as an error toast without refreshing the parent', async () => {
    vi.mocked(api.updateLearnedRule).mockRejectedValue(new Error('Invalid status transition'));
    const onSynthesized = vi.fn();
    mountPanel({ enabled: true, learned_rules: [PENDING_RULE] }, { onSynthesized });

    await userEvent.click(screen.getByRole('button', { name: 'Approve rule' }));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith('Failed to update rule. Please try again.'));
    expect(onSynthesized).not.toHaveBeenCalled();
  });

  // --- synthesize outcomes ----------------------------------------------------------------------

  it('distinguishes a populated synthesize result from an empty one', async () => {
    vi.mocked(api.synthesizeLearnedRules).mockResolvedValue({ ok: true, rules: [PENDING_RULE] });
    const onSynthesized = vi.fn();
    mountPanel({ enabled: true, learned_rules: [] }, { onSynthesized });

    await userEvent.click(screen.getByRole('button', { name: 'Synthesize learned rules' }));

    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('Rules synthesized. Review pending rules below.'));
    expect(toastInfo).not.toHaveBeenCalled();
    expect(onSynthesized).toHaveBeenCalled();
  });

  it('reports an empty synthesize result as info, not success', async () => {
    vi.mocked(api.synthesizeLearnedRules).mockResolvedValue({ ok: true, rules: [], message: 'No new rule candidates found' });
    mountPanel({ enabled: true, learned_rules: [] });

    await userEvent.click(screen.getByRole('button', { name: 'Synthesize learned rules' }));

    await waitFor(() => expect(toastInfo).toHaveBeenCalled());
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it('renders an inline alert when synthesis fails', async () => {
    vi.mocked(api.synthesizeLearnedRules).mockRejectedValue(new Error('boom'));
    mountPanel({ enabled: true, learned_rules: [PENDING_RULE] });

    await userEvent.click(screen.getByRole('button', { name: 'Synthesize learned rules' }));

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(
      screen.getByText('Synthesis failed. Check that reject feedback exists for this repository and try again.'),
    ).toBeInTheDocument();
  });
});
