"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import {
  createBudgetLine,
  deleteBudgetLine,
  updateBudgetLine,
} from "@/lib/actions/budget";
import {
  remainingCents,
  type Budget,
  type BudgetLineRow,
  type BudgetSubteamRow,
  type Tally,
} from "@/lib/finance/budget";
import { schoolYearLabel } from "@/lib/finance/ledger";
import { centsToPlain, formatCents } from "@/lib/finance/money";

const control =
  "min-h-11 w-full rounded border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-2 py-1.5 text-sm sm:min-h-0";
const button =
  "min-h-11 rounded border border-neutral-300 px-3 py-1 text-sm hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800 sm:min-h-0";
const primary =
  "min-h-11 rounded bg-neutral-900 px-3 py-1 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300 sm:min-h-0";
const muted = "text-xs text-neutral-500 dark:text-neutral-400";

type Res =
  { ok: true } | { error: string; fieldErrors?: Record<string, string> };
type ProjectOption = { id: string; label: string };

/**
 * A school year's budget: each line's plan beside what PVPs approved on purchase
 * requests against it and what still waits. With several subteams (the Finance
 * tab) it is a row of tabs, All plus one per subteam; with one (the subteam's
 * Budget page) it is just that subteam. `linkSubteams` heads a subteam with a
 * link to its own Budget page.
 */
export function BudgetPanel({
  budget,
  projects,
  linkSubteams = false,
}: {
  budget: Budget;
  projects: ProjectOption[];
  linkSubteams?: boolean;
}) {
  const single = budget.subteams.length === 1;
  const [tab, setTab] = useState<string>(
    single ? budget.subteams[0].id : "all",
  );
  const current = budget.subteams.find((s) => s.id === tab);

  return (
    <div className="viz">
      {!single && (
        <div
          role="tablist"
          aria-label="Subteam"
          className="-mx-1 mb-4 flex gap-1 overflow-x-auto border-b border-neutral-200 px-1 dark:border-neutral-800"
        >
          <Tab active={!current} onClick={() => setTab("all")}>
            All
          </Tab>
          {budget.subteams.map((s) => (
            <Tab
              key={s.id}
              active={current?.id === s.id}
              onClick={() => setTab(s.id)}
            >
              <span
                className="mr-1.5 inline-block h-2 w-2 rounded-full"
                style={{ background: s.color ?? "#a3a3a3" }}
              />
              {s.name}
            </Tab>
          ))}
        </div>
      )}
      <Legend />
      {current ? (
        <SubteamBudget
          key={current.id}
          year={budget.year}
          subteam={current}
          projects={projects}
          link={linkSubteams && !single}
        />
      ) : (
        <Overview budget={budget} onPick={setTab} />
      )}
    </div>
  );
}

function Tab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`-mb-px flex min-h-11 shrink-0 items-center whitespace-nowrap border-b-2 px-3 text-sm sm:min-h-0 sm:py-2 ${
        active
          ? "border-neutral-900 font-medium text-neutral-900 dark:border-neutral-100 dark:text-neutral-100"
          : "border-transparent text-neutral-500 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-200"
      }`}
    >
      {children}
    </button>
  );
}

