import { parseCriticPruneResponse, parseFileReviewResponse, parseWalkthroughDiagram } from '@server/core/model-output';
import type { FileDiff } from '@server/core/diff';

describe('Model Output Parsing Deep Dive', () => {
  const mockFile: FileDiff = {
    path: 'test.ts',
    previousPath: null,
    isNew: false,
    isDeleted: false,
    isBinary: false,
    lineCount: 10,
    hunks: [
      {
        header: '@@ -1,5 +1,5 @@',
        lines: [
          { kind: 'context', content: 'older', newLineNumber: 1, position: 1 },
          { kind: 'add', content: 'new line', newLineNumber: 2, position: 2 },
          { kind: 'context', content: 'older', newLineNumber: 3, position: 3 },
        ],
      },
    ],
  };

  it('extracts JSON from markdown code blocks with surrounding text', () => {
    const rawOutput = `
Here is my review:
\`\`\`json
{
  "findings": [{
    "title": "Good code",
    "body": "This looks fine.",
    "priority": 2,
    "code_location": { "absolute_file_path": "test.ts", "line": 2 }
  }],
  "overall_correctness": "patch is correct",
  "overall_explanation": "All good"
}
\`\`\`
Hope this helps!`;

    const result = parseFileReviewResponse(rawOutput, mockFile);
    expect(result.comments).toHaveLength(1);
    expect(result.verdict).toBe('comment'); // Since it has comments, verdict becomes 'comment'
  });

  it('salvages malformed JSON with unescaped newlines using jsonrepair', () => {
    const rawOutput = `
{
  "findings": [{
    "title": "Multiline
Issue",
    "body": "This has
unescaped newlines",
    "priority": 1,
    "code_location": { "absolute_file_path": "test.ts", "line": 2 }
  }],
  "overall_correctness": "issues found",
  "overall_explanation": "explanation"
}`;

    const result = parseFileReviewResponse(rawOutput, mockFile);
    // our cleanText flattens newlines in titles to spaces
    expect(result.comments[0].title).toBe('Multiline Issue');
  });

  it('handles truncated JSON gracefully (salvage success)', () => {
    const rawOutput = `
{
  "findings": [{
    "title": "Truncated",
    "body": "This cuts off",
    "priority": 1,
    "code_location": { "absolute_file_path": "test.ts", "line": 2 }
`; 
    const result = parseFileReviewResponse(rawOutput, mockFile);
    expect(result.comments).toHaveLength(1);
    expect(result.comments[0].title).toBe('Truncated');
  });

  it('removes conversational tags and emojis from titles and bodies', () => {
    const rawOutput = `
{
  "findings": [{
    "title": "🚀 [PERFORMANCE] Optimization needed",
    "body": "⚠️ HIGH: You should optimize this.",
    "priority": 0,
    "code_location": { "absolute_file_path": "test.ts", "line": 2 }
  }],
  "overall_correctness": "issues found",
  "overall_explanation": "explanation"
}`;

    const result = parseFileReviewResponse(rawOutput, mockFile);
    expect(result.comments[0].title).toBe('Optimization needed');
  });

  it('maps priorities correctly to P-levels', () => {
    const rawOutput = `
{
  "findings": [
    {
      "title": "P0 Issue",
      "body": "Critical",
      "priority": 0,
      "code_location": { "absolute_file_path": "test.ts", "line": 2 }
    },
    {
      "title": "P3 Issue",
      "body": "Minor",
      "priority": 3,
      "code_location": { "absolute_file_path": "test.ts", "line": 2 }
    }
  ],
  "overall_correctness": "issues found",
  "overall_explanation": "explanation"
}`;

    // Engine defaults ENABLED. This test stays green because "P3 Issue"/"Minor" carries no positive
    // SEV-03 style-signal keyword, so the positive-predicate fix leaves it at P3 (a bare
    // absence-of-defect-words no longer downgrades a real finding).
    const result = parseFileReviewResponse(rawOutput, mockFile);
    expect(result.comments[0].severity).toBe('P0');
    expect(result.comments[1].severity).toBe('P3');
  });

  it('severity engine DISABLED: raw priority mapping, no downgrade, empty severityAuditEvents', () => {
    const rawOutput = `
{
  "findings": [{
    "title": "Inconsistent naming convention",
    "body": "Please rename for readability.",
    "priority": 3,
    "code_location": { "absolute_file_path": "test.ts", "line": 2 }
  }],
  "overall_correctness": "issues found",
  "overall_explanation": "explanation"
}`;
    const result = parseFileReviewResponse(rawOutput, mockFile, { severityEngineEnabled: false });
    expect(result.comments[0].severity).toBe('P3'); // raw priority mapping, no SEV-03 downgrade
    expect(result.severityAuditEvents).toHaveLength(0);
  });

  it('severity engine ENABLED: an SEV-01 exploit keyword promotes to P0 and records a keyword_promotion event', () => {
    const rawOutput = `
{
  "findings": [{
    "title": "Possible SQL injection",
    "body": "user input flows into the query unescaped.",
    "priority": 2,
    "code_location": { "absolute_file_path": "test.ts", "line": 2 }
  }],
  "overall_correctness": "issues found",
  "overall_explanation": "explanation"
}`;
    const result = parseFileReviewResponse(rawOutput, mockFile, { severityEngineEnabled: true });
    expect(result.comments[0].severity).toBe('P0');
    expect(result.severityAuditEvents.some(e => e.stage === 'severity_adjusted' && (e as any).rule === 'keyword_promotion')).toBe(true);
  });

  it('handles findings targeting lines outside the diff by finding the closest line', () => {
    const rawOutput = `
{
  "findings": [{
    "title": "Off-target",
    "body": "Targeting line 10",
    "priority": 2,
    "code_location": { "absolute_file_path": "test.ts", "line": 8 }
  }],
  "overall_correctness": "issues found",
  "overall_explanation": "explanation"
}`;

    const result = parseFileReviewResponse(rawOutput, mockFile);
    // Closest valid line to 8 in our mockFile (available are 1, 2, 3) is 3
    expect(result.comments[0].line).toBe(3);
  });

  it('does not treat reviewed source snippets as review JSON', () => {
    const rawOutput = `
\`\`\`ts
export function nextOwner(owner: string) {
  return owner.toUpperCase();
}
\`\`\``;

    expect(() => parseFileReviewResponse(rawOutput, mockFile)).toThrow('Could not find JSON root');
  });

  it('drops placeholder schema findings instead of failing validation', () => {
    const rawOutput = `
{
  "findings": [{
    "title": "<Plain title>",
    "body": "<Technical explanation>",
    "priority": "<0|1|2|3>",
    "code_location": {
      "absolute_file_path": "test.ts",
      "line": "<int>",
      "line_range": { "start": "<int>", "end": "<int>" }
    }
  }],
  "overall_correctness": "patch is correct",
  "overall_explanation": "No concrete findings",
  "overall_confidence_score": 0.5
}`;

    const result = parseFileReviewResponse(rawOutput, mockFile);
    expect(result.comments).toHaveLength(0);
    expect(result.verdict).toBe('approve');
  });

  it('carries a per-finding confidence_score through to comment.confidence', () => {
    const rawOutput = `
{
  "findings": [{
    "title": "Potential bug",
    "body": "This looks wrong.",
    "priority": 1,
    "confidence_score": 0.9,
    "code_location": { "absolute_file_path": "test.ts", "line": 2 }
  }],
  "overall_correctness": "patch is incorrect",
  "overall_explanation": "Found an issue"
}`;

    const result = parseFileReviewResponse(rawOutput, mockFile);
    expect(result.comments).toHaveLength(1);
    expect(result.comments[0].confidence).toBe(0.9);
  });

  it('preserves missing confidence (undefined/null), never fabricating a score', () => {
    const rawOutput = `
{
  "findings": [{
    "title": "Potential bug",
    "body": "This looks wrong.",
    "priority": 1,
    "code_location": { "absolute_file_path": "test.ts", "line": 2 }
  }],
  "overall_correctness": "patch is incorrect",
  "overall_explanation": "Found an issue"
}`;

    const result = parseFileReviewResponse(rawOutput, mockFile);
    expect(result.comments).toHaveLength(1);
    expect(result.comments[0].confidence == null).toBe(true);
  });
});

