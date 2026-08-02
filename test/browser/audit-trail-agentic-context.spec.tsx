// Phase 35 (PRD-06 / 35-06 Task 2) render backstop for the `agentic_context` audit row.
//
// `npm test` runs `vitest run --project node` only (scripts/test.mjs), and `AuditTrailViewer` is
// rendered NOWHERE in that project — so the render case added to audit-trail-viewer.tsx would be
// typechecked but never actually rendered by an executed test. The node specs prove
// `groupAuditByStage` routes the stage; they cannot prove the row's nine lines are right, and in
// particular they cannot prove the thing this row exists for:
//
//   A ZERO MUST RENDER AS A ZERO.
//
// `hops_used: 0`, `files_read: 0`, `greps_run: 0`, `bytes_gathered: 0`, `budget_headroom: 0`,
// `truncated: false` and `grep_supported: false` are all falsy and all diagnostic — 35-AI-SPEC.md §7
// samples `bytes_gathered == 0 && hops_used >= 2` at 100%. A truthy gate
// (`{event.bytes_gathered && <MetricLine …/>}`) deletes the single most diagnostic reading from the
// only surface that shows it and renders a stray literal `0` text node in its place. Only a real
// render catches that; `tsc` never will.
//
// Run with:
//   nix-shell shell.nix --run 'npx vitest run --project browser test/browser/audit-trail-agentic-context.spec.tsx'
//
// Deliberately free of the production-stylesheet machinery in visual-backstops.spec.tsx — these are
// text/structure assertions, not computed-style ones (the light/dark + long-text half of backstop
// B-1 lives there, where the real Tailwind build is loaded). Extends the shape of the sibling
// test/browser/audit-trail-skipped-comments.spec.tsx.

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AuditTrailViewer } from '@client/components/features/job-detail/audit-trail-viewer';
import type { JobAuditEvent, JobDetail } from '@shared/schema';
import { renderPage } from './render';

// This project has no auto-cleanup, and several cases below render the viewer more than once to
// compare two states. Without this, `screen.getByText('Audit trail')` finds the leftover trail from
// the previous render and throws "found multiple elements" instead of asserting anything.
afterEach(cleanup);

const TIMESTAMP = '2026-08-02T09:00:00.000Z';

function jobWith(...audit: Array<Partial<JobAuditEvent> & Record<string, unknown>>): JobDetail {
  return {
    audit: audit.map((event) => ({ timestamp: TIMESTAMP, ...event })),
    auditTruncated: false,
  } as unknown as JobDetail;
}

async function openTrail() {
  const user = userEvent.setup();
  await user.click(screen.getByText('Audit trail'));
}

// The nine metric labels, in the contract's fixed order: status -> outcome reason -> effort counts
// -> bound flags -> capability -> budget tail. Authored lowercase in source; CSS uppercases them.
const ORDERED_LABELS = [
  'status',
  'reason',
  'hops',
  'files read',
  'greps run',
  'bytes gathered',
  'truncated',
  'grep supported',
  'budget headroom',
];

/** The rendered row for the (single) agentic_context group. */
function agenticRow(): HTMLElement {
  const heading = screen.getByText('Agentic context');
  const group = heading.closest('div.rounded-md');
  if (!group) throw new Error('audit-trail-agentic-context.spec: no group shell around the label');
  const row = group.querySelector('li');
  if (!row) throw new Error('audit-trail-agentic-context.spec: no row inside the group');
  return row as HTMLElement;
}

/** The label spans actually rendered in the row, in DOM order. */
function renderedLabels(row: HTMLElement): string[] {
  return Array.from(row.querySelectorAll('span.uppercase')).map((el) => el.textContent ?? '');
}

