import type { ParsedReviewComment } from '@shared/schema';
import { reviewSeverities } from '@shared/schema';

// Defense-in-depth HTML escaper for the plain-text comment `title` before it is interpolated into
// a `<strong>...</strong>` tag. The title is plain text per schema (not model-authored Markdown),
// so escaping `<`/`&`/etc. cannot break intended formatting. This is NOT applied to `body`: the
// body is model-authored Markdown meant to render, and every sink already sanitizes it (VCS
// platforms + the dashboard's rehypeSanitize), so escaping it would corrupt intended formatting.
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Walkthrough rendering caps (D-04, threats T-09-03/T-09-11). A large PR or a verbose/hostile
// per-file summary must never produce a body that exceeds provider comment-size limits (GitHub is
// ~65 KB; Bitbucket is smaller). Three independent bounds work together:
//  - WALKTHROUGH_FILE_CAP: max table rows rendered; the remainder collapses to a "+N more" line.
//  - WALKTHROUGH_CELL_MAX: max chars per table cell (path AND summary), truncated with an ellipsis.
//  - WALKTHROUGH_BODY_MAX: a hard total-body ceiling backstop, well under GitHub's ~65 KB limit,
//    enforced by dropping trailing rows so the returned body length is provably bounded regardless
//    of per-cell content.
const WALKTHROUGH_FILE_CAP = 30;
const WALKTHROUGH_CELL_MAX = 240;
const WALKTHROUGH_BODY_MAX = 60_000;

// Neutralize a value for safe interpolation into a single Markdown table cell. `escapeHtml` does NOT
// cover the characters that break a table: `|` terminates a cell, backticks can open/close an
// inline-code span that bleeds across cells, and a literal newline ends the table row. The per-file
// `summary` is untrusted, unbounded, possibly multi-line model output (Option A reuse of the
// existing `file_summary`), so every cell (path AND summary, on both providers) MUST pass through
// here so a malicious/verbose summary renders as exactly one intact row and cannot inject markup
// (threat T-09-11).
//
// Backslash is escaped FIRST, before `|`/backtick. If it were escaped after (or not at all), an
// input that already contains a backslash immediately before a pipe (e.g. `a\|b`) would produce an
// EVEN number of backslashes before the `|` once the pipe-escaping backslash is inserted — the
// pre-existing backslash pairs with the new one and renders as a single literal `\`, leaving the
// original `|` unescaped and able to terminate the table cell (CodeQL `js/incomplete-sanitization`,
// T-09-11). Escaping backslash first guarantees an ODD backslash count before every escaped `|`,
// so the pipe is always correctly escaped regardless of pre-existing backslashes in the input.
function formatMarkdownTableCell(value: string): string {
  const flattened = value.replace(/[\r\n]+/g, ' ').trim();
  const escaped = flattened.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/`/g, '\\`');
  if (escaped.length <= WALKTHROUGH_CELL_MAX) return escaped;
  // Trim a dangling escape backslash so truncation can never leave a `\` that swallows the cell's
  // closing ` |` delimiter.
  return `${escaped.slice(0, WALKTHROUGH_CELL_MAX - 1).replace(/\\+$/, '')}…`;
}

// Provider discriminator consumed by `severityIcon` and forwarded by `formatInlineComment`. The
// formatter-level branch keeps the Bitbucket-specific emoji rendering isolated from the GitHub
// path so reviewers can see at a glance that the GitHub <img> output is byte-identical (D-13).
export type FormatterProvider = 'github' | 'bitbucket';
export type FormatterOptions = { provider?: FormatterProvider };

export class FormatterService {
  constructor(private baseUrl: string) {}

  severityIcon(severity: ParsedReviewComment['severity'], options?: FormatterOptions) {
    // D-13: Bitbucket has no native PR-label-style icon assets; emoji is the supported inline
    // rendering. The switch remains the same; only the per-case output changes when provider is
    // 'bitbucket'. Any other provider value (including the default 'github' / undefined path) uses
    // the existing <img> shape byte-identically.
    if (options?.provider === 'bitbucket') {
      switch (severity) {
        case 'P0':  return '🚨 P0';
        case 'P1':  return '⚠️ P1';
        case 'P2':  return '⚠️ P2';
        case 'P3':  return 'ℹ️ P3';
        case 'nit': return '💬 nit';
        default:    return '⚪';
      }
    }

    const iconBase = `${this.baseUrl}/icons`;
    const img = (name: string, alt: string) =>
      `<img src="${iconBase}/${name}-icon.svg" width="20" height="20" alt="${alt}" style="vertical-align:middle" />`;
    switch (severity) {
      case 'P0':  return img('p0',  'P0');
      case 'P1':  return img('p1',  'P1');
      case 'P2':  return img('p2',  'P2');
      case 'P3':  return img('p3',  'P3');
      case 'nit': return img('nit', 'nit');
      default:    return '⚪';
    }
  }

