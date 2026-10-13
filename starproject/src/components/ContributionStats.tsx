import type { NamedContributionStats } from "@/lib/stats-data";
import { ALL_TIME_WEEKS, type Bucket, type Counts, type StatClass } from "@/lib/stats";

// The Stats tab's body: a leaderboard of who completed / created / moved
// forward the most tasks in the window, and a small stacked histogram of the
// same three classes over time. Server component; the SVG is inline so no chart
// library is needed. Colours follow the status badges in src/lib/tasks.ts:
// done is green, to-do is blue, in-progress is amber.

const SERIES: { key: StatClass; label: string; fill: string; bar: string }[] = [
  { key: "completed", label: "Completed", fill: "fill-green-500 dark:fill-green-400", bar: "bg-green-500 dark:bg-green-400" },
  { key: "created", label: "Created", fill: "fill-blue-500 dark:fill-blue-400", bar: "bg-blue-500 dark:bg-blue-400" },
  { key: "forward", label: "Moved forward", fill: "fill-amber-500 dark:fill-amber-400", bar: "bg-amber-500 dark:bg-amber-400" },
];

const total = (c: Counts) => c.completed + c.created + c.forward;

/** One leaderboard cell: the number and a thin bar relative to the column max. */
function CountCell({ value, max, bar }: { value: number; max: number; bar: string }) {
  const pct = max > 0 ? (value / max) * 100 : 0;
  return (
    <td className="px-3 py-2 align-middle">
      <div className="flex items-center gap-2">
        <span className="min-w-6 shrink-0 text-right tabular-nums">{value}</span>
        <span className="h-1.5 flex-1 rounded-full bg-neutral-100 dark:bg-neutral-800" aria-hidden>
          <span className={`block h-1.5 rounded-full ${value > 0 ? bar : ""}`} style={{ width: `${pct}%` }} />
        </span>
      </div>
    </td>
  );
}

function Leaderboard({ users }: { users: NamedContributionStats["users"] }) {
  if (users.length === 0) {
    return (
      <p className="rounded-lg border border-neutral-200 bg-white p-4 text-neutral-500 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-400">
        No activity in this window.
      </p>
    );
  }
  const max: Counts = {
    completed: Math.max(...users.map((u) => u.completed)),
    created: Math.max(...users.map((u) => u.created)),
    forward: Math.max(...users.map((u) => u.forward)),
  };
  return (
    <div className="overflow-x-auto rounded-lg border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
      <table className="w-full min-w-[32rem] text-sm">
        <thead>
          <tr className="border-b border-neutral-200 text-left text-xs font-medium uppercase tracking-wide text-neutral-500 dark:border-neutral-800 dark:text-neutral-400">
            <th scope="col" className="px-3 py-2">
              Person
            </th>
            {SERIES.map((s) => (
              <th key={s.key} scope="col" className="w-1/4 px-3 py-2">
                {s.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-neutral-200 dark:divide-neutral-800">
          {users.map((u) => (
            <tr key={u.actorId}>
              <th scope="row" className="px-3 py-2 text-left font-medium text-neutral-800 dark:text-neutral-100">
                {u.name}
              </th>
              {SERIES.map((s) => (
                <CountCell key={s.key} value={u[s.key]} max={max[s.key]} bar={s.bar} />
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

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
            ? `One bar per week (Monday start) for the last ${ALL_TIME_WEEKS} weeks; the totals and leaderboard count everything ever recorded.`
            : "One bar per day, Berkeley time."}
        </p>
      </section>

      <Leaderboard users={stats.users} />
    </div>
  );
}
