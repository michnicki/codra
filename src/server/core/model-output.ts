import { criticPruneOutputSchema, fileReviewModelOutputSchema, parsedReviewCommentSchema, summaryModelOutputSchema, type ParsedReviewComment, type JobAuditEvent, reviewSeverities } from '@shared/schema';
import { z } from 'zod';
import { logger } from './logger';
import { applySeverityRules } from './severity';
import { clampAuditTitle } from './audit';
import { findClosestValidLine, findPositionForLine, getValidNewLines, getValidPositions } from './diff';
import type { FileDiff } from './diff';
import { jsonrepair } from 'jsonrepair';

const MAX_LOGGED_JSON_CHARS = 2_000;

function truncateJsonForLog(value: string) {
  if (value.length <= MAX_LOGGED_JSON_CHARS) return value;
  return `${value.slice(0, MAX_LOGGED_JSON_CHARS)}... [truncated ${value.length - MAX_LOGGED_JSON_CHARS} chars]`;
}

function hasReviewKeys(input: string) {
  return /"(findings|overall_explanation|overall_correctness|overall_confidence_score|summary)"\s*:/.test(input);
}

function extractJson(raw: string) {
  // 1. Try to find explicit JSON blocks first (most reliable)
  const jsonBlocks = Array.from(raw.matchAll(/```json\s*([\s\S]*?)```/gi));
  if (jsonBlocks.length > 0) {
    return jsonBlocks[jsonBlocks.length - 1][1].trim();
  }

  // 2. Fallback to generic code blocks - must contain a JSON-like structure
  const genericBlocks = Array.from(raw.matchAll(/```(?:[\w+-]+)?\s*([\s\S]*?)```/gi));
  if (genericBlocks.length > 0) {
    const candidates = genericBlocks.filter(b => b[1].includes('{') && b[1].includes('}') && hasReviewKeys(b[1]));
    if (candidates.length > 0) {
      const content = candidates[candidates.length - 1][1].trim();
      // Try to find the actual object inside the code block
      const start = content.indexOf('{');
      const end = content.lastIndexOf('}');
      if (start !== -1 && end !== -1 && end > start) {
        return content.slice(start, end + 1);
      }
      return content;
    }
  }

  // 3. Robust "Outer Brace" extraction
  // Find the first '{' and then match braces to find the corresponding '}'
  // We prioritize blocks that look like our expected JSON
  const findingsIdx = raw.indexOf('"findings"');
  const summaryIdx = raw.indexOf('"summary"');
  const targetIdx = findingsIdx !== -1 ? findingsIdx : (summaryIdx !== -1 ? summaryIdx : -1);

  let firstBrace = -1;
  if (targetIdx !== -1) {
    // Try to find the brace that opens the object containing the keyword
    firstBrace = raw.lastIndexOf('{', targetIdx);
  }

  // If no keyword found, search for generic brace blocks and score them
  if (firstBrace === -1) {
    const allBraces = Array.from(raw.matchAll(/\{/g));
    let bestIdx = -1;
    let bestScore = -1;

    for (const match of allBraces) {
      const idx = match.index!;
      const excerpt = raw.slice(idx, idx + 200);
      let score = 0;

      // Keywords are strong indicators
      if (excerpt.includes('"findings"')) score += 100;
      if (excerpt.includes('"summary"')) score += 50;
      if (excerpt.includes('"overall_explanation"')) score += 50;

      // JSON structure indicators
      if (excerpt.includes('" : ') || excerpt.includes('":')) score += 10;
      if (excerpt.includes('"[')) score += 5;

      // Anti-indicators (looks like code, not our JSON)
      if (excerpt.includes(': number;') || excerpt.includes(': string;')) score -= 80;
      if (excerpt.includes('export ') || excerpt.includes('function ')) score -= 80;
      if (excerpt.includes('interface ') || excerpt.includes('type ')) score -= 80;
      if (excerpt.includes(' + ')) score -= 20; // Looks like a diff hunk

      if (score > bestScore) {
        bestScore = score;
        bestIdx = idx;
      }
    }

    if (bestIdx !== -1 && bestScore > 0) {
      firstBrace = bestIdx;
    }
  }

  // Final fallback to the very first brace if we're desperate and it looks like JSON
  if (firstBrace === -1) {
    const start = raw.indexOf('{');
    if (start !== -1) {
      const excerpt = raw.slice(start, start + 50);
      if (excerpt.includes('"') && excerpt.includes(':')) {
        firstBrace = start;
      }
    }
  }

  if (firstBrace !== -1) {
    let stack = 0;
    let inString = false;
    let escape = false;

    for (let i = firstBrace; i < raw.length; i++) {
      const char = raw[i];

      if (escape) {
        escape = false;
        continue;
      }

      if (char === '\\') {
        escape = true;
        continue;
      }

      if (char === '"') {
        inString = !inString;
        continue;
      }

      if (!inString) {
        if (char === '{') stack++;
        else if (char === '}') {
          stack--;
          if (stack === 0) {
            return raw.slice(firstBrace, i + 1);
          }
        }
      }
    }

    // Truncated JSON: the closing brace(s) are missing. Append them so jsonrepair
    // has a structurally complete (though incomplete-content) object to work with.
    const partial = raw.slice(firstBrace).trim();
    let closing = '';
    if (inString) closing += '"';
    closing += '}'.repeat(Math.max(1, stack));
    return `${partial}${closing}`;
  }

  return raw.trim();
}

function isPlaceholderString(value: unknown) {
  return typeof value === 'string' && /^<[^>]+>$/.test(value.trim());
}

function coerceReviewNumber(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && !isPlaceholderString(value)) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

// CR-01 (D-14 fail-open): the file-review/security-review prompts ask the model to quote the "exact
// unchanged original line(s)" in `existing_code`. "line(s)" invites a model to return an ARRAY of
// strings (or, less often, a number/object) for multi-line evidence. But fileReviewModelOutputSchema
// types existing_code as z.string().nullable().optional(), so a non-string-non-null value would throw
// a ZodError in fileReviewModelOutputSchema.parse — rethrown as 'Response schema mismatch', aborting
// the parse of the WHOLE file and losing EVERY finding for it. That breaks EVID-01's soft-gate
// guarantee that findings must ALWAYS still post. Coerce here so the value can never fail validation:
//   string  -> keep as-is
//   Array   -> keep only string elements, joined by '\n' (multi-line array evidence stays checkable)
//   null    -> keep null (schema allows; flows to the `absent` telemetry branch)
//   else    -> undefined (number/object/boolean -> `absent`, never a parse throw)
function coerceExistingCode(value: unknown): string | null | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.filter((x): x is string => typeof x === 'string').join('\n');
  if (value === null) return null;
  return undefined;
}

