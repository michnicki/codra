import { describe, expect, it } from 'vitest';
import {
  codeInsightsReportSchema,
  commitBuildStatusSchema,
  prCommentSchema,
  pullRequestWebhookPayloadSchema,
  reportAnnotationSchema,
} from '@shared/bitbucket';

const parsedBody = {
  repository: {
    full_name: 'acme/backend',
    workspace: { slug: 'acme' },
    uuid: '{repository-uuid}',
  },
  pullrequest: {
    id: 42,
    source: {
      branch: { name: 'feature/bitbucket' },
      commit: { hash: 'abc123def456' },
    },
    destination: {
      branch: { name: 'main' },
      commit: { hash: 'base123def456' },
    },
    title: 'Add Bitbucket review support',
    state: 'OPEN',
  },
} as const;

describe('pullRequestWebhookPayloadSchema', () => {
  it('parses a created event after the route injects X-Event-Key', () => {
    const result = pullRequestWebhookPayloadSchema.safeParse({
      eventName: 'pullrequest:created',
      ...parsedBody,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.eventName).toBe('pullrequest:created');
      expect(result.data.pullrequest.destination.commit.hash).toBe('base123def456');
    }
  });

  it('parses an updated event after the route injects X-Event-Key', () => {
    const result = pullRequestWebhookPayloadSchema.safeParse({
      eventName: 'pullrequest:updated',
      ...parsedBody,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.eventName).toBe('pullrequest:updated');
    }
  });

  it('does not require eventName inside the raw request body', () => {
    expect('eventName' in parsedBody).toBe(false);

    const routeConstructedPayload = {
      eventName: 'pullrequest:created' as const,
      ...parsedBody,
    };
    expect(pullRequestWebhookPayloadSchema.safeParse(routeConstructedPayload).success).toBe(true);
  });

  it('accepts documented Bitbucket fields outside Codra\'s consumed projection', () => {
    const result = pullRequestWebhookPayloadSchema.safeParse({
      eventName: 'pullrequest:created',
      actor: { display_name: 'Alice', uuid: '{actor-uuid}' },
      repository: {
        ...parsedBody.repository,
        name: 'backend',
        links: { html: { href: 'https://bitbucket.org/acme/backend' } },
      },
      pullrequest: {
        ...parsedBody.pullrequest,
        description: 'A real payload contains more fields than Codra consumes.',
        source: {
          ...parsedBody.pullrequest.source,
          repository: { full_name: 'acme/backend' },
        },
        links: { html: { href: 'https://bitbucket.org/acme/backend/pull-requests/42' } },
      },
    });

    expect(result.success).toBe(true);
  });

  it('rejects an unknown event name', () => {
    expect(pullRequestWebhookPayloadSchema.safeParse({
      eventName: 'pullrequest:deleted',
      ...parsedBody,
    }).success).toBe(false);
  });

  it('rejects a missing repository workspace slug', () => {
    const invalidPayload = {
      eventName: 'pullrequest:created',
      repository: {
        full_name: parsedBody.repository.full_name,
        workspace: {},
        uuid: parsedBody.repository.uuid,
      },
      pullrequest: parsedBody.pullrequest,
    };

    expect(pullRequestWebhookPayloadSchema.safeParse(invalidPayload).success).toBe(false);
  });

  it('rejects a missing destination commit hash', () => {
    const invalidPayload = {
      eventName: 'pullrequest:updated',
      repository: parsedBody.repository,
      pullrequest: {
        ...parsedBody.pullrequest,
        destination: { branch: { name: 'main' }, commit: {} },
      },
    };

    expect(pullRequestWebhookPayloadSchema.safeParse(invalidPayload).success).toBe(false);
  });
});

