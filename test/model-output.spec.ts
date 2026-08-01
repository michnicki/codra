import { parseCriticPruneResponse, parseFileReviewResponse, parseWalkthroughDiagram, parseWalkthroughEnrichmentResponse } from '@server/core/model-output';
import { normalizeForEvidence } from '@server/core/evidence';
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

describe('FR-153/FR-154 parse normalization (PRD-02)', () => {
  // Same shape as the parent describe's mockFile (hunk line 2 = the add line "new line", position
  // 2) so a finding anchored at line 2 survives the orphan check and becomes a persisted comment.
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

  const dropEvents = (r: ReturnType<typeof parseFileReviewResponse>) =>
    r.severityAuditEvents.filter((e) => e.stage === 'suggestion_dropped');

  const rawWith = (finding: Record<string, unknown>) =>
    JSON.stringify({
      findings: [{ ...finding, code_location: finding.code_location ?? { absolute_file_path: 'test.ts', line: 2 } }],
      overall_correctness: 'patch is incorrect',
      overall_explanation: 'Found an issue',
    });

  it('suggestion == existingCode clears codeSuggestion to null and strips the fence from the body (D-06)', () => {
    const result = parseFileReviewResponse(
      rawWith({ title: 'finding', body: 'the issue', priority: 1, code_suggestion: 'same', existing_code: 'same' }),
      mockFile,
    );
    expect(result.comments).toHaveLength(1);
    expect(result.comments[0].codeSuggestion).toBeNull();
    expect(result.comments[0].body).not.toContain('```suggestion');
    expect(result.comments[0].body).toBe('the issue');
  });

  it('a FENCED suggestion identical to existingCode still clears (D-07 — the fence cannot dodge the check)', () => {
    const result = parseFileReviewResponse(
      rawWith({
        title: 'finding',
        body: 'the issue',
        priority: 1,
        code_suggestion: '```suggestion\nsame\n```',
        existing_code: 'same',
      }),
      mockFile,
    );
    expect(result.comments).toHaveLength(1);
    expect(result.comments[0].codeSuggestion).toBeNull();
    expect(result.comments[0].body).not.toContain('```suggestion');
    expect(result.comments[0].body).toBe('the issue');
  });

  it('a suggestion differing from existingCode stays unchanged with the fence intact', () => {
    const result = parseFileReviewResponse(
      rawWith({ title: 'finding', body: 'the issue', priority: 1, code_suggestion: 'x', existing_code: 'y' }),
      mockFile,
    );
    expect(result.comments).toHaveLength(1);
    expect(result.comments[0].codeSuggestion).toBe('x');
    expect(result.comments[0].body).toContain('```suggestion');
  });

  it('non-empty suggestion + whitespace-only body drops the comment and audits suggestion_dropped (D-05/D-08)', () => {
    const result = parseFileReviewResponse(
      rawWith({ title: 'finding', body: '   ', priority: 1, code_suggestion: 'x' }),
      mockFile,
    );
    expect(result.comments).toHaveLength(0);
    const events = dropEvents(result);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ stage: 'suggestion_dropped', droppedCount: 1 });
  });

  // CR-01: the body-prefix de-duplication strip erased the ENTIRE body whenever the body opened by
  // restating its title (cleanText flattens newlines, so `body.split('\n')[0]` IS the whole body).
  // The FR-153 drop clause then read that erased value and deleted a complete, on-diff finding with
  // an actionable suggestion — invisible in the PR, absent from the orphan bucket, and
  // unidentifiable in the audit trail (redactFindingTitle collapses every title to a fixed marker).
  // The whitespace-only-body test above never exercised this path.
  it('a title-echoing body + a code_suggestion still POSTS — the strip never empties the body (CR-01)', () => {
    const result = parseFileReviewResponse(
      rawWith({
        title: 'Missing null check on user input',
        body: 'Missing null check on user input. This can crash the worker when req.body is undefined. Add a guard.',
        priority: 1,
        code_suggestion: 'if (!req.body) return;',
      }),
      mockFile,
    );

    expect(result.comments).toHaveLength(1);
    // The finding is NOT audit-dropped: the model DID supply an explanation.
    expect(dropEvents(result)).toHaveLength(0);
    // The surviving body keeps the model's explanation and carries the suggestion fence.
    expect(result.comments[0].body).toContain('crash the worker');
    expect(result.comments[0].body).toContain('```suggestion');
    expect(result.comments[0].codeSuggestion).toBe('if (!req.body) return;');
  });

  it('a title-echoing body with NO suggestion also keeps its body rather than emptying it (CR-01)', () => {
    const result = parseFileReviewResponse(
      rawWith({ title: 'Missing null check', body: 'Missing null check', priority: 1 }),
      mockFile,
    );

    expect(result.comments).toHaveLength(1);
    expect(result.comments[0].body).toBe('Missing null check');
  });

  it('a body that merely PREFIXES the title still strips down to the remainder (strip preserved)', () => {
    const result = parseFileReviewResponse(
      rawWith({ title: 'finding', body: 'finding\nthe real explanation', priority: 1 }),
      mockFile,
    );

    expect(result.comments).toHaveLength(1);
    // cleanText flattens the newline, so the whole line is the prefix and stripping it would empty
    // the body — the CR-01 guard keeps the full text instead of deleting the explanation.
    expect(result.comments[0].body).toContain('the real explanation');
  });

  it('code_suggestion: "" is treated as absent — the per-file parse never throws (fail-open hardening)', () => {
    const result = parseFileReviewResponse(
      rawWith({ title: 'finding', body: 'the issue', priority: 1, code_suggestion: '' }),
      mockFile,
    );
    expect(result.comments).toHaveLength(1);
    expect(result.comments[0].codeSuggestion).toBeUndefined();
  });

  it('code_suggestion: "   " (whitespace-only) is also treated as absent', () => {
    const result = parseFileReviewResponse(
      rawWith({ title: 'finding', body: 'the issue', priority: 1, code_suggestion: '   ' }),
      mockFile,
    );
    expect(result.comments).toHaveLength(1);
    expect(result.comments[0].codeSuggestion).toBeUndefined();
  });

  it('an 81-char title truncates to exactly 80 chars; an exactly-80-char title is unchanged (D-09/D-10)', () => {
    const longTitle = 'A'.repeat(81);
    const result = parseFileReviewResponse(
      rawWith({ title: longTitle, body: 'the issue', priority: 1 }),
      mockFile,
    );
    expect(result.comments).toHaveLength(1);
    expect(result.comments[0].title).toHaveLength(80);
    expect(result.comments[0].title).toBe(longTitle.slice(0, 80));

    const exactly80 = 'B'.repeat(80);
    const result80 = parseFileReviewResponse(
      rawWith({ title: exactly80, body: 'the issue', priority: 1 }),
      mockFile,
    );
    expect(result80.comments[0].title).toBe(exactly80);
  });

  it('truncation happens AFTER the severity/category engine saw the full title (D-10)', () => {
    const longTitle = 'A'.repeat(81);
    const longResult = parseFileReviewResponse(
      rawWith({ title: longTitle, body: 'the issue', priority: 1 }),
      mockFile,
    );
    const shortResult = parseFileReviewResponse(
      rawWith({ title: longTitle.slice(0, 80), body: 'the issue', priority: 1 }),
      mockFile,
    );
    expect(longResult.comments[0].severity).toBe(shortResult.comments[0].severity);
    expect(longResult.comments[0].category).toBe(shortResult.comments[0].category);
  });

  it('an off-diff 81-char title lands in the orphan bucket truncated to 80 chars (D-11)', () => {
    const longTitle = 'A'.repeat(81);
    const result = parseFileReviewResponse(
      rawWith({ title: longTitle, body: 'the issue', priority: 1, code_location: { absolute_file_path: 'test.ts', line: 999 } }),
      mockFile,
    );
    expect(result.comments).toHaveLength(0);
    expect(result.fileSummary).toContain(longTitle.slice(0, 80));
    // The 81-char full title must NOT appear — the orphan entry carries exactly the truncated form.
    expect(result.fileSummary).not.toContain(longTitle);
  });

  it('an off-diff title with a QUALITY: prefix strips the prefix before truncation (consensus fold-in (c))', () => {
    const result = parseFileReviewResponse(
      rawWith({
        title: `QUALITY: ${'A'.repeat(81)}`,
        body: 'the issue',
        priority: 1,
        code_location: { absolute_file_path: 'test.ts', line: 999 },
      }),
      mockFile,
    );
    expect(result.comments).toHaveLength(0);
    // cleanText strips the QUALITY: prefix, then slice(0, 80) applies to the cleaned title.
    expect(result.fileSummary).toContain('A'.repeat(80));
    expect(result.fileSummary).not.toContain('QUALITY');
  });

  it('a clean finding round-trips byte-identically (NREG-01, REVIEWS R12)', () => {
    const result = parseFileReviewResponse(
      rawWith({ title: 'finding', body: 'the issue', priority: 1 }),
      mockFile,
    );
    expect(result.comments).toEqual([
      {
        path: 'test.ts',
        line: 2,
        position: 2,
        severity: 'P1',
        category: 'correctness',
        title: 'finding',
        body: 'the issue',
        codeSuggestion: undefined,
        existingCode: null,
        confidence: undefined,
      },
    ]);
    expect(dropEvents(result)).toHaveLength(0);
  });
});