function normalizeFinding(finding: unknown) {
  if (!finding || typeof finding !== 'object') return null;
  const f = finding as Record<string, unknown>;
  if (isPlaceholderString(f.title) || isPlaceholderString(f.body)) return null;

  const location = f.code_location && typeof f.code_location === 'object' ? (f.code_location as Record<string, unknown>) : {};
  const line = coerceReviewNumber(location.line);
  const start = coerceReviewNumber(location.line_range && typeof location.line_range === 'object' ? (location.line_range as Record<string, unknown>).start : undefined);
  const end = coerceReviewNumber(location.line_range && typeof location.line_range === 'object' ? (location.line_range as Record<string, unknown>).end : undefined);
  const priority = coerceReviewNumber(f.priority);

  const codeLocation: Record<string, unknown> = {
    absolute_file_path: location.absolute_file_path || f.path || '',
  };
  if (line !== undefined) {
    codeLocation.line = Math.trunc(line as number);
  }
  if (start !== undefined || end !== undefined) {
    codeLocation.line_range = {
      start: Math.trunc((start as number) ?? (end as number)!),
      end: Math.trunc((end as number) ?? (start as number)!),
    };
  }

  return {
    ...f,
    title: f.title || 'Code finding',
    priority: priority === undefined ? undefined : Math.max(0, Math.min(3, Math.trunc(priority as number))),
    // CR-01: coerce so a non-string existing_code (array/number/object) can never fail schema
    // validation and abort the whole-file parse (D-14 fail-open).
    existing_code: coerceExistingCode(f.existing_code),
    code_location: codeLocation,
    confidence_score: typeof f.confidence_score === 'number'
      ? Math.max(0, Math.min(1, f.confidence_score > 1 ? f.confidence_score / 10 : f.confidence_score))
      : undefined,
  };
}

