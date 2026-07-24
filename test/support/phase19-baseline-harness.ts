import {
  defaultRepoConfig,
  reviewSeverities,
  type ParsedReviewComment,
} from '@shared/schema';
import {
  composeRoundFloors,
  resolveRoundContext,
  selectDiffForRound,
} from '@server/core/rounds';
import type { FileDiff } from '@server/core/diff';
import { applyNoiseFilter } from '@server/core/noise-filter';
import { dedupeComposite } from '@server/core/dedup';
import { buildWalkthroughData } from '@server/core/walkthrough';
import { FormatterService } from '@server/services/formatter';

type PathName = 'full' | 'incremental' | 'review-rest';

type BaselinePath = {
  round: ReturnType<typeof resolveRoundContext>;
  selection: ReturnType<typeof selectDiffForRound>;
  floors: {
    minConfidence: number;
    minSeverity: ParsedReviewComment['severity'];
    effectiveChanged: boolean;
  };
  review: {
    comments: Array<Pick<ParsedReviewComment, 'path' | 'line' | 'severity' | 'title' | 'body'>>;
    overview: string;
    walkthrough: string;
  };
  phase19: {
    modelCalls: number;
    auditEvents: string[];
    results: {
      threadVerification: null;
      critic: null;
      ensemble: null;
      walkthroughEnrichment: null;
    };
  };
};

export type Phase19Baseline = {
  schemaVersion: 1;
  config: {
    threads: { verify_fixes: false; auto_resolve: false };
    critic: { enabled: false };
    ensemble: { runs: 1; temperature: 0.7 };
    walkthrough: { enabled: false };
  };
  paths: Record<PathName, BaselinePath>;
};

function baselineDiff(path: string): FileDiff {
  return {
    path,
    previousPath: null,
    isNew: false,
    isDeleted: false,
    isBinary: false,
    lineCount: 1,
    hunks: [],
  };
}

function emptyCounts(): Record<ParsedReviewComment['severity'], number> {
  return Object.fromEntries(reviewSeverities.map((severity) => [severity, 0])) as Record<ParsedReviewComment['severity'], number>;
}

function comments(): ParsedReviewComment[] {
  return [
    {
      path: 'src/app.ts',
      line: 1,
      position: 1,
      severity: 'P0',
      category: 'bugs',
      title: 'Critical finding',
      body: 'critical finding body',
      confidence: 0.95,
      existingCode: null,
      codeSuggestion: null,
    },
    {
      path: 'src/app.ts',
      line: 2,
      position: 2,
      severity: 'P2',
      category: 'quality',
      title: 'Warning finding',
      body: 'warning finding body',
      confidence: 0.9,
      existingCode: null,
      codeSuggestion: null,
    },
  ];
}

function reviewRows() {
  return [{
    file_path: 'src/app.ts',
    file_summary: 'one-line file summary',
    file_status: 'done' as const,
    error_msg: null,
    verdict: 'comment' as const,
    diff_line_count: 2,
    pass: 'main' as const,
  }];
}

function phase19InertState(): BaselinePath['phase19'] {
  return {
    modelCalls: 0,
    auditEvents: [],
    results: {
      threadVerification: null,
      critic: null,
      ensemble: null,
      walkthroughEnrichment: null,
    },
  };
}

function buildPath(pathName: PathName): BaselinePath {
  const incremental = pathName === 'incremental';
  const reviewRest = pathName === 'review-rest';
  const priorState = incremental || reviewRest
    ? { last_reviewed_sha: 'a'.repeat(40), last_review_round: 1 }
    : null;
  const round = resolveRoundContext({
    reviewScope: reviewRest ? 'rest' : 'all',
    priorState,
    unresolvedThreads: [],
    roundsIncremental: incremental,
  });
  const selection = selectDiffForRound({
    roundContext: round,
    compareDiff: incremental ? 'diff --git a/src/app.ts b/src/app.ts\n' : '',
    compareFiles: incremental ? [baselineDiff('src/app.ts')] : [],
    fullDiff: 'diff --git a/src/app.ts b/src/app.ts\n',
    fullFiles: [baselineDiff('src/app.ts')],
    toSha: 'b'.repeat(40),
  });
  const floors = composeRoundFloors({
    reviewRound: round.round,
    reviewMode: round.mode,
    roundsIncremental: round.roundsIncremental,
    base: {
      minConfidence: defaultRepoConfig.review.min_confidence,
      minSeverity: defaultRepoConfig.review.min_severity,
      categoryConfidence: defaultRepoConfig.review.category_confidence,
    },
    escalateFloors: defaultRepoConfig.review.rounds.escalate_floors,
  });
  const filter = applyNoiseFilter(comments(), {
    minConfidence: floors.minConfidence,
    categoryConfidence: floors.categoryConfidence,
    minSeverity: floors.minSeverity,
    effectiveMaxComments: defaultRepoConfig.review.max_comments,
    dedup: dedupeComposite,
  });
  const walkthrough = buildWalkthroughData({ reviews: reviewRows(), finalComments: filter.kept });
  const formatter = new FormatterService('https://baseline.invalid');
  const severityCounts = emptyCounts();
  for (const comment of filter.kept) severityCounts[comment.severity] += 1;
  const overview = formatter.formatReviewOverview({
    commitSha: 'b'.repeat(40),
    botUsername: 'opencodra',
    narrative: null,
    verdict: 'comment',
    confidenceScore: null,
    severityCounts,
    topFindings: filter.kept.map((comment) => ({
      severity: comment.severity,
      title: comment.title,
      path: comment.path,
    })),
    filesReviewed: 1,
    omittedCount: 0,
    maxComments: defaultRepoConfig.review.max_comments,
  });
  return {
    round,
    selection,
    floors: {
      minConfidence: floors.minConfidence,
      minSeverity: floors.minSeverity,
      effectiveChanged: floors.effectiveChanged,
    },
    review: {
      comments: filter.kept.map(({ path, line, severity, title, body }) => ({ path, line, severity, title, body })),
      overview,
      walkthrough: formatter.formatWalkthrough(walkthrough),
    },
    phase19: phase19InertState(),
  };
}

export function buildPhase19Baseline(): Phase19Baseline {
  return {
    schemaVersion: 1,
    config: {
      threads: {
        verify_fixes: defaultRepoConfig.review.threads.verify_fixes,
        auto_resolve: defaultRepoConfig.review.threads.auto_resolve,
      },
      critic: { enabled: defaultRepoConfig.review.passes.critic.enabled },
      ensemble: {
        runs: defaultRepoConfig.review.passes.ensemble.runs,
        temperature: defaultRepoConfig.review.passes.ensemble.temperature,
      },
      walkthrough: { enabled: defaultRepoConfig.review.walkthrough.enabled },
    } as Phase19Baseline['config'],
    paths: {
      full: buildPath('full'),
      incremental: buildPath('incremental'),
      'review-rest': buildPath('review-rest'),
    },
  };
}

export function canonicalizePhase19Baseline(value: Phase19Baseline): string {
  return JSON.stringify(value);
}
