import { describe, expect, it } from 'vitest';
import { buildWalkthroughData, type WalkthroughReviewRow } from '@server/core/walkthrough';
import { FormatterService } from '@server/services/formatter';
import type { ThreadVerifications } from '@shared/schema';

const formatter = new FormatterService('https://open-codra.example.com');
const providers = ['github', 'bitbucket'] as const;

const reviews: WalkthroughReviewRow[] = [
  {
    file_path: 'src/example.ts',
    file_summary: 'Updates the example.',
    file_status: 'done',
    error_msg: null,
    verdict: 'approve',
    diff_line_count: 12,
    pass: 'main',
  },
];

function verification(
  overrides: Partial<ThreadVerifications> = {},
): ThreadVerifications {
  return {
    version: 1,
    status: 'completed',
    entries: [],
    totals: {
      fixed: 2,
      unfixed: 1,
      unverifiable: 1,
      resolved: 1,
    },
    ...overrides,
  };
}

function render(result?: ThreadVerifications | null, provider: (typeof providers)[number] = 'github') {
  const data = buildWalkthroughData({
    reviews,
    finalComments: [],
    threadVerification: result,
  });
  return formatter.formatWalkthrough(data, { provider });
}

describe('D-04 durable thread verification walkthrough projection', () => {
  it.each(providers)('renders completed enabled totals from persisted data on %s', (provider) => {
    expect(render(verification(), provider)).toContain(
      '**Thread verification:** Fixed 2 · Unfixed 1 · Unverifiable 1 · Resolved 1',
    );
  });

  it.each(providers)('renders verify-only fixed results with resolved zero on %s', (provider) => {
    const result = verification({
      totals: { fixed: 2, unfixed: 0, unverifiable: 0, resolved: 0 },
    });

    expect(render(result, provider)).toContain(
      '**Thread verification:** Fixed 2 · Unfixed 0 · Unverifiable 0 · Resolved 0',
    );
  });

  it.each(providers)('renders only confirmed auto-resolve successes on %s', (provider) => {
    const result = verification({
      totals: { fixed: 3, unfixed: 1, unverifiable: 1, resolved: 2 },
    });

    expect(render(result, provider)).toContain(
      '**Thread verification:** Fixed 3 · Unfixed 1 · Unverifiable 1 · Resolved 2',
    );
  });

  it.each(providers)('renders fail-open as unavailable without successful zero counts on %s', (provider) => {
    const result = verification({
      status: 'fail_open',
      reason: 'provider_unavailable',
      totals: { fixed: 0, unfixed: 0, unverifiable: 0, resolved: 0 },
    });
    const body = render(result, provider);

    expect(body).toContain('**Thread verification:** Unavailable (degraded)');
    expect(body).not.toContain('Fixed 0');
  });

  it.each(providers)('emits no verification block for absent or disabled data on %s', (provider) => {
    expect(render(undefined, provider)).not.toContain('Thread verification');
    expect(render(null, provider)).not.toContain('Thread verification');
  });

  it.each(providers)('degrades logically invalid resolved totals instead of claiming impossible success on %s', (provider) => {
    const result = verification({
      totals: { fixed: 1, unfixed: 0, unverifiable: 0, resolved: 2 },
    });
    const body = render(result, provider);

    expect(body).toContain('**Thread verification:** Unavailable (degraded)');
    expect(body).not.toContain('Resolved 2');
  });

  it('preserves provider-gated Mermaid behavior when verification totals are present', () => {
    const data = buildWalkthroughData({
      reviews,
      finalComments: [],
      threadVerification: verification(),
    });
    const mermaid = 'sequenceDiagram\n  Reviewer->>PR: verify fixes';

    expect(formatter.formatWalkthrough({ ...data, mermaid }, { provider: 'github' })).toContain('```mermaid');
    expect(formatter.formatWalkthrough({ ...data, mermaid }, { provider: 'bitbucket' })).not.toContain('```mermaid');
  });
});