/**
 * Pre-processes JSON string to handle common LLM defects before passing to jsonrepair.
 * Optimized for CPU performance (avoids backtracking regexes).
 */
function preprocessJson(json: string): string {
  let result = '';
  let inString = false;
  let escape = false;

  for (let i = 0; i < json.length; i++) {
    const char = json[i];

    if (escape) {
      result += char;
      escape = false;
      continue;
    }

    if (char === '\\') {
      result += char;
      escape = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      result += char;
      continue;
    }

    if (inString) {
      if (char === '\n') {
        result += '\\n';
      } else if (char === '\r') {
        result += '\\r';
      } else {
        result += char;
      }
    } else {
      result += char;
    }
  }

  return result;
}

/**
 * Normalizer for the soft evidence gate (EVID-01, D-16). Collapses every whitespace run to a single
 * space, trims, AND lower-cases — the substring match is therefore whitespace- AND case-INSENSITIVE,
 * so trivial `Const` vs `const` / indentation differences do NOT inflate the `not_in_hunk` count and
 * pollute the EVID-02 go/no-go signal (OpenCode C4 / Antigravity). No Unicode normalization.
 *
 * This is DELIBERATELY NOT `cleanText` (D-16 Anti-Pattern): cleanText strips leading tag/emoji
 * prefixes (SECURITY/BUG/P0/…), which are meaningless for diff-line evidence and would corrupt the
 * haystack/needle comparison. Never reuse cleanText here.
 */
