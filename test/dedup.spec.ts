import { describe, expect, it } from 'vitest';
import type { ParsedReviewComment } from '@shared/schema';
import {
  dedupeFindings,
  dedupeComposite,
  wordJaccardSimilarity,
  pickSurvivor,
  trigramJaccardSimilarity,
  normalizeForDedup,
  DEDUP_SIMILARITY_THRESHOLD,
  DEDUP_LINE_PROXIMITY,
} from '@server/core/dedup';

// Pure, no-DB unit spec (mirrors test/chunk-concurrency.spec.ts): dedup is a zero-cost
// deterministic function, so every edge the cross-AI review flagged is pinned here against
// the REAL exported similarity helper — not a hand-crafted fixture string.
//
// Fixture trick: normalizeForDedup strips punctuation, collapses whitespace and trims, so a
// title of '.' collapses to empty and the finding's comparison text `(title + ' ' + body)`
// normalizes to exactly `body`. That lets a finding's dedupe similarity equal the value proven
// directly against trigramJaccardSimilarity on the same raw string.

function finding(overrides: Partial<ParsedReviewComment> = {}): ParsedReviewComment {
  return {
    path: 'src/a.ts',
    line: 5,
    severity: 'P2',
    category: 'quality',
    title: '.',
    body: 'default finding body text',
    ...overrides,
  };
}

describe('dedup tuning constants', () => {
  it('pins the tuned defaults the whole algorithm is calibrated against', () => {
    expect(DEDUP_SIMILARITY_THRESHOLD).toBe(0.7);
    expect(DEDUP_LINE_PROXIMITY).toBe(10);
  });
});

describe('normalizeForDedup', () => {
  it('lowercases, strips markdown/backticks/punctuation, and collapses whitespace', () => {
    expect(normalizeForDedup('**Null** check on `user.id`!!')).toBe('null check on user id');
  });

  it('strips fenced code blocks', () => {
    expect(normalizeForDedup('text ```const x = 1``` more')).toBe('text more');
  });

  it('normalizes NFC/NFD unicode forms to the same string', () => {
    const nfc = 'Café'.normalize('NFC');
    const nfd = 'Café'.normalize('NFD');
    expect(nfc).not.toBe(nfd); // sanity: the two byte forms genuinely differ
    expect(normalizeForDedup(nfd)).toBe(normalizeForDedup(nfc));
    expect(normalizeForDedup(nfd)).toBe('café');
  });
});

describe('trigramJaccardSimilarity', () => {
  it('computes |A∩B| / |A∪B| over character 3-grams', () => {
    // abcdefghi -> {abc,bcd,cde,def,efg,fgh,ghi} (7); abcdefghij -> +{hij} (8); intersection 7.
    expect(trigramJaccardSimilarity('abcdefghij', 'abcdefghijk')).toBeCloseTo(8 / 9, 12);
  });

  it('returns exactly the threshold value for a pair AT the boundary', () => {
    // 7 shared trigrams, union 10 -> 0.7 exactly (used by the at-threshold merge test below).
    expect(trigramJaccardSimilarity('abcdefghi', 'abcdefghinop')).toBe(0.7);
  });

  it('scores a just-below pair under the threshold', () => {
    const sim = trigramJaccardSimilarity('abcdef', 'abcdefno');
    expect(sim).toBeLessThan(DEDUP_SIMILARITY_THRESHOLD);
    expect(sim).toBeCloseTo(2 / 3, 12);
  });

  it('scores fully disjoint strings 0', () => {
    expect(trigramJaccardSimilarity('abcdefghij', 'nopqrstuvw')).toBe(0);
  });

  it('treats two empty trigram sets as similar ONLY when the strings are exactly equal', () => {
    expect(trigramJaccardSimilarity('', '')).toBe(1);
    expect(trigramJaccardSimilarity('ab', 'ab')).toBe(1); // both < 3 chars -> empty sets, equal
    expect(trigramJaccardSimilarity('ab', 'cd')).toBe(0); // both empty sets, not equal
  });

  it('scores an empty set against a non-empty set 0', () => {
    expect(trigramJaccardSimilarity('', 'abcdef')).toBe(0);
    expect(trigramJaccardSimilarity('ab', 'abcdef')).toBe(0);
  });
});

