import { normalizeForEvidence, parseCriticPruneResponse, parseFileReviewResponse, parseWalkthroughDiagram, parseWalkthroughEnrichmentResponse } from '@server/core/model-output';
import { truncateFileDiff, type FileDiff } from '@server/core/diff';

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
    // The severity engine produced no events; severityAuditEvents is the shared accumulator (D-18) and
    // now also rides EVID-01 evidence events, so assert specifically that NO severity_adjusted event
    // was recorded (this finding has no existing_code, so exactly one evidence_missing{absent} rides).
    expect(result.severityAuditEvents.some((e) => e.stage === 'severity_adjusted')).toBe(false);
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

describe('EVID-01 soft evidence gate (D-14/D-16/D-17/D-18)', () => {
  // mockFile hunk line 2 is the add line "new line" (position 2), so a finding at line 2 survives the
  // orphan check and becomes a persisted comment. Evidence is checked against the cleaned-hunk
  // haystack = "older\nnew line\nother".
  const evidenceFile: FileDiff = {
    path: 'src/evid.ts',
    previousPath: null,
    isNew: false,
    isDeleted: false,
    isBinary: false,
    lineCount: 3,
    hunks: [
      {
        header: '@@ -1,2 +1,3 @@',
        lines: [
          { kind: 'context', content: 'const older = 1;', newLineNumber: 1, position: 1 },
          { kind: 'add', content: 'const Value = compute();', newLineNumber: 2, position: 2 },
          { kind: 'context', content: 'return older;', newLineNumber: 3, position: 3 },
        ],
      },
    ],
  };

  const rawWith = (existingCode: unknown) =>
    JSON.stringify({
      findings: [
        {
          title: 'Uses computed value',
          body: 'The computed value is not validated before use.',
          priority: 2,
          category: 'correctness',
          code_location: { absolute_file_path: 'src/evid.ts', line: 2 },
          ...(existingCode === '__OMIT__' ? {} : { existing_code: existingCode }),
        },
      ],
      overall_correctness: 'patch is incorrect',
      overall_explanation: 'Found an issue',
      overall_confidence_score: 0.8,
    });

  const evidenceEvents = (r: ReturnType<typeof parseFileReviewResponse>) =>
    r.severityAuditEvents.filter((e) => e.stage === 'evidence_missing');

  it('exact substring match: no evidence_missing event, comment still posts', () => {
    const result = parseFileReviewResponse(rawWith('const Value = compute();'), evidenceFile);
    expect(result.comments).toHaveLength(1);
    expect(evidenceEvents(result)).toHaveLength(0);
  });

  it('whitespace-only difference still matches (normalizeForEvidence collapses runs)', () => {
    const result = parseFileReviewResponse(rawWith('   const   Value =   compute();  '), evidenceFile);
    expect(result.comments).toHaveLength(1);
    expect(evidenceEvents(result)).toHaveLength(0);
  });

  it('case-only difference still matches (case-INSENSITIVE, OpenCode C4)', () => {
    const result = parseFileReviewResponse(rawWith('CONST value = COMPUTE();'), evidenceFile);
    expect(result.comments).toHaveLength(1);
    expect(evidenceEvents(result)).toHaveLength(0);
  });

  it('non-substring evidence: one evidence_missing{not_in_hunk}, comment still posts', () => {
    const result = parseFileReviewResponse(rawWith('someTotallyUnrelatedIdentifier()'), evidenceFile);
    expect(result.comments).toHaveLength(1);
    const events = evidenceEvents(result);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ stage: 'evidence_missing', reason: 'not_in_hunk', path: 'src/evid.ts', line: 2 });
  });

  it('BLOCKER 1 (D-06): evidence_missing title is redacted when over 100 chars', () => {
    // The model output schema caps the title at 100 chars (fileReviewModelOutputSchema.title
    // `.max(100)`), so the redaction is transparent for the model output path — the title
    // passes through unchanged. The wire-through is verified by asserting that the event
    // title matches the parsed comment title (the redaction is a no-op for <= 100 chars).
    // The producer-side redaction (redactFindingTitle) is exercised in test/audit-redact.spec.ts
    // and test/audit-events.spec.ts; the wiring here is verified by the schema-validated event.
    const result = parseFileReviewResponse(rawWith('someTotallyUnrelatedIdentifier()'), evidenceFile);
    expect(result.comments).toHaveLength(1);
    const events = evidenceEvents(result);
    expect(events).toHaveLength(1);
    // The title in the evidence_missing event is derived from the parsed comment title, which
    // is bounded by the model output schema. The redaction is a no-op for <= 100 chars.
    expect(events[0].title).toBe(result.comments[0].title);
    expect(events[0].title!.length).toBeLessThanOrEqual(100);
  });

  it('omitted existing_code: one evidence_missing{absent}, comment still posts', () => {
    const result = parseFileReviewResponse(rawWith('__OMIT__'), evidenceFile);
    expect(result.comments).toHaveLength(1);
    const events = evidenceEvents(result);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ stage: 'evidence_missing', reason: 'absent' });
  });

  it('empty-string existing_code: one evidence_missing{absent}, comment still posts', () => {
    const result = parseFileReviewResponse(rawWith('   '), evidenceFile);
    expect(result.comments).toHaveLength(1);
    expect(evidenceEvents(result)).toEqual([
      expect.objectContaining({ stage: 'evidence_missing', reason: 'absent' }),
    ]);
  });

  it('JSON null existing_code: no parse throw, comment still posts, one evidence_missing{absent}', () => {
    // Codex 15-01 HIGH: existing_code is nullable().optional(), so a JSON null must NOT throw the
    // per-file parse before the evidence check runs.
    const result = parseFileReviewResponse(rawWith(null), evidenceFile);
    expect(result.comments).toHaveLength(1);
    const events = evidenceEvents(result);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ stage: 'evidence_missing', reason: 'absent' });
  });

  it('array existing_code: no parse throw, joined + evidence-checked, comment still posts (CR-01, D-14)', () => {
    // "line(s)" in the prompt invites an ARRAY of strings for multi-line evidence. It must NOT throw
    // the whole-file parse; it is joined by '\n' and evidence-checked against the hunk. Both lines are
    // present in the haystack ("const older = 1;" line 1, "const Value = compute();" line 2), so this
    // is an exact in-hunk match -> NO evidence_missing event, and the finding still posts.
    const result = parseFileReviewResponse(
      rawWith(['const older = 1;', 'const Value = compute();']),
      evidenceFile,
    );
    expect(result.comments).toHaveLength(1);
    expect(evidenceEvents(result)).toHaveLength(0);
    expect(result.comments[0].existingCode).toBe('const older = 1;\nconst Value = compute();');
  });

  it('array existing_code not in hunk: joined + evidence-checked -> not_in_hunk, comment still posts (CR-01)', () => {
    const result = parseFileReviewResponse(
      rawWith(['totallyUnrelated();', 'alsoAbsent();']),
      evidenceFile,
    );
    expect(result.comments).toHaveLength(1);
    const events = evidenceEvents(result);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ stage: 'evidence_missing', reason: 'not_in_hunk' });
  });

  it('number existing_code: no parse throw, degrades to absent, comment still posts (CR-01, D-14)', () => {
    const result = parseFileReviewResponse(rawWith(42), evidenceFile);
    expect(result.comments).toHaveLength(1);
    const events = evidenceEvents(result);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ stage: 'evidence_missing', reason: 'absent' });
    // Non-string scalar coerced to undefined -> parsed comment existingCode is null (schema fail-open).
    expect(result.comments[0].existingCode == null).toBe(true);
  });

  it('object existing_code: no parse throw, degrades to absent, comment still posts (CR-01, D-14)', () => {
    const result = parseFileReviewResponse(rawWith({ some: 'object' }), evidenceFile);
    expect(result.comments).toHaveLength(1);
    const events = evidenceEvents(result);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ stage: 'evidence_missing', reason: 'absent' });
    expect(result.comments[0].existingCode == null).toBe(true);
  });

  it('needle with leading +/- diff markers still matches the (prefix-stripped) hunk (WR-02)', () => {
    // The haystack is built from diff-prefix-stripped hunk content. The model is only ASKED not to add
    // a +/- marker; when it disobeys, each needle line must be stripped so it is normalized the same
    // way -> recognized as in-hunk, NOT a false not_in_hunk.
    const result = parseFileReviewResponse(
      rawWith('-const older = 1;\n+const Value = compute();'),
      evidenceFile,
    );
    expect(result.comments).toHaveLength(1);
    expect(evidenceEvents(result)).toHaveLength(0);
  });

  it('genuinely absent needle still emits not_in_hunk even with a leading diff marker (WR-02)', () => {
    const result = parseFileReviewResponse(rawWith('+someTotallyUnrelatedIdentifier()'), evidenceFile);
    expect(result.comments).toHaveLength(1);
    const events = evidenceEvents(result);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ stage: 'evidence_missing', reason: 'not_in_hunk' });
  });

  it('maps existing_code into the parsed comment existingCode field', () => {
    const result = parseFileReviewResponse(rawWith('const Value = compute();'), evidenceFile);
    expect(result.comments[0].existingCode).toBe('const Value = compute();');
  });

  it('the evidence_missing event carries NO body/diff/existingCode/codeSuggestion (privacy)', () => {
    const result = parseFileReviewResponse(rawWith('someTotallyUnrelatedIdentifier()'), evidenceFile);
    const event = evidenceEvents(result)[0];
    const keys = Object.keys(event);
    expect(keys).not.toContain('body');
    expect(keys).not.toContain('diff');
    expect(keys).not.toContain('existingCode');
    expect(keys).not.toContain('codeSuggestion');
    expect(keys.sort()).toEqual(['line', 'path', 'reason', 'stage', 'timestamp', 'title']);
  });

  it('off-diff finding contributes NO evidence_missing event (checked only after orphan survival)', () => {
    // line 999 is not a valid diff line -> the finding is orphaned (no comment), so no evidence event.
    const raw = JSON.stringify({
      findings: [
        {
          title: 'Off-diff finding',
          body: 'This references a line not in the diff.',
          priority: 2,
          code_location: { absolute_file_path: 'src/evid.ts', line: 999 },
          existing_code: 'not present anywhere',
        },
      ],
      overall_correctness: 'patch is incorrect',
      overall_explanation: 'off diff',
    });
    const result = parseFileReviewResponse(raw, evidenceFile);
    expect(result.comments).toHaveLength(0);
    expect(evidenceEvents(result)).toHaveLength(0);
  });
});

