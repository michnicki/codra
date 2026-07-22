import { useState, type ReactNode } from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { PageHeaderActions } from '@client/components/shared/page-header-actions';
import { VcsProviderMark } from '@client/components/shared/vcs-provider-mark';
import { PageHeader } from '@client/components/layout/page-header';
import { Skeleton } from '@client/components/shared/skeleton';
import { Alert } from '@client/components/ui/alert';
import { useIsDarkMode } from '@client/hooks/use-is-dark-mode';
import { usePolling } from '@client/hooks/use-polling';
import { api } from '@client/lib/api';
import { fmtNumber } from '@client/lib/utils';
import { barPercent, normalizeCategoryCounts, normalizeSeverityCounts } from '@client/lib/stats-metrics';
import type { ReviewCategory, ReviewSeverity, StatsPayload } from '@shared/schema';

const CHART = {
  primary: '#65a30d',
  primaryDark: '#e0fe56',
  comments: '#0ea5e9',
  commentsDark: '#38bdf8',
  warning: '#d97706',
  warningDark: '#fbbf24',
  danger: '#dc2626',
  dangerDark: '#f87171',
  quiet: '#94a3b8',
  quietDark: '#64748b',
};

// D-11 severity distribution bar fills — the established severity-tag/severityConfig ramp expressed
// as Tailwind semantic bg utilities (P0 danger … nit quiet). NOT a new palette, NOT recharts. P2 is
// the lighter amber tier of the ramp (a dimmed --warning) so the P1→P2 step reads as in the severity-tag.
const SEVERITY_BAR_COLOR: Record<ReviewSeverity, string> = {
  P0: 'bg-danger',
  P1: 'bg-warning',
  P2: 'bg-warning/60',
  P3: 'bg-info',
  nit: 'bg-muted-foreground',
};

// D-11 category distribution bar fills — reuse the .category-tag color mapping verbatim
// (security→danger, performance→info, bugs→warning, correctness→success, quality→purple) for
// cross-surface consistency. quality has no semantic token, so use its exact category-tag oklch
// (light + dark) rather than invent a new categorical color.
const CATEGORY_BAR_COLOR: Record<ReviewCategory, string> = {
  security: 'bg-danger',
  bugs: 'bg-warning',
  performance: 'bg-info',
  correctness: 'bg-success',
  quality: 'bg-[oklch(56%_0.16_295)] dark:bg-[oklch(70%_0.14_295)]',
};

