import type { NamedContributionStats } from "@/lib/stats-data";
import { ALL_TIME_WEEKS, type Bucket, type Counts, type StatClass } from "@/lib/stats";

// The Stats tab's body: the window's totals and a small stacked histogram of
// tasks completed / created / moved forward over time (who did them is on the
// Leaderboard tab, components/Leaderboard.tsx). Server component; the SVG is inline so no chart
// library is needed. Colours follow the status badges in src/lib/tasks.ts:
// done is green, to-do is blue, in-progress is amber.

const SERIES: { key: StatClass; label: string; fill: string; bar: string }[] = [
  { key: "completed", label: "Completed", fill: "fill-green-500 dark:fill-green-400", bar: "bg-green-500 dark:bg-green-400" },
  { key: "created", label: "Created", fill: "fill-blue-500 dark:fill-blue-400", bar: "bg-blue-500 dark:bg-blue-400" },
  { key: "forward", label: "Moved forward", fill: "fill-amber-500 dark:fill-amber-400", bar: "bg-amber-500 dark:bg-amber-400" },
];

const total = (c: Counts) => c.completed + c.created + c.forward;

const CHART_W = 600;
const CHART_H = 100;
const AXIS_H = 18;

/** Indices of the buckets that get an x-axis label: first, last and ~3 between. */
function labelledIndices(n: number): number[] {
  if (n <= 5) return Array.from({ length: n }, (_, i) => i);
  const picks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(f * (n - 1)));
  return [...new Set(picks)];
}

function Histogram({ buckets }: { buckets: Bucket[] }) {
  const n = buckets.length;
  const max = Math.max(1, ...buckets.map(total));
  const slot = CHART_W / n;
  const barW = Math.max(2, slot * 0.68);
  const labelled = new Set(labelledIndices(n));

  return (
    <svg
      viewBox={`0 0 ${CHART_W} ${CHART_H + AXIS_H}`}
      width="100%"
      className="block h-auto"
      role="img"
      aria-label="Events per period, stacked by completed, created and moved forward"
    >
      <line
        x1={0}
        x2={CHART_W}
        y1={CHART_H + 0.5}
        y2={CHART_H + 0.5}
        className="stroke-neutral-200 dark:stroke-neutral-800"
        strokeWidth={1}
      />
      {buckets.map((b, i) => {
        const x = i * slot + (slot - barW) / 2;
        let y = CHART_H;
        const title = `${b.label}: ${b.completed} completed, ${b.created} created, ${b.forward} moved forward`;
        return (
          <g key={b.key}>
            <title>{title}</title>
            {/* An invisible full-height hit area so the title shows for empty periods too. */}
            <rect x={i * slot} y={0} width={slot} height={CHART_H} fill="transparent" />
            {SERIES.map((s) => {
              const v = b[s.key];
              if (v === 0) return null;
              const h = (v / max) * CHART_H;
              y -= h;
              return <rect key={s.key} x={x} y={y} width={barW} height={h} className={s.fill} />;
            })}
            {labelled.has(i) && (
              <text
                x={i === 0 ? i * slot : i === n - 1 ? (i + 1) * slot : i * slot + slot / 2}
                y={CHART_H + AXIS_H - 4}
                textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"}
                fontSize={10}
                className="fill-neutral-500 dark:fill-neutral-400"
              >
                {b.label}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

export function ContributionStats({ stats }: { stats: NamedContributionStats }) {
  return (
    <div className="mt-4 space-y-6">
      <section className="rounded-lg border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
          {SERIES.map((s) => (
            <span key={s.key} className="inline-flex items-center gap-1.5 text-neutral-700 dark:text-neutral-200">
              <span className={`inline-block h-2.5 w-2.5 rounded-sm ${s.bar}`} aria-hidden />
              <span className="tabular-nums font-medium">{stats.totals[s.key]}</span>
              <span className="text-neutral-500 dark:text-neutral-400">{s.label.toLowerCase()}</span>
            </span>
          ))}
        </div>
        <div className="mt-3">
          <Histogram buckets={stats.buckets} />
        </div>
        <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
          {stats.window === "all"
            ? `One bar per week (Monday start) for the last ${ALL_TIME_WEEKS} weeks; the totals count everything ever recorded.`
            : "One bar per day, Berkeley time."}
        </p>
      </section>
    </div>
  );
}