describe('normalizeForEvidence (D-16)', () => {
  it('collapses whitespace runs, trims, and lower-cases', () => {
    expect(normalizeForEvidence('  Foo\n   BAR ')).toBe('foo bar');
  });
});

describe('EVID-01 async-path bounded reconstruction (Task 4, Codex 15-04 HIGH)', () => {
  // pollReviewBatch reconstructs truncateFileDiff(params.file, modelLineCap) before parsing so the
  // evidence haystack never contains code beyond the submitted prefix. This proves the MECHANISM:
  // evidence present ONLY in the truncated-away tail emits not_in_hunk against the bounded file, but
  // would FALSELY pass against the full file.
  const bigFile: FileDiff = {
    path: 'src/big.ts',
    previousPath: null,
    isNew: false,
    isDeleted: false,
    isBinary: false,
    lineCount: 4,
    hunks: [
      {
        header: '@@ -1,4 +1,4 @@',
        lines: [
          { kind: 'add', content: 'const target = risky();', newLineNumber: 1, position: 1 },
          { kind: 'context', content: 'padding line;', newLineNumber: 2, position: 2 },
          { kind: 'context', content: 'const evidenceOnly = secretPattern();', newLineNumber: 3, position: 3 },
          { kind: 'context', content: 'trailing line;', newLineNumber: 4, position: 4 },
        ],
      },
    ],
  };

  // Finding at line 1 (survives the orphan check in BOTH the full and bounded file) whose evidence
  // string lives ONLY on line 3 (beyond a 2-line cap).
  const raw = JSON.stringify({
    findings: [
      {
        title: 'Risky call',
        body: 'The risky call is unguarded.',
        priority: 1,
        code_location: { absolute_file_path: 'src/big.ts', line: 1 },
        existing_code: 'const evidenceOnly = secretPattern();',
      },
    ],
    overall_correctness: 'patch is incorrect',
    overall_explanation: 'issue',
  });

  const evidenceEvents = (r: ReturnType<typeof parseFileReviewResponse>) =>
    r.severityAuditEvents.filter((e) => e.stage === 'evidence_missing');

  it('FULL file: evidence in the tail falsely passes (no not_in_hunk)', () => {
    const result = parseFileReviewResponse(raw, bigFile);
    expect(result.comments).toHaveLength(1);
    expect(evidenceEvents(result)).toHaveLength(0);
  });

  it('BOUNDED file (truncated to the submitted prefix): tail evidence correctly emits not_in_hunk', () => {
    const bounded = truncateFileDiff(bigFile, 2);
    const result = parseFileReviewResponse(raw, bounded);
    expect(result.comments).toHaveLength(1);
    const events = evidenceEvents(result);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ stage: 'evidence_missing', reason: 'not_in_hunk' });
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

// Phase 20 (D-05 reachability): the walkthrough enrichment parser carries malformed-field
// provenance from each field-validation gate. The parser's `parsed` variant reports
// `malformedFields` so the phase can distinguish 'completed' (every supplied field survived)
// from 'partial' (at least one supplied field was malformed). These tests pin that contract —
// the orchestrator's status derivation depends on it.
describe('parseWalkthroughEnrichmentResponse — Phase 20 D-05 malformedFields provenance', () => {
  it('returns empty malformedFields when every supplied field validates', () => {
    const result = parseWalkthroughEnrichmentResponse(JSON.stringify({
      groups: [{ label: 'API', paths: ['src/a.ts'] }],
      confidence: { score: 4, label: 'Looks good', reason: 'r' },
      effort: { level: 2, label: 'Small', minutes: 30 },
    }));
    expect(result.kind).toBe('parsed');
    if (result.kind === 'parsed') {
      expect(result.malformedFields).toEqual([]);
    }
  });

  it('marks a supplied-but-invalid confidence as malformed', () => {
    const result = parseWalkthroughEnrichmentResponse(JSON.stringify({
      groups: [{ label: 'API', paths: ['src/a.ts'] }],
      confidence: { score: 99, label: 'bad' }, // out-of-range score
    }));
    expect(result.kind).toBe('parsed');
    if (result.kind === 'parsed') {
      expect(result.malformedFields).toEqual(['confidence']);
      expect(result.groups).toHaveLength(1);
      expect(result.confidence).toBeNull();
    }
  });

  it('marks a supplied-but-invalid effort as malformed', () => {
    const result = parseWalkthroughEnrichmentResponse(JSON.stringify({
      groups: [{ label: 'API', paths: ['src/a.ts'] }],
      effort: { level: 2, label: 'Small' }, // missing minutes
    }));
    expect(result.kind).toBe('parsed');
    if (result.kind === 'parsed') {
      expect(result.malformedFields).toEqual(['effort']);
      expect(result.effort).toBeNull();
    }
  });

  it('does NOT mark absent fields as malformed when other fields validate', () => {
    const result = parseWalkthroughEnrichmentResponse(JSON.stringify({
      groups: [{ label: 'API', paths: ['src/a.ts'] }],
    }));
    expect(result.kind).toBe('parsed');
    if (result.kind === 'parsed') {
      expect(result.malformedFields).toEqual([]);
    }
  });

  it('keeps groups non-malformed when the array was supplied AND at least one item survived', () => {
    const result = parseWalkthroughEnrichmentResponse(JSON.stringify({
      groups: [
        { label: 'API', paths: ['src/a.ts'] },
        { label: '', paths: [] }, // invalid per the schema
      ],
    }));
    expect(result.kind).toBe('parsed');
    if (result.kind === 'parsed') {
      expect(result.malformedFields).toEqual([]);
      expect(result.groups).toHaveLength(1);
    }
  });

  it('marks groups as malformed when the array was supplied but EVERY item was invalid', () => {
    const result = parseWalkthroughEnrichmentResponse(JSON.stringify({
      groups: [{ label: '' }, 'not-an-object', null], // all invalid
    }));
    expect(result.kind).toBe('fail_open');
    if (result.kind === 'fail_open') {
      expect(result.reason).toBe('all_fields_invalid');
    }
  });

  it('marks a wrong-shape groups (non-array) as malformed', () => {
    const result = parseWalkthroughEnrichmentResponse(JSON.stringify({
      groups: 'not-an-array',
    }));
    expect(result.kind).toBe('fail_open');
    if (result.kind === 'fail_open') {
      expect(result.reason).toBe('all_fields_invalid');
    }
  });

  it('returns fail_open on non-object root', () => {
    expect(parseWalkthroughEnrichmentResponse('[1, 2, 3]')).toEqual({
      kind: 'fail_open',
      reason: 'json_not_object',
    });
  });
});