  /** Strip leading emoji / legacy tag prefixes from a string (same logic as model-output cleanText). */
  stripLeadingTags(text: string): string {
    let current = text.trim();
    let prev = '';
    while (current !== prev) {
      prev = current;
      current = current
        .replace(/^([\u{1F300}-\u{1F9FF}\u{2600}-\u{27BF}\u{FE00}-\u{FEFF}]|\[QUALITY\]|\[SECURITY\]|\[BUG\]|\[P[0-3]\]|\[NIT\]|QUALITY|SECURITY|BUG|P[0-3]|NIT|[:\-\s\uFE0F]|[^\w\s])+/giu, '')
        .trim();
    }
    return current;
  }

  formatInlineComment(comment: ParsedReviewComment, options?: FormatterOptions) {
    // Clean the body: strip any residual prefix tags, then remove a leading line
    // that duplicates the title (can happen with stale DB records).
    let body = this.stripLeadingTags(comment.body);
    const firstLine = body.split('\n')[0].trim();
    const cleanFirstLine = this.stripLeadingTags(firstLine);
    if (
      cleanFirstLine.toLowerCase().startsWith(comment.title.toLowerCase()) ||
      comment.title.toLowerCase().startsWith(cleanFirstLine.toLowerCase())
    ) {
      body = body.slice(firstLine.length).replace(/^[\n\r]+/, '');
    }

    // Escape the title only (defense-in-depth) — body is intentionally left as-is (sanitized
    // Markdown at every sink; escaping it would break rendering).
    return `${this.severityIcon(comment.severity, options)} <strong>${escapeHtml(comment.title)}</strong>\n\n${body}`;
  }

  summarizeVerdict(comments: ParsedReviewComment[], hasFailures: boolean) {
    const p0 = comments.filter((c) => c.severity === 'P0').length;
    const p1 = comments.filter((c) => c.severity === 'P1').length;
    const p2 = comments.filter((c) => c.severity === 'P2').length;

    if (p0 > 0 || p1 > 0 || hasFailures || p2 > 0) {
      return { verdict: 'comment' as const, errors: p0 + p1, warnings: p2 };
    }

    return { verdict: 'approve' as const, errors: 0, warnings: 0 };
  }

