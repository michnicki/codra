// SEC-XDIFF-01: unit tests for the cross-file security reasoning phase.
//
// Tests cover:
// - buildCrossFileDiff: priority sorting, truncation, empty input
// - parseCrossFileSecurityResponse: tolerant parsing, fail-open, malformed input
// - CROSS_FILE_SENTINEL / CROSS_FILE_DIFF_MAX_LINES constants
// - Prompt template functions
// - Audit event builders
// - Walkthrough cross-file section (buildWalkthroughData)
// - Formatter cross-reference rendering (formatInlineComment)
// - No-duplication / NREG-01 byte-identical assertions

import { describe, it, expect } from 'vitest';
import {
  buildCrossFileDiff,
  CROSS_FILE_DIFF_MAX_LINES,
  CROSS_FILE_SENTINEL,
  parseUnifiedDiff,
  type FileDiff,
} from '@server/core/diff';
import { parseCrossFileSecurityResponse } from '@server/core/model-output';
import {
  buildCrossFileSecuritySystemPrompt,
  buildCrossFileSecurityUserPrompt,
} from '@server/prompts/cross-file-security-review';
import {
  buildCrossFileSecurityAuditEvent,
} from '@server/core/audit';
import { buildWalkthroughData, type WalkthroughReviewRow } from '@server/core/walkthrough';
import { FormatterService } from '@server/services/formatter';
import type { ParsedReviewComment } from '@shared/schema';

// ── Constants ──────────────────────────────────────────────────────────────────

describe('CROSS_FILE_SENTINEL', () => {
  it('is the expected sentinel path', () => {
    expect(CROSS_FILE_SENTINEL).toBe('__cross_file__');
  });
});

describe('CROSS_FILE_DIFF_MAX_LINES', () => {
  it('is a reasonable budget (~3000 lines)', () => {
    expect(CROSS_FILE_DIFF_MAX_LINES).toBe(3000);
  });
});

// ── buildCrossFileDiff ─────────────────────────────────────────────────────────

