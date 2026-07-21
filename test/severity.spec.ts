import {
  applySeverityRules,
  SEV01_EXPLOIT_KEYWORDS,
  SEV02_SECURITY_TERMS,
  SEV03_STYLE_SIGNALS,
  SEV03_DEFECT_SIGNALS,
} from '@server/core/severity';
import type { ReviewSeverity } from '@shared/schema';

const base = (overrides: Partial<{
  severity: ReviewSeverity;
  category?: string;
  title: string;
  body: string;
  pass: 'main' | 'security';
}> = {}) => ({
  severity: 'P3' as ReviewSeverity,
  category: undefined as string | undefined,
  title: '',
  body: '',
  pass: 'main' as 'main' | 'security',
  ...overrides,
});

const enabled = { enabled: true };
const disabled = { enabled: false };

describe('applySeverityRules — SEV-01 keyword promotion (PRD FR-170, D-01)', () => {
  it('promotes a P2 "Possible SQL Injection" finding to P0 with a keyword_promotion audit event', () => {
    const out = applySeverityRules(base({ severity: 'P2', title: 'Possible SQL Injection', body: 'user input flows to query' }), enabled);
    expect(out.severity).toBe('P0');
    const event = out.auditEvents.find(e => e.stage === 'severity_adjusted');
    expect(event).toBeDefined();
    expect(event).toMatchObject({ stage: 'severity_adjusted', rule: 'keyword_promotion', matched: 'sql injection', from: 'P2', to: 'P0' });
    expect(typeof (event as any).timestamp).toBe('string');
  });

  it('leaves an already-P0 finding with no exploit keyword at P0 and emits no audit event', () => {
    const out = applySeverityRules(base({ severity: 'P0', title: 'Off-by-one bug', body: 'loop overruns' }), enabled);
    expect(out.severity).toBe('P0');
    expect(out.auditEvents).toHaveLength(0);
  });

  it('promotes when the exploit keyword appears in the body (not the title)', () => {
    const out = applySeverityRules(base({ severity: 'P3', title: 'Config parsing', body: 'this calls eval( on untrusted config' }), enabled);
    expect(out.severity).toBe('P0');
    expect(out.auditEvents[0]).toMatchObject({ rule: 'keyword_promotion', matched: 'eval(' });
  });

  it('word-bounds rce: "force"/"farce" do NOT promote, but "CSRF token missing" DOES (case-insensitive)', () => {
    expect(applySeverityRules(base({ severity: 'P3', title: 'force a rebuild', body: 'a farce of a fix' }), enabled).severity).toBe('P3');
    const csrf = applySeverityRules(base({ severity: 'P3', title: 'CSRF token missing', body: '' }), enabled);
    expect(csrf.severity).toBe('P0');
    expect(csrf.auditEvents[0]).toMatchObject({ matched: 'csrf' });
  });

  it('word-boundary false-positive guards: evaluate/executed/xssns are NOT promoted; XSS/xss are', () => {
    expect(applySeverityRules(base({ severity: 'P3', title: 'Evaluate the config' }), enabled).severity).toBe('P3');
    expect(applySeverityRules(base({ severity: 'P3', title: 'The job executed successfully' }), enabled).severity).toBe('P3');
    expect(applySeverityRules(base({ severity: 'P3', title: 'the class xssns wrapper' }), enabled).severity).toBe('P3');
    expect(applySeverityRules(base({ severity: 'P3', title: 'Fix the XSS filter' }), enabled).severity).toBe('P0');
  });

  // WR-01: `eval(`/`exec(` now require a LEADING word boundary, so an identifier that merely ENDS in
  // the literal sequence (retrieval(/medieval(/…exec() must NOT trip a spurious P0 promotion.
  it('WR-01: identifiers ending in the eval(/exec( sequence do NOT promote (retrieval(/medieval(/queryExec()', () => {
    expect(applySeverityRules(base({ severity: 'P3', title: 'the data retrieval( call', body: '' }), enabled).severity).toBe('P3');
    expect(applySeverityRules(base({ severity: 'P3', title: 'a medieval( helper', body: '' }), enabled).severity).toBe('P3');
    // '...exec(' with a leading word char (queryExec() must not match 'exec('
    expect(applySeverityRules(base({ severity: 'P3', title: 'calls queryExec( on the pool', body: '' }), enabled).severity).toBe('P3');
  });

  it('WR-01: a genuine eval(/exec( call still promotes to P0 in all boundary positions, including eval()', () => {
    // leading space
    expect(applySeverityRules(base({ severity: 'P3', body: 'this uses eval( on input' }), enabled).severity).toBe('P0');
    // assignment / operator boundary
    expect(applySeverityRules(base({ severity: 'P3', body: 'x = eval(userInput)' }), enabled).severity).toBe('P0');
    // start of string
    expect(applySeverityRules(base({ severity: 'P3', title: 'eval( is called here' }), enabled).severity).toBe('P0');
    // empty-arg call eval() — trailing \b would have wrongly failed this
    expect(applySeverityRules(base({ severity: 'P3', body: 'code calls eval() directly' }), enabled).severity).toBe('P0');
    // exec( with a preceding operator/space boundary
    const ex = applySeverityRules(base({ severity: 'P3', body: 'child.exec( cmd )' }), enabled);
    expect(ex.severity).toBe('P0');
    expect(ex.auditEvents[0]).toMatchObject({ rule: 'keyword_promotion', matched: 'exec(' });
  });
});

