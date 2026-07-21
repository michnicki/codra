import { reviewCategories, type ReviewSeverity, type ReviewCategory, type JobAuditEvent } from '@shared/schema';

// Pure, deterministic severity/category engine (SEV-01/02/03/04). No I/O, no DB, no logging —
// trivially unit-testable (test/severity.spec.ts). Style matches core/diff.ts: plain named exports,
// no class. The ONLY input is model-generated finding text (never the raw diff — see threat model
// T-13-02-01), so matching is bounded and non-backtracking.

// SEV-01 exploit-class keywords (PRD FR-170). A word-bounded match on title+body PROMOTES a finding
// to P0 regardless of its model-assigned severity. `eval(`/`exec(` keep the trailing `(` — the paren
// is itself a non-word boundary so `matchesTerm` uses a plain substring test for those two (so
// 'evaluate('/'executed' cannot match); every other term is matched WORD-BOUNDED (case-insensitive),
// so bare 'rce'/'csrf'/'ssrf' require `\b` boundaries ('force'/'farce' do NOT trip 'rce').
export const SEV01_EXPLOIT_KEYWORDS = [
  'sql injection',
  'xss',
  'cross-site scripting',
  'command injection',
  'shell injection',
  'path traversal',
  'directory traversal',
  'remote code execution',
  'arbitrary code',
  'eval(',
  'exec(',
  'deserialization',
  'buffer overflow',
  'rce',
  'csrf',
  'ssrf',
] as const;

// SEV-02 canonical PRD FR-171 security terms. A finding whose resolved category is 'security' OR
// whose text word-bounded-matches any of these terms (and was not promoted by SEV-01) is force-set
// to exactly P2. This is the FULL canonical list (bare 'hardcoded'/'insecure'/'vulnerability' plus
// the multi-word phrases) — SEV-01 runs first and short-circuits, so 'sql injection vulnerability'
// still promotes to P0 before this cap can apply.
export const SEV02_SECURITY_TERMS = [
  'hardcoded',
  'default key',
  'default password',
  'default secret',
  'insecure default',
  'missing error handling',
  'missing validation',
  'insecure',
  'vulnerability',
] as const;

// SEV-03 positive style-signal keywords (PRD FR-172). A finding is downgraded to at most 'nit' ONLY
// when it word-bounded-matches one of these AND matches none of SEV03_DEFECT_SIGNALS. A finding with
// NO positive style signal is left unchanged — the deliberate deviation from a literal reading of
// SEV-03 that keeps real defects ('race condition'/'deadlock'/'null dereference'/'data loss') from
// being wrongly nit'd (review fix, Codex HIGH).
export const SEV03_STYLE_SIGNALS = [
  'style',
  'formatting',
  'format',
  'naming',
  'rename',
  'typo',
  'whitespace',
  'indentation',
  'indent',
  'readability',
  'readable',
  'comment',
  'lint',
  'convention',
  'spacing',
  'unused import',
] as const;

// SEV-03 defect signals. Any word-bounded match here BLOCKS the style-only downgrade — a finding
// that mentions a defect keyword keeps its model-assigned severity even if it also mentions a style
// keyword.
export const SEV03_DEFECT_SIGNALS = ['bug', 'error', 'crash', 'security', 'vulnerability'] as const;