describe('dedupeFindings — empty / trivial inputs', () => {
  it('returns [] for empty input', () => {
    expect(dedupeFindings([])).toEqual([]);
  });

  it('returns a single-element input unchanged', () => {
    const f = finding();
    expect(dedupeFindings([f])).toEqual([f]);
  });
});

describe('dedupeFindings — core same-file merge', () => {
  it('merges two near-identical findings on the same path within proximity', () => {
    const a = finding({ body: 'abcdefghij', severity: 'P2' });
    const b = finding({ body: 'abcdefghijk', severity: 'P2', line: 6 });
    // prove the pair is above threshold via the real helper before asserting the merge
    expect(
      trigramJaccardSimilarity(normalizeForDedup(`${a.title} ${a.body}`), normalizeForDedup(`${b.title} ${b.body}`)),
    ).toBeGreaterThan(DEDUP_SIMILARITY_THRESHOLD);
    expect(dedupeFindings([a, b])).toHaveLength(1);
  });

  it('merges a pair whose similarity is EXACTLY at the threshold', () => {
    const a = finding({ body: 'abcdefghi', line: 5 });
    const b = finding({ body: 'abcdefghinop', line: 6 });
    // title '.' normalizes away, so the comparison strings are exactly the raw fixtures.
    expect(
      trigramJaccardSimilarity(normalizeForDedup(`${a.title} ${a.body}`), normalizeForDedup(`${b.title} ${b.body}`)),
    ).toBe(DEDUP_SIMILARITY_THRESHOLD);
    expect(dedupeFindings([a, b])).toHaveLength(1);
  });

  it('keeps a pair just BELOW the threshold separate', () => {
    const a = finding({ body: 'abcdef', line: 5 });
    const b = finding({ body: 'abcdefno', line: 6 });
    expect(
      trigramJaccardSimilarity(normalizeForDedup(`${a.title} ${a.body}`), normalizeForDedup(`${b.title} ${b.body}`)),
    ).toBeLessThan(DEDUP_SIMILARITY_THRESHOLD);
    expect(dedupeFindings([a, b])).toHaveLength(2);
  });

  it('never merges findings on different files, even at similarity 1.0', () => {
    const a = finding({ path: 'src/a.ts', body: 'identical body content here' });
    const b = finding({ path: 'src/b.ts', body: 'identical body content here' });
    expect(
      trigramJaccardSimilarity(normalizeForDedup(`${a.title} ${a.body}`), normalizeForDedup(`${b.title} ${b.body}`)),
    ).toBe(1);
    expect(dedupeFindings([a, b])).toHaveLength(2);
  });
});

describe('dedupeFindings — PINNED proximity gate', () => {
  const simA = 'abcdefghij';
  const simB = 'abcdefghijk'; // ~0.888 similar to simA

  it('merges when both lines are present and within DEDUP_LINE_PROXIMITY', () => {
    const a = finding({ body: simA, line: 5 });
    const b = finding({ body: simB, line: 5 + DEDUP_LINE_PROXIMITY });
    expect(dedupeFindings([a, b])).toHaveLength(1);
  });

  it('keeps a pair separate when both lines are present but beyond proximity', () => {
    const a = finding({ body: simA, line: 5 });
    const b = finding({ body: simB, line: 6 + DEDUP_LINE_PROXIMITY });
    expect(dedupeFindings([a, b])).toHaveLength(2);
  });

  it('merges when BOTH lines are null (proximity cannot be violated)', () => {
    const a = finding({ body: simA, line: null });
    const b = finding({ body: simB, line: null });
    expect(dedupeFindings([a, b])).toHaveLength(1);
  });

  it('keeps a pair separate when exactly ONE line is null', () => {
    const a = finding({ body: simA, line: 5 });
    const b = finding({ body: simB, line: null });
    expect(dedupeFindings([a, b])).toHaveLength(2);

    const c = finding({ body: simA, line: null });
    const d = finding({ body: simB, line: 5 });
    expect(dedupeFindings([c, d])).toHaveLength(2);
  });
});