describe('applySeverityRules — SEV-02 security cap (PRD FR-171, D-06)', () => {
  it('caps a security-category P3 finding to exactly P2 with a security_category_cap event', () => {
    const out = applySeverityRules(base({ severity: 'P3', category: 'security', title: 'Weak config', body: 'review this' }), enabled);
    expect(out.severity).toBe('P2');
    expect(out.auditEvents[0]).toMatchObject({ stage: 'severity_adjusted', rule: 'security_category_cap', matched: 'category:security', from: 'P3', to: 'P2' });
  });

  it('caps a non-security-category finding matching a canonical FR-171 term (hardcoded / vulnerability) to P2', () => {
    expect(applySeverityRules(base({ severity: 'P3', category: 'quality', title: 't', body: 'This uses a hardcoded token' }), enabled).severity).toBe('P2');
    expect(applySeverityRules(base({ severity: 'P3', category: 'quality', title: 'generic vulnerability noted' }), enabled).severity).toBe('P2');
    expect(applySeverityRules(base({ severity: 'P3', category: 'quality', body: 'hardcoded API key' }), enabled).auditEvents[0]).toMatchObject({ rule: 'security_category_cap', matched: 'hardcoded' });
  });

  it('does NOT cap benign substring-only matches (insecurely / invulnerable)', () => {
    expect(applySeverityRules(base({ severity: 'P3', category: 'quality', title: 'The formatter runs insecurely' }), enabled).severity).toBe('P3');
    expect(applySeverityRules(base({ severity: 'P3', category: 'quality', title: 'code is invulnerable' }), enabled).severity).toBe('P3');
  });

  it('SEV-01 short-circuits SEV-02: "sql injection vulnerability" promotes to P0, not capped at P2', () => {
    const out = applySeverityRules(base({ severity: 'P3', category: 'quality', title: 'sql injection vulnerability' }), enabled);
    expect(out.severity).toBe('P0');
    expect(out.auditEvents).toHaveLength(1);
    expect(out.auditEvents[0]).toMatchObject({ rule: 'keyword_promotion' });
  });
});

describe('applySeverityRules — SEV-03 style-only downgrade (PRD FR-172, positive predicate)', () => {
  it('downgrades a style-signal finding with no defect signal to nit', () => {
    const out = applySeverityRules(base({ severity: 'P3', category: 'quality', title: 'Inconsistent naming convention', body: 'rename for clarity' }), enabled);
    expect(out.severity).toBe('nit');
    expect(out.auditEvents[0]).toMatchObject({ stage: 'severity_adjusted', rule: 'style_only_downgrade', from: 'P3', to: 'nit' });
  });

  it('does NOT downgrade a real defect with no positive style signal (race condition / deadlock / data loss / null dereference)', () => {
    expect(applySeverityRules(base({ severity: 'P2', title: 'Race condition on shared counter', body: 'may produce incorrect results' }), enabled).severity).toBe('P2');
    expect(applySeverityRules(base({ severity: 'P2', title: 'Potential deadlock' }), enabled).severity).toBe('P2');
    expect(applySeverityRules(base({ severity: 'P2', title: 'Possible data loss' }), enabled).severity).toBe('P2');
    expect(applySeverityRules(base({ severity: 'P2', title: 'Null dereference' }), enabled).severity).toBe('P2');
  });

  it('a defect signal (bug) blocks the downgrade even with a style keyword present', () => {
    const out = applySeverityRules(base({ severity: 'P2', title: 'naming bug', body: 'this is a bug in the naming logic' }), enabled);
    expect(out.severity).toBe('P2');
    expect(out.auditEvents).toHaveLength(0);
  });

  // WR-02: a genuine defect that incidentally contains a broad style word (format/comment/indent/…)
  // but none of the original five defect words must NOT be downgraded to nit (where min_severity could
  // then drop it). The widened SEV03_DEFECT_SIGNALS list blocks the downgrade.
  it('WR-02: "format string produces incorrect output" is NOT downgraded (style word + widened defect vocab)', () => {
    const out = applySeverityRules(base({ severity: 'P2', category: 'quality', title: 'format string produces incorrect output' }), enabled);
    expect(out.severity).toBe('P2');
    expect(out.auditEvents).toHaveLength(0);
  });

  it('WR-02: a comment-mentioning defect (unchecked null return) is NOT downgraded', () => {
    const out = applySeverityRules(base({ severity: 'P1', category: 'quality', title: 'misleading comment', body: 'this comment hides an unchecked null return' }), enabled);
    expect(out.severity).toBe('P1');
    expect(out.auditEvents).toHaveLength(0);
  });

  it('WR-02: newly-added defect words (race/deadlock/null dereference) block the downgrade even with a style keyword', () => {
    // 'formatting' style signal + 'race'
    expect(applySeverityRules(base({ severity: 'P2', category: 'quality', title: 'formatting hides a race on the cache', body: '' }), enabled).severity).toBe('P2');
    // 'comment' style signal + 'deadlock'
    expect(applySeverityRules(base({ severity: 'P2', category: 'quality', title: 'comment omits deadlock risk', body: '' }), enabled).severity).toBe('P2');
    // 'indent' style signal + 'dereference' (null dereference)
    expect(applySeverityRules(base({ severity: 'P2', category: 'quality', title: 'indentation obscures a null dereference', body: '' }), enabled).severity).toBe('P2');
  });

  it('WR-02: a purely cosmetic finding (no defect signal) is STILL downgraded to nit', () => {
    expect(applySeverityRules(base({ severity: 'P3', category: 'quality', title: 'inconsistent indentation' }), enabled).severity).toBe('nit');
    const out = applySeverityRules(base({ severity: 'P3', category: 'quality', title: 'variable naming convention' }), enabled);
    expect(out.severity).toBe('nit');
    expect(out.auditEvents[0]).toMatchObject({ rule: 'style_only_downgrade', to: 'nit' });
  });
});

