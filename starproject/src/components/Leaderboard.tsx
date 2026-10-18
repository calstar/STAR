import Link from "next/link";

import { tabClass } from "@/components/ActivityTabs";
import {
  type LeaderRow,
  type SubteamSection,
  formatPoints,
} from "@/lib/leaderboard";
import type { StatWindow } from "@/lib/stats";

// The Leaderboard tab's body: a podium card per subteam, ranked by points and
// filtered by the subteam chips. Everyone past 3rd is listed under the podium
// so nobody with points drops off the board. Server component; every control
// is a link (?window=&team=), so a view can be shared and needs no JS. Points
// are violet, a colour no status uses.

/** What the page is showing: the URL's window and subteam filter (null = all). */
export type LeaderView = { window: StatWindow; team: string | null };

/** The URL for a view, leaving out whatever is the default. */
export function leaderboardHref(v: LeaderView): string {
  const q = new URLSearchParams();
  if (v.window !== "30d") q.set("window", v.window);
  if (v.team) q.set("team", v.team);
  const s = q.toString();
  return s ? `/activity/leaderboard?${s}` : "/activity/leaderboard";
}

const pts = (v: number) => {
  const n = formatPoints(v);
  return `${n} ${n === "1" ? "pt" : "pts"}`;
};

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

/** A medal: two ribbon tails and a disc, on the sidebar icons' 24-unit grid.
 * Coloured by currentColor, so the place picks gold, silver or bronze. */
function IconMedal({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden>
      <path d="M7.5 2.5h3l2.2 6.2h-3Zm9 0h-3l-2.2 6.2h3Z" fill="currentColor" opacity={0.55} />
      <circle cx="12" cy="15" r="6.5" fill="currentColor" />
      <circle cx="12" cy="15" r="4.2" fill="none" stroke="white" strokeOpacity={0.6} strokeWidth={1.4} />
    </svg>
  );
}

// Podium places, drawn left to right as 2nd, 1st, 3rd. `medal` is the text
// colour the medal icon takes; it matches the stripe on top of the block.
const PLACES = [
  {
    idx: 1,
    label: "2nd",
    block: "h-16",
    ring: "ring-neutral-400 dark:ring-neutral-500",
    top: "bg-neutral-400 dark:bg-neutral-500",
    medal: "text-neutral-400 dark:text-neutral-400",
  },
  { idx: 0, label: "1st", block: "h-24", ring: "ring-amber-400", top: "bg-amber-400", medal: "text-amber-400" },
  {
    idx: 2,
    label: "3rd",
    block: "h-12",
    ring: "ring-amber-700 dark:ring-amber-600",
    top: "bg-amber-700 dark:bg-amber-600",
    medal: "text-amber-700 dark:text-amber-600",
  },
];