  /**
   * Assembles the "Review Overview" block posted to the PR (and rendered verbatim in the
   * dashboard job-detail panel via `summary_markdown`). Combines a best-effort AI `narrative`
   * with a deterministic recap (verdict, confidence, non-zero severity counts, up to 5 top
   * findings, and a files-reviewed/omitted footer) — see
   * docs/superpowers/specs/2026-07-19-review-overview-design.md §1.
   *
   * `commitSha` is accepted for interface parity with the design's input shape but intentionally
   * never rendered — the new format has no "Reviewed commit" line.
   */
  formatReviewOverview(
    input: {
      commitSha: string;
      botUsername: string;
      narrative: string | null;
      verdict: 'approve' | 'comment';
      confidenceScore: number | null;
      severityCounts: Record<ParsedReviewComment['severity'], number>;
      topFindings: Array<{ severity: ParsedReviewComment['severity']; title: string; path: string }>;
      filesReviewed: number;
      omittedCount: number;
      maxComments: number;
      // CMD-01/CMD-02 (D-10/D-11, Phase 11): commands-feature footer additions. Both default to
      // inert (false / 0) so a caller that omits them renders the exact current footer byte-identically
      // (NREG-01) -- the disabled path never gains a line.
      commandsEnabled?: boolean;
      skippedForSizeCount?: number;
    },
    options?: FormatterOptions,
  ) {
    const {
      botUsername,
      narrative,
      verdict,
      confidenceScore,
      severityCounts,
      topFindings,
      filesReviewed,
      omittedCount,
    } = input;
    const commandsEnabled = input.commandsEnabled ?? false;
    const skippedForSizeCount = input.skippedForSizeCount ?? 0;

    const totalFindings = reviewSeverities.reduce((sum, sev) => sum + (severityCounts[sev] ?? 0), 0);
    const zeroFindings = verdict === 'approve' && totalFindings === 0;

    const fileWord = `${filesReviewed} file${filesReviewed === 1 ? '' : 's'} reviewed`;
    const footer =
      omittedCount > 0
        ? `_${fileWord} · ${omittedCount} comments trimmed to ${input.maxComments}_`
        : `_${fileWord}_`;

    const sections: string[] = [];
    if (narrative && narrative.trim().length > 0) {
      sections.push(narrative.trim());
    }

    if (zeroFindings) {
      sections.push('**No issues found**');
    } else {
      const verdictLabel = verdict === 'approve' ? 'Approved' : 'Changes requested';
      const confidenceSuffix =
        confidenceScore !== null ? ` · Confidence ${Math.round(confidenceScore * 100)}%` : '';
      sections.push(`**Verdict:** ${verdictLabel}${confidenceSuffix}`);

      const countsLine = reviewSeverities
        .filter((sev) => (severityCounts[sev] ?? 0) > 0)
        .map((sev) => `${this.severityIcon(sev, { provider: 'bitbucket' })} ×${severityCounts[sev]}`)
        .join('  ');
      if (countsLine) {
        sections.push(countsLine);
      }

      if (topFindings.length > 0) {
        const findingLines = topFindings
          .map((f) => `- ${this.severityIcon(f.severity, options)} ${escapeHtml(f.title)} — \`${f.path}\``)
          .join('\n');
        sections.push(`**Top findings**\n${findingLines}`);
      }
    }

    sections.push(footer);

    // CMD-01/CMD-02 footer additions, only when the commands feature is ENABLED (disabled path stays
    // byte-identical, NREG-01):
    //   - D-10: a "N files skipped for size — comment @bot review-rest" line ONLY when omissions exist.
    //   - D-11 (discoverability): the compact "Commands: review · pause · help" hint ALWAYS (regardless
    //     of omission count -- REVIEW: Codex 11-05 MED: the hint must NOT be gated on omissions).
    if (commandsEnabled) {
      if (skippedForSizeCount > 0) {
        const skippedWord = `${skippedForSizeCount} file${skippedForSizeCount === 1 ? '' : 's'} skipped for size`;
        sections.push(`_${skippedWord} — comment @${botUsername} review-rest_`);
      }
      sections.push(`_Commands: @${botUsername} review · pause · help_`);
    }

    const bodyBlock = sections.join('\n\n');

    // D-13 (Thread C): Bitbucket Cloud does not render GitHub-flavored HTML — <details>/<summary>/
    // <br/> are sanitized to junk, and the "in GitHub" copy plus @mention / draft / 👍 semantics
    // are GitHub-only. Emit clean CommonMark with Bitbucket-accurate trigger copy instead. The
    // GitHub branch below is byte-identical to the pre-Thread-C output (regression-guarded).
    if (options?.provider === 'bitbucket') {
      return `### OpenCodra Review

${bodyBlock}

[OpenCodra](${this.baseUrl}/repos) automatically reviews pull requests in this repository. A review runs when you open a pull request or push new commits to it.`;
    }

    return `### OpenCodra Review

${bodyBlock}

<details>
<summary>About OpenCodra</summary>

<br/>

[Your team has set up OpenCodra to review pull requests in this repo](${this.baseUrl}/repos). Reviews are triggered when you:

- **Open** a pull request for review
- **Mark** a draft as ready
- **Comment** "@${botUsername} review"

If OpenCodra has suggestions, it will comment; otherwise it will react with 👍.

OpenCodra can also answer questions or update the PR. Try commenting "@${botUsername} address that feedback".

</details>`;
  }