export function normalizeForEvidence(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

function withSuggestion(body: string, codeSuggestion?: string) {
  if (!codeSuggestion) return body;

  // Clean suggestion: remove existing fences if model added them, and trim
  const cleanSuggestion = codeSuggestion.replace(/```suggestion\n?|```/g, '').trim();

  // Clean body: remove any trailing redundant suggestion blocks if the model double-outputted
  const cleanBody = body.split('```suggestion')[0].trim();

  return `${cleanBody}\n\n\`\`\`suggestion\n${cleanSuggestion}\n\`\`\``;
}

export function parseFileReviewResponse(
  raw: string,
  file: FileDiff,
  opts: { pass?: 'main' | 'security'; severityEngineEnabled?: boolean } = {},
): {
  comments: ParsedReviewComment[];
  verdict: 'approve' | 'comment';
  fileSummary: string;
  overallCorrectness?: string;
  confidenceScore?: number;
  severityAuditEvents: JobAuditEvent[];
} {
  let extracted = '';
  try {
    extracted = extractJson(raw);
    if (!hasReviewKeys(extracted)) {
      throw new Error('Model response did not contain review JSON keys.');
    }
  } catch (e) {
    // Log a prefix of the raw response so we can diagnose what the model returned
    // without bloating logs with 10k+ char dumps.
    logger.error('Failed to extract JSON from model response', {
      rawLength: raw.length,
      rawPrefix: raw.slice(0, 500),
      error: e instanceof Error ? e.message : String(e),
    });
    throw new Error('Could not find JSON root in model response.');
  }

  let preprocessed = '';
  try {
    preprocessed = preprocessJson(extracted);
  } catch (e) {
    logger.warn('JSON preprocessing partially failed, continuing...', { extracted, error: e });
    preprocessed = extracted;
  }

  let repaired = preprocessed;
  try {
    repaired = jsonrepair(preprocessed);
  } catch (e) {
    logger.warn('jsonrepair failed to fix model output, using preprocessed text', { preprocessed: truncateJsonForLog(preprocessed), error: e });
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(repaired);
  } catch (e) {
    logger.error('Critical JSON parse error after extraction and repair', { repaired: truncateJsonForLog(repaired), error: e });
    throw new Error(`Invalid JSON format: ${e instanceof Error ? e.message : 'Unknown error'}`);
  }

  let parsed: z.infer<typeof fileReviewModelOutputSchema>;
  try {
    const findReviewObject = (arr: unknown[]): unknown | null => {
      // Priority 1: Has findings array and summary
      const best = arr.find(i => i && typeof i === 'object' && Array.isArray((i as Record<string, unknown>).findings) && typeof (i as Record<string, unknown>).summary === 'string');
      if (best) return best;

      // Priority 2: Has findings array
      const good = arr.find(i => i && typeof i === 'object' && Array.isArray((i as Record<string, unknown>).findings));
      if (good) return good;

      // Priority 3: Has review-like keys
      return arr.find(i =>
        i && typeof i === 'object' &&
        ('findings' in i || 'overall_explanation' in i || 'summary' in i || 'overall_correctness' in i)
      );
    };

    let data = Array.isArray(parsedJson) ? (findReviewObject(parsedJson) || parsedJson[0] || {}) : parsedJson;

    // Ensure essential keys exist to avoid schema validation errors
    if (data && typeof data === 'object') {
      const obj = data as Record<string, unknown>;
      if (!obj.findings) obj.findings = [];
      if (!obj.overall_explanation) obj.overall_explanation = 'No explanation provided.';
      if (!obj.overall_correctness) obj.overall_correctness = 'Uncertain';

      // Handle confidence score hallucinations (0-1 range expected)
      if (typeof obj.overall_confidence_score === 'number') {
        if (obj.overall_confidence_score > 1) {
          // If they gave 1-10 scale, normalize it
          obj.overall_confidence_score = Math.min(obj.overall_confidence_score / 10, 1);
        } else if (obj.overall_confidence_score < 0) {
          obj.overall_confidence_score = 0;
        }
      } else {
        obj.overall_confidence_score = 0.5;
      }

      if (Array.isArray(obj.findings)) {
        obj.findings = obj.findings.map(normalizeFinding).filter(Boolean);
      }
      data = obj;
    }

    parsed = fileReviewModelOutputSchema.parse(data);
  } catch (e) {
    logger.error('Model response failed schema validation', { parsedJson, error: e });
    throw new Error(`Response schema mismatch: ${e instanceof Error ? e.message : 'Check logs'}`);
  }

  const validLines = getValidNewLines(file);
  const validPositions = getValidPositions(file);

  const orphanedComments: string[] = [];
  // Accumulate the severity engine's audit events across every finding this call produces. Only
  // findings that survive the orphan check (i.e. become a persisted comment) contribute events, so
  // the trail never references a dropped, off-diff finding.
  const severityAuditEvents: JobAuditEvent[] = [];

  // EVID-01 soft evidence gate (D-16). Build the cleaned-hunk haystack ONCE for this file: concat of
  // ALL hunk lines (context + add + del) content — hunk `content` is already diff-prefix-stripped
  // (diff.ts) — then normalizeForEvidence. Per surviving finding, we test whether its normalized
  // existing_code is a substring of this haystack. This is audit-only (D-14): a miss NEVER drops or
  // penalizes the finding, it only emits an `evidence_missing` telemetry event.
  const evidenceHaystack = normalizeForEvidence(
    file.hunks.flatMap((h) => h.lines).map((l) => l.content).join('\n'),
  );

  const comments = (parsed.findings || [])
    .map((finding) => {
      // Codex style findings use start/end or line
      let line = finding.code_location.line || finding.code_location.line_range?.start;
      let position: number | undefined;

      // Try to find position for the line
      if (line !== undefined) {
        // Find if the line exists in the diff
        if (!validLines.has(line)) {
          const closest = findClosestValidLine(file, line);
          if (closest !== undefined) {
            line = closest;
          } else {
            line = undefined;
          }
        }

        if (line !== undefined) {
          position = findPositionForLine(file, line);
        }
      }

      // Final validation
      if (position === undefined || !validPositions.has(position)) {
        orphanedComments.push(`- **${finding.title}:** ${finding.body}`);
        return null;
      }

      // Map priority to severity
      const priorityMap: Record<number, typeof reviewSeverities[number]> = {
        0: 'P0',
        1: 'P1',
        2: 'P2',
        3: 'P3'
      };
      const severity = finding.priority !== undefined ? priorityMap[finding.priority] || 'P2' : 'P2';

      const cleanText = (text: string) => {
        let current = text.trim();
        let prev = '';
        while (current !== prev) {
          prev = current;
          current = current
            .replace(/^(?:[^\w\s]+|(?:QUALITY|SECURITY|BUG|PERFORMANCE|CORRECTNESS|P[0-3]|NIT)\b)+/giu, '')
            .replace(/\n\s*/g, ' ') // Flatten newlines in titles/snippets
            .trim();
        }
        return current;
      };

      const title = cleanText(finding.title);
      let body = cleanText(finding.body);

      // If the body starts with the title or a similar variant, strip it
      const bodyPrefix = cleanText(body.split('\n')[0]);
      if (bodyPrefix.toLowerCase().startsWith(title.toLowerCase()) || title.toLowerCase().startsWith(bodyPrefix.toLowerCase())) {
        body = cleanText(body.slice(body.split('\n')[0].length));
      }

      // Apply the deterministic severity/category engine (SEV-01/02/03/04). Category resolution is
      // unconditional (D-02); severity rules run only when the engine is enabled. Defaults keep this
      // a valid zero-opts call (pass 'main', engine enabled).
      const ruled = applySeverityRules(
        { severity, category: finding.category, title, body, pass: opts.pass ?? 'main' },
        { enabled: opts.severityEngineEnabled ?? true },
      );
      severityAuditEvents.push(...ruled.auditEvents);

      // EVID-01 soft evidence gate (D-14/D-16/D-17/D-18): only findings that SURVIVED the orphan check
      // (they become a persisted comment) reach here, so the trail never references an off-diff finding.
      // The finding ALWAYS still posts below regardless of the evidence outcome — this block only pushes
      // telemetry into the SAME severityAuditEvents accumulator (D-18), never a new returned field, and
      // NEVER carries body/diff/existingCode/codeSuggestion (privacy posture; T-15-04-01).
      const evidence = finding.existing_code;
      if (evidence == null || normalizeForEvidence(evidence).length === 0) {
        // null / undefined / whitespace-only -> `absent`. A JSON `null` reaches here (never a parse
        // failure) because fileReviewModelOutputSchema.existing_code is nullable().optional() (15-01).
        severityAuditEvents.push({
          stage: 'evidence_missing',
          reason: 'absent',
          path: file.path,
          line,
          title: clampAuditTitle(title),
          timestamp: new Date().toISOString(),
        });
      } else if (!evidenceHaystack.includes(normalizeForEvidence(evidence))) {
        severityAuditEvents.push({
          stage: 'evidence_missing',
          reason: 'not_in_hunk',
          path: file.path,
          line,
          title: clampAuditTitle(title),
          timestamp: new Date().toISOString(),
        });
      }

      return parsedReviewCommentSchema.parse({
        path: file.path,
        line: line,
        position,
        severity: ruled.severity,
        category: ruled.category,
        title,
        body: withSuggestion(body, finding.code_suggestion),
        codeSuggestion: finding.code_suggestion,
        // EVID-01 (D-15): map the model-emitted evidence into the parsed comment's existingCode field.
        // `?? null` because parsedReviewCommentSchema.existingCode is nullable().optional().
        existingCode: finding.existing_code ?? null,
        // Already validated/clamped by fileReviewModelOutputSchema + normalizeFinding.
        // Absent -> undefined, which parsedReviewCommentSchema accepts (fail-open at finalize).
        confidence: finding.confidence_score,
      });
    })
    .filter((comment): comment is ParsedReviewComment => Boolean(comment));

  const verdict = parsed.overall_correctness.toLowerCase().includes('patch is correct') ? 'approve' : 'comment';
  let fileSummary = parsed.overall_explanation;

  if (orphanedComments.length > 0) {
    fileSummary += `\n\n### Additional Comments (Off-diff)\n${orphanedComments.join('\n')}`;
  }

  return {
    comments,
    verdict: comments.length > 0 ? 'comment' : verdict,
    fileSummary: fileSummary,
    overallCorrectness: parsed.overall_correctness,
    confidenceScore: parsed.overall_confidence_score,
    severityAuditEvents,
  };
}

// Hard cap on the returned Mermaid diagram source (chars). Keeps a hostile/huge model diagram from
// blowing the walkthrough comment-size budget (the formatter fences it under WALKTHROUGH_BODY_MAX);
// over-length source is rejected (returns null -> diagram omitted).
const DIAGRAM_SOURCE_MAX = 20_000;

/**
 * Best-effort, tolerant parse of a model's Mermaid sequence-diagram output for the walkthrough
 * (WT-04, D-04a, Pitfall #6). Returns the trimmed RAW diagram source WITHOUT any ```mermaid fence
 * (the formatter is the sole fence-adder, GitHub-only — see formatWalkthrough's fence contract), or
 * `null` on empty, `<think>`-only, non-diagram, over-length, or garbage output. NEVER throws and
 * never uses bare `JSON.parse` — this is the fall-back-to-omit contract the Plan 03 best-effort
 * diagram call relies on (a null diagram -> the walkthrough simply posts without a diagram).
 */
export function parseWalkthroughDiagram(raw: string): string | null {
  try {
    if (typeof raw !== 'string' || raw.trim().length === 0) return null;

    // (1) Strip <think>...</think> reasoning block(s). NET-NEW logic: no <think> stripper exists in
    // src/server today (cleanText only strips leading prefix tags/emoji and flattens newlines). This
    // is tolerant of a missing close tag — a lone opening <think> with no </think> drops the rest.
    let text = raw
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      .replace(/<think>[\s\S]*$/i, '');

    // (2) If the model wrapped the diagram in a ```mermaid (or bare ```) fence, take the fence body;
    // otherwise use the stripped text as-is. Anchor the fence to the START of the stripped text
    // (^\s*```) so a bare, unfenced diagram that merely CONTAINS a stray ```…``` pair somewhere in
    // its body is not mistakenly unwrapped to the content between those inner backticks — which would
    // drop the leading `sequenceDiagram` line and fail (3), discarding an otherwise-usable diagram
    // (IN-02). Still tolerant: no match -> use the stripped text as-is, never throws.
    const fenceMatch = text.match(/^\s*```(?:mermaid)?[ \t]*\r?\n?([\s\S]*?)```/i);
    if (fenceMatch) {
      text = fenceMatch[1];
    }

    const source = text.trim();
    if (source.length === 0) return null;

    // (3) Strict validation: after dropping leading blank / `%%`-comment lines, the FIRST
    // non-comment token must be `sequenceDiagram` (reject surrounding prose or a mid-paragraph
    // mention — "contains sequenceDiagram somewhere" is NOT enough).
    const meaningful = source
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0 && !line.startsWith('%%'));
    if (!meaningful) return null;
    if (meaningful.split(/\s+/)[0] !== 'sequenceDiagram') return null;

    // (4) Hard length cap — reject an over-length diagram outright.
    if (source.length > DIAGRAM_SOURCE_MAX) return null;

    return source;
  } catch {
    // Best-effort: any unexpected failure -> omit the diagram, never fail the walkthrough.
    return null;
  }
}

