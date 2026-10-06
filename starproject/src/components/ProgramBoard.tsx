"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { TaskLink } from "@/components/TaskLink";
import {
  addMilestone,
  deleteMilestone,
  setFeatured,
  setMilestoneDone,
  setMilestoneLink,
  setCardOrder,
  setPhases,
  setSubteamPhase,
  untrackSubteam,
} from "@/lib/actions/program";
import type {
  Program,
  ProgramCardData,
  ProgramMilestone,
  ProgramSubteam,
} from "@/lib/program-data";
import { compareBig, relativeDays } from "@/lib/program";

const FALLBACK = "#a3a3a3";
const CARD =
  "rounded-xl border border-neutral-200 bg-white p-5 shadow-sm dark:border-neutral-800 dark:bg-neutral-900";
const input =
  "rounded-md border border-neutral-300 bg-white px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900";
const ghostBtn =
  "inline-flex min-h-8 items-center rounded-md px-2 text-xs font-medium text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800";
const sectionTitle =
  "text-xs font-medium uppercase tracking-wide text-neutral-500 dark:text-neutral-400";

type Subteams = { id: string; name: string }[];

/** Runs a server action, refreshes the server tree, and surfaces its error. */
function useAction() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const run = (fn: () => Promise<unknown>) =>
    start(async () => {
      setError(null);
      try {
        await fn();
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    });
  return { run, pending, error };
}

/** "LE4 Engine" on the LE4 card reads as just "Engine". */
function shortName(name: string, parent: string | null): string {
  if (!parent) return name;
  const rest = name.slice(parent.length).trim();
  return name.toLowerCase().startsWith(parent.toLowerCase()) && rest ? rest : name;
}

const utcDate = (iso: string) => new Date(`${iso}T00:00:00Z`);

// ── Small pieces ────────────────────────────────────────────────────────────

type Segment = { label: string; done: number; active: number };

/** One segment per phase. Solid = finished, striped = under way, track = not
 * started. Fractions let a project's line show "3 of 5 subteams are past this".
 * Colour comes from `currentColor`, so the caller sets it with a text colour. */
