// Phase 9..19: the canonical typed control-flow signal for phase transitions. Lives in its own
// module (separate from review.ts) so the durable phase modules (verify-fixes, walkthrough-
// enrichment) can throw NextPhaseError without creating a circular import with review.ts.

export type PhaseName =
  | 'prepare'
  | 'review'
  | 'finalize'
  | 'critic'
  | 'verify_fixes'
  | 'walkthrough_enrichment';

export class NextPhaseError extends Error {
  constructor(public phase: PhaseName, public delaySeconds: number) {
    super(`NextPhase: ${phase}`);
  }
}