// Escape regex metacharacters so a keyword is always treated as a literal — no attacker-influenced
// regex construct, no catastrophic backtracking (DoS hardening, threat T-13-02-01).
function escapeRegExp(term: string): string {
  return term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Word-bounded, case-insensitive match of a single keyword/phrase against `text`. Terms ending in
// `(` (only 'eval('/'exec(') use a plain substring test — the `(` already bounds them. Every other
// term (single word OR multi-word phrase like 'default key') uses a non-backtracking
// `\b<escaped-literal>\b` regex.
function matchesTerm(text: string, term: string): boolean {
  if (term.endsWith('(')) {
    return text.toLowerCase().includes(term.toLowerCase());
  }
  return new RegExp(String.raw`\b` + escapeRegExp(term) + String.raw`\b`, 'i').test(text);
}

// Returns the first term in `terms` that matches `text` (word-bounded), or undefined. The returned
// value is always a literal from the constant list — never a slice of the finding text (threat
// T-13-02-03: no attacker/model free text is copied into the persisted audit event's `matched`).
function findMatchingTerm(text: string, terms: readonly string[]): string | undefined {
  for (const term of terms) {
    if (matchesTerm(text, term)) return term;
  }
  return undefined;
}

// D-07 (unconditional) / D-06 (exact match) / D-05 (fail-open). A security pass always forces
// 'security'. Otherwise an EXACT member of reviewCategories passes through; any other value
// (undefined, empty, invalid) fails open to 'correctness'. Never throws.
function resolveCategory(pass: 'main' | 'security', category: string | undefined): ReviewCategory {
  if (pass === 'security') return 'security';
  if (typeof category === 'string' && (reviewCategories as readonly string[]).includes(category)) {
    return category as ReviewCategory;
  }
  return 'correctness';
}

/**
 * Apply the deterministic severity/category rules to a single finding (SEV-01/02/03/04). Pure: no
 * I/O, never throws for any input shape.
 *
 * Category resolution runs FIRST and UNCONDITIONALLY (regardless of opts.enabled — D-02): SEV-04 is
 * never gated by the toggle. Severity resolution runs only when opts.enabled is true, as a tiered,
 * mutually-exclusive check (first match wins) over `${title} ${body}`; an already-P0 finding is
 * NEVER touched by any rule.
 */
export function applySeverityRules(
  input: { severity: ReviewSeverity; category?: string; title: string; body: string; pass: 'main' | 'security' },
  opts: { enabled: boolean },
): { severity: ReviewSeverity; category: ReviewCategory; auditEvents: JobAuditEvent[] } {
  const auditEvents: JobAuditEvent[] = [];
  const category = resolveCategory(input.pass, input.category);

  let severity: ReviewSeverity = input.severity;

  // Severity rules are gated by the toggle AND never touch an already-P0 finding.
  if (opts.enabled && severity !== 'P0') {
    const text = `${input.title ?? ''} ${input.body ?? ''}`;
    const timestamp = new Date().toISOString();
    const from = severity;

    // Rule 1 — SEV-01 keyword promotion (PRD FR-170). First match wins; skips rules 2 and 3.
    const exploit = findMatchingTerm(text, SEV01_EXPLOIT_KEYWORDS);
    if (exploit) {
      severity = 'P0';
      auditEvents.push({ stage: 'severity_adjusted', rule: 'keyword_promotion', matched: exploit, from, to: 'P0', timestamp });
    } else {
      // Rule 2 — SEV-02 security-category cap (PRD FR-171). Category 'security' OR a canonical term.
      const securityMatch = category === 'security' ? 'category:security' : findMatchingTerm(text, SEV02_SECURITY_TERMS);
      if (securityMatch) {
        severity = 'P2';
        auditEvents.push({ stage: 'severity_adjusted', rule: 'security_category_cap', matched: securityMatch, from, to: 'P2', timestamp });
      } else {
        // Rule 3 — SEV-03 style-only downgrade (PRD FR-172). Requires a POSITIVE style signal AND no
        // defect signal. A finding with no style signal is left unchanged.
        const styleMatch = findMatchingTerm(text, SEV03_STYLE_SIGNALS);
        const defectMatch = findMatchingTerm(text, SEV03_DEFECT_SIGNALS);
        if (styleMatch && !defectMatch) {
          severity = 'nit';
          auditEvents.push({ stage: 'severity_adjusted', rule: 'style_only_downgrade', matched: styleMatch, from, to: 'nit', timestamp });
        }
      }
    }
  }

  return { severity, category, auditEvents };
}