describe('audit-trail viewer — agentic_context row (PRD-06)', () => {
  it('renders the group under the locked `Agentic context` label with a count badge', async () => {
    renderPage(<AuditTrailViewer job={jobWith({ stage: 'agentic_context', status: 'completed' })} />);
    await openTrail();

    const heading = screen.getByText('Agentic context');
    expect(heading).toBeInTheDocument();
    // Sentence case, matching every sibling label. Title case would break the whole trail's register.
    expect(screen.queryByText('Agentic Context')).not.toBeInTheDocument();
    const group = heading.closest('div.rounded-md')!;
    expect(within(group as HTMLElement).getByText('1')).toBeInTheDocument();
  });

  it('renders nine metric lines in the fixed order when every field is present — and NO `stage` line', async () => {
    renderPage(
      <AuditTrailViewer
        job={jobWith({
          stage: 'agentic_context',
          status: 'completed',
          reason: 'done',
          hops_used: 3,
          files_read: 2,
          greps_run: 1,
          bytes_gathered: 4096,
          truncated: false,
          grep_supported: true,
          budget_headroom: 7,
        })}
      />,
    );
    await openTrail();

    const row = agenticRow();
    expect(renderedLabels(row)).toEqual(ORDERED_LABELS);
    // The group heading already names the stage — this stage has its own dedicated display group
    // with exactly one literal, so a `stage` line would be pure redundancy. Copying the
    // walkthrough.enrichment case is the way an executor adds one by accident.
    expect(renderedLabels(row)).not.toContain('stage');
    expect(row.textContent).not.toContain('agentic_context');
  });

  it('THE ZERO GATE: renders every zero and false rather than dropping it, with no stray `0` text node', async () => {
    renderPage(
      <AuditTrailViewer
        job={jobWith({
          stage: 'agentic_context',
          status: 'skipped',
          reason: 'no_content',
          hops_used: 0,
          files_read: 0,
          greps_run: 0,
          bytes_gathered: 0,
          truncated: false,
          grep_supported: false,
          budget_headroom: 0,
        })}
      />,
    );
    await openTrail();

    const row = agenticRow();
    // All nine lines present — this fails the moment any gate becomes a truthy check.
    expect(renderedLabels(row)).toEqual(ORDERED_LABELS);

    const values = Array.from(row.querySelectorAll('span.font-mono')).map((el) => el.textContent);
    expect(values).toEqual([
      'skipped',
      'no_content',
      '0',
      '0',
      '0',
      '0',
      'false',
      'false',
      '0',
    ]);
    // A truthy gate renders `0` as a BARE text node outside any MetricLine span. Reconstructing the
    // row's whole text content from nothing but the label/value pairs proves there is no orphan
    // digit anywhere: any stray node would show up as text the reconstruction cannot account for.
    const labels = renderedLabels(row);
    const reconstructed = labels.map((label, index) => label + values[index]).join('');
    const strip = (text: string) => text.replace(/\s+/g, '');
    expect(strip(row.textContent ?? '')).toBe(strip(reconstructed));
  });

  it('renders a partial subset without placeholders — a skipped event with only status + reason is two lines', async () => {
    renderPage(
      <AuditTrailViewer
        job={jobWith({ stage: 'agentic_context', status: 'skipped', reason: 'index_present' })}
      />,
    );
    await openTrail();

    const row = agenticRow();
    expect(renderedLabels(row)).toEqual(['status', 'reason']);
    // Absent means omit. No em dash, no N/A, no (none), no 0 placeholder.
    for (const placeholder of ['—', 'N/A', '(none)']) {
      expect(row.textContent).not.toContain(placeholder);
    }
  });

  it('renders `status: failed` as a neutral token — no destructive styling, no icon, no inline style', async () => {
    // D-11: `failed` here means the advisory loop yielded nothing and the job proceeded anyway. It
    // is NOT a job failure, so the row's class list must be identical to the completed case's.
    renderPage(
      <AuditTrailViewer
        job={jobWith({ stage: 'agentic_context', status: 'failed', reason: 'budget_exhausted' })}
      />,
    );
    await openTrail();
    const failedRow = agenticRow();
    const failedClasses = failedRow.className;
    expect(failedRow.querySelector('svg')).toBeNull();
    expect(failedRow.getAttribute('style')).toBeNull();
    expect(failedClasses).not.toMatch(/destructive|warning|red|danger/);
    expect(screen.getByText('failed')).toBeInTheDocument();

    // Byte-identical row shell to the completed case — the `<li>` class list must not vary by status.
    cleanup();
    renderPage(
      <AuditTrailViewer job={jobWith({ stage: 'agentic_context', status: 'completed' })} />,
    );
    await openTrail();
    expect(agenticRow().className).toBe(failedClasses);
  });

  it('renders `grep supported: false` as the neutral token `false`, never a reworded failure', async () => {
    // On Bitbucket this is the documented expected steady state (§7 must-not-alert); on GitHub it is
    // a real signal. The viewer cannot tell which, so it states the fact and editorialises nothing.
    renderPage(
      <AuditTrailViewer
        job={jobWith({ stage: 'agentic_context', status: 'completed', grep_supported: false })}
      />,
    );
    await openTrail();

    const row = agenticRow();
    expect(renderedLabels(row)).toEqual(['status', 'grep supported']);
    expect(within(row).getByText('false')).toBeInTheDocument();
    for (const reworded of ['unsupported', 'unavailable', 'error', 'missing']) {
      expect(row.textContent).not.toContain(reworded);
    }
  });

  it('renders `reason` verbatim — the machine token, never a humanised sentence', async () => {
    renderPage(
      <AuditTrailViewer
        job={jobWith({ stage: 'agentic_context', status: 'partial', reason: 'unparseable_action' })}
      />,
    );
    await openTrail();

    // This literal is what §7's alert thresholds and an operator's SQL / `wrangler tail` greps
    // match on, so any humanisation breaks the operator's tooling.
    expect(screen.getByText('unparseable_action')).toBeInTheDocument();
    expect(agenticRow().textContent).not.toMatch(/unparseable tool call|could not parse/i);
  });

  it('renders `hops` as a bare integer, never as a ratio against the hop cap', async () => {
    renderPage(
      <AuditTrailViewer
        job={jobWith({ stage: 'agentic_context', status: 'completed', hops_used: 3 })}
      />,
    );
    await openTrail();

    const row = agenticRow();
    expect(within(row).getByText('3')).toBeInTheDocument();
    // The arm carries no cap field; duplicating a server tuning constant into the client is the
    // drift the codebase's constant-comment convention exists to prevent.
    expect(row.textContent).not.toContain('/ 6');
    expect(row.textContent).not.toContain('of 6');
  });

  it('B-3: an unexpected passthrough key renders nothing, surfaces nowhere, and does not throw', async () => {
    // The render-side half of the T-35-21 counts-not-content boundary. The arm is `.passthrough()`,
    // so an event written by a future deploy may carry keys this build has never seen; a generic
    // renderer would put them in front of an operator unreviewed.
    renderPage(
      <AuditTrailViewer
        job={jobWith({
          stage: 'agentic_context',
          status: 'completed',
          hops_used: 1,
          gathered_path: 'src/server/core/secret-handler.ts',
          future_flag: true,
        })}
      />,
    );
    await openTrail();

    const row = agenticRow();
    expect(renderedLabels(row)).toEqual(['status', 'hops']);
    expect(row.textContent).not.toContain('gathered_path');
    expect(row.textContent).not.toContain('secret-handler');
    expect(row.textContent).not.toContain('future_flag');
    expect(document.body.textContent).not.toContain('secret-handler');
  });

  it('renders the group EXPANDED (DecisionGroup), not behind a collapsed disclosure', async () => {
    // The stage emits at most one event per job, so collapsing would hide a single row behind a
    // click. Only `drafted` takes the collapsed path.
    renderPage(
      <AuditTrailViewer
        job={jobWith(
          { stage: 'agentic_context', status: 'completed', reason: 'done' },
          { stage: 'drafted', file: 'src/x.ts', pass: 'main' },
        )}
      />,
    );
    await openTrail();

    expect(screen.getByText('done')).toBeVisible();
    const group = screen.getByText('Agentic context').closest('div.rounded-md')!;
    expect(group.closest('details')!.textContent).toContain('Audit trail');
    expect(group.querySelector('details')).toBeNull();
  });

  it('B-2 rendered: absent at zero events, one row at one, two stacked rows at two', async () => {
    // Zero — the toggle-off run's correct UI is the absence of the group entirely (NREG-01), with
    // no empty-state copy of its own. A sibling stage is present so the trail is not merely empty.
    renderPage(
      <AuditTrailViewer job={jobWith({ stage: 'cross_file_security', status: 'completed' })} />,
    );
    await openTrail();
    expect(screen.getByText('Cross-file security')).toBeInTheDocument();
    expect(screen.queryByText('Agentic context')).not.toBeInTheDocument();
    cleanup();

    // One.
    renderPage(
      <AuditTrailViewer job={jobWith({ stage: 'agentic_context', status: 'completed' })} />,
    );
    await openTrail();
    let group = screen.getByText('Agentic context').closest('div.rounded-md')! as HTMLElement;
    expect(group.querySelectorAll('li')).toHaveLength(1);
    expect(within(group).getByText('1')).toBeInTheDocument();
    cleanup();

    // Two — not producible today (Task 3 emits at most one per job and re-entry emits none), but the
    // group must count both and stack the rows without the layout implying an error.
    renderPage(
      <AuditTrailViewer
        job={jobWith(
          { stage: 'agentic_context', status: 'completed', reason: 'done' },
          { stage: 'agentic_context', status: 'skipped', reason: 'no_content' },
        )}
      />,
    );
    await openTrail();
    group = screen.getByText('Agentic context').closest('div.rounded-md')! as HTMLElement;
    expect(group.querySelectorAll('li')).toHaveLength(2);
    expect(within(group).getByText('2')).toBeInTheDocument();
    expect(within(group).getByText('done')).toBeInTheDocument();
    expect(within(group).getByText('no_content')).toBeInTheDocument();
  });
});