/** One row per subteam with its totals; a name opens that subteam's tab. */
function Overview({
  budget,
  onPick,
}: {
  budget: Budget;
  onPick: (id: string) => void;
}) {
  return (
    <>
      <table className="mt-3 w-full text-sm">
        <thead>
          <tr className={`text-left ${muted}`}>
            <th className="py-1 pr-2 font-medium">Subteam</th>
            <th className="py-1 pr-2 text-right font-medium">Planned</th>
            <th className="py-1 pr-2 text-right font-medium">Approved</th>
            <th className="hidden py-1 pr-2 text-right font-medium sm:table-cell">
              Waiting
            </th>
            <th className="py-1 text-right font-medium">Left</th>
          </tr>
        </thead>
        <tbody>
          {budget.subteams.map((s) => {
            const left = remainingCents(s.tally);
            return (
              <tr
                key={s.id}
                className="border-t border-neutral-100 align-top dark:border-neutral-800"
              >
                <td className="py-2 pr-2">
                  <button
                    type="button"
                    className="flex items-center gap-2 font-medium hover:underline"
                    onClick={() => onPick(s.id)}
                  >
                    <span
                      className="inline-block h-2.5 w-2.5 rounded-full"
                      style={{ background: s.color ?? "#a3a3a3" }}
                    />
                    {s.name}
                  </button>
                  {s.lines.length > 0 ? (
                    <div className="mt-1.5 max-w-60">
                      <Meter t={s.tally} label={s.name} />
                    </div>
                  ) : (
                    <span className={`block ${muted}`}>No budget yet</span>
                  )}
                </td>
                <td className="whitespace-nowrap py-2 pr-2 text-right tabular-nums">
                  {formatCents(s.tally.plannedCents)}
                </td>
                <td className="whitespace-nowrap py-2 pr-2 text-right tabular-nums">
                  {formatCents(s.tally.approvedCents)}
                </td>
                <td className="hidden whitespace-nowrap py-2 pr-2 text-right tabular-nums text-neutral-500 sm:table-cell dark:text-neutral-400">
                  {s.tally.pendingCents
                    ? formatCents(s.tally.pendingCents)
                    : "—"}
                </td>
                <td
                  className={`whitespace-nowrap py-2 text-right tabular-nums ${left < 0 ? "font-medium text-red-600 dark:text-red-400" : ""}`}
                >
                  {formatCents(left)}
                </td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr className="border-t border-neutral-300 font-semibold dark:border-neutral-700">
            <td className="py-2 pr-2">All subteams</td>
            <td className="py-2 pr-2 text-right tabular-nums">
              {formatCents(budget.total.plannedCents)}
            </td>
            <td className="py-2 pr-2 text-right tabular-nums">
              {formatCents(budget.total.approvedCents)}
            </td>
            <td className="hidden py-2 pr-2 text-right tabular-nums sm:table-cell">
              {budget.total.pendingCents
                ? formatCents(budget.total.pendingCents)
                : "—"}
            </td>
            <td
              className={`py-2 text-right tabular-nums ${remainingCents(budget.total) < 0 ? "text-red-600 dark:text-red-400" : ""}`}
            >
              {formatCents(remainingCents(budget.total))}
            </td>
          </tr>
        </tfoot>
      </table>
      {budget.unbudgeted.requests > 0 && (
        <p className={`mt-3 ${muted}`}>
          Plus {formatCents(budget.unbudgeted.approvedCents)} approved
          {budget.unbudgeted.pendingCents
            ? ` and ${formatCents(budget.unbudgeted.pendingCents)} waiting`
            : ""}{" "}
          on {budget.unbudgeted.requests} purchase request
          {budget.unbudgeted.requests === 1 ? "" : "s"} made before budgets, on
          no line.
        </p>
      )}
    </>
  );
}

function Legend() {
  return (
    <p className={`flex flex-wrap items-center gap-3 ${muted}`}>
      <span className="flex items-center gap-1">
        <span
          className="inline-block h-2 w-2 rounded-sm"
          style={{ background: "var(--viz-approved)" }}
        />{" "}
        Approved
      </span>
      <span className="flex items-center gap-1">
        <span
          className="inline-block h-2 w-2 rounded-sm"
          style={{ background: "var(--viz-pending)" }}
        />{" "}
        Waiting on a PVP
      </span>
      <span className="flex items-center gap-1">
        <span
          className="inline-block h-2 w-2 rounded-sm"
          style={{ background: "var(--viz-over)" }}
        />{" "}
        Over budget
      </span>
    </p>
  );
}

/** "$850 of $1,200 approved · $350 left", with left in red once it's gone over. */
function Summary({ t }: { t: Tally }) {
  const left = remainingCents(t);
  return (
    <span className="text-sm tabular-nums">
      {formatCents(t.approvedCents)}{" "}
      <span className="text-neutral-500 dark:text-neutral-400">of</span>{" "}
      {formatCents(t.plannedCents)}
      <span className="text-neutral-500 dark:text-neutral-400"> · </span>
      <span
        className={left < 0 ? "font-medium text-red-600 dark:text-red-400" : ""}
      >
        {left < 0 ? `${formatCents(-left)} over` : `${formatCents(left)} left`}
      </span>
    </span>
  );
}

/** Approved, then waiting, as shares of the plan; past the plan the bar fills red. */
function Meter({ t, label }: { t: Tally; label: string }) {
  const scale = Math.max(t.plannedCents, t.approvedCents + t.pendingCents, 1);
  const over = t.approvedCents > t.plannedCents;
  const pct = (c: number) => `${(c / scale) * 100}%`;
  return (
    <div
      role="img"
      aria-label={`${label}: ${formatCents(t.approvedCents)} approved, ${formatCents(t.pendingCents)} waiting, of ${formatCents(t.plannedCents)} planned`}
      className="relative flex h-2 w-full overflow-hidden rounded-full"
      style={{ background: "var(--viz-grid)" }}
    >
      <span
        style={{
          width: pct(Math.min(t.approvedCents, t.plannedCents)),
          background: "var(--viz-approved)",
        }}
      />
      {over && (
        <span
          style={{
            width: pct(t.approvedCents - t.plannedCents),
            background: "var(--viz-over)",
          }}
        />
      )}
      {t.pendingCents > 0 && (
        <span
          className="border-l-2"
          style={{
            width: pct(t.pendingCents),
            background: "var(--viz-pending)",
            borderColor: "var(--viz-surface)",
          }}
        />
      )}
      {/* where the plan ends, once spending runs past it */}
      {scale > t.plannedCents && t.plannedCents > 0 && (
        <span
          className="absolute inset-y-0 w-0.5"
          style={{
            left: pct(t.plannedCents),
            background: "var(--viz-surface)",
          }}
        />
      )}
    </div>
  );
}

function SubteamBudget({
  year,
  subteam: s,
  projects,
  link,
}: {
  year: number;
  subteam: BudgetSubteamRow;
  projects: ProjectOption[];
  link: boolean;
}) {
  const empty = s.lines.length === 0;
  const [adding, setAdding] = useState(empty);
  const [editing, setEditing] = useState<string | null>(null);
  return (
    <section className="mt-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <span
            className="inline-block h-2.5 w-2.5 rounded-full"
            style={{ background: s.color ?? "#a3a3a3" }}
          />
          {link ? (
            <Link
              href={`/subteams/${s.id}/budget?year=${year}`}
              className="hover:underline"
            >
              {s.name}
            </Link>
          ) : (
            s.name
          )}
        </h3>
        <Summary t={s.tally} />
      </div>
      <div className="mt-2">
        <Meter t={s.tally} label={s.name} />
      </div>

      {empty && (
        <p className="mt-3 text-sm text-neutral-500 dark:text-neutral-400">
          No budget for {schoolYearLabel(year)} yet. Add the first line:
        </p>
      )}
      {!empty && (
        <table className="mt-2 w-full text-sm">
          <thead>
            <tr className={`text-left ${muted}`}>
              <th className="py-1 pr-2 font-medium">Line</th>
              <th className="py-1 pr-2 text-right font-medium">Planned</th>
              <th className="py-1 pr-2 text-right font-medium">Approved</th>
              <th className="hidden py-1 pr-2 text-right font-medium sm:table-cell">
                Waiting
              </th>
              <th className="py-1 text-right font-medium">Left</th>
              <th className="py-1" />
            </tr>
          </thead>
          <tbody>
            {s.lines.map((l) =>
              editing === l.id ? (
                <tr key={l.id}>
                  <td colSpan={6}>
                    <LineForm
                      year={year}
                      subteamId={s.id}
                      line={l}
                      projects={projects}
                      onDone={() => setEditing(null)}
                    />
                  </td>
                </tr>
              ) : (
                <LineRow key={l.id} line={l} onEdit={() => setEditing(l.id)} />
              ),
            )}
          </tbody>
        </table>
      )}
      {adding ? (
        <LineForm
          year={year}
          subteamId={s.id}
          projects={projects}
          onDone={() => setAdding(empty)}
        />
      ) : (
        <button
          type="button"
          className={`${button} mt-2`}
          onClick={() => setAdding(true)}
        >
          Add line
        </button>
      )}
    </section>
  );
}

function LineRow({
  line: l,
  onEdit,
}: {
  line: BudgetLineRow;
  onEdit: () => void;
}) {
  const left = remainingCents(l.tally);
  return (
    <tr className="border-t border-neutral-100 align-top dark:border-neutral-800">
      <td className="py-2 pr-2">
        <span className="font-medium">{l.name}</span>
        {l.projectLabel && (
          <span className={`block ${muted}`}>{l.projectLabel}</span>
        )}
        {l.note && <span className={`block ${muted}`}>{l.note}</span>}
        <span className={`block ${muted}`}>
          {l.tally.requests} request{l.tally.requests === 1 ? "" : "s"}
          {l.tally.pendingCents ? (
            <span className="sm:hidden">
              {" "}
              · {formatCents(l.tally.pendingCents)} waiting
            </span>
          ) : null}
        </span>
      </td>
      <td className="whitespace-nowrap py-2 pr-2 text-right tabular-nums">
        {formatCents(l.plannedCents)}
      </td>
      <td className="whitespace-nowrap py-2 pr-2 text-right tabular-nums">
        {formatCents(l.tally.approvedCents)}
      </td>
      <td className="hidden whitespace-nowrap py-2 pr-2 text-right tabular-nums text-neutral-500 sm:table-cell dark:text-neutral-400">
        {l.tally.pendingCents ? formatCents(l.tally.pendingCents) : "—"}
      </td>
      <td
        className={`whitespace-nowrap py-2 text-right tabular-nums ${left < 0 ? "font-medium text-red-600 dark:text-red-400" : ""}`}
      >
        {formatCents(left)}
      </td>
      <td className="py-2 pl-3 text-right">
        <button
          type="button"
          className="text-sm text-neutral-600 underline hover:no-underline dark:text-neutral-300"
          onClick={onEdit}
        >
          Edit
        </button>
      </td>
    </tr>
  );
}

function LineForm({
  year,
  subteamId,
  line,
  projects,
  onDone,
}: {
  year: number;
  subteamId: string;
  line?: BudgetLineRow;
  projects: ProjectOption[];
  onDone: () => void;
}) {
  const router = useRouter();
  const [name, setName] = useState(line?.name ?? "");
  const [amount, setAmount] = useState(
    line ? centsToPlain(line.plannedCents) : "",
  );
  const [projectId, setProjectId] = useState(line?.projectId ?? "");
  const [note, setNote] = useState(line?.note ?? "");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(action: () => Promise<Res>) {
    setBusy(true);
    setError(null);
    const res = await action();
    setBusy(false);
    if ("error" in res) {
      setError(res.error);
      setErrors(res.fieldErrors ?? {});
      return;
    }
    onDone();
    router.refresh();
  }

  const input = { name, amount, projectId, note };
  return (
    <form
      className="my-3 rounded-md border border-neutral-200 p-3 dark:border-neutral-800"
      onSubmit={(e) => {
        e.preventDefault();
        run(() =>
          line
            ? updateBudgetLine(line.id, input)
            : createBudgetLine(subteamId, year, input),
        );
      }}
    >
      <div className="grid gap-3 sm:grid-cols-6">
        <label className="block sm:col-span-3">
          <span className={muted}>Line</span>
          <input
            className={`${control} mt-1`}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Avionics boards, test-stand plumbing, …"
            autoFocus
          />
          {errors.name && (
            <span className="mt-1 block text-xs text-red-600">
              {errors.name}
            </span>
          )}
        </label>
        <label className="block sm:col-span-1">
          <span className={muted}>Planned</span>
          <input
            className={`${control} mt-1 tabular-nums`}
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00"
          />
          {errors.amount && (
            <span className="mt-1 block text-xs text-red-600">
              {errors.amount}
            </span>
          )}
        </label>
        <label className="block sm:col-span-2">
          <span className={muted}>Project (optional)</span>
          <select
            className={`${control} mt-1`}
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
          >
            <option value="">—</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
          {errors.projectId && (
            <span className="mt-1 block text-xs text-red-600">
              {errors.projectId}
            </span>
          )}
        </label>
        <label className="block sm:col-span-6">
          <span className={muted}>Note (optional)</span>
          <input
            className={`${control} mt-1`}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="What it covers, how the number was reached"
          />
        </label>
      </div>
      {error && (
        <p role="alert" className="mt-2 text-xs text-red-600">
          {error}
        </p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button type="submit" className={primary} disabled={busy}>
          {line ? "Save" : "Add line"}
        </button>
        <button type="button" className={button} onClick={onDone}>
          Cancel
        </button>
        {line && (
          <button
            type="button"
            className="ml-auto text-sm text-red-600 hover:underline"
            disabled={busy}
            onClick={() => {
              if (confirm(`Delete “${line.name}”?`))
                run(() => deleteBudgetLine(line.id));
            }}
          >
            Delete
          </button>
        )}
      </div>
    </form>
  );
}