// The per-item validation target for the critic's prune output (D-05). Reuses the exact item shape
// declared on criticPruneOutputSchema (id: nonnegative int, reason: string) so validation stays in
// one place — parseCriticPruneResponse skips malformed entries per-item instead of the schema's
// all-or-nothing array parse.
const criticPruneItemSchema = criticPruneOutputSchema.shape.prune.element;

/**
 * Tolerant parse of the critic's ID-based prune output (D-05). Returns the { id, reason }[] the
 * critic wants DROPPED — never a keep-list, never full findings (runCriticPhase, 10-06, reconciles
 * `kept = deduped minus pruned-by-id` in code). Mirrors parseFileReviewResponse's tolerant pattern
 * (strip <think> tags, extractJson, jsonrepair fallback) and MUST live inside this module because
 * the extractJson/preprocessJson helpers are private (the critic parser cannot be assembled from
 * outside — review-verified HIGH). Never throws: unparseable input returns []; malformed prune
 * entries are skipped per-item, validated against criticPruneOutputSchema's item shape.
 */
export function parseCriticPruneResponse(raw: string): { id: number; reason: string }[] {
  if (typeof raw !== 'string' || raw.trim().length === 0) return [];

  // Strip <think>...</think> reasoning (tolerant of a missing close tag) before extraction, same as
  // parseWalkthroughDiagram — reasoning text can contain JSON-looking fragments that would confuse
  // the extractor.
  const stripped = raw
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<think>[\s\S]*$/i, '');

  let extracted: string;
  try {
    extracted = extractJson(stripped);
  } catch {
    return [];
  }

  let repaired = extracted;
  try {
    repaired = jsonrepair(preprocessJson(extracted));
  } catch {
    // Fall back to the raw extracted text; the JSON.parse below is the final gate.
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(repaired);
  } catch {
    return [];
  }

  // Accept either a { prune: [...] } object or a bare [...] array of prune items (fail-soft: a model
  // that emits just the array still parses). An array-of-objects picks the wrapper carrying `prune`.
  let pruneArray: unknown[];
  if (Array.isArray(parsedJson)) {
    const wrapper = parsedJson.find(
      (i) => i && typeof i === 'object' && Array.isArray((i as Record<string, unknown>).prune),
    ) as Record<string, unknown> | undefined;
    pruneArray = wrapper ? (wrapper.prune as unknown[]) : parsedJson;
  } else if (parsedJson && typeof parsedJson === 'object' && Array.isArray((parsedJson as Record<string, unknown>).prune)) {
    pruneArray = (parsedJson as Record<string, unknown>).prune as unknown[];
  } else {
    return [];
  }

  const results: { id: number; reason: string }[] = [];
  for (const item of pruneArray) {
    const parsed = criticPruneItemSchema.safeParse(item);
    if (parsed.success) {
      results.push({ id: parsed.data.id, reason: parsed.data.reason });
    }
  }
  return results;
}