  /**
   * Renders the streaming "Walkthrough" comment body: a file-coverage table (path + one-line review
   * summary + that file's per-severity finding counts) plus a per-severity totals line, and — on
   * GitHub only — a fenced Mermaid sequence diagram. Pure/deterministic: Wave 2/3 orchestration
   * (Plans 09-02/09-03) computes the inputs and posts/edits the returned body.
   *
   * Provider awareness (D-13, threat T-09-01): the Bitbucket branch emits clean CommonMark and NEVER
   * a ```mermaid fence (Bitbucket does not sandbox-render Mermaid); GitHub gets the fence when a
   * non-empty raw diagram source is supplied. `formatWalkthrough` is the SOLE place the fence is
   * added — `mermaid` arrives fence-free from `parseWalkthroughDiagram` (WT-03 fence contract).
   *
   * Every table cell passes through `formatMarkdownTableCell` (threat T-09-11); the body is bounded
   * by WALKTHROUGH_FILE_CAP rows, WALKTHROUGH_CELL_MAX per cell, and a WALKTHROUGH_BODY_MAX ceiling
   * (D-04). Empty summaries and a null `mermaid` still render deterministic coverage + counts
   * (D-02/D-04a) — never throws.
   */
  formatWalkthrough(
    input: {
      files: Array<{
        path: string;
        summary: string;
        counts: Record<ParsedReviewComment['severity'], number>;
      }>;
      severityCounts: Record<ParsedReviewComment['severity'], number>;
      filesReviewed: number;
      threadVerification?:
        | {
            status: 'completed';
            totals: { fixed: number; unfixed: number; unverifiable: number; resolved: number };
          }
        | { status: 'degraded' };
      mermaid?: string | null;
    },
    options?: FormatterOptions,
  ): string {
    const isBitbucket = options?.provider === 'bitbucket';
    const { files, severityCounts, filesReviewed } = input;

    const fileWord = `${filesReviewed} file${filesReviewed === 1 ? '' : 's'} reviewed`;

    // Per-severity totals line — emoji render identically on both providers (mirrors
    // formatReviewOverview's counts line). Non-zero severities only, in canonical order.
    const countsLine = reviewSeverities
      .filter((sev) => (severityCounts?.[sev] ?? 0) > 0)
      .map((sev) => `${this.severityIcon(sev, { provider: 'bitbucket' })} ×${severityCounts[sev]}`)
      .join('  ');

    const renderCountsCell = (counts: Record<ParsedReviewComment['severity'], number>): string => {
      const parts = reviewSeverities
        .filter((sev) => (counts?.[sev] ?? 0) > 0)
        .map((sev) => `${this.severityIcon(sev, { provider: 'bitbucket' })}×${counts[sev]}`);
      return parts.length > 0 ? parts.join(' ') : '—';
    };

    const renderRow = (file: {
      path: string;
      summary: string;
      counts: Record<ParsedReviewComment['severity'], number>;
    }): string => {
      // path may be escapeHtml'd first on the GitHub HTML branch, but formatMarkdownTableCell is the
      // mandatory sink for BOTH cells on BOTH providers.
      const pathCell = formatMarkdownTableCell(isBitbucket ? file.path : escapeHtml(file.path));
      const summaryCell = formatMarkdownTableCell(file.summary ?? '');
      return `| ${pathCell || '—'} | ${summaryCell || '—'} | ${renderCountsCell(file.counts)} |`;
    };

    const tableHeader = '| File | Summary | Findings |\n| --- | --- | --- |';

    const buildBody = (rowCount: number, truncated: boolean): string => {
      const sections: string[] = ['### OpenCodra Walkthrough'];
      if (countsLine) sections.push(countsLine);

      if (input.threadVerification?.status === 'completed') {
        const { fixed, unfixed, unverifiable, resolved } = input.threadVerification.totals;
        sections.push(
          `**Thread verification:** Fixed ${fixed} · Unfixed ${unfixed} · Unverifiable ${unverifiable} · Resolved ${resolved}`,
        );
      } else if (input.threadVerification?.status === 'degraded') {
        sections.push('**Thread verification:** Unavailable (degraded)');
      }

      const renderedRows = files.slice(0, rowCount).map(renderRow);
      sections.push([tableHeader, ...renderedRows].join('\n'));

      const overflow = files.length - rowCount;
      if (overflow > 0) {
        sections.push(`_+${overflow} more files reviewed_`);
      } else if (truncated) {
        sections.push('_…walkthrough truncated_');
      }

      sections.push(`_${fileWord}_`);

      if (!isBitbucket && typeof input.mermaid === 'string' && input.mermaid.trim().length > 0) {
        sections.push('```mermaid\n' + input.mermaid.trim() + '\n```');
      }

      return sections.join('\n\n');
    };

    // Row cap (D-04): render at most WALKTHROUGH_FILE_CAP rows (caller supplies them pre-sorted);
    // the remainder collapses to a "+N more files reviewed" line.
    let rowCount = Math.min(files.length, WALKTHROUGH_FILE_CAP);
    let body = buildBody(rowCount, false);

    // Total-body ceiling backstop (threat T-09-03): drop trailing rows until the body is provably
    // under WALKTHROUGH_BODY_MAX regardless of per-cell content.
    let truncated = false;
    while (body.length > WALKTHROUGH_BODY_MAX && rowCount > 0) {
      rowCount -= 1;
      truncated = true;
      body = buildBody(rowCount, truncated);
    }

    return body;
  }
}
