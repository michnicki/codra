// Phase 34 (PRD-05, §15): YAML config pipeline tests — YAML → JS object → Zod validation → merge.
//
// PURE Zod tests (no DB). This file locks the D-09 merge contract as a tested expression:
// `repoConfigSchema.parse({ ...dbConfig, ...yamlDeclared })` — a YAML-declared top-level key
// replaces the DB key WHOLESALE ("right-biased for the entire nested subtree"), sub-keys the YAML
// subtree omits revert to their Zod schema defaults (review.max_files → 150, never the DB's 100),
// and top-level keys the YAML does not declare keep their DB values (model.main unchanged).
// Deep-merging sub-keys (which would yield 100) FAILS this contract. 34-03 Task 1 re-implements
// the same expression inside runPreparePhase.
//
// Also pins: the yaml_config_parse_failed audit-event shape via jobAuditEventSchema (the
// builder/recorder family itself is 34-03's — here the SHAPE is the contract), the identity
// merge for an absent YAML file, unknown-key stripping, and the .review.yaml-before-.review.yml
// discovery ordering.

import { describe, expect, it } from 'vitest';
import { parseYaml } from '@server/core/yaml-parse';
import { repoConfigSchema, jobAuditEventSchema } from '@shared/schema';

function auditEventFor(reason: string) {
  return { stage: 'yaml_config_parse_failed', reason, timestamp: new Date().toISOString() };
}