describe('dedupeFindings — D-04 tie-break', () => {
  const simA = 'abcdefghij';
  const simB = 'abcdefghijk';

  it('keeps the higher-severity finding regardless of input order', () => {
    const high = finding({ body: simA, severity: 'P0', line: 5 });
    const low = finding({ body: simB, severity: 'nit', line: 6 });

    const survivorsForward = dedupeFindings([low, high]);
    expect(survivorsForward).toHaveLength(1);
    expect(survivorsForward[0].severity).toBe('P0');

    const survivorsReverse = dedupeFindings([high, low]);
    expect(survivorsReverse).toHaveLength(1);
    expect(survivorsReverse[0].severity).toBe('P0');
  });

  it('breaks equal-severity ties by higher confidence (explicit score beats null)', () => {
    const nullConf = finding({ body: simA, severity: 'P2', confidence: null, line: 5 });
    const scored = finding({ body: simB, severity: 'P2', confidence: 0.5, line: 6 });
    const survivors = dedupeFindings([nullConf, scored]);
    expect(survivors).toHaveLength(1);
    expect(survivors[0].confidence).toBe(0.5);
  });

  it('breaks equal severity+confidence ties by keeping the FIRST in input order', () => {
    const first = finding({ body: simA, severity: 'P2', confidence: 0.5, position: 1, line: 5 });
    const second = finding({ body: simB, severity: 'P2', confidence: 0.5, position: 2, line: 6 });
    const survivors = dedupeFindings([first, second]);
    expect(survivors).toHaveLength(1);
    expect(survivors[0].position).toBe(1);
    expect(survivors[0].body).toBe(simA);
  });

  it('never lets a lower-severity duplicate displace a higher-severity finding', () => {
    const high = finding({ body: simA, severity: 'P1', line: 5 });
    const low = finding({ body: simB, severity: 'P3', line: 6 });
    const survivors = dedupeFindings([high, low]);
    expect(survivors).toHaveLength(1);
    expect(survivors[0].severity).toBe('P1');
    expect(survivors[0].body).toBe(simA);
  });
});

describe('dedupeFindings — PINNED clustering (greedy against kept survivors)', () => {
  // Sliding-window triple: A≈B, B≈C, A≉C, proven against the real helper.
  const A = 'abcdefghijklmnopqrstuvwxyz0123';
  const B = 'defghijklmnopqrstuvwxyz0123456';
  const C = 'ghijklmnopqrstuvwxyz0123456789';

  it('has the intended A≈B, B≈C, A≉C similarity structure', () => {
    expect(trigramJaccardSimilarity(A, B)).toBeGreaterThanOrEqual(DEDUP_SIMILARITY_THRESHOLD);
    expect(trigramJaccardSimilarity(B, C)).toBeGreaterThanOrEqual(DEDUP_SIMILARITY_THRESHOLD);
    expect(trigramJaccardSimilarity(A, C)).toBeLessThan(DEDUP_SIMILARITY_THRESHOLD);
  });

  it('compares each finding against KEPT survivors, so a broken transitive chain stays split', () => {
    // A survives the A/B merge (higher severity), so C is compared against A (not B): A≉C -> C kept.
    const fa = finding({ body: A, severity: 'P0', line: 5 });
    const fb = finding({ body: B, severity: 'P1', line: 6 });
    const fc = finding({ body: C, severity: 'P2', line: 7 });
    const survivors = dedupeFindings([fa, fb, fc]);
    expect(survivors).toHaveLength(2);
    expect(survivors[0].body).toBe(A);
    expect(survivors[0].severity).toBe('P0');
    expect(survivors[1].body).toBe(C);
  });

  it('lets a later higher-severity finding replace an earlier survivor without reordering', () => {
    const x = finding({ path: 'src/a.ts', body: 'abcdefghij', severity: 'nit', line: 5 });
    const y = finding({ path: 'src/a.ts', body: 'abcdefghijk', severity: 'P0', line: 6 });
    const z = finding({ path: 'src/z.ts', body: 'wholly different content', severity: 'P2', line: 1 });
    const survivors = dedupeFindings([x, y, z]);
    expect(survivors).toHaveLength(2);
    // y replaced x in slot 0 (higher severity), position preserved; z stays in slot 1.
    expect(survivors[0].severity).toBe('P0');
    expect(survivors[0].path).toBe('src/a.ts');
    expect(survivors[1].path).toBe('src/z.ts');
  });
});