function Podium({ rows, meId }: { rows: LeaderRow[]; meId: string }) {
  return (
    <ol className="flex items-end justify-center gap-1.5 border-b border-neutral-200 dark:border-neutral-800" aria-label="Top three">
      {PLACES.map((p) => {
        const r = rows[p.idx];
        if (!r) {
          // An empty place keeps its shape, dashed, so the podium doesn't lopside.
          return (
            <li key={p.label} className="flex w-1/3 max-w-32 flex-col items-center" aria-hidden>
              <div className={`w-full rounded-t-md border border-b-0 border-dashed border-neutral-200 dark:border-neutral-800 ${p.block}`} />
            </li>
          );
        }
        const me = r.userId === meId;
        return (
          <li key={p.label} className="flex w-1/3 max-w-32 min-w-0 flex-col items-center">
            <span
              className={`flex h-9 w-9 items-center justify-center rounded-full bg-neutral-100 text-xs font-semibold text-neutral-700 ring-2 dark:bg-neutral-800 dark:text-neutral-200 ${p.ring}`}
              aria-hidden
            >
              {initials(r.name)}
            </span>
            <span className="mt-1 max-w-full truncate text-sm font-medium text-neutral-800 dark:text-neutral-100" title={r.name}>
              {r.name}
              {me && <span className="font-normal text-neutral-500 dark:text-neutral-400"> (you)</span>}
            </span>
            <div
              className={`relative mt-1.5 flex w-full flex-col items-center overflow-hidden rounded-t-md border border-b-0 border-neutral-200 bg-neutral-50 pt-2.5 dark:border-neutral-800 dark:bg-neutral-950 ${p.block}`}
            >
              <span className={`absolute inset-x-0 top-0 h-1 ${p.top}`} aria-hidden />
              {/* The medal says the place; the words stay for screen readers. */}
              <IconMedal className={`h-6 w-6 ${p.medal}`} />
              <span className="sr-only">{p.label} place</span>
              <span className="text-xs font-medium tabular-nums text-violet-600 dark:text-violet-400">{pts(r.points)}</span>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** Everyone past 3rd, in order, so the podium never hides anybody. */
function RunnersUp({ rows, meId }: { rows: LeaderRow[]; meId: string }) {
  if (rows.length <= 3) return null;
  return (
    <ol start={4} className="mt-3 divide-y divide-neutral-100 text-sm dark:divide-neutral-800" aria-label="The rest">
      {rows.slice(3).map((r, i) => {
        const me = r.userId === meId;
        return (
          <li
            key={r.userId}
            className={`flex items-center gap-3 px-1 py-1.5 ${me ? "rounded bg-blue-50 dark:bg-blue-950/40" : ""}`}
          >
            <span className="w-5 text-right tabular-nums text-neutral-500 dark:text-neutral-400">{i + 4}</span>
            <span className="min-w-0 flex-1 truncate text-neutral-800 dark:text-neutral-100" title={r.name}>
              {r.name}
              {me && <span className="text-neutral-500 dark:text-neutral-400"> (you)</span>}
            </span>
            <span className="tabular-nums text-violet-600 dark:text-violet-400">{pts(r.points)}</span>
          </li>
        );
      })}
    </ol>
  );
}

function Empty({ filtered }: { filtered: boolean }) {
  return (
    <p className="mt-6 rounded-lg border border-neutral-200 bg-white p-4 text-neutral-500 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-400">
      {filtered ? "No points for this subteam in this window." : "No points earned in this window yet."}
    </p>
  );
}

/**
 * The subteam chips: All shows every subteam's card; a subteam chip shows only
 * that subteam's. One at a time, like the window picker.
 */
export function SubteamFilter({ subteams, view }: { subteams: { id: string; name: string; color: string | null }[]; view: LeaderView }) {
  return (
    <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Subteam">
      <Link
        href={leaderboardHref({ ...view, team: null })}
        scroll={false}
        className={tabClass(view.team === null, "min-h-11 sm:min-h-0")}
        aria-current={view.team === null ? "page" : undefined}
      >
        All
      </Link>
      {subteams.map((s) => (
        <Link
          key={s.id}
          href={leaderboardHref({ ...view, team: s.id })}
          scroll={false}
          className={tabClass(view.team === s.id, "gap-1.5 min-h-11 sm:min-h-0")}
          aria-current={view.team === s.id ? "page" : undefined}
        >
          <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: s.color ?? "#a3a3a3" }} aria-hidden />
          {s.name}
        </Link>
      ))}
    </div>
  );
}

/** A podium card per subteam: the top three on the podium, the rest listed below. */
export function SubteamLeaderboards({ sections, view, meId }: { sections: SubteamSection[]; view: LeaderView; meId: string }) {
  if (sections.length === 0) return <Empty filtered={view.team !== null} />;
  return (
    <div className={`mt-6 grid gap-4 ${sections.length > 1 ? "sm:grid-cols-2" : ""}`}>
      {sections.map((sec) => {
        const id = `subteam-${sec.subteamId}`;
        return (
          <section
            key={id}
            aria-labelledby={id}
            className="rounded-lg border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900"
          >
            <h2 id={id} className="mb-3 flex items-center gap-2 text-base font-semibold">
              <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: sec.color ?? "#a3a3a3" }} aria-hidden />
              <Link href={`/subteams/${sec.subteamId}`} className="truncate hover:underline">
                {sec.name}
              </Link>
              <span className="ml-auto shrink-0 text-xs font-normal text-neutral-500 dark:text-neutral-400">
                {sec.rows.length} {sec.rows.length === 1 ? "person" : "people"}
              </span>
            </h2>
            <Podium rows={sec.rows} meId={meId} />
            <RunnersUp rows={sec.rows} meId={meId} />
          </section>
        );
      })}
    </div>
  );
}