describe('parseWalkthroughDiagram (WT-04)', () => {
  const noFence = (s: string | null) => {
    expect(s).not.toBeNull();
    expect(s!.startsWith('```')).toBe(false);
    expect(s!.endsWith('```')).toBe(false);
  };

  it('returns fence-free source for a bare sequenceDiagram payload', () => {
    const out = parseWalkthroughDiagram('sequenceDiagram\n  A->>B: hi');
    noFence(out);
    expect(out).toContain('sequenceDiagram');
    expect(out).toContain('A->>B: hi');
  });

  it('unwraps a ```mermaid fenced block and returns fence-free source', () => {
    const out = parseWalkthroughDiagram('```mermaid\nsequenceDiagram\n  A->>B: hi\n```');
    noFence(out);
    expect(out).toBe('sequenceDiagram\n  A->>B: hi');
  });

  it('unwraps a bare ``` fenced block', () => {
    const out = parseWalkthroughDiagram('```\nsequenceDiagram\n  A->>B: hi\n```');
    noFence(out);
    expect(out).toContain('sequenceDiagram');
  });

  it('strips a leading <think>...</think> block before validating', () => {
    const out = parseWalkthroughDiagram(
      '<think>let me reason about this</think>\nsequenceDiagram\n  A->>B: hi',
    );
    noFence(out);
    expect(out).toBe('sequenceDiagram\n  A->>B: hi');
    expect(out).not.toContain('reason');
  });

  it('strips a <think> block wrapping a fenced diagram', () => {
    const out = parseWalkthroughDiagram(
      '<think>planning</think>\n```mermaid\nsequenceDiagram\n  A->>B: hi\n```',
    );
    noFence(out);
    expect(out).toBe('sequenceDiagram\n  A->>B: hi');
  });

  it('accepts leading %% comment lines before sequenceDiagram', () => {
    const out = parseWalkthroughDiagram('%% generated\nsequenceDiagram\n  A->>B: hi');
    noFence(out);
    expect(out).toContain('sequenceDiagram');
  });

  it('returns null for an empty string', () => {
    expect(parseWalkthroughDiagram('')).toBeNull();
    expect(parseWalkthroughDiagram('   \n  ')).toBeNull();
  });

  it('returns null for <think>-only output (no diagram)', () => {
    expect(parseWalkthroughDiagram('<think>just reasoning, no diagram</think>')).toBeNull();
  });

  it('returns null when sequenceDiagram is only mentioned mid-paragraph (first token is prose)', () => {
    expect(
      parseWalkthroughDiagram('Here is a sequenceDiagram you might like: A talks to B.'),
    ).toBeNull();
  });

  it('returns null for an over-length source', () => {
    const huge = 'sequenceDiagram\n' + '  A->>B: x\n'.repeat(5000);
    expect(huge.length).toBeGreaterThan(20_000);
    expect(parseWalkthroughDiagram(huge)).toBeNull();
  });

  it('returns null for garbage / non-diagram output', () => {
    expect(parseWalkthroughDiagram('{"foo": "bar"}')).toBeNull();
    expect(parseWalkthroughDiagram('graph TD; A-->B;')).toBeNull();
  });
});