describe('buildCrossFileDiff', () => {
  function makeFileDiff(path: string, hunks: Array<{ header: string; lines: Array<{ kind: 'add' | 'del' | 'context'; content: string }> }>): FileDiff {
    return {
      path,
      previousPath: null,
      isNew: false,
      isDeleted: false,
      isBinary: false,
      lineCount: hunks.reduce((sum, h) => sum + h.lines.length, 0),
      hunks: hunks.map((h, hi) => ({
        header: h.header,
        lines: h.lines.map((l, li) => ({ ...l, position: hi * 100 + li })),
      })),
    };
  }

  it('returns empty string for empty input', () => {
    expect(buildCrossFileDiff([])).toBe('');
  });

  it('produces a unified diff with --- a/ and +++ b/ headers', () => {
    const files = [
      makeFileDiff('src/auth.ts', [{
        header: '@@ -1,3 +1,4 @@',
        lines: [
          { kind: 'context', content: 'existing' },
          { kind: 'add', content: 'new line' },
        ],
      }]),
    ];
    const result = buildCrossFileDiff(files, CROSS_FILE_DIFF_MAX_LINES);
    expect(result).toContain('--- a/src/auth.ts');
    expect(result).toContain('+++ b/src/auth.ts');
    expect(result).toContain('+new line');
    expect(result).toContain(' existing');
  });

  it('sorts files by security-sensitive priority (auth/middleware/session first)', () => {
    const files = [
      makeFileDiff('src/utils.ts', [{
        header: '@@ -1,1 +1,2 @@',
        lines: [{ kind: 'add', content: 'util' }],
      }]),
      makeFileDiff('src/middleware/auth.ts', [{
        header: '@@ -1,1 +1,2 @@',
        lines: [{ kind: 'add', content: 'auth' }],
      }]),
      makeFileDiff('src/routes/api.ts', [{
        header: '@@ -1,1 +1,2 @@',
        lines: [{ kind: 'add', content: 'route' }],
      }]),
    ];
    const result = buildCrossFileDiff(files, CROSS_FILE_DIFF_MAX_LINES);
    // middleware/auth should come before utils
    const authIdx = result.indexOf('+++ b/src/middleware/auth.ts');
    const utilIdx = result.indexOf('+++ b/src/utils.ts');
    expect(authIdx).toBeLessThan(utilIdx);
  });

  it('truncates by priority when budget exceeded', () => {
    const bigLines = Array.from({ length: 200 }, (_, i) => ({
      kind: 'add' as const,
      content: `line ${i}`,
    }));
    const files = [
      makeFileDiff('src/low-priority.ts', [{
        header: '@@ -1,1 +1,200 @@',
        lines: bigLines,
      }]),
      makeFileDiff('src/auth/middleware.ts', [{
        header: '@@ -1,1 +1,2 @@',
        lines: [{ kind: 'add', content: 'auth line' }],
      }]),
    ];
    // With a very small budget, the high-priority auth file should be kept
    const result = buildCrossFileDiff(files, 50);
    expect(result).toContain('+++ b/src/auth/middleware.ts');
  });

  it('skips binary files', () => {
    const files: FileDiff[] = [
      {
        path: 'image.png',
        previousPath: null,
        isNew: false,
        isDeleted: false,
        isBinary: true,
        lineCount: 0,
        hunks: [],
      },
      makeFileDiff('src/code.ts', [{
        header: '@@ -1,1 +1,2 @@',
        lines: [{ kind: 'add', content: 'code' }],
      }]),
    ];
    const result = buildCrossFileDiff(files, CROSS_FILE_DIFF_MAX_LINES);
    expect(result).not.toContain('image.png');
    expect(result).toContain('+++ b/src/code.ts');
  });

  it('includes deleted files', () => {
    const files: FileDiff[] = [{
      path: 'deleted.ts',
      previousPath: null,
      isNew: false,
      isDeleted: true,
      isBinary: false,
      lineCount: 1,
      hunks: [{
        header: '@@ -1,1 +0,0 @@',
        lines: [{ kind: 'del', content: 'removed', position: 0 }],
      }],
    }];
    const result = buildCrossFileDiff(files, CROSS_FILE_DIFF_MAX_LINES);
    expect(result).toContain('-removed');
  });
});

// ── parseCrossFileSecurityResponse ─────────────────────────────────────────────

