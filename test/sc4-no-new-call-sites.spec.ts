import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

// SC4 / NREG-01: Phase 17 widens the VcsProvider seam with four new methods
// (`getFileContent`, `getCompareDiff`, `getUnresolvedBotThreads`, `resolveThread`). SC4
// requires that NO production consumer wire any of those primitives — review output must
// stay byte-identical. This spec is a repository-wide, fail-closed scan:
//   1. Recursively discover every production `.ts`/`.tsx` file under `src/server`.
//   2. Assert the two LIVE protected review surfaces (src/server/core/review.ts and
//      src/server/workflows/review.ts) exist and are scanned — ENOENT does NOT pass.
//   3. Skip an explicit allowlist (seam contract, both adapters, both provider clients,
//      and the GitHub service pass-through) — these are the only files that legitimately
//      contain the four method identifiers as definitions, signatures, or delegated
//      implementations.
//   4. Flag any identifier occurrence in a non-allowlisted file, naming the offending
//      file and the offending identifier in the failure message.
//
// RATIONALE: a narrower scan (e.g. only the three protected review-flow files) goes stale
// the moment a new consumer is added; a repo-wide scan keyed off an explicit allowlist
// catches every future addition in `src/server` and keeps the protected set stable across
// the post-refactor renaming (src/server/core/review-flow.ts was merged away; that path
// is therefore intentionally NOT in the protected set).
//
// Phase 18 carve-out (RND-01 / RND-04): the round-detection block in src/server/core/review.ts
// now wires `vcs.getUnresolvedBotThreads` (gated on `rounds.incremental && supportsThreadListing`)
// for thread-aware round detection. That call site is the documented Phase 18 consumer of the
// Phase 17 seam primitive, scoped to one method call gated by config + capability. The scan
// excludes it via SC4_ALLOWLISTED_REVIEW_CALL_SITES so the broader NREG-01 invariant stays tight
// for every other primitive. Phase 18 Plan 02 (RND-02) ALSO wires `getCompareDiff` in
// `src/server/core/review.ts` (the prepare-time selection block, gated on
// `rounds.incremental && hasAnchor`) and the typed `selectDiffForRound` signature in
// `src/server/core/rounds.ts` references the seam primitive's name in JSDoc.
//
// Phase 19 carve-out (THR-01 / THR-02): `src/server/core/verify-fixes.ts` is the intentional,
// default-off consumer of thread listing, head file content, and resolution. It remains provider-
// neutral and capability-gated; test/verify-fixes-provider-parity.spec.ts proves equivalent logical
// outcomes on GitHub and Bitbucket. The explicit per-file identifier set below keeps any other new
// consumer fail-closed.

const PROJECT_ROOT = join(__dirname, '..');

// Phase-17 primitive identifiers (D-01/D-02/D-05/D-08/D-09). These exact names are the
// contract methods added to VcsProvider in Plan 17-01 / 17-02; any production call site
// outside the allowlist represents a Phase 17 wiring that defeats the byte-identical bar.
const PHASE_17_METHOD_IDENTIFIERS = [
  'getFileContent',
  'getCompareDiff',
  'getUnresolvedBotThreads',
  'resolveThread',
] as const;

// The two LIVE protected review surfaces. Their existence IS PART OF the assertion —
// deletion or rename of either file should fail this spec, not silently skip it.
const REQUIRED_LIVE_REVIEW_FILES = [
  'src/server/core/review.ts',
  'src/server/workflows/review.ts',
] as const;

// Explicit allowlist for the scan. Only these files are permitted to mention the four
// Phase-17 primitive identifiers. Every entry must be a production source file under
// src/server:
//   - `src/server/vcs/types.ts`         — the seam contract declaring the methods
//   - `src/server/vcs/github.ts`        — the GitHub adapter (delegates each method)
//   - `src/server/vcs/bitbucket.ts`     — the Bitbucket adapter (delegates each method)
//   - `src/server/core/github.ts`       — the GitHub REST/GraphQL client implementing each
//   - `src/server/core/bitbucket.ts`    — the Bitbucket REST client implementing each
//   - `src/server/services/github.ts`   — the GitHub service pass-through seam
// (The deleted `src/server/core/review-flow.ts` is intentionally absent — see VERIFICATION.md.)
const SOURCE_SCAN_ALLOWLIST = new Set<string>([
  'src/server/vcs/types.ts',
  'src/server/vcs/github.ts',
  'src/server/vcs/bitbucket.ts',
  'src/server/core/github.ts',
  'src/server/core/bitbucket.ts',
  'src/server/services/github.ts',
]);