describe('prCommentSchema', () => {
  it('parses Bitbucket-native added-line comments', () => {
    expect(prCommentSchema.safeParse({
      path: 'src/foo.ts',
      line: 42,
      line_type: 'added',
      content: { raw: 'Consider extracting this logic.' },
    }).success).toBe(true);
  });

  it('parses removed-line comments', () => {
    expect(prCommentSchema.safeParse({
      path: 'src/foo.ts',
      line: 17,
      line_type: 'removed',
      content: { raw: 'Why was this removed?' },
    }).success).toBe(true);
  });

  it('rejects unknown line types', () => {
    expect(prCommentSchema.safeParse({
      path: 'src/foo.ts',
      line: 42,
      line_type: 'changed',
      content: { raw: 'body' },
    }).success).toBe(false);
  });

  it('rejects extra fields in strict mode', () => {
    expect(prCommentSchema.safeParse({
      path: 'src/foo.ts',
      line: 42,
      line_type: 'context',
      content: { raw: 'body' },
      unexpected: true,
    }).success).toBe(false);
  });

  it('rejects GitHub-style body and lineType aliases', () => {
    expect(prCommentSchema.safeParse({
      path: 'src/foo.ts',
      line: 42,
      lineType: 'added',
      body: 'body',
    }).success).toBe(false);
  });
});

describe('codeInsightsReportSchema', () => {
  it('parses a minimal BUG report', () => {
    expect(codeInsightsReportSchema.safeParse({
      title: 'Codra review summary',
      details: 'Found 3 issues across 2 files.',
      report_type: 'BUG',
      result: 'PASSED',
    }).success).toBe(true);
  });

  it('parses optional links and typed data values', () => {
    expect(codeInsightsReportSchema.safeParse({
      title: 'Codra review summary',
      details: 'Found 3 issues across 2 files.',
      report_type: 'BUG',
      result: 'FAILED',
      link: 'https://app.example.com/jobs/123',
      data: [
        { title: 'Files reviewed', type: 'NUMBER', value: 12 },
        { title: 'Needs attention', type: 'BOOLEAN', value: true },
      ],
    }).success).toBe(true);
  });

  it('rejects unknown result values', () => {
    expect(codeInsightsReportSchema.safeParse({
      title: 'Codra review summary',
      details: 'Details',
      report_type: 'BUG',
      result: 'OK',
    }).success).toBe(false);
  });

  it('rejects INPROGRESS because report results are binary', () => {
    expect(codeInsightsReportSchema.safeParse({
      title: 'Codra review summary',
      details: 'Details',
      report_type: 'BUG',
      result: 'INPROGRESS',
    }).success).toBe(false);
  });

  it('rejects missing required fields', () => {
    expect(codeInsightsReportSchema.safeParse({
      title: 'Codra review summary',
      report_type: 'BUG',
      result: 'PASSED',
    }).success).toBe(false);
  });
});

describe('commitBuildStatusSchema', () => {
  const baseStatus = {
    key: 'codra-review',
    description: 'Codra review status',
    url: 'https://app.example.com/jobs/123',
  } as const;

  it('parses a successful build status', () => {
    expect(commitBuildStatusSchema.safeParse({
      ...baseStatus,
      state: 'SUCCESSFUL',
    }).success).toBe(true);
  });

  it.each(['FAILED', 'INPROGRESS'] as const)('parses the %s build state', (state) => {
    expect(commitBuildStatusSchema.safeParse({ ...baseStatus, state }).success).toBe(true);
  });

  it('rejects unknown build states', () => {
    expect(commitBuildStatusSchema.safeParse({
      ...baseStatus,
      state: 'PENDING',
    }).success).toBe(false);
  });

  it('rejects a missing key', () => {
    expect(commitBuildStatusSchema.safeParse({
      state: 'SUCCESSFUL',
      description: baseStatus.description,
      url: baseStatus.url,
    }).success).toBe(false);
  });
});

describe('reportAnnotationSchema', () => {
  it('parses a minimal inline annotation with path/line', () => {
    expect(reportAnnotationSchema.safeParse({
      external_id: 'x',
      annotation_type: 'BUG',
      severity: 'CRITICAL',
      path: 'a.ts',
      line: 1,
    }).success).toBe(true);
  });

  it('rejects unknown keys (.strict())', () => {
    expect(reportAnnotationSchema.safeParse({
      external_id: 'x',
      annotation_type: 'BUG',
      severity: 'CRITICAL',
      unexpected_key: 'x',
    }).success).toBe(false);
  });

  it('rejects a severity value outside the four verified literals', () => {
    expect(reportAnnotationSchema.safeParse({
      external_id: 'x',
      severity: 'IMPOSSIBLE',
    }).success).toBe(false);
  });

  it('parses an overview-modal annotation (no path/line) with a valid severity', () => {
    expect(reportAnnotationSchema.safeParse({
      external_id: 'x',
      severity: 'LOW',
    }).success).toBe(true);
  });
});