describe('parseCrossFileSecurityResponse', () => {
  it('parses a valid findings array', () => {
    const raw = JSON.stringify({
      findings: [
        {
          title: 'Inconsistent auth',
          body: 'Middleware checks auth but route handler does not',
          severity: 'P0',
          path: 'src/auth.ts',
          line: 10,
          confidence: 0.9,
          cross_references: [
            { path: 'src/routes/api.ts', line: 25, relationship: 'bypasses auth check' },
          ],
        },
      ],
    });
    const result = parseCrossFileSecurityResponse(raw);
    expect(result.kind).toBe('parsed');
    if (result.kind === 'parsed') {
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0].title).toBe('Inconsistent auth');
      expect(result.findings[0].severity).toBe('P0');
      expect(result.findings[0].cross_references).toHaveLength(1);
    }
  });

  it('parses multiple findings', () => {
    const raw = JSON.stringify({
      findings: [
        { title: 'Finding 1', body: 'Body 1', severity: 'P1', path: 'a.ts' },
        { title: 'Finding 2', body: 'Body 2', severity: 'P2', path: 'b.ts' },
      ],
    });
    const result = parseCrossFileSecurityResponse(raw);
    expect(result.kind).toBe('parsed');
    if (result.kind === 'parsed') {
      expect(result.findings).toHaveLength(2);
    }
  });

  it('drops malformed findings but keeps valid ones', () => {
    const raw = JSON.stringify({
      findings: [
        { title: '', body: 'ok', severity: 'P1', path: 'a.ts' }, // empty title -> invalid
        { title: 'Valid', body: 'ok', severity: 'P1', path: 'b.ts' },
      ],
    });
    const result = parseCrossFileSecurityResponse(raw);
    expect(result.kind).toBe('parsed');
    if (result.kind === 'parsed') {
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0].title).toBe('Valid');
    }
  });

  it('falls back to P2 for invalid severity', () => {
    const raw = JSON.stringify({
      findings: [
        { title: 'Test', body: 'Body', severity: 'critical', path: 'a.ts' },
      ],
    });
    const result = parseCrossFileSecurityResponse(raw);
    expect(result.kind).toBe('parsed');
    if (result.kind === 'parsed') {
      expect(result.findings[0].severity).toBe('P2'); // caught by .catch('P2')
    }
  });

  it('returns fail_open for empty response', () => {
    expect(parseCrossFileSecurityResponse('').kind).toBe('fail_open');
    expect(parseCrossFileSecurityResponse('  ').kind).toBe('fail_open');
  });

  it('returns fail_open for non-JSON', () => {
    const result = parseCrossFileSecurityResponse('This is not JSON at all');
    expect(result.kind).toBe('fail_open');
  });

  it('returns fail_open when findings is missing', () => {
    const result = parseCrossFileSecurityResponse(JSON.stringify({ other: 'data' }));
    expect(result.kind).toBe('fail_open');
    if (result.kind === 'fail_open') {
      expect(result.reason).toBe('findings_missing_or_not_array');
    }
  });

  it('returns fail_open when findings is not an array', () => {
    const result = parseCrossFileSecurityResponse(JSON.stringify({ findings: 'not-array' }));
    expect(result.kind).toBe('fail_open');
  });

  it('returns fail_open when all findings are invalid', () => {
    const result = parseCrossFileSecurityResponse(JSON.stringify({
      findings: [
        { title: '', body: '', severity: 'P1', path: '' }, // all invalid
      ],
    }));
    expect(result.kind).toBe('fail_open');
    if (result.kind === 'fail_open') {
      expect(result.reason).toBe('all_findings_invalid');
    }
  });

  it('strips think tags before parsing', () => {
    // Use string concatenation to avoid the parser treating <think> as JSX
    const thinkOpen = '<' + 'think' + '>';
    const thinkClose = '<' + '/think' + '>';
    const raw = thinkOpen + 'reasoning' + thinkClose + JSON.stringify({
      findings: [
        { title: 'Test', body: 'Body', severity: 'P1', path: 'a.ts' },
      ],
    });
    const result = parseCrossFileSecurityResponse(raw);
    expect(result.kind).toBe('parsed');
  });

  it('handles JSON wrapped in markdown code blocks', () => {
    const raw = '```json\n' + JSON.stringify({
      findings: [
        { title: 'Test', body: 'Body', severity: 'P1', path: 'a.ts' },
      ],
    }) + '\n```';
    const result = parseCrossFileSecurityResponse(raw);
    expect(result.kind).toBe('parsed');
  });

  it('handles missing optional fields (line, confidence, cross_references)', () => {
    const raw = JSON.stringify({
      findings: [
        { title: 'Test', body: 'Body', severity: 'P2', path: 'a.ts' },
      ],
    });
    const result = parseCrossFileSecurityResponse(raw);
    expect(result.kind).toBe('parsed');
    if (result.kind === 'parsed') {
      expect(result.findings[0].line).toBeUndefined();
      expect(result.findings[0].confidence).toBeUndefined();
      expect(result.findings[0].cross_references).toBeUndefined();
    }
  });
});

// ── Prompt template ────────────────────────────────────────────────────────────

describe('buildCrossFileSecuritySystemPrompt', () => {
  it('returns a non-empty system prompt', () => {
    const prompt = buildCrossFileSecuritySystemPrompt();
    expect(prompt.length).toBeGreaterThan(100);
  });

  it('mentions cross-file patterns', () => {
    const prompt = buildCrossFileSecuritySystemPrompt();
    expect(prompt).toContain('cross-file');
    expect(prompt).toContain('CROSS-FILE');
  });

  it('mentions JSON output format', () => {
    const prompt = buildCrossFileSecuritySystemPrompt();
    expect(prompt).toContain('JSON');
    expect(prompt).toContain('findings');
  });
});