describe('EVID-01/EVID-03 soft evidence gate (evidence_missing_summary aggregate)', () => {
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
    r.severityAuditEvents.filter((e) => e.stage === 'evidence_missing_summary');

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

  it('non-substring evidence: one evidence_missing_summary with not_in_hunk entry, comment still posts', () => {
    const result = parseFileReviewResponse(rawWith('someTotallyUnrelatedIdentifier()'), evidenceFile);
    expect(result.comments).toHaveLength(1);
    const events = evidenceEvents(result);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ stage: 'evidence_missing_summary', notInHunkCount: 1, file: 'src/evid.ts' });
  });

  it('BLOCKER 1 (D-06): evidence_missing_summary redacts sample title without changing parsed finding', () => {
    const result = parseFileReviewResponse(rawWith('someTotallyUnrelatedIdentifier()'), evidenceFile);
    expect(result.comments).toHaveLength(1);
    expect(result.comments[0].title).toBe('Uses computed value');
    const events = evidenceEvents(result);
    expect(events).toHaveLength(1);
    expect(events[0].sample[0].title).toBe('[title-redacted]');
    expect(events[0].sample[0].title).not.toBe(result.comments[0].title);
    expect(events[0].sample[0].title).not.toContain(result.comments[0].title);
  });

  it('omitted existing_code: one evidence_missing_summary with absent entry, comment still posts', () => {
    const result = parseFileReviewResponse(rawWith('__OMIT__'), evidenceFile);
    expect(result.comments).toHaveLength(1);
    const events = evidenceEvents(result);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ stage: 'evidence_missing_summary', absentCount: 1 });
  });

  it('empty-string existing_code: one evidence_missing_summary with absent entry, comment still posts', () => {
    const result = parseFileReviewResponse(rawWith('   '), evidenceFile);
    expect(result.comments).toHaveLength(1);
    expect(evidenceEvents(result)).toEqual([
      expect.objectContaining({ stage: 'evidence_missing_summary', absentCount: 1 }),
    ]);
  });

  it('JSON null existing_code: no parse throw, comment still posts, one evidence_missing_summary with absent entry', () => {
    // Codex 15-01 HIGH: existing_code is nullable().optional(), so a JSON null must NOT throw the
    // per-file parse before the evidence check runs.
    const result = parseFileReviewResponse(rawWith(null), evidenceFile);
    expect(result.comments).toHaveLength(1);
    const events = evidenceEvents(result);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ stage: 'evidence_missing_summary', absentCount: 1 });
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
    expect(events[0]).toMatchObject({ stage: 'evidence_missing_summary', notInHunkCount: 1 });
  });

  it('number existing_code: no parse throw, degrades to absent, comment still posts (CR-01, D-14)', () => {
    const result = parseFileReviewResponse(rawWith(42), evidenceFile);
    expect(result.comments).toHaveLength(1);
    const events = evidenceEvents(result);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ stage: 'evidence_missing_summary', absentCount: 1 });
    // Non-string scalar coerced to undefined -> parsed comment existingCode is null (schema fail-open).
    expect(result.comments[0].existingCode == null).toBe(true);
  });

  it('object existing_code: no parse throw, degrades to absent, comment still posts (CR-01, D-14)', () => {
    const result = parseFileReviewResponse(rawWith({ some: 'object' }), evidenceFile);
    expect(result.comments).toHaveLength(1);
    const events = evidenceEvents(result);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ stage: 'evidence_missing_summary', absentCount: 1 });
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
    expect(events[0]).toMatchObject({ stage: 'evidence_missing_summary', notInHunkCount: 1 });
  });

  it('maps existing_code into the parsed comment existingCode field', () => {
    const result = parseFileReviewResponse(rawWith('const Value = compute();'), evidenceFile);
    expect(result.comments[0].existingCode).toBe('const Value = compute();');
  });

  it('the evidence_missing_summary event carries NO body/diff/existingCode/codeSuggestion (privacy)', () => {
    const result = parseFileReviewResponse(rawWith('someTotallyUnrelatedIdentifier()'), evidenceFile);
    const event = evidenceEvents(result)[0];
    const keys = Object.keys(event);
    expect(keys).not.toContain('body');
    expect(keys).not.toContain('diff');
    expect(keys).not.toContain('existingCode');
    expect(keys).not.toContain('codeSuggestion');
    expect(keys.sort()).toEqual(['absentCount', 'file', 'notInHunkCount', 'pass', 'sample', 'stage', 'timestamp']);
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

  it('multiple findings: both absent and not_in_hunk produce aggregate with correct counts and ordered sample', () => {
    const multiRaw = JSON.stringify({
      findings: [
        { title: 'No evidence', body: 'x', priority: 2, code_location: { absolute_file_path: 'src/evid.ts', line: 2 }, existing_code: '   ' },
        { title: 'Wrong evidence', body: 'y', priority: 3, code_location: { absolute_file_path: 'src/evid.ts', line: 5 }, existing_code: 'someTotallyUnrelatedIdentifier()' },
      ],
      overall_correctness: 'patch is incorrect',
      overall_explanation: 'Issues found',
      overall_confidence_score: 0.8,
    });
    const result = parseFileReviewResponse(multiRaw, evidenceFile);
    expect(result.comments).toHaveLength(2);
    const events = evidenceEvents(result);
    expect(events).toHaveLength(1);
    expect(events[0].absentCount).toBe(1);
    expect(events[0].notInHunkCount).toBe(1);
    expect(events[0].sample[0].reason).toBe('absent');
    expect(events[0].sample[1].reason).toBe('not_in_hunk');
  });

  it('evidence_missing_summary sample entry carries the original model-cited line, not the orphan-remap line (EVID-04)', () => {
    // Model cites line 5, which is outside valid diff lines {1,2,3}. The orphan remap moves it to the
    // closest valid line (3), so the finding survives the orphan check. The evidence_missing_summary
    // sample must carry the ORIGINAL line (5), NOT the remapped line (3), while the comment itself
    // uses the remapped line (proving remap logic is untouched).
    const raw = JSON.stringify({
      findings: [
        {
          title: 'Off-diff evidence',
          body: 'This finding cites a line just outside the diff.',
          priority: 2,
          code_location: { absolute_file_path: 'src/evid.ts', line: 5 },
          existing_code: '   ',
        },
      ],
      overall_correctness: 'patch is incorrect',
      overall_explanation: 'Found an issue',
    });
    const result = parseFileReviewResponse(raw, evidenceFile);
    expect(result.comments).toHaveLength(1);
    // Comment line is remapped (orphan remap is untouched per D-01)
    expect(result.comments[0].line).toBe(3);
    const events = evidenceEvents(result);
    expect(events).toHaveLength(1);
    expect(events[0].sample).toHaveLength(1);
    // Sample entry carries the original model-cited line (5), not the remapped line (3)
    expect(events[0].sample[0].line).toBe(5);
    expect(events[0].sample[0].reason).toBe('absent');
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
    r.severityAuditEvents.filter((e) => e.stage === 'evidence_missing_summary');

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
    expect(events[0]).toMatchObject({ stage: 'evidence_missing_summary', notInHunkCount: 1 });
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

  // --- Phase 33 (FR-155, PRD-03): sanitizeMermaidLabels nested-quote repair ---

  it('repairs the canonical nested-quote label in a bare payload (FR-155, D-12)', () => {
    const out = parseWalkthroughDiagram('sequenceDiagram\n  participant engine["core/"engine.py""]\n  A->>B: hi');
    noFence(out);
    expect(out).toBe('sequenceDiagram\n  participant engine["core/engine.py"]\n  A->>B: hi');
  });

  it('repairs the canonical nested-quote label inside a ```mermaid fence (fence unwrap runs first)', () => {
    const out = parseWalkthroughDiagram(
      '```mermaid\nsequenceDiagram\n  participant engine["core/"engine.py""]\n  A->>B: hi\n```',
    );
    noFence(out);
    expect(out).toBe('sequenceDiagram\n  participant engine["core/engine.py"]\n  A->>B: hi');
  });

  it('returns a repaired broken-label-only diagram instead of omitting it (D-14)', () => {
    const out = parseWalkthroughDiagram('sequenceDiagram\n  participant engine["core/"engine.py""]');
    noFence(out);
    expect(out).toContain('engine["core/engine.py"]');
  });

  it('leaves message-quote text untouched (NREG-01, D-13)', () => {
    const out = parseWalkthroughDiagram('sequenceDiagram\n  A->>B: say "hi"');
    noFence(out);
    expect(out).toBe('sequenceDiagram\n  A->>B: say "hi"');
  });

  it('round-trips a clean multi-label line byte-identically (NREG-01, REVIEWS R7)', () => {
    const out = parseWalkthroughDiagram('sequenceDiagram\n  A["x"]->>B["y"]');
    noFence(out);
    expect(out).toBe('sequenceDiagram\n  A["x"]->>B["y"]');
  });

  it('strips interior quotes inside a label token (A["x"y"z"] -> A["xyz"])', () => {
    const out = parseWalkthroughDiagram('sequenceDiagram\n  A["x"y"z"]->>B');
    noFence(out);
    expect(out).toBe('sequenceDiagram\n  A["xyz"]->>B');
  });

  it('copies an unterminated label token verbatim without hanging or crashing (REVIEWS R7)', () => {
    const out = parseWalkthroughDiagram('sequenceDiagram\n  A["unterminated');
    noFence(out);
    expect(out).toBe('sequenceDiagram\n  A["unterminated');
  });

  it('does not close a label token on a ] inside the label text (consensus fold-in (b))', () => {
    const out = parseWalkthroughDiagram('sequenceDiagram\n  A["file]name"]');
    noFence(out);
    expect(out).toBe('sequenceDiagram\n  A["file]name"]');
  });

  it('strips an interior quote while keeping an interior ] (A["x"y]z"] -> A["xy]z"])', () => {
    const out = parseWalkthroughDiagram('sequenceDiagram\n  A["x"y]z"]');
    noFence(out);
    expect(out).toBe('sequenceDiagram\n  A["xy]z"]');
  });

  // WR-02: the close-scan must stop at the end of the current line. Before the fix an
  // unterminated `["` in note/message prose consumed everything up to the NEXT line's `"]`
  // and rewrote a previously-VALID label (A["alpha"] -> A[alpha"]), turning a repairable
  // diagram into a broken one -- the opposite of FR-155's purpose.
  it('does not let an unterminated token on one line corrupt a valid label on the next (WR-02)', () => {
    const out = parseWalkthroughDiagram(
      'sequenceDiagram\n  Note over A: see cfg["key\n  A["alpha"] ->> B["beta"]: go',
    );
    noFence(out);
    expect(out).toBe('sequenceDiagram\n  Note over A: see cfg["key\n  A["alpha"] ->> B["beta"]: go');
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

  // Phase 20.1 (D-13 verification): when the model returns a partial result with 1 valid group,
  // a malformed confidence object, and a valid effort object, the parser attributes the
  // `malformedFields` to the ACTUALLY malformed field (confidence) and keeps the valid fields
  // (groups + effort). This pins the contract that the parser does NOT conflate per-field
  // validation with whole-group classification — the audit's "groups malformed when zero items
  // survive" claim is the correct narrow check, not a blanket "all groups failed" gate.
  it('attributes malformedFields to the actually-invalid field in a mixed valid + invalid case', () => {
    const result = parseWalkthroughEnrichmentResponse(JSON.stringify({
      groups: [{ label: 'API', paths: ['src/a.ts'] }],
      // confidence object with wrong shape (level is required, missing here) — invalid
      confidence: { label: 'unsure' },
      effort: { level: 2, label: 'Small', minutes: 30 },
    }));
    expect(result.kind).toBe('parsed');
    if (result.kind === 'parsed') {
      expect(result.malformedFields).toEqual(['confidence']);
      expect(result.groups).toHaveLength(1);
      expect(result.confidence).toBeNull();
      expect(result.effort).not.toBeNull();
    }
  });
});
