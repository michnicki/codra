import type { ReviewMode } from '@shared/schema';

export interface RoundBadgeInput {
  round?: number | null;
  mode?: ReviewMode | null;
  incrementalEnabled?: boolean;
  escalateFloors?: boolean;
}

const MODE_LABELS: Partial<Record<ReviewMode, string>> = {
  full: 'full diff',
  incremental: 'incremental',
  fallback: 'full-diff fallback',
  no_changes: 'no changes',
};

/**
 * Produces the compact, non-interactive job-detail label for persisted round state.
 * Invalid/round-1 values fail open to no UI so legacy jobs retain their existing layout.
 */
export function formatRoundBadge({
  round,
  mode,
  incrementalEnabled,
  escalateFloors,
}: RoundBadgeInput): string | null {
  if (typeof round !== 'number' || !Number.isFinite(round) || round < 2) {
    return null;
  }

  const normalizedRound = Math.floor(round);
  if (incrementalEnabled === false) {
    return `Round ${normalizedRound}`;
  }

  const modeLabel = mode ? MODE_LABELS[mode] : undefined;
  if (!modeLabel) {
    return normalizedRound >= 3 ? 'Round 3+' : `Round ${normalizedRound}`;
  }

  const floorSuffix = escalateFloors === false ? ' · floors not escalated' : '';
  return `Round ${normalizedRound} · ${modeLabel}${floorSuffix}`;
}