function formatDay(value: string) {
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function formatCompact(value: number) {
  return value >= 1000 ? fmtNumber(value) : value.toLocaleString();
}

function percent(numerator: number, denominator: number) {
  if (!denominator) return 0;
  return Math.round((numerator / denominator) * 100);
}

function modelName(model: string) {
  return model.split('/').pop()?.replace(/-/g, ' ') ?? model;
}

function ChartTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;

  return (
    <div className="rounded-md border border-border bg-card px-3 py-2.5 text-xs shadow-lg">
      {label && (
        <p className="mb-2 font-semibold text-foreground">
          {typeof label === 'string' && label.includes('-') ? formatDay(label) : label}
        </p>
      )}
      <div className="space-y-1.5">
        {payload.map((item: any) => (
          <div key={item.dataKey ?? item.name} className="flex min-w-32 items-center gap-2">
            <span
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ backgroundColor: item.color }}
            />
            <span className="flex-1 capitalize text-muted-foreground">{item.name}</span>
            <span className="font-semibold tabular-nums text-foreground">
              {typeof item.value === 'number' ? formatCompact(item.value) : item.value}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function GraphSectionTitle() {
  return <div className="pt-2" aria-hidden="true" />;
}

function GraphShell({
  title,
  children,
  className = '',
}: {
  title: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <article className={`flex flex-col overflow-hidden rounded-lg border border-border bg-card shadow-[var(--shadow-md)] ${className}`}>
      <div className="px-4 pt-4 sm:px-5 sm:pt-5">
        <h3 className="text-sm font-bold text-foreground sm:text-base">{title}</h3>
      </div>
      <div className="flex flex-1 flex-col">{children}</div>
    </article>
  );
}

function MetricsGrid({ stats, isDark }: { stats: StatsPayload; isDark: boolean }) {
  const color = isDark ? CHART.primaryDark : CHART.primary;
  const commentsColor = isDark ? CHART.commentsDark : CHART.comments;
  const inputColor = isDark ? CHART.commentsDark : CHART.comments;
  const outputColor = isDark ? CHART.warningDark : CHART.warning;
  const dangerColor = isDark ? CHART.dangerDark : CHART.danger;
  const quietColor = isDark ? CHART.quietDark : CHART.quiet;
  const repoMax = Math.max(...stats.topRepos.map((repo) => repo.jobs), 1);
  const modelMax = Math.max(...stats.models.map((model) => model.calls), 1);

  // REVIEW #1: db/stats.ts GROUP BYs severity/category and omits zero-count bands from the payload,
  // so map through the normalizers (zero-fill from the static enums) — never stats.severities /
  // stats.categories directly — so every band (incl. an entirely empty array) still renders at 0.
  const severityRows = normalizeSeverityCounts(stats.severities);
  const categoryRows = normalizeCategoryCounts(stats.categories);
  const severityMax = Math.max(...severityRows.map((row) => row.count), 1);
  const categoryMax = Math.max(...categoryRows.map((row) => row.count), 1);

  // Theme-aware chart chrome. CSS variables don't reliably resolve inside
  // Recharts SVG text, so use explicit colors keyed off the active theme.
  const axisColor = isDark ? 'rgba(228,228,231,0.62)' : 'rgba(63,63,70,0.78)';
  const gridColor = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)';
  const cursorColor = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)';
  const axisProps = {
    fontSize: 11,
    tickLine: false,
    tickMargin: 8,
    axisLine: false,
    tick: { fontFamily: 'var(--font-sans)', fill: axisColor },
  } as const;
  // Let Recharts thin the labels by available space (respecting minTickGap)
  // rather than a fixed stride keyed off the range — the trend array can have
  // far fewer points than `days`, which would hide every label but the first.
  const xAxisProps = {
    dataKey: 'day',
    tickFormatter: formatDay,
    interval: 'preserveStartEnd' as const,
    minTickGap: 24,
  };

  const STATUS_COLOR: Record<string, string> = {
    done: color,
    running: commentsColor,
    queued: quietColor,
    failed: dangerColor,
    superseded: quietColor,
    cancelled: quietColor,
  };
  const statusTotal = Math.max(stats.statuses.reduce((sum, s) => sum + s.count, 0), 1);

  return (
    <div className="flex flex-col gap-5 sm:gap-6">
      <GraphSectionTitle />

      <div className="grid gap-4 sm:gap-5 lg:grid-cols-2">
        <GraphShell title="Review flow">
          <div className="h-64 px-2 pb-4 pt-4 sm:h-80 sm:px-3 sm:pb-5">
            <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={0}>
              <AreaChart data={stats.trend} margin={{ left: 4, right: 8, top: 8, bottom: 4 }}>
                <defs>
                  <linearGradient id="reviewFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={color} stopOpacity={0.28} />
                    <stop offset="100%" stopColor={color} stopOpacity={0.02} />
                  </linearGradient>
                  <linearGradient id="commentFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={commentsColor} stopOpacity={0.2} />
                    <stop offset="100%" stopColor={commentsColor} stopOpacity={0.01} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke={gridColor} strokeDasharray="3 3" vertical={false} />
                <XAxis {...axisProps} {...xAxisProps} />
                <YAxis {...axisProps} width={34} allowDecimals={false} />
                <Tooltip content={<ChartTooltip />} cursor={{ stroke: color, strokeDasharray: '4 4' }} />
                <Area
                  type="monotone"
                  dataKey="jobs"
                  name="reviews"
                  stroke={color}
                  strokeWidth={2.5}
                  fill="url(#reviewFill)"
                  dot={false}
                  activeDot={{ r: 4, fill: color, stroke: 'var(--card)', strokeWidth: 2 }}
                />
                <Area
                  type="monotone"
                  dataKey="comments"
                  name="comments"
                  stroke={commentsColor}
                  strokeWidth={2}
                  fill="url(#commentFill)"
                  dot={false}
                  activeDot={{ r: 4, fill: commentsColor, stroke: 'var(--card)', strokeWidth: 2 }}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </GraphShell>

        <GraphShell title="Input vs output tokens">
          <div className="h-64 px-2 pb-4 pt-4 sm:h-80 sm:px-3 sm:pb-5">
            <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={0}>
              <BarChart data={stats.trend} margin={{ left: 4, right: 8, top: 8, bottom: 4 }}>
                <CartesianGrid stroke={gridColor} strokeDasharray="3 3" vertical={false} />
                <XAxis {...axisProps} {...xAxisProps} />
                <YAxis {...axisProps} width={46} tickFormatter={formatCompact} />
                <Tooltip content={<ChartTooltip />} cursor={{ fill: cursorColor }} />
                <Bar dataKey="inputTokens" name="input" fill={inputColor} radius={[3, 3, 0, 0]} />
                <Bar dataKey="outputTokens" name="output" fill={outputColor} radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </GraphShell>
      </div>

      <div className="grid gap-4 sm:gap-5 sm:grid-cols-2 xl:grid-cols-3">
        <GraphShell title="Job health">
          <div className="flex flex-col space-y-5 px-4 pb-5 pt-4 sm:px-5 sm:pb-6 sm:pt-5">
            <div className="flex h-3.5 overflow-hidden rounded-full bg-secondary">
              {stats.statuses.map((s) => (
                <div
                  key={s.status}
                  style={{ width: `${(s.count / statusTotal) * 100}%`, backgroundColor: STATUS_COLOR[s.status] ?? CHART.quiet }}
                />
              ))}
            </div>
            <div className="space-y-3.5">
              {stats.statuses.map((s) => (
                <div key={s.status} className="flex items-center justify-between gap-3 text-sm">
                  <div className="flex items-center gap-2.5">
                    <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: STATUS_COLOR[s.status] ?? CHART.quiet }} />
                    <span className="capitalize font-medium text-muted-foreground">{s.status}</span>
                  </div>
                  <span className="font-bold tabular-nums text-foreground">{s.count}</span>
                </div>
              ))}
            </div>
          </div>
        </GraphShell>

        <GraphShell title="Repository bars">
          <div className="space-y-4 px-4 pb-5 pt-4 sm:px-5 sm:pb-6 sm:pt-5">
            {stats.topRepos.slice(0, 8).map((repo) => (
              <div key={`${repo.vcsProvider}:${repo.owner}/${repo.repo}`} className="grid grid-cols-[minmax(0,1fr)_3rem] items-center gap-3">
                <div className="min-w-0">
                  <div className="flex items-center justify-between gap-3 text-sm">
                    <span className="flex min-w-0 items-center gap-1.5 font-semibold text-foreground">
                      <VcsProviderMark provider={repo.vcsProvider} size={13} className="text-muted-foreground" />
                      <span className="truncate">{repo.owner}/{repo.repo}</span>
                    </span>
                  </div>
                  <div className="mt-2 h-2 overflow-hidden rounded-full bg-secondary">
                    <div className="h-full rounded-full bg-primary" style={{ width: `${percent(repo.jobs, repoMax)}%` }} />
                  </div>
                </div>
                <span className="text-right text-xs font-bold tabular-nums text-foreground">{repo.jobs}</span>
              </div>
            ))}
          </div>
        </GraphShell>

        <GraphShell title="Model calls">
          <div className="space-y-4 px-4 pb-5 pt-4 sm:px-5 sm:pb-6 sm:pt-5">
            {stats.models.slice(0, 8).map((model) => (
              <div key={model.modelUsed} className="grid grid-cols-[minmax(0,1fr)_3rem] items-center gap-3">
                <div className="min-w-0">
                  <div className="flex items-center justify-between gap-3 text-sm">
                    <span className="truncate font-semibold text-foreground">{modelName(model.modelUsed)}</span>
                  </div>
                  <div className="mt-2 h-2 overflow-hidden rounded-full bg-secondary">
                    <div className="h-full rounded-full bg-info" style={{ width: `${percent(model.calls, modelMax)}%` }} />
                  </div>
                </div>
                <span className="text-right text-xs font-bold tabular-nums text-foreground">{model.calls}</span>
              </div>
            ))}
          </div>
        </GraphShell>

        <GraphShell title="Severity distribution">
          <div className="space-y-4 px-4 pb-5 pt-4 sm:px-5 sm:pb-6 sm:pt-5">
            {severityRows.map((row) => (
              <div key={row.severity} className="grid grid-cols-[minmax(0,1fr)_3rem] items-center gap-3">
                <div className="min-w-0">
                  <div className="flex items-center justify-between gap-3 text-sm">
                    <span className="truncate font-semibold uppercase text-foreground">{row.severity}</span>
                  </div>
                  <div className="mt-2 h-2 overflow-hidden rounded-full bg-secondary">
                    <div
                      className={`h-full rounded-full ${SEVERITY_BAR_COLOR[row.severity]}`}
                      style={{ width: `${barPercent(row.count, severityMax)}%` }}
                    />
                  </div>
                </div>
                <span className="text-right text-xs font-bold tabular-nums text-foreground">{row.count}</span>
              </div>
            ))}
          </div>
        </GraphShell>

        <GraphShell title="Category distribution">
          <div className="space-y-4 px-4 pb-5 pt-4 sm:px-5 sm:pb-6 sm:pt-5">
            {categoryRows.map((row) => (
              <div key={row.category} className="grid grid-cols-[minmax(0,1fr)_3rem] items-center gap-3">
                <div className="min-w-0">
                  <div className="flex items-center justify-between gap-3 text-sm">
                    <span className="truncate font-semibold capitalize text-foreground">{row.category}</span>
                  </div>
                  <div className="mt-2 h-2 overflow-hidden rounded-full bg-secondary">
                    <div
                      className={`h-full rounded-full ${CATEGORY_BAR_COLOR[row.category]}`}
                      style={{ width: `${barPercent(row.count, categoryMax)}%` }}
                    />
                  </div>
                </div>
                <span className="text-right text-xs font-bold tabular-nums text-foreground">{row.count}</span>
              </div>
            ))}
          </div>
        </GraphShell>
      </div>
    </div>
  );
}