function SegmentedLine({
  segments,
  current,
  labels,
  thin,
  onPick,
}: {
  segments: Segment[];
  current: number;
  labels: boolean;
  thin?: boolean;
  onPick?: (i: number) => void;
}) {
  return (
    <div>
      <div className="flex gap-1">
        {segments.map((s, i) => {
          const Tag = onPick ? "button" : "div";
          return (
            <Tag
              key={i}
              type={onPick ? "button" : undefined}
              onClick={onPick ? () => onPick(i) : undefined}
              title={`${s.label}${onPick ? " — set as current phase" : ""}`}
              aria-label={s.label}
              className={`relative flex-1 overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-800 ${
                thin ? "h-1.5" : "h-2"
              } ${onPick ? "cursor-pointer outline-offset-2 hover:outline hover:outline-1 hover:outline-neutral-400" : ""}`}
            >
              <span className="absolute inset-y-0 left-0 bg-current" style={{ width: `${s.done * 100}%` }} />
              <span
                className="absolute inset-y-0 opacity-60"
                style={{
                  left: `${s.done * 100}%`,
                  width: `${s.active * 100}%`,
                  background: "repeating-linear-gradient(135deg, currentColor 0 3px, transparent 3px 6px)",
                }}
              />
            </Tag>
          );
        })}
      </div>
      {labels && (
        <div className="mt-1.5 hidden gap-1 sm:flex">
          {segments.map((s, i) => (
            <span
              key={i}
              className={`flex-1 truncate text-xs ${
                i === current
                  ? "font-medium text-neutral-900 dark:text-neutral-100"
                  : i < current
                    ? "text-neutral-500 dark:text-neutral-400"
                    : "text-neutral-400 dark:text-neutral-500"
              }`}
            >
              {s.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function Dot({ color }: { color: string | null }) {
  return (
    <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: color ?? FALLBACK }} />
  );
}

function MilestoneDate({ m, today }: { m: ProgramMilestone; today: string }) {
  const overdue = !m.done && m.dueDate < today;
  return (
    <span
      className={`shrink-0 text-xs tabular-nums ${
        overdue ? "font-medium text-red-600 dark:text-red-400" : "text-neutral-500 dark:text-neutral-400"
      }`}
    >
      {utcDate(m.dueDate).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}
      {" · "}
      {relativeDays(utcDate(m.dueDate), today)}
    </span>
  );
}

/** A milestone's name — opens its link (slides, a doc) in a new tab when it
 * has one. The URL was checked to be http(s) when it was saved. */
function MilestoneName({ m, className = "" }: { m: ProgramMilestone; className?: string }) {
  if (!m.url) return <span className={className}>{m.title}</span>;
  return (
    <a
      href={m.url}
      target="_blank"
      rel="noopener noreferrer"
      title={m.url}
      className={`underline decoration-neutral-300 underline-offset-2 hover:decoration-current dark:decoration-neutral-600 ${className}`}
    >
      {m.title}
      <span aria-hidden className="ml-0.5 text-[0.85em] text-neutral-400">↗</span>
    </a>
  );
}

/** A project's line, rolled up across its subteams. */
function projectSegments(p: Program): Segment[] {
  return p.phases.map((label, i) => {
    const s = p.segments[i];
    return { label, done: s.total ? s.done / s.total : 0, active: s.total ? s.active / s.total : 0 };
  });
}

/** "Design review — waiting on Aerostructures, Operations". */
function statusText(p: Program) {
  const tracked = p.subteams.length;
  if (tracked === 0) return <>No subteams tracked yet</>;
  if (p.phase >= p.phases.length) return <>Complete</>;
  const behind = p.subteams.filter((s) => s.phase === p.phase).map((s) => s.name);
  return (
    <>
      <span className="font-medium text-neutral-800 dark:text-neutral-200">{p.phases[p.phase]}</span>
      {behind.length < tracked && <> — waiting on {behind.join(", ")}</>}
    </>
  );
}

// ── Admin settings for one project ──────────────────────────────────────────

function ProjectSettings({ program, allSubteams }: { program: Program; allSubteams: Subteams }) {
  const { run, pending, error } = useAction();
  const [phases, setPhaseText] = useState(program.phases.join(", "));
  const untracked = allSubteams.filter((s) => !program.subteams.some((t) => t.id === s.id));

  return (
    <div className="space-y-3 rounded-lg bg-neutral-50 p-3 text-sm dark:bg-neutral-800/40">
      <label className="block">
        <span className="text-xs font-medium text-neutral-600 dark:text-neutral-300">
          {program.name} phases, in order (comma-separated)
        </span>
        <div className="mt-1 flex gap-2">
          <input className={`${input} min-w-0 flex-1`} value={phases} onChange={(e) => setPhaseText(e.target.value)} />
          <button
            type="button"
            className={ghostBtn}
            disabled={pending}
            onClick={() => run(() => setPhases(program.id, phases.split(",")))}
          >
            Save
          </button>
        </div>
      </label>
      {untracked.length > 0 && (
        <select
          className={input}
          value=""
          disabled={pending}
          onChange={(e) => e.target.value && run(() => setSubteamPhase(program.id, e.target.value, 0))}
        >
          <option value="">+ Add a subteam to {program.name}…</option>
          {untracked.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      )}
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}

// ── 1. Status of each system ────────────────────────────────────────────────

/** One compact row per project: name, rolled-up line, where it is. */
function SystemRows({
  systems,
  group,
  editing,
  isAdmin,
  allSubteams,
}: {
  systems: Program[];
  group: string;
  editing: boolean;
  isAdmin: boolean;
  allSubteams: Subteams;
}) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div>
      <h3 className={sectionTitle}>Status</h3>
      <ul className="mt-3 space-y-3">
        {systems.map((p) => (
          <li key={p.id}>
            <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1.5 sm:grid-cols-[9rem_minmax(0,1fr)_17rem_auto]">
              <span className="flex min-w-0 items-center gap-2">
                <Dot color={p.color} />
                <span className="truncate text-sm font-medium">{shortName(p.name, group)}</span>
              </span>
              <div className="col-span-2 row-start-2 text-neutral-900 sm:col-span-1 sm:row-start-auto dark:text-neutral-100">
                <SegmentedLine segments={projectSegments(p)} current={p.phase} labels={false} />
              </div>
              <span className="col-span-2 row-start-3 truncate text-xs text-neutral-500 sm:col-span-1 sm:row-start-auto dark:text-neutral-400">
                {statusText(p)}
              </span>
              {editing && isAdmin ? (
                <button
                  type="button"
                  className={`${ghostBtn} col-start-2 row-start-1 sm:col-start-auto sm:row-start-auto`}
                  onClick={() => setOpen(open === p.id ? null : p.id)}
                >
                  {open === p.id ? "Close" : "Settings"}
                </button>
              ) : (
                <span className="hidden sm:block" />
              )}
            </div>
            {editing && isAdmin && open === p.id && (
              <div className="mt-2">
                <ProjectSettings program={p} allSubteams={allSubteams} />
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── 2. Milestones ───────────────────────────────────────────────────────────

/** Edit-mode control to set, change or clear one milestone's link. */
function LinkEditor({ m, onDone }: { m: ProgramMilestone; onDone: () => void }) {
  const { run, pending, error } = useAction();
  const [url, setUrl] = useState(m.url ?? "");
  return (
    <form
      className="flex basis-full flex-wrap items-center gap-2 pb-1 pl-6"
      onSubmit={(e) => {
        e.preventDefault();
        run(async () => {
          await setMilestoneLink(m.id, url);
          onDone();
        });
      }}
    >
      <input
        className={`${input} min-w-0 flex-1 py-0.5 text-xs`}
        placeholder="Paste a link — slides, a doc, a test plan"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        autoFocus
      />
      <button type="submit" className={ghostBtn} disabled={pending}>
        Save
      </button>
      {m.url && (
        <button
          type="button"
          className={ghostBtn}
          disabled={pending}
          onClick={() =>
            run(async () => {
              await setMilestoneLink(m.id, null);
              onDone();
            })
          }
        >
          Remove link
        </button>
      )}
      <button type="button" className={ghostBtn} onClick={onDone}>
        Cancel
      </button>
      {error && <span className="basis-full text-xs text-red-600">{error}</span>}
    </form>
  );
}

function Milestones({
  root,
  systems,
  group,
  editing,
  today,
}: {
  root: Program;
  systems: Program[];
  group: string | null;
  editing: boolean;
  today: string;
}) {
  const { run, pending, error } = useAction();
  const [title, setTitle] = useState("");
  const [date, setDate] = useState("");
  const [projectId, setProjectId] = useState(root.id);
  const [subteamId, setSubteamId] = useState("");
  const [link, setLink] = useState("");
  const [linking, setLinking] = useState<string | null>(null);
  // The parent's own milestones are the whole program's (CDR, launch), so it is
  // always a place to add one even when it isn't a system row itself.
  const targets = systems.some((s) => s.id === root.id) ? systems : [root, ...systems];
  const multi = targets.length > 1;
  const target = targets.find((s) => s.id === projectId) ?? root;
  const targetLabel = (p: Program) => (p.id === root.id ? `All of ${root.name}` : shortName(p.name, group));
  const systemTag = (p: Program) => (multi && p.id !== root.id ? shortName(p.name, group) : null);

  // Every project's milestones on one list, soonest first; outside edit mode
  // only what's still open.
  const all = targets
    .flatMap((p) => p.milestones.map((m) => ({ m, p })))
    .filter(({ m }) => editing || !m.done)
    .sort((a, b) => a.m.dueDate.localeCompare(b.m.dueDate));
  const shown = editing ? all : all.slice(0, 9);

  return (
    <div>
      <h3 className={sectionTitle}>Milestones</h3>
      <ul className="mt-2 grid gap-x-10 gap-y-1 md:grid-cols-2 xl:grid-cols-3">
        {shown.length === 0 && (
          <li className="text-sm text-neutral-500 dark:text-neutral-400">
            {editing ? "No milestones yet — add the next one below." : "Nothing scheduled."}
          </li>
        )}
        {shown.map(({ m, p }) => {
          // The dot already says which subteam; spell out the system when there
          // are several, and keep the subteam's name for the tooltip.
          const tag = multi ? systemTag(p) : m.subteam?.name;
          return (
            <li
              key={m.id}
              className="flex min-h-7 flex-wrap items-center gap-x-2"
              title={[m.title, systemTag(p), m.subteam?.name].filter(Boolean).join(" · ")}
            >
              {editing && (
                <input
                  type="checkbox"
                  checked={m.done}
                  disabled={pending}
                  onChange={(e) => run(() => setMilestoneDone(m.id, e.target.checked))}
                  aria-label={`Mark ${m.title} done`}
                />
              )}
              {m.subteam ? (
                <Dot color={m.subteam.color} />
              ) : (
                <span className="h-2.5 w-2.5 shrink-0 rounded-full border border-neutral-400" />
              )}
              <span className={`min-w-0 flex-1 truncate text-sm ${m.done ? "text-neutral-400 line-through" : ""}`}>
                <MilestoneName m={m} />
                {tag && <span className="text-neutral-500 dark:text-neutral-400"> · {tag}</span>}
              </span>
              <MilestoneDate m={m} today={today} />
              {editing && (
                <button
                  type="button"
                  className={ghostBtn}
                  onClick={() => setLinking(linking === m.id ? null : m.id)}
                  aria-label={`${m.url ? "Change" : "Add"} link for ${m.title}`}
                  title={m.url ? "Change link" : "Add a link"}
                >
                  {m.url ? "Link ✓" : "Link"}
                </button>
              )}
              {editing && (
                <button
                  type="button"
                  className={`${ghostBtn} text-red-600 dark:text-red-400`}
                  disabled={pending}
                  onClick={() => run(() => deleteMilestone(m.id))}
                  aria-label={`Delete ${m.title}`}
                >
                  ✕
                </button>
              )}
              {editing && linking === m.id && <LinkEditor m={m} onDone={() => setLinking(null)} />}
            </li>
          );
        })}
      </ul>
      {editing && (
        <form
          className="mt-4 flex max-w-4xl flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            run(async () => {
              await addMilestone(target.id, {
                title,
                dueDate: date,
                subteamId: subteamId || null,
                url: link,
              });
              setTitle("");
              setDate("");
              setLink("");
            });
          }}
        >
          <input
            className={`${input} min-w-0 basis-full sm:basis-auto sm:flex-1`}
            placeholder="What's next — e.g. CDR, first cold flow"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <input
            type="date"
            className={input}
            min="1900-01-01"
            max="9999-12-31"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
          <input
            className={`${input} min-w-0 basis-full sm:basis-56`}
            placeholder="Link (optional) — slides, a doc"
            value={link}
            onChange={(e) => setLink(e.target.value)}
          />
          {multi && (
            <select
              className={input}
              value={target.id}
              onChange={(e) => {
                setProjectId(e.target.value);
                setSubteamId("");
              }}
            >
              {targets.map((p) => (
                <option key={p.id} value={p.id}>
                  {targetLabel(p)}
                </option>
              ))}
            </select>
          )}
          <select className={input} value={subteamId} onChange={(e) => setSubteamId(e.target.value)}>
            <option value="">{target.id === root.id ? "No specific subteam" : "Whole system"}</option>
            {target.subteams.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <button
            type="submit"
            disabled={pending || !title.trim() || !date}
            className="rounded-md bg-neutral-900 px-3 py-1 text-sm font-medium text-white disabled:opacity-40 dark:bg-neutral-100 dark:text-neutral-900"
          >
            Add
          </button>
        </form>
      )}
      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
    </div>
  );
}

// ── 3. Subteams ─────────────────────────────────────────────────────────────

/** One subteam's standing in one project. */
type Entry = { program: Program; status: ProgramSubteam };
type SubteamRollup = { id: string; name: string; color: string | null; entries: Entry[] };

/** Fold every project's subteams into one card per subteam. */
function rollupSubteams(systems: Program[]): SubteamRollup[] {
  const byId = new Map<string, SubteamRollup>();
  for (const program of systems) {
    for (const status of program.subteams) {
      const r = byId.get(status.id) ?? { id: status.id, name: status.name, color: status.color, entries: [] };
      r.entries.push({ program, status });
      byId.set(status.id, r);
    }
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function PhaseRow({
  entry,
  label,
  thin,
  editing,
}: {
  entry: Entry;
  label: React.ReactNode;
  thin: boolean;
  editing: boolean;
}) {
  const { run, pending, error } = useAction();
  const { program, status } = entry;
  const n = program.phases.length;
  const segments = program.phases.map((l, i) => ({
    label: l,
    done: i < status.phase ? 1 : 0,
    active: i === status.phase ? 1 : 0,
  }));
  const set = (phase: number) => run(() => setSubteamPhase(program.id, status.id, phase));

  return (
    <div className={pending ? "opacity-60" : ""}>
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="min-w-0 truncate text-neutral-500 dark:text-neutral-400">{label}</span>
        {editing ? (
          <select
            className={`${input} py-0.5 text-xs text-neutral-900 dark:text-neutral-100`}
            value={status.phase}
            disabled={pending}
            onChange={(e) => set(Number(e.target.value))}
          >
            {program.phases.map((p, i) => (
              <option key={i} value={i}>
                {p}
              </option>
            ))}
            <option value={n}>Complete</option>
          </select>
        ) : (
          <span className="shrink-0 text-neutral-500 dark:text-neutral-400">
            <span className="font-medium text-neutral-800 dark:text-neutral-200">
              {status.phase >= n ? "Complete" : program.phases[status.phase]}
            </span>
            {status.phase < n && ` · ${status.phase + 1}/${n}`}
          </span>
        )}
      </div>
      <div className="mt-1.5">
        <SegmentedLine
          segments={segments}
          current={status.phase}
          labels={false}
          thin={thin}
          onPick={editing ? set : undefined}
        />
      </div>
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  );
}

function SubteamCard({
  subteam,
  group,
  editing,
  isAdmin,
  today,
}: {
  subteam: SubteamRollup;
  group: string | null;
  editing: boolean;
  isAdmin: boolean;
  today: string;
}) {
  const { run, pending } = useAction();
  const multi = subteam.entries.length > 1;
  const named = group !== null;
  const next = subteam.entries
    .flatMap((e) => (e.status.nextMilestone ? [e.status.nextMilestone] : []))
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate))[0];
  // Each project already picked its biggest; the card leads with the biggest of those.
  const key = (b: NonNullable<ProgramSubteam["biggest"]>) => ({
    blocks: b.blocks,
    priority: b.priority,
    due: b.dueDate ? Date.parse(b.dueDate) : null,
  });
  const big = subteam.entries
    .flatMap((e) => (e.status.biggest ? [e.status.biggest] : []))
    .sort((a, b) => compareBig(key(a), key(b)))[0];
  const open = subteam.entries.reduce((n, e) => n + e.status.openTasks, 0);

  return (
    <div className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
      {/* On a card with subprojects the subteam's name heads one row per
          system; on a single project the one row carries the name itself. */}
      {named && (
        <div className="mb-3 flex items-center gap-2">
          <Dot color={subteam.color} />
          <span className="truncate text-sm font-medium">{subteam.name}</span>
        </div>
      )}
      <div className="space-y-2.5" style={{ color: subteam.color ?? FALLBACK }}>
        {subteam.entries.map((e) => (
          <PhaseRow
            key={e.program.id}
            entry={e}
            thin={named}
            label={
              named ? (
                shortName(e.program.name, group)
              ) : (
                <span className="flex items-center gap-2 text-sm font-medium text-neutral-900 dark:text-neutral-100">
                  <Dot color={subteam.color} />
                  <span className="truncate">{subteam.name}</span>
                </span>
              )
            }
            editing={editing}
          />
        ))}
      </div>

      <dl className="mt-4 space-y-2.5 text-xs">
        <div className="flex gap-2">
          <dt className="w-16 shrink-0 text-neutral-500 dark:text-neutral-400">Milestone</dt>
          <dd className="flex min-w-0 flex-1 items-center justify-between gap-2">
            {next ? (
              <>
                <MilestoneName m={next} className="truncate" />
                <MilestoneDate m={next} today={today} />
              </>
            ) : (
              <span className="text-neutral-400 dark:text-neutral-500">—</span>
            )}
          </dd>
        </div>
        <div className="flex gap-2">
          <dt className="w-16 shrink-0 text-neutral-500 dark:text-neutral-400">Biggest</dt>
          <dd className="min-w-0 flex-1">
            {big ? (
              <TaskLink
                projectId={big.projectId}
                taskId={big.id}
                className="-mx-1 block w-[calc(100%+0.5rem)] rounded px-1 text-left hover:bg-neutral-100 dark:hover:bg-neutral-800"
              >
                <span className="block truncate font-medium text-neutral-900 dark:text-neutral-100">
                  <span className="font-normal text-neutral-400">#{big.number}</span> {big.title}
                </span>
                <span className="block truncate text-neutral-500 dark:text-neutral-400">
                  {[
                    big.blocks > 0 && `blocks ${big.blocks}`,
                    big.priority && `${big.priority} priority`,
                    big.dueDate && `due ${relativeDays(utcDate(big.dueDate), today)}`,
                  ]
                    .filter(Boolean)
                    .join(" · ") || "no priority or date set"}
                </span>
              </TaskLink>
            ) : (
              <span className="text-neutral-400 dark:text-neutral-500">No open tasks</span>
            )}
          </dd>
        </div>
      </dl>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-1 text-xs text-neutral-500 dark:text-neutral-400">
        <span>
          {open} open{multi ? ` across ${subteam.entries.length}` : ""}
        </span>
        {editing &&
          isAdmin &&
          subteam.entries.map((e) => (
            <button
              key={e.program.id}
              type="button"
              className={ghostBtn}
              disabled={pending}
              onClick={() => run(() => untrackSubteam(e.program.id, subteam.id))}
            >
              Remove from {named ? shortName(e.program.name, group) : e.program.name}
            </button>
          ))}
      </div>
    </div>
  );
}

// ── The card ────────────────────────────────────────────────────────────────

/** A tracked project — on its own, or with its subprojects as systems
 * ("LE4": Engine, Avionics, Solid Demo). Status of each system first, then
 * the milestones, then the subteams. */
function ProgramCard({
  card,
  isAdmin,
  allSubteams,
  today,
  onMove,
}: {
  card: ProgramCardData;
  isAdmin: boolean;
  allSubteams: Subteams;
  today: string;
  /** Admin reordering; a direction is absent when the card is already at that end. */
  onMove: { up?: () => void; down?: () => void } | null;
}) {
  const { root, systems } = card;
  const title = root.name;
  const only = systems.length === 1 && systems[0].id === root.id ? root : null;
  const group = only ? null : title;
  const { run, pending } = useAction();
  const [editing, setEditing] = useState(false);
  const subteams = rollupSubteams(systems);

  return (
    <section className={CARD}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2.5">
            {only && <Dot color={only.color} />}
            <h2 className="truncate text-2xl font-semibold tracking-tight">{title}</h2>
          </div>
          {only && <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">In {statusText(only)}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {editing && isAdmin && (
            <button
              type="button"
              className={ghostBtn}
              disabled={pending}
              onClick={() => run(() => setFeatured(root.id, false))}
            >
              Take off homepage
            </button>
          )}
          {editing && onMove && (
            <>
              <button
                type="button"
                className={ghostBtn}
                disabled={!onMove.up}
                onClick={onMove.up}
                aria-label={`Move ${title} up`}
                title="Move card up"
              >
                ↑
              </button>
              <button
                type="button"
                className={ghostBtn}
                disabled={!onMove.down}
                onClick={onMove.down}
                aria-label={`Move ${title} down`}
                title="Move card down"
              >
                ↓
              </button>
            </>
          )}
          <button
            type="button"
            onClick={() => setEditing((e) => !e)}
            className={`${ghostBtn} border border-neutral-200 dark:border-neutral-700`}
          >
            {editing ? "Done" : "Edit"}
          </button>
        </div>
      </div>

      <div className="mt-5">
        {only ? (
          <div className="space-y-4">
            <div className="text-neutral-900 dark:text-neutral-100">
              <SegmentedLine segments={projectSegments(only)} current={only.phase} labels />
            </div>
            {editing && isAdmin && <ProjectSettings program={only} allSubteams={allSubteams} />}
          </div>
        ) : (
          <SystemRows
            systems={systems}
            group={title}
            editing={editing}
            isAdmin={isAdmin}
            allSubteams={allSubteams}
          />
        )}
      </div>

      <div className="mt-8">
        <Milestones root={root} systems={systems} group={group} editing={editing} today={today} />
      </div>

      <div className="mt-8 border-t border-neutral-200 pt-6 dark:border-neutral-800">
        <h3 className={sectionTitle}>Subteams</h3>
        {subteams.length === 0 ? (
          <p className="mt-2 text-sm text-neutral-500 dark:text-neutral-400">
            {isAdmin
              ? only
                ? "Press Edit to add subteams."
                : "Press Edit, then Settings on a system, to add subteams."
              : "An admin can add subteams with Edit."}
          </p>
        ) : (
          <div className="mt-3 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {subteams.map((s) => (
              <SubteamCard key={s.id} subteam={s} group={group} editing={editing} isAdmin={isAdmin} today={today} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

/** Lets an admin put another project on the homepage. */
function TrackProject({
  candidates,
  prominent,
}: {
  candidates: { id: string; name: string }[];
  prominent: boolean;
}) {
  const { run, pending, error } = useAction();
  const [open, setOpen] = useState(prominent);
  const [projectId, setProjectId] = useState("");

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`${ghostBtn} border border-dashed border-neutral-300 dark:border-neutral-700`}
      >
        + Track another project
      </button>
    );
  }
  return (
    <form
      className="flex flex-wrap items-center gap-3 rounded-xl border border-dashed border-neutral-300 p-4 text-sm dark:border-neutral-700"
      onSubmit={(e) => {
        e.preventDefault();
        run(async () => {
          await setFeatured(projectId, true);
          setProjectId("");
          setOpen(prominent);
        });
      }}
    >
      <span className="text-neutral-600 dark:text-neutral-300">
        Track a project&apos;s phases and milestones here (its subprojects come with it):
      </span>
      <select className={input} value={projectId} onChange={(e) => setProjectId(e.target.value)}>
        <option value="">Choose a project…</option>
        {candidates.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      <button
        type="submit"
        disabled={pending || !projectId}
        className="rounded-md bg-neutral-900 px-3 py-1 text-sm font-medium text-white disabled:opacity-40 dark:bg-neutral-100 dark:text-neutral-900"
      >
        Track
      </button>
      {!prominent && (
        <button type="button" className={ghostBtn} onClick={() => setOpen(false)}>
          Cancel
        </button>
      )}
      {error && <span className="text-xs text-red-600">{error}</span>}
    </form>
  );
}

export function ProgramBoard({
  cards,
  isAdmin,
  candidates,
  allSubteams,
  today,
}: {
  cards: ProgramCardData[];
  isAdmin: boolean;
  /** Top-level projects, for the "track" picker. */
  candidates: { id: string; name: string }[];
  allSubteams: Subteams;
  today: string;
}) {
  const untracked = candidates.filter((c) => !cards.some((k) => k.root.id === c.id));
  const { run } = useAction();
  const move = (i: number, j: number) => () => {
    const order = cards.map((k) => k.root.id);
    [order[i], order[j]] = [order[j], order[i]];
    run(() => setCardOrder(order));
  };

  return (
    <div className="space-y-4">
      {cards.map((card, i) => (
        <ProgramCard
          key={card.root.id}
          card={card}
          isAdmin={isAdmin}
          allSubteams={allSubteams}
          today={today}
          onMove={
            isAdmin && cards.length > 1
              ? {
                  up: i > 0 ? move(i, i - 1) : undefined,
                  down: i < cards.length - 1 ? move(i, i + 1) : undefined,
                }
              : null
          }
        />
      ))}
      {isAdmin && untracked.length > 0 && (
        <TrackProject candidates={untracked} prominent={cards.length === 0} />
      )}
    </div>
  );
}