describe('parseCriticPruneResponse (D-05 ID-based prune contract)', () => {
  it('returns { id, reason }[] for a well-formed prune object', () => {
    const out = parseCriticPruneResponse('{"prune":[{"id":0,"reason":"false positive"},{"id":2,"reason":"nitpick"}]}');
    expect(out).toEqual([
      { id: 0, reason: 'false positive' },
      { id: 2, reason: 'nitpick' },
    ]);
  });

  it('extracts the prune object from a ```json fenced block with surrounding prose', () => {
    const raw = 'Here is my verdict:\n```json\n{ "prune": [ { "id": 1, "reason": "duplicate" } ] }\n```\nDone.';
    expect(parseCriticPruneResponse(raw)).toEqual([{ id: 1, reason: 'duplicate' }]);
  });

  it('strips a leading <think> block before parsing', () => {
    const raw = '<think>let me decide which to drop</think>\n{"prune":[{"id":3,"reason":"stylistic"}]}';
    expect(parseCriticPruneResponse(raw)).toEqual([{ id: 3, reason: 'stylistic' }]);
  });

  it('skips malformed entries per-item (bad id / missing reason) and keeps valid ones', () => {
    const raw = JSON.stringify({
      prune: [
        { id: 0, reason: 'keep this one' },
        { id: 'nope', reason: 'bad id type' },
        { id: -1, reason: 'negative id rejected' },
        { id: 4 }, // missing reason
        { reason: 'missing id' },
        { id: 5, reason: 'also valid' },
      ],
    });
    expect(parseCriticPruneResponse(raw)).toEqual([
      { id: 0, reason: 'keep this one' },
      { id: 5, reason: 'also valid' },
    ]);
  });

  it('returns [] for an empty prune array', () => {
    expect(parseCriticPruneResponse('{"prune":[]}')).toEqual([]);
  });

  it('returns [] for unparseable / non-JSON input', () => {
    expect(parseCriticPruneResponse('not json at all, just prose')).toEqual([]);
    expect(parseCriticPruneResponse('')).toEqual([]);
    expect(parseCriticPruneResponse('   ')).toEqual([]);
  });

  it('returns [] when the JSON has no prune array', () => {
    expect(parseCriticPruneResponse('{"kept":[1,2,3]}')).toEqual([]);
  });

  it('tolerates a jsonrepair-fixable trailing comma', () => {
    expect(parseCriticPruneResponse('{"prune":[{"id":1,"reason":"x"},]}')).toEqual([{ id: 1, reason: 'x' }]);
  });
});