describe('dedupeFindings — stable ordering & normalization', () => {
  it('preserves input order for surviving (non-merged) findings', () => {
    const one = finding({ path: 'src/a.ts', body: 'alpha content one' });
    const two = finding({ path: 'src/b.ts', body: 'beta content two' });
    const three = finding({ path: 'src/c.ts', body: 'gamma content three' });
    const survivors = dedupeFindings([one, two, three]);
    expect(survivors.map((s) => s.path)).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
  });

  it('merges markdown-only bodies that normalize to the same text', () => {
    const a = finding({ body: '**Null pointer** on `user.id` access', line: 5 });
    const b = finding({ body: 'Null pointer on user.id access', line: 6 });
    expect(
      trigramJaccardSimilarity(normalizeForDedup(`${a.title} ${a.body}`), normalizeForDedup(`${b.title} ${b.body}`)),
    ).toBeGreaterThanOrEqual(DEDUP_SIMILARITY_THRESHOLD);
    expect(dedupeFindings([a, b])).toHaveLength(1);
  });

  it('merges NFC/NFD unicode variants of the same finding text', () => {
    const text = 'Résumé parsing café overflow détail here';
    const a = finding({ body: text.normalize('NFC'), line: 5 });
    const b = finding({ body: text.normalize('NFD'), line: 6 });
    expect(dedupeFindings([a, b])).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Phase 14 FILT-03: word-set (token) Jaccard + composite 4-rule dedup. Additive
// only — everything above (legacy trigram path + its pinned cases) is frozen.
// ---------------------------------------------------------------------------

describe('wordJaccardSimilarity', () => {
  it('returns 1 for identical token sets', () => {
    expect(wordJaccardSimilarity('null check on user id', 'null check on user id')).toBe(1);
  });

  it('computes |A∩B| / |A∪B| over word tokens (order/case/punctuation insensitive)', () => {
    // A={null,check,user,id}, B={null,check,user,name}: inter 3, union 5 -> 0.6
    expect(wordJaccardSimilarity('Null check user id', 'null check user name')).toBeCloseTo(0.6, 12);
  });

  it('returns >= threshold for a pair EXACTLY at 0.2 and < for just below', () => {
    // {alpha,beta,gamma} vs {alpha,delta,epsilon}: inter 1, union 5 -> 0.2
    expect(wordJaccardSimilarity('alpha beta gamma', 'alpha delta epsilon')).toBe(0.2);
    // add one more disjoint word -> inter 1, union 6 -> 0.1666.. < 0.2
    expect(wordJaccardSimilarity('alpha beta gamma', 'alpha delta epsilon zeta')).toBeLessThan(0.2);
  });

  it('is 0.6 at boundary and 0.5 just below', () => {
    expect(wordJaccardSimilarity('aa bb cc dd', 'aa bb cc ee')).toBe(0.6);
    expect(wordJaccardSimilarity('aa bb cc dd', 'aa bb cc ee ff')).toBe(0.5);
  });

  it('is 0.8 at boundary and 0.666.. just below', () => {
    expect(wordJaccardSimilarity('aa bb cc dd ee', 'aa bb cc dd')).toBe(0.8);
    expect(wordJaccardSimilarity('aa bb cc dd ee', 'aa bb cc dd ff')).toBeLessThan(0.8);
  });

  it('returns 0 whenever EITHER token set is empty, INCLUDING both-empty (review finding #8a)', () => {
    // Intentionally DIFFERENT from the frozen trigram rule, which returns 1 for two equal-empty strings.
    expect(wordJaccardSimilarity('', '')).toBe(0);
    expect(wordJaccardSimilarity('...', '!!!')).toBe(0); // both normalize to '' -> 0, not 1
    expect(wordJaccardSimilarity('...', '...')).toBe(0); // equal pure-punctuation still 0
    expect(wordJaccardSimilarity('', 'alpha beta')).toBe(0);
    expect(wordJaccardSimilarity('!!!', 'alpha beta')).toBe(0);
  });
});

describe('pickSurvivor (exported, behavior-neutral)', () => {
  it('keeps the higher-severity finding', () => {
    const high = finding({ severity: 'P0', body: 'high' });
    const low = finding({ severity: 'nit', body: 'low' });
    expect(pickSurvivor(low, high)).toBe(high);
    expect(pickSurvivor(high, low)).toBe(high);
  });

  it('breaks equal-severity ties by higher confidence, then stable-first', () => {
    const nullConf = finding({ severity: 'P2', confidence: null, body: 'a' });
    const scored = finding({ severity: 'P2', confidence: 0.5, body: 'b' });
    expect(pickSurvivor(nullConf, scored)).toBe(scored);
    const first = finding({ severity: 'P2', confidence: 0.5, body: 'first' });
    const second = finding({ severity: 'P2', confidence: 0.5, body: 'second' });
    expect(pickSurvivor(first, second)).toBe(first); // full tie -> earlier
  });
});

describe('dedupeComposite — trivial inputs', () => {
  it('returns [] survivors and [] merges for empty input', () => {
    expect(dedupeComposite([])).toEqual({ survivors: [], merges: [] });
  });

  it('returns a single-element input unchanged with no merges', () => {
    const f = finding();
    const result = dedupeComposite([f]);
    expect(result.survivors).toEqual([f]);
    expect(result.merges).toEqual([]);
  });
});

describe('dedupeComposite — rule 1 (same path, exact-equal non-null line, same category, no title check)', () => {
  it('merges two same-path/equal-line/same-category findings even with unrelated titles', () => {
    const a = finding({ path: 'src/a.ts', line: 5, category: 'quality', title: 'alpha beta gamma', body: 'x' });
    const b = finding({ path: 'src/a.ts', line: 5, category: 'quality', title: 'delta epsilon zeta', body: 'y' });
    // titles share nothing, yet rule1 fires (no title check)
    expect(wordJaccardSimilarity(a.title, b.title)).toBe(0);
    const result = dedupeComposite([a, b]);
    expect(result.survivors).toHaveLength(1);
    expect(result.merges).toHaveLength(1);
    expect(result.merges[0].rule).toBe('rule1');
    expect(result.merges[0].titleSimilarity).toBeNull();
    expect(result.merges[0].bodySimilarity).toBeNull();
  });

  it('does NOT fire rule1 on different category (falls through to rule2, which fails on low title similarity)', () => {
    const a = finding({ path: 'src/a.ts', line: 5, category: 'quality', title: 'alpha beta gamma', body: 'x' });
    const b = finding({ path: 'src/a.ts', line: 5, category: 'bugs', title: 'delta epsilon zeta', body: 'y' });
    expect(dedupeComposite([a, b]).survivors).toHaveLength(2);
  });

  it('does NOT fire rule1 when a line is null (a null line is not an "exact same line", finding #8b)', () => {
    const a = finding({ path: 'src/a.ts', line: null, category: 'quality', title: 'alpha beta gamma', body: 'x' });
    const b = finding({ path: 'src/a.ts', line: null, category: 'quality', title: 'delta epsilon zeta', body: 'y' });
    // both-null + same category but title similarity 0 -> rule2 fails, rule1 excluded -> no merge
    expect(dedupeComposite([a, b]).survivors).toHaveLength(2);
  });
});

describe('dedupeComposite — rule 2 (same path, equal line, title-Jaccard >= 0.2)', () => {
  it('merges at exactly 0.2 and records titleSimilarity', () => {
    const a = finding({ path: 'src/a.ts', line: 5, category: 'quality', title: 'alpha beta gamma', body: 'x' });
    const b = finding({ path: 'src/a.ts', line: 5, category: 'bugs', title: 'alpha delta epsilon', body: 'y' });
    expect(wordJaccardSimilarity(a.title, b.title)).toBe(0.2);
    const result = dedupeComposite([a, b]);
    expect(result.survivors).toHaveLength(1);
    expect(result.merges[0].rule).toBe('rule2');
    expect(result.merges[0].titleSimilarity).toBeCloseTo(0.2, 12);
    expect(result.merges[0].bodySimilarity).toBeNull();
  });

  it('does NOT merge just below 0.2', () => {
    const a = finding({ path: 'src/a.ts', line: 5, category: 'quality', title: 'alpha beta gamma', body: 'x' });
    const b = finding({ path: 'src/a.ts', line: 5, category: 'bugs', title: 'alpha delta epsilon zeta', body: 'y' });
    expect(wordJaccardSimilarity(a.title, b.title)).toBeLessThan(0.2);
    expect(dedupeComposite([a, b]).survivors).toHaveLength(2);
  });
});

describe('dedupeComposite — rule 3 (same path, different line, title-Jaccard >= 0.6)', () => {
  it('merges at exactly 0.6 and records titleSimilarity', () => {
    const a = finding({ path: 'src/a.ts', line: 5, title: 'aa bb cc dd', body: 'x' });
    const b = finding({ path: 'src/a.ts', line: 99, title: 'aa bb cc ee', body: 'y' });
    expect(wordJaccardSimilarity(a.title, b.title)).toBe(0.6);
    const result = dedupeComposite([a, b]);
    expect(result.survivors).toHaveLength(1);
    expect(result.merges[0].rule).toBe('rule3');
    expect(result.merges[0].titleSimilarity).toBeCloseTo(0.6, 12);
    expect(result.merges[0].bodySimilarity).toBeNull();
  });

  it('does NOT merge just below 0.6', () => {
    const a = finding({ path: 'src/a.ts', line: 5, title: 'aa bb cc dd', body: 'x' });
    const b = finding({ path: 'src/a.ts', line: 99, title: 'aa bb cc ee ff', body: 'y' });
    expect(wordJaccardSimilarity(a.title, b.title)).toBeLessThan(0.6);
    expect(dedupeComposite([a, b]).survivors).toHaveLength(2);
  });
});

describe('dedupeComposite — rule 4 (different path, title-Jaccard >= 0.8 AND body-Jaccard >= 0.5)', () => {
  it('merges when both title and body thresholds are met, recording both similarities', () => {
    const a = finding({ path: 'src/a.ts', line: 5, title: 'aa bb cc dd ee', body: 'pp qq' });
    const b = finding({ path: 'src/b.ts', line: 7, title: 'aa bb cc dd', body: 'pp qq rr ss' });
    expect(wordJaccardSimilarity(a.title, b.title)).toBe(0.8);
    expect(wordJaccardSimilarity(a.body, b.body)).toBe(0.5);
    const result = dedupeComposite([a, b]);
    expect(result.survivors).toHaveLength(1);
    expect(result.merges[0].rule).toBe('rule4');
    expect(result.merges[0].titleSimilarity).toBeCloseTo(0.8, 12);
    expect(result.merges[0].bodySimilarity).toBeCloseTo(0.5, 12);
  });

  it('does NOT merge cross-path when title passes but body fails', () => {
    const a = finding({ path: 'src/a.ts', title: 'aa bb cc dd ee', body: 'pp qq rr ss tt' });
    const b = finding({ path: 'src/b.ts', title: 'aa bb cc dd', body: 'zz yy xx ww vv' });
    expect(wordJaccardSimilarity(a.title, b.title)).toBe(0.8);
    expect(wordJaccardSimilarity(a.body, b.body)).toBeLessThan(0.5);
    expect(dedupeComposite([a, b]).survivors).toHaveLength(2);
  });
});

describe('dedupeComposite — empty/punctuation titles never spuriously merge (finding #8a)', () => {
  it('same path + equal line + DIFFERENT category + pure-punctuation titles -> NO merge (rule2 sees 0)', () => {
    const a = finding({ path: 'src/a.ts', line: 5, category: 'quality', title: '...', body: 'x' });
    const b = finding({ path: 'src/a.ts', line: 5, category: 'bugs', title: '!!!', body: 'y' });
    expect(dedupeComposite([a, b]).survivors).toHaveLength(2);
  });

  it('same path + equal non-null line + SAME category + pure-punctuation titles -> merge via rule1 only', () => {
    const a = finding({ path: 'src/a.ts', line: 5, category: 'quality', title: '...', body: 'x' });
    const b = finding({ path: 'src/a.ts', line: 5, category: 'quality', title: '!!!', body: 'y' });
    const result = dedupeComposite([a, b]);
    expect(result.survivors).toHaveLength(1);
    expect(result.merges[0].rule).toBe('rule1');
  });
});

describe('dedupeComposite — null-line handling (A3, finding #8b)', () => {
  it('two both-null same-path findings merge ONLY through rule2 (title check required)', () => {
    const a = finding({ path: 'src/a.ts', line: null, category: 'quality', title: 'alpha beta gamma', body: 'x' });
    const b = finding({ path: 'src/a.ts', line: null, category: 'quality', title: 'alpha delta epsilon', body: 'y' });
    expect(wordJaccardSimilarity(a.title, b.title)).toBe(0.2);
    const result = dedupeComposite([a, b]);
    expect(result.survivors).toHaveLength(1);
    expect(result.merges[0].rule).toBe('rule2');
  });

  it('two both-null same-path findings with title-Jaccard < 0.2 do NOT merge', () => {
    const a = finding({ path: 'src/a.ts', line: null, category: 'quality', title: 'alpha beta gamma', body: 'x' });
    const b = finding({ path: 'src/a.ts', line: null, category: 'quality', title: 'alpha delta epsilon zeta', body: 'y' });
    expect(dedupeComposite([a, b]).survivors).toHaveLength(2);
  });

  it('exactly-one-null takes the different-line branch (rule 3, >= 0.6)', () => {
    const a = finding({ path: 'src/a.ts', line: 5, title: 'aa bb cc dd', body: 'x' });
    const b = finding({ path: 'src/a.ts', line: null, title: 'aa bb cc ee', body: 'y' });
    expect(wordJaccardSimilarity(a.title, b.title)).toBe(0.6);
    const result = dedupeComposite([a, b]);
    expect(result.survivors).toHaveLength(1);
    expect(result.merges[0].rule).toBe('rule3');
  });
});

describe('dedupeComposite — survivor selection + stable ordering', () => {
  it('keeps the higher-severity member as survivor regardless of input order', () => {
    const high = finding({ path: 'src/a.ts', line: 5, category: 'quality', severity: 'P0', title: 't1', body: 'x' });
    const low = finding({ path: 'src/a.ts', line: 5, category: 'quality', severity: 'nit', title: 't2', body: 'y' });
    const forward = dedupeComposite([low, high]);
    expect(forward.survivors).toHaveLength(1);
    expect(forward.survivors[0].severity).toBe('P0');
    expect(forward.merges[0].survivor.severity).toBe('P0');
    expect(forward.merges[0].suppressed.severity).toBe('nit');
    const reverse = dedupeComposite([high, low]);
    expect(reverse.survivors[0].severity).toBe('P0');
  });

  it('preserves input order for non-merged survivors', () => {
    const one = finding({ path: 'src/a.ts', title: 'alpha one', body: 'aaa' });
    const two = finding({ path: 'src/b.ts', title: 'beta two', body: 'bbb' });
    const three = finding({ path: 'src/c.ts', title: 'gamma three', body: 'ccc' });
    const result = dedupeComposite([one, two, three]);
    expect(result.survivors.map((s) => s.path)).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
    expect(result.merges).toHaveLength(0);
  });

  it('lets a later higher-severity finding replace an earlier survivor in its slot (position preserved)', () => {
    const x = finding({ path: 'src/a.ts', line: 5, category: 'quality', severity: 'nit', title: 't', body: 'x' });
    const y = finding({ path: 'src/a.ts', line: 5, category: 'quality', severity: 'P0', title: 't', body: 'y' });
    const z = finding({ path: 'src/z.ts', line: 1, title: 'unrelated words here', body: 'zzz' });
    const result = dedupeComposite([x, y, z]);
    expect(result.survivors).toHaveLength(2);
    expect(result.survivors[0].severity).toBe('P0'); // y replaced x in slot 0
    expect(result.survivors[0].path).toBe('src/a.ts');
    expect(result.survivors[1].path).toBe('src/z.ts');
  });
});