export function parseSummaryResponse(raw: string): string {
  const extracted = extractJson(raw);
  const preprocessed = preprocessJson(extracted);

  let repaired = preprocessed;
  try {
    repaired = jsonrepair(preprocessed);
  } catch (e) {
    // Fall back to original preprocessed text if repair fails
  }

  try {
    const parsedJson = JSON.parse(repaired);
    const validated = summaryModelOutputSchema.parse(parsedJson);
    return Array.isArray(validated) ? validated[0]?.summary : validated.summary;
  } catch (error) {
    // If it's not valid JSON or doesn't match the schema, return the raw text as a fallback
    // This handles cases where the model might still ignore the JSON constraint
    return raw.trim() || 'Review completed with no summary provided.';
  }
}

// The Q&A model envelope (Phase 11, Plan 04). The Q&A path requests a single `{ "answer": string }`
// object because the provider adapters are JSON-only (OpenAI response_format:json_object, Anthropic
// pre-fills '{'), so a bare-prose response is not a reliable option — the {answer} envelope is the
// one shape that works uniformly across every adapter. Accept either the bare object or a
// single-element array wrapper, mirroring summaryModelOutputSchema's tolerance.
const answerModelOutputSchema = z.union([
  z.array(z.object({ answer: z.string().min(1) })),
  z.object({ answer: z.string().min(1) }),
]);

