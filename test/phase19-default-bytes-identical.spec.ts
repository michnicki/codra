import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPhase19Baseline, canonicalizePhase19Baseline } from './support/phase19-baseline-harness';

type BaselineFixture = ReturnType<typeof buildPhase19Baseline> & {
  provenance: { captureCommit: string; source: string };
};

const fixturePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  './phase19-default-baseline.fixture.json',
);

function loadFixture(): BaselineFixture {
  return JSON.parse(readFileSync(fixturePath, 'utf8')) as BaselineFixture;
}

describe('Phase 19 default-path byte identity', () => {
  it('matches the pinned pre-Phase-19 oracle for full, incremental, and review-rest paths', () => {
    const fixture = loadFixture();
    const actual = canonicalizePhase19Baseline(buildPhase19Baseline());

    expect(fixture.provenance.captureCommit).toBe('3d5f4150f8ff88787c10a3067ddc59176285eb25');
    expect(fixture.provenance.source).toBe('detached pre-Phase-19 worktree');
    expect(actual).toEqual({ ...fixture, provenance: undefined });
  });

  it('keeps all Phase-19 toggles inert and records no Phase-19 calls/results at defaults', () => {
    const actual = buildPhase19Baseline();
    for (const pathName of ['full', 'incremental', 'review-rest'] as const) {
      expect(actual.paths[pathName].phase19).toEqual({
        modelCalls: 0,
        auditEvents: [],
        results: {
          threadVerification: null,
          critic: null,
          ensemble: null,
          walkthroughEnrichment: null,
        },
      });
    }
  });
});