// Explicit consumer carve-outs. Phase 18 permits round detection/compare selection in review.ts
// and the rounds helper's typed reference. Phase 19 permits verify-fixes.ts to consume thread
// listing, file content, and resolution behind its default-off config and provider capabilities.
// Stored as `{ file -> Set<identifier> }` so the scan grants only the documented primitive to each
// file rather than a blanket file-level pass.
const SC4_ALLOWLISTED_REVIEW_CALL_SITES = new Map<string, ReadonlySet<string>>([
  ['src/server/core/review.ts', new Set(['getUnresolvedBotThreads', 'getCompareDiff'])],
  ['src/server/core/rounds.ts', new Set(['getCompareDiff'])],
  [
    'src/server/core/verify-fixes.ts',
    new Set(['getFileContent', 'getUnresolvedBotThreads', 'resolveThread']),
  ],
]);

function collectProductionFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...collectProductionFiles(full));
      continue;
    }
    if (stat.isFile() && /\.(ts|tsx)$/.test(entry)) {
      out.push(relative(PROJECT_ROOT, full).split(sep).join('/'));
    }
  }
  return out;
}

describe('SC4 / NREG-01: no new call sites for Phase-17 primitives', () => {
  const allProductionFiles = collectProductionFiles(join(PROJECT_ROOT, 'src/server'));

  it('discovers at least one production file under src/server', () => {
    expect(allProductionFiles.length).toBeGreaterThan(0);
  });

  for (const required of REQUIRED_LIVE_REVIEW_FILES) {
    it(`protected live file exists: ${required}`, () => {
      // Existence is part of the assertion. Missing file = a hard fail, not a skip.
      expect(allProductionFiles).toContain(required);
    });
  }

  it('the deleted src/server/core/review-flow.ts is NOT in the protected set', () => {
    // The pre-refactor review-flow module was merged away in a prior phase; the SC4
    // protected set intentionally tracks the TWO live surfaces, not the deleted path.
    // If this path EVER reappears, the spec exposes the rename as a deliberate scan
    // update rather than a stale assertion.
    expect(allProductionFiles).not.toContain('src/server/core/review-flow.ts');
  });

  it('flagging: every non-allowlisted production file MUST NOT reference any Phase-17 method identifier', () => {
    const violations: string[] = [];
    for (const file of allProductionFiles) {
      if (SOURCE_SCAN_ALLOWLIST.has(file)) continue;
      // Read every discovered file (the protected ones are scanned too — they MUST be
      // clean of the four identifiers, which is the load-bearing NREG-01 invariant).
      const content = readFileSync(join(PROJECT_ROOT, file), 'utf8');
      const fileCarveOut = SC4_ALLOWLISTED_REVIEW_CALL_SITES.get(file);
      for (const identifier of PHASE_17_METHOD_IDENTIFIERS) {
        // Phase 18 carve-out: if this (file, identifier) pair is in the explicit
        // SC4_ALLOWLISTED_REVIEW_CALL_SITES map, the scan skips it. Every other
        // combination must stay clean.
        if (fileCarveOut?.has(identifier)) continue;
        // Word-boundary match so an unrelated identifier like `getCompareDiffStrict` does
        // not trip the scan. The seam methods are camelCase verbs followed by a `(`,
        // property, assignment, or end of token; `\b` covers all of those.
        const pattern = new RegExp(`\\b${identifier}\\b`);
        if (pattern.test(content)) {
          violations.push(`${file}: identifier "${identifier}" found in non-allowlisted production file`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('allowlist discipline: every allowlisted file actually exists and is a real production source file', () => {
    // A shrunk allowlist that silently excludes a real seam/adapter client would let
    // consumer calls slip through. Validate every allowlist entry is present so a
    // typo in the entry is caught up front.
    const allowlist = Array.from(SOURCE_SCAN_ALLOWLIST);
    expect(allowlist.length).toBeGreaterThan(0);
    for (const file of allowlist) {
      expect(allProductionFiles).toContain(file);
    }
  });

  it('consumer carve-outs point at real files and permit only Phase-17 method identifiers', () => {
    // Each carve-out grants specific (file, identifier) pairs. Validate every entry references a
    // real production file and every identifier belongs to the closed primitive vocabulary.
    expect(SC4_ALLOWLISTED_REVIEW_CALL_SITES.size).toBeGreaterThan(0);
    for (const [file, identifiers] of SC4_ALLOWLISTED_REVIEW_CALL_SITES.entries()) {
      expect(allProductionFiles).toContain(file);
      for (const id of identifiers) {
        expect((PHASE_17_METHOD_IDENTIFIERS as readonly string[])).toContain(id);
      }
    }
  });
});