describe('buildCrossFileSecurityUserPrompt', () => {
  it('includes PR title and diff', () => {
    const prompt = buildCrossFileSecurityUserPrompt({
      prTitle: 'Fix auth bypass',
      concatenatedDiff: '--- a/auth.ts\n+++ b/auth.ts\n+fix',
      fileCount: 1,
    });
    expect(prompt).toContain('Fix auth bypass');
    expect(prompt).toContain('--- a/auth.ts');
    expect(prompt).toContain('Files in diff: 1');
  });

  it('includes PR title with untrusted markers', () => {
    const prompt = buildCrossFileSecurityUserPrompt({
      prTitle: 'Evil title with special chars',
      concatenatedDiff: 'diff',
      fileCount: 1,
    });
    // The sanitizer wraps untrusted content with UNTRUSTED markers
    expect(prompt).toContain('Evil title with special chars');
    expect(prompt).toContain('UNTRUSTED');
  });

  it('handles null PR title', () => {
    const prompt = buildCrossFileSecurityUserPrompt({
      prTitle: null,
      concatenatedDiff: 'diff',
      fileCount: 2,
    });
    expect(prompt).toContain('Untitled PR');
  });
});

// ── Audit event builder ────────────────────────────────────────────────────────

describe('buildCrossFileSecurityAuditEvent', () => {
  it('builds a completed audit event', () => {
    const event = buildCrossFileSecurityAuditEvent('completed', {
      findingCount: 3,
      filesIncluded: 5,
    });
    expect(event.stage).toBe('cross_file_security');
    expect(event.status).toBe('completed');
    expect(event.finding_count).toBe(3);
    expect(event.files_included).toBe(5);
    expect(event.timestamp).toBeTruthy();
  });

  it('builds a skipped audit event with reason', () => {
    const event = buildCrossFileSecurityAuditEvent('skipped', {
      reason: 'no_diff_input',
      findingCount: 0,
      filesIncluded: 0,
    });
    expect(event.stage).toBe('cross_file_security');
    expect(event.status).toBe('skipped');
    expect(event.reason).toBe('no_diff_input');
    // finding_count/files_included are only set for 'completed' status
    expect(event.finding_count).toBeUndefined();
  });

  it('builds a failed audit event', () => {
    const event = buildCrossFileSecurityAuditEvent('failed', {
      reason: 'model_call_failed',
    });
    expect(event.stage).toBe('cross_file_security');
    expect(event.status).toBe('failed');
    expect(event.reason).toBe('model_call_failed');
  });

  it('includes a timestamp', () => {
    const event = buildCrossFileSecurityAuditEvent('completed');
    expect(event.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

// ── Walkthrough cross-file section ───────────────────────────────────────────

describe('buildWalkthroughData — cross-file section', () => {
  function makeReview(overrides: Partial<WalkthroughReviewRow> = {}): WalkthroughReviewRow {
    return {
      file_path: 'src/auth.ts',
      file_summary: 'Auth module reviewed',
      file_status: 'done',
      error_msg: null,
      verdict: 'comment',
      diff_line_count: 50,
      pass: 'main',
      ...overrides,
    };
  }

  function makeComment(overrides: Partial<ParsedReviewComment> = {}): ParsedReviewComment {
    return {
      path: 'src/auth.ts',
      line: 10,
      severity: 'P1',
      category: 'security',
      title: 'Missing auth check',
      body: 'The middleware does not verify the token.',
      ...overrides,
    };
  }

  it('omits crossFileSection when no crossFileComments provided (NREG-01)', () => {
    const data = buildWalkthroughData({
      reviews: [makeReview()],
      finalComments: [makeComment()],
    });
    expect(data.crossFileSection).toBeUndefined();
  });

  it('omits crossFileSection when crossFileComments is empty (NREG-01)', () => {
    const data = buildWalkthroughData({
      reviews: [makeReview()],
      finalComments: [makeComment()],
      crossFileComments: [],
    });
    expect(data.crossFileSection).toBeUndefined();
  });

  it('builds cross-file section with severity counts and findings', () => {
    const crossFileComments = [
      makeComment({
        path: 'src/auth.ts',
        severity: 'P0',
        title: 'Auth bypass via middleware gap',
        cross_references: [
          { path: 'src/routes/api.ts', line: 42, relationship: 'missing_auth_guard' },
          { path: 'src/middleware/session.ts', relationship: 'session_not_checked' },
        ],
      }),
      makeComment({
        path: 'src/routes/api.ts',
        severity: 'P1',
        title: 'Unprotected endpoint',
        cross_references: [
          { path: 'src/auth.ts', line: 10, relationship: 'auth_not_called' },
        ],
      }),
    ];
    const data = buildWalkthroughData({
      reviews: [makeReview()],
      finalComments: [makeComment()],
      crossFileComments,
    });
    expect(data.crossFileSection).toBeDefined();
    expect(data.crossFileSection!.severityCounts.P0).toBe(1);
    expect(data.crossFileSection!.severityCounts.P1).toBe(1);
    expect(data.crossFileSection!.severityCounts.P2).toBe(0);
    expect(data.crossFileSection!.findings).toHaveLength(2);
    expect(data.crossFileSection!.findings[0].title).toBe('Auth bypass via middleware gap');
    expect(data.crossFileSection!.findings[0].crossReferences).toHaveLength(2);
    expect(data.crossFileSection!.findings[0].crossReferences[0].path).toBe('src/routes/api.ts');
    expect(data.crossFileSection!.findings[0].crossReferences[0].line).toBe(42);
    expect(data.crossFileSection!.findings[0].crossReferences[1].path).toBe('src/middleware/session.ts');
  });

  it('counts unique files across primary paths and cross-references', () => {
    const crossFileComments = [
      makeComment({
        path: 'src/auth.ts',
        cross_references: [
          { path: 'src/routes/api.ts', relationship: 'missing_auth_guard' },
          { path: 'src/middleware/session.ts', relationship: 'session_not_checked' },
        ],
      }),
    ];
    const data = buildWalkthroughData({
      reviews: [makeReview()],
      finalComments: [makeComment()],
      crossFileComments,
    });
    // Unique paths: src/auth.ts, src/routes/api.ts, src/middleware/session.ts = 3
    expect(data.crossFileSection!.filesAnalyzed).toBe(3);
  });

  it('severityCounts on main walkthrough data are unaffected by cross-file section', () => {
    const crossFileComments = [
      makeComment({
        path: 'src/auth.ts',
        severity: 'P0',
        title: 'Critical cross-file vuln',
        cross_references: [{ path: 'src/routes/api.ts', relationship: 'test' }],
      }),
    ];
    const data = buildWalkthroughData({
      reviews: [makeReview()],
      finalComments: [makeComment({ severity: 'P2' })],
      crossFileComments,
    });
    // Main severity counts come from finalComments (P2 only)
    expect(data.severityCounts.P0).toBe(0);
    expect(data.severityCounts.P2).toBe(1);
    // Cross-file section has its own P0 count
    expect(data.crossFileSection!.severityCounts.P0).toBe(1);
  });
});

// ── Formatter cross-reference rendering ──────────────────────────────────────

describe('FormatterService.formatInlineComment — cross-references', () => {
  const formatter = new FormatterService('https://example.com');

  it('renders "Also affects" line for findings with cross_references', () => {
    const comment: ParsedReviewComment = {
      path: 'src/auth.ts',
      line: 10,
      severity: 'P1',
      category: 'security',
      title: 'Missing auth check',
      body: 'The middleware does not verify the token.',
      cross_references: [
        { path: 'src/routes/api.ts', line: 42, relationship: 'missing_auth_guard' },
        { path: 'src/middleware/session.ts', relationship: 'session_not_checked' },
      ],
    };
    const result = formatter.formatInlineComment(comment);
    expect(result).toContain('Also affects:');
    expect(result).toContain('`src/routes/api.ts` (line 42)');
    expect(result).toContain('`src/middleware/session.ts`');
  });

  it('does not render "Also affects" for findings without cross_references (NREG-01)', () => {
    const comment: ParsedReviewComment = {
      path: 'src/auth.ts',
      line: 10,
      severity: 'P1',
      category: 'security',
      title: 'Missing auth check',
      body: 'The middleware does not verify the token.',
    };
    const result = formatter.formatInlineComment(comment);
    expect(result).not.toContain('Also affects');
  });

  it('does not render "Also affects" for empty cross_references array (NREG-01)', () => {
    const comment: ParsedReviewComment = {
      path: 'src/auth.ts',
      line: 10,
      severity: 'P1',
      category: 'security',
      title: 'Missing auth check',
      body: 'The middleware does not verify the token.',
      cross_references: [],
    };
    const result = formatter.formatInlineComment(comment);
    expect(result).not.toContain('Also affects');
  });

  it('renders cross-references without line numbers', () => {
    const comment: ParsedReviewComment = {
      path: 'src/auth.ts',
      line: 10,
      severity: 'P2',
      category: 'security',
      title: 'Session fixation',
      body: 'Session ID not rotated after login.',
      cross_references: [
        { path: 'src/middleware/session.ts', relationship: 'session_not_rotated' },
      ],
    };
    const result = formatter.formatInlineComment(comment);
    expect(result).toContain('Also affects: `src/middleware/session.ts`');
    expect(result).not.toContain('line');
  });
});

// ── Formatter walkthrough cross-file section ────────────────────────────────

describe('FormatterService.formatWalkthrough — cross-file section', () => {
  const formatter = new FormatterService('https://example.com');

  it('renders cross-file section when crossFileSection is provided', () => {
    const result = formatter.formatWalkthrough({
      files: [{ path: 'src/auth.ts', summary: 'Auth reviewed', counts: { P0: 0, P1: 0, P2: 1, P3: 0, nit: 0 } }],
      severityCounts: { P0: 0, P1: 0, P2: 1, P3: 0, nit: 0 },
      filesReviewed: 1,
      crossFileSection: {
        severityCounts: { P0: 1, P1: 0, P2: 0, P3: 0, nit: 0 },
        filesAnalyzed: 3,
        findings: [{
          path: 'src/auth.ts',
          title: 'Auth bypass via middleware gap',
          severity: 'P0',
          crossReferences: [
            { path: 'src/routes/api.ts', line: 42, relationship: 'missing_auth_guard' },
          ],
        }],
      },
    });
    expect(result).toContain('Cross-file Security');
    expect(result).toContain('3 files analyzed');
    expect(result).toContain('Auth bypass via middleware gap');
    expect(result).toContain('`src/routes/api.ts` (line 42)');
  });

  it('does not render cross-file section when crossFileSection is absent (NREG-01)', () => {
    const result = formatter.formatWalkthrough({
      files: [{ path: 'src/auth.ts', summary: 'Auth reviewed', counts: { P0: 0, P1: 0, P2: 1, P3: 0, nit: 0 } }],
      severityCounts: { P0: 0, P1: 0, P2: 1, P3: 0, nit: 0 },
      filesReviewed: 1,
    });
    expect(result).not.toContain('Cross-file Security');
  });

  it('does not render cross-file section when findings is empty (NREG-01)', () => {
    const result = formatter.formatWalkthrough({
      files: [{ path: 'src/auth.ts', summary: 'Auth reviewed', counts: { P0: 0, P1: 0, P2: 1, P3: 0, nit: 0 } }],
      severityCounts: { P0: 0, P1: 0, P2: 1, P3: 0, nit: 0 },
      filesReviewed: 1,
      crossFileSection: {
        severityCounts: { P0: 0, P1: 0, P2: 0, P3: 0, nit: 0 },
        filesAnalyzed: 0,
        findings: [],
      },
    });
    expect(result).not.toContain('Cross-file Security');
  });
});