/**
 * Tolerant parse of the Q&A model's `{ "answer": string }` envelope (Plan 11-04). Mirrors
 * parseSummaryResponse exactly (extractJson -> preprocessJson -> jsonrepair -> JSON.parse ->
 * schema) and MUST live in this module because the extractJson/preprocessJson helpers are private
 * here (same rationale as parseCriticPruneResponse — the parser cannot be assembled from outside).
 * When the model ignores the JSON envelope entirely, fall back to the raw trimmed text so a usable
 * prose answer is still returned rather than throwing.
 */
export function parseAnswerResponse(raw: string): string {
  const extracted = extractJson(raw);
  const preprocessed = preprocessJson(extracted);

  let repaired = preprocessed;
  try {
    repaired = jsonrepair(preprocessed);
  } catch (e) {
    // Fall back to original preprocessed text if repair fails.
  }

  try {
    const parsedJson = JSON.parse(repaired);
    const validated = answerModelOutputSchema.parse(parsedJson);
    // The array variant permits an empty [], so validated[0] can be undefined at runtime even though
    // the static type does not surface it — fall back to the raw text (parity with parseSummaryResponse).
    return Array.isArray(validated) ? (validated[0]?.answer ?? raw.trim()) : validated.answer;
  } catch (error) {
    // The model ignored the JSON envelope — return the raw text so the reviewer still gets an
    // answer rather than an error (the JSON-only adapters make this rare in practice).
    return raw.trim() || 'I was unable to produce an answer for this question.';
  }
}