function GraphCardSkeleton({ className = '' }: { className?: string }) {
  return (
    <article className={`overflow-hidden rounded-lg border border-border bg-card shadow-[var(--shadow-md)] ${className}`}>
      <div className="px-4 pt-4 sm:px-5 sm:pt-5">
        <Skeleton height={16} width={140} />
      </div>
      <div className="h-64 px-4 pb-4 pt-4 sm:h-80 sm:px-5 sm:pb-5">
        <Skeleton height="100%" width="100%" borderRadius={6} />
      </div>
    </article>
  );
}

function GraphBarCardSkeleton({ className = '' }: { className?: string }) {
  return (
    <article className={`overflow-hidden rounded-lg border border-border bg-card shadow-[var(--shadow-md)] ${className}`}>
      <div className="px-4 pt-4 sm:px-5 sm:pt-5">
        <Skeleton height={16} width={140} />
      </div>
      <div className="space-y-4 px-4 pb-5 pt-4 sm:px-5 sm:pb-6 sm:pt-5">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="grid grid-cols-[minmax(0,1fr)_3rem] items-center gap-3">
            <div className="space-y-2">
              <Skeleton height={10} width={`${70 + (i % 3) * 10}%`} />
              <Skeleton height={8} width={`${40 + ((i * 17) % 50)}%`} />
            </div>
            <Skeleton height={12} width={28} />
          </div>
        ))}
      </div>
    </article>
  );
}

