// Phase 9..19: the canonical typed control-flow signal for phase transitions. Lives in its own
// module (separate from review.ts) so the durable phase modules (verify-fixes, walkthrough-
// enrichment) can throw NextPhaseError without creating a circular import with review.ts.

export type PhaseName =
  | 'prepare'
  | 'review'
  | 'finalize'
  | 'critic'
  | 'verify_fixes'
  | 'walkthrough_enrichment'
  | 'cross_file_security'
  // Phase 35 (PRD-06, D-09): the bounded agentic-context phase between prepare and review. This is a
  // `tsc` site — the phase cannot be thrown or dispatched without it — and it is what makes the
  // `error.phase === 'agentic_context'` freshInstance test in review.ts type-check rather than being
  // flagged as a comparison with no overlap.
  | 'agentic_context';

export class NextPhaseError extends Error {
  constructor(public phase: PhaseName, public delaySeconds: number) {
    super(`NextPhase: ${phase}`);
  }
}