describe('applySeverityRules — SEV-04 category resolution (D-05/D-06/D-07)', () => {
  it('D-07: a security pass forces category to "security" regardless of the model self-report', () => {
    expect(applySeverityRules(base({ pass: 'security', category: 'quality' }), enabled).category).toBe('security');
  });

  it('D-07: category forcing runs even when the engine is disabled', () => {
    const out = applySeverityRules(base({ pass: 'security', category: 'quality', severity: 'P1', title: 'sql injection' }), disabled);
    expect(out.category).toBe('security');
    expect(out.severity).toBe('P1'); // no severity change when disabled
    expect(out.auditEvents).toHaveLength(0);
  });

  it('D-05 fail-open: undefined or invalid category resolves to "correctness"', () => {
    expect(applySeverityRules(base({ pass: 'main', category: undefined }), enabled).category).toBe('correctness');
    expect(applySeverityRules(base({ pass: 'main', category: 'not-a-real-category' }), enabled).category).toBe('correctness');
    expect(applySeverityRules(base({ pass: 'main', category: '' }), enabled).category).toBe('correctness');
  });

  it('D-05 edge: a missing category on a main pass is NOT treated as a security cap candidate', () => {
    const out = applySeverityRules(base({ severity: 'P3', pass: 'main', category: undefined, title: 'benign note' }), enabled);
    expect(out.category).toBe('correctness');
    expect(out.severity).toBe('P3');
    expect(out.auditEvents).toHaveLength(0);
  });

  it('D-06: an exact valid enum member passes through unchanged', () => {
    expect(applySeverityRules(base({ pass: 'main', category: 'performance' }), enabled).category).toBe('performance');
  });
});

describe('applySeverityRules — toggle + never-throws (D-02)', () => {
  it('disabled: an exploit-keyword finding is NOT promoted and emits no audit event, but category still resolves', () => {
    const out = applySeverityRules(base({ severity: 'P3', title: 'Possible SQL injection', category: undefined }), disabled);
    expect(out.severity).toBe('P3');
    expect(out.auditEvents).toHaveLength(0);
    expect(out.category).toBe('correctness');
  });

  it('never throws for empty/degenerate input', () => {
    expect(() => applySeverityRules({ severity: 'P2', category: undefined, title: '', body: '', pass: 'main' }, enabled)).not.toThrow();
  });
});

describe('keyword set constants are exported and table-driven', () => {
  it('every SEV-01 exploit term individually promotes to P0', () => {
    for (const term of SEV01_EXPLOIT_KEYWORDS) {
      const text = term.endsWith('(') ? `code calls ${term}now)` : `finding about ${term} here`;
      const out = applySeverityRules(base({ severity: 'P3', title: text }), enabled);
      expect(out.severity, `term "${term}" should promote`).toBe('P0');
    }
  });

  it('every SEV-02 security term individually caps a P3 quality finding to P2', () => {
    for (const term of SEV02_SECURITY_TERMS) {
      const out = applySeverityRules(base({ severity: 'P3', category: 'quality', body: `finding mentions ${term} in code` }), enabled);
      expect(out.severity, `term "${term}" should cap`).toBe('P2');
    }
  });

  it('every SEV-03 style signal (with no defect signal) downgrades a P3 quality finding to nit', () => {
    for (const term of SEV03_STYLE_SIGNALS) {
      const out = applySeverityRules(base({ severity: 'P3', category: 'quality', title: `finding about ${term} here` }), enabled);
      expect(out.severity, `style term "${term}" should downgrade`).toBe('nit');
    }
  });

  it('exposes the SEV-03 defect signal list', () => {
    expect(SEV03_DEFECT_SIGNALS).toEqual(expect.arrayContaining(['bug', 'error', 'crash', 'security', 'vulnerability']));
  });
});