function MetricsGridSkeleton() {
  return (
    <div className="flex flex-col gap-5 sm:gap-6">
      <div className="pt-2" aria-hidden="true" />
      <div className="grid gap-4 sm:gap-5 lg:grid-cols-2">
        <GraphCardSkeleton />
        <GraphCardSkeleton />
      </div>
      <div className="grid gap-4 sm:gap-5 sm:grid-cols-2 xl:grid-cols-3">
        <GraphBarCardSkeleton />
        <GraphBarCardSkeleton />
        <GraphBarCardSkeleton />
      </div>
    </div>
  );
}

export function StatsPage() {
  const [stats, setStats] = useState<StatsPayload | null>(null);
  const [, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState(30);
  const isDark = useIsDarkMode();

  const load = async (manual = false) => {
    if (manual) setRefreshing(true);
    try {
      const res = await api.getStats(days);
      setStats(res.stats);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load stats.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  usePolling(load, 30_000, [days]);

  return (
    <section className="page-enter flex flex-col gap-6">
      <PageHeader
        category="Reports"
        title="Review metrics"
        description="Daily review and comment activity for the selected range."
        actions={
          <PageHeaderActions
            days={days}
            onDaysChange={setDays}
            onRefresh={() => load(true)}
            refreshing={refreshing}
          />
        }
      />

      {error && <Alert variant="destructive">{error}</Alert>}

      {stats ? (
        <MetricsGrid stats={stats} isDark={isDark} />
      ) : (
        <MetricsGridSkeleton />
      )}
    </section>
  );
}