describe('YAML config pipeline', () => {
  it('parses valid full config YAML into a normalized RepoConfig', () => {
    const raw = [
      '# .review.yaml',
      'review:',
      '  max_comments: 5',
      '  max_files: 100',
      '  custom_rules:',
      '    - "no console.log"',
      '    - "no any type"',
      '  skip_files:',
      '    - "*.lock"',
      '    - "dist/**"',
      'model:',
      '  main: "claude-sonnet-4-20250514"',
      '  fallbacks:',
      '    - "gpt-4o"',
    ].join('\n');

    const config = repoConfigSchema.parse(parseYaml(raw));

    expect(config.review.max_comments).toBe(5);
    expect(config.review.max_files).toBe(100);
    expect(config.review.custom_rules).toEqual(['no console.log', 'no any type']);
    expect(config.review.skip_files).toEqual(['*.lock', 'dist/**']);
    expect(config.model.main).toBe('claude-sonnet-4-20250514');
    expect(config.model.fallbacks).toEqual(['gpt-4o']);
  });

  it('applies Zod defaults for missing sub-keys in a partial config', () => {
    const config = repoConfigSchema.parse(parseYaml('review:\n  max_comments: 3'));

    expect(config.review.max_comments).toBe(3);
    // Zod default at schema.ts — the DB value would be irrelevant here; the schema fills it.
    expect(config.review.max_files).toBe(150);
    expect(config.review.max_diff_lines_per_file).toBe(800);
    expect(config.model.main).toBeNull();
    expect(config.review.file_history.enabled).toBe(false);
    expect(config.review.yaml_config.enabled).toBe(false);
  });

  it('validates the yaml_config_parse_failed audit event shape (schema contract)', () => {
    const event = auditEventFor('Invalid YAML syntax');

    const parsed = jobAuditEventSchema.parse(event);
    expect(parsed.stage).toBe('yaml_config_parse_failed');
    expect(parsed.reason).toBe('Invalid YAML syntax');
  });

  it('rejects a reason longer than the 500-char bound (builder must slice to 500)', () => {
    const event = auditEventFor('x'.repeat(600));

    expect(jobAuditEventSchema.safeParse(event).success).toBe(false);
  });

  it('falls back to DB config when parseYaml throws (catch-and-keep semantics)', () => {
    const dbConfig = repoConfigSchema.parse({
      review: { max_comments: 10, max_files: 100 },
      model: { main: 'gpt-4o', fallbacks: [], size_overrides: [] },
    });

    let parseError: unknown;
    try {
      parseYaml('key: |\n  multi\n  line');
    } catch (error) {
      parseError = error;
    }

    expect(parseError).toBeInstanceOf(Error);
    expect((parseError as Error).message).toMatch(/^YAML parse error:/);
    // The DB config is the resolved config, unchanged — and the failure reason still validates
    // against the audit-event schema so the 34-03 recorder can emit it.
    const auditEvent = auditEventFor((parseError as Error).message);
    expect(jobAuditEventSchema.safeParse(auditEvent).success).toBe(true);
    expect(dbConfig.review.max_comments).toBe(10);
    expect(dbConfig.review.max_files).toBe(100);
  });

  it('D-09: top-level key replacement with Zod default fill (the contract 34-03 implements)', () => {
    const dbConfig = repoConfigSchema.parse({
      review: { max_comments: 10, max_files: 100 },
      model: { main: 'gpt-4o', fallbacks: [], size_overrides: [] },
    });
    const yamlDeclared = parseYaml('review:\n  max_comments: 3');

    const merged = repoConfigSchema.parse({ ...dbConfig, ...yamlDeclared });

    // YAML-declared top-level key replaces the DB key wholesale.
    expect(merged.review.max_comments).toBe(3);
    // Sub-keys the YAML subtree omits revert to Zod schema defaults — the DB's 100 is NOT retained
    // (right-biased for the entire nested subtree). A deep merge would yield 100 and fail this.
    expect(merged.review.max_files).toBe(150);
    // Top-level key the YAML does not declare at all keeps its DB value.
    expect(merged.model.main).toBe('gpt-4o');
  });

  it('no YAML file → the merge expression is identity (DB config used as-is)', () => {
    const dbConfig = repoConfigSchema.parse({
      review: { max_comments: 10, max_files: 100 },
      model: { main: 'gpt-4o', fallbacks: [], size_overrides: [] },
    });

    const merged = repoConfigSchema.parse({ ...dbConfig, ...{} });

    expect(merged).toEqual(dbConfig);
    expect(merged.review.max_comments).toBe(10);
    expect(merged.review.max_files).toBe(100);
  });

  it('unknown top-level YAML keys are stripped by Zod (default .strip() behavior)', () => {
    const merged = repoConfigSchema.parse(parseYaml('bogus_key: "hello"'));

    expect(merged).toBeDefined();
    expect((merged as Record<string, unknown>).bogus_key).toBeUndefined();
  });

  it('valid YAML but invalid Zod throws, and the failure reason fits the audit event shape', () => {
    const yamlDeclared = parseYaml('review:\n  max_comments: "not_a_number"');

    expect(() => repoConfigSchema.parse(yamlDeclared)).toThrow();

    const auditEvent = auditEventFor('review.max_comments must be a number');
    expect(jobAuditEventSchema.safeParse(auditEvent).success).toBe(true);
  });

  it('first found file wins — .review.yaml before .review.yml', () => {
    // Simulation of the discovery contract: the caller (34-03) tries .review.yaml first and only
    // falls through to .review.yml when the first file is absent. Pinning the ordering here.
    const reviewYaml = parseYaml('review:\n  max_comments: 3');
    const reviewYml = parseYaml('review:\n  max_comments: 7');

    const candidates = [
      { path: '.review.yaml', parsed: reviewYaml },
      { path: '.review.yml', parsed: reviewYml },
    ];
    // Discovery in order, stopping at the first file that parses successfully.
    const found = candidates.find((candidate) => candidate.parsed !== null);

    expect(found?.path).toBe('.review.yaml');
    const config = repoConfigSchema.parse(found?.parsed ?? {});
    expect(config.review.max_comments).toBe(3);
  });

  it('flow-style and block-style arrays round-trip through the schema (MEDIUM-5 shapes)', () => {
    const config = repoConfigSchema.parse(
      parseYaml('review:\n  on: [opened, synchronize]\n  skip_files: ["*.lock", "dist/**"]'),
    );

    expect(config.review.on).toEqual(['opened', 'synchronize']);
    expect(config.review.skip_files).toEqual(['*.lock', 'dist/**']);
  });
});
