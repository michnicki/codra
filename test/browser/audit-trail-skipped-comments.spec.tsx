// Code-review WR-01 / WR-03 / WR-06 render backstop for the audit-trail viewer.
//
// `npm test` runs `vitest run --project node` only (scripts/test.mjs), and `AuditTrailViewer` is
// rendered NOWHERE in that project — so the 76-line WR-01/WR-03/WR-06 change to
// audit-trail-viewer.tsx was typechecked but never actually rendered by an executed test. The node
// specs prove `groupAuditByStage` routes the stages; they cannot prove the row TEXT is right.
// That distinction matters here because the whole point of WR-01 is that a GitHub diff `position`
// must never be printed in the `:N` form an operator reads as a head-side line number.
//
// Run with:
//   nix-shell shell.nix --run 'npx vitest run --project browser test/browser/audit-trail-skipped-comments.spec.tsx'
//
// Deliberately free of the production-stylesheet machinery in visual-backstops.spec.tsx — these are
// text/structure assertions, not computed-style ones, so they need no CSS and no VITEST_BROWSER_OK gate.

import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AuditTrailViewer } from '@client/components/features/job-detail/audit-trail-viewer';
import type { JobDetail } from '@shared/schema';
import { renderPage } from './render';

const TIMESTAMP = '2026-08-01T09:00:00.000Z';

// One event per coordinate case the WR-01 split produces. GitHub fills `position` and leaves `line`
// null; Bitbucket fills `line` and leaves `position` null; the WR-04 no-position drop path has
// neither. All three carry a `commentId` (WR-06) and NO title — the sample schema has no title field.
function jobWithSkips(): JobDetail {
  return {
    audit: [
      {
        stage: 'inline_comment_skipped',
        count: 3,
        sample: [
          { path: 'src/gh.ts', line: null, position: 3, commentId: '4242' },
          { path: 'src/bb.ts', line: 12, position: null, commentId: '99' },
          { path: 'src/none.ts', line: null, position: null, commentId: '7' },
        ],
        timestamp: TIMESTAMP,
      },
    ],
    auditTruncated: false,
  } as unknown as JobDetail;
}

async function openTrail() {
  const user = userEvent.setup();
  await user.click(screen.getByText('Audit trail'));
}

describe('audit-trail viewer — inline_comment_skipped rows (WR-01/WR-06)', () => {
  it('renders a GitHub skip as `@pos N`, never as `:N`', async () => {
    renderPage(<AuditTrailViewer job={jobWithSkips()} />);
    await openTrail();

    // The WHOLE point of WR-01: a diff offset must not be printed in the line-number form.
    expect(screen.getByText(/^src\/gh\.ts @pos 3$/)).toBeInTheDocument();
    expect(screen.queryByText(/^src\/gh\.ts:3$/)).not.toBeInTheDocument();
  });

  it('renders a Bitbucket skip as `:N` (a real head-side line number)', async () => {
    renderPage(<AuditTrailViewer job={jobWithSkips()} />);
    await openTrail();

    expect(screen.getByText(/^src\/bb\.ts:12$/)).toBeInTheDocument();
    expect(screen.queryByText(/src\/bb\.ts @pos/)).not.toBeInTheDocument();
  });

  it('renders a coordinate-less skip as the bare path', async () => {
    renderPage(<AuditTrailViewer job={jobWithSkips()} />);
    await openTrail();

    expect(screen.getByText(/^src\/none\.ts$/)).toBeInTheDocument();
  });

  it('renders the persisted review_comments id as `#id` on every sample row (WR-06)', async () => {
    renderPage(<AuditTrailViewer job={jobWithSkips()} />);
    await openTrail();

    for (const id of ['#4242', '#99', '#7']) {
      expect(screen.getByText(id)).toBeInTheDocument();
    }
  });

  it('shows no redacted-title marker anywhere — WR-06 removed the title from the sample entirely', async () => {
    renderPage(<AuditTrailViewer job={jobWithSkips()} />);
    await openTrail();

    expect(screen.queryByText(/title-redacted/)).not.toBeInTheDocument();
    expect(screen.queryByText(/clamped:empty/)).not.toBeInTheDocument();
  });

  it('renders the group under its own "Inline comments skipped" heading', async () => {
    renderPage(<AuditTrailViewer job={jobWithSkips()} />);
    await openTrail();

    expect(screen.getByText('Inline comments skipped')).toBeInTheDocument();
  });
});

describe('audit-trail viewer — stages WR-03 rescued from silent discard', () => {
  // Before WR-03 these two had no STAGE_ORDER entry, so groupAuditByStage's
  // `STAGE_ORDER.filter(stage => buckets.has(stage))` dropped them with no trace: the header badge
  // counted them but no group rendered. These assertions fail on the pre-WR-03 viewer.
  it('renders cross_file_security and yaml_config_parse_failed as visible groups', async () => {
    const job = {
      audit: [
        {
          stage: 'yaml_config_parse_failed',
          reason: 'invalid indentation at line 4',
          timestamp: TIMESTAMP,
        },
        {
          stage: 'cross_file_security',
          timestamp: TIMESTAMP,
        },
      ],
      auditTruncated: false,
    } as unknown as JobDetail;

    renderPage(<AuditTrailViewer job={job} />);
    await openTrail();

    expect(screen.getByText('Config parse failed')).toBeInTheDocument();
    expect(screen.getByText('Cross-file security')).toBeInTheDocument();
  });

  it('renders an unknown stage in the `other` catch-all instead of discarding it', async () => {
    const job = {
      audit: [{ stage: 'some_future_stage', timestamp: TIMESTAMP }],
      auditTruncated: false,
    } as unknown as JobDetail;

    renderPage(<AuditTrailViewer job={job} />);
    await openTrail();

    expect(screen.getByText('Other')).toBeInTheDocument();
  });
});
