"use client";

import Link from "next/link";
import { Fragment, useEffect, useRef, useState } from "react";

import { BomLineEditor } from "@/components/bom/BomLineEditor";
import { type Option, StatusSelect } from "@/components/bom/shared";
import { ConfirmButton } from "@/components/ConfirmButton";
import { Modal } from "@/components/Modal";
import {
  addBomLine,
  commitBomImport,
  deleteBomLine,
  updateBomField,
} from "@/lib/actions/bom";
import {
  type BomField,
  type BomSection,
  linkHost,
  predictedCents,
  reimbursedState,
  summarize,
} from "@/lib/bom";
import { type Cell, parseSheet } from "@/lib/bom-import";
import { centsToPlain, formatCents } from "@/lib/finance/money";

type Line = BomSection["lines"][number];
type Kind =
  | "text"
  | "money"
  | "number"
  | "url"
  | "date"
  | "status"
  | "person"
  | "project"
  | "check"
  | "computed";

type Col = {
  key: string;
  field?: BomField;
  label: string;
  /** The header a pasted block may use for this column (read by bom-import.ts). */
  pasteHeader?: string;
  width: number;
  kind: Kind;
};

// LE3's column order, trimmed to what the team keeps in the sheet; supplier,
// realized cost, purchaser, location and notes are still on every line, in the
// row's ⋯ panel and the export. Item is pinned on the left while the rest scrolls.
const COLS: Col[] = [
  {
    key: "name",
    field: "name",
    label: "Item",
    pasteHeader: "Item",
    width: 240,
    kind: "text",
  },
  {
    key: "manufacturer",
    field: "manufacturer",
    label: "Manufacturer",
    pasteHeader: "Manufacturer",
    width: 140,
    kind: "text",
  },
  {
    key: "partNumber",
    field: "partNumber",
    label: "Part #",
    pasteHeader: "Part #",
    width: 120,
    kind: "text",
  },
  {
    key: "unitCostCents",
    field: "unitCostCents",
    label: "Unit cost",
    pasteHeader: "Unit Cost",
    width: 96,
    kind: "money",
  },
  {
    key: "quantity",
    field: "quantity",
    label: "Qty",
    pasteHeader: "Qty",
    width: 64,
    kind: "number",
  },
  {
    key: "predicted",
    label: "Predicted",
    pasteHeader: "Predicted Cost",
    width: 104,
    kind: "computed",
  },
  {
    key: "shippingCents",
    field: "shippingCents",
    label: "Ship & tax",
    pasteHeader: "Shipping & Tax",
    width: 96,
    kind: "money",
  },
  {
    key: "url",
    field: "url",
    label: "Link",
    pasteHeader: "Link",
    width: 170,
    kind: "url",
  },
  {
    key: "status",
    field: "status",
    label: "Status",
    pasteHeader: "Status",
    width: 160,
    kind: "status",
  },
  {
    key: "orderedAt",
    field: "orderedAt",
    label: "Ordered on",
    pasteHeader: "Ordered on",
    width: 136,
    kind: "date",
  },
  { key: "spare", field: "spare", label: "Spare", width: 60, kind: "check" },
  {
    key: "projectId",
    field: "projectId",
    label: "Project",
    width: 170,
    kind: "project",
  },
];

const PASTE_HEADERS: Cell[] = COLS.filter((c) => c.pasteHeader).map(
  (c) => c.pasteHeader!,
);

const cellInput =
  "h-9 w-full bg-transparent px-2 text-sm outline-none focus:bg-white focus:ring-2 focus:ring-inset focus:ring-blue-500 dark:focus:bg-neutral-900";

/** What a cell shows while not being edited, as text the input starts from. */
function rawOf(l: Line, col: Col): string {
  switch (col.key) {
    case "unitCostCents":
    case "shippingCents":
    case "realizedCents": {
      const c = l[col.key];
      return c === null ? "" : centsToPlain(c);
    }
    case "quantity":
      return l.quantity === null ? "" : String(l.quantity);
    default: {
      const v = l[col.key as keyof Line];
      return v === null || v === undefined ? "" : String(v);
    }
  }
}

/** Focus the same column one row up or down, skipping section headers. */
function moveFocus(from: HTMLElement, dir: 1 | -1) {
  const td = from.closest("td");
  const col = td?.dataset.col;
  let tr = td?.parentElement as HTMLElement | null | undefined;
  while (tr) {
    tr = (
      dir > 0 ? tr.nextElementSibling : tr.previousElementSibling
    ) as HTMLElement | null;
    const target = tr?.querySelector<HTMLElement>(
      `td[data-col="${col}"] input, td[data-col="${col}"] select`,
    );
    if (target) {
      target.focus();
      if (target instanceof HTMLInputElement) target.select();
      return;
    }
  }
  (from as HTMLInputElement).blur();
}

/**
 * The BOM as a spreadsheet: one section per project (the page's own, then each
 * subproject with everything under it), every cell editable in place and saved
 * when you leave it. Each section ends in an empty row: type a name to add a
 * part there, or paste rows from Excel / Google Sheets.
 */
export function BomSheet({
  rootProjectId,
  showOwnHeader,
  sections,
  projectOptions,
  people,
  canApprove,
  pendingRequests,
  selected,
  onToggle,
  onToggleAll,
  onChanged,
  onError,
}: {
  rootProjectId: string;
  /** Head the page's own lines with a "<project> (general)" row. Only a
   * top-level project does; any project with a parent starts straight at its lines. */
  showOwnHeader: boolean;
  sections: BomSection[];
  projectOptions: Option[];
  people: Option[];
  canApprove: boolean;
  /** BOM line id -> the PR number it is waiting on. */
  pendingRequests: Record<string, number>;
  selected: Set<string>;
  onToggle: (id: string) => void;
  /** Tick or untick every line the sheet shows (that can be ticked). */
  onToggleAll: (ids: string[], on: boolean) => void;
  onChanged: () => void;
  onError: (message: string | null) => void;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [details, setDetails] = useState<Line | null>(null);
  const [focusNext, setFocusNext] = useState<string | null>(null);
  const cols =
    projectOptions.length > 1
      ? COLS
      : COLS.filter((c) => c.key !== "projectId");
  const width = 40 + cols.reduce((n, c) => n + c.width, 0) + 72;
  // The header's select-all box covers every line shown that can be ticked
  // (a line already filed for reimbursement can't be).
  const tickable = sections.flatMap((s) => s.lines).filter((l) => reimbursedState(l) === "none").map((l) => l.id);
  const allTicked = tickable.length > 0 && tickable.every((id) => selected.has(id));
  const someTicked = tickable.some((id) => selected.has(id));

  // After adding a row, carry on in the column right after Item once the row
  // appears; Tab then walks the rest of the row left to right.
  useEffect(() => {
    if (!focusNext) return;
    const el = document.querySelector<HTMLInputElement>(
      `[data-cell="${focusNext}:${cols[1]?.key ?? "unitCostCents"}"]`,
    );
    if (el) {
      el.focus();
      setFocusNext(null);
    }
  }, [sections, focusNext, cols]);

  async function save(l: Line, field: BomField, value: string) {
    const res = await updateBomField(l.id, field, value);
    onError(res.error ? `${l.name}: ${res.error}` : null);
    if (!res.error) onChanged();
    return !res.error;
  }

  // The current values of lines open in the details panel follow the sheet.
  const detailLine = details
    ? (sections.flatMap((s) => s.lines).find((l) => l.id === details.id) ??
      null)
    : null;

  return (
    <>
      <div className="max-w-full overflow-x-auto rounded-lg border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
        <table
          className="table-fixed border-collapse text-sm"
          style={{ width }}
        >
          <colgroup>
            <col style={{ width: 40 }} />
            {cols.map((c) => (
              <col key={c.key} style={{ width: c.width }} />
            ))}
            <col style={{ width: 72 }} />
          </colgroup>
          <thead className="bg-neutral-50 text-left text-xs font-medium text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">
            <tr>
              <th className="sticky left-0 z-20 bg-neutral-50 text-center dark:bg-neutral-800">
                <input
                  type="checkbox"
                  aria-label="Select every part"
                  title="Select every part shown"
                  disabled={tickable.length === 0}
                  checked={allTicked}
                  ref={(el) => {
                    if (el) el.indeterminate = someTicked && !allTicked;
                  }}
                  onChange={() => onToggleAll(tickable, !allTicked)}
                />
              </th>
              {cols.map((c, i) => (
                <th
                  key={c.key}
                  className={`border-l border-neutral-200 px-2 py-2 font-medium dark:border-neutral-700 ${
                    c.kind === "money" ||
                    c.kind === "number" ||
                    c.kind === "computed"
                      ? "text-right"
                      : ""
                  } ${i === 0 ? "sticky left-10 z-20 bg-neutral-50 dark:bg-neutral-800" : ""}`}
                >
                  {c.label}
                </th>
              ))}
              <th className="border-l border-neutral-200 dark:border-neutral-700" />
            </tr>
          </thead>
          <tbody>
            {sections.map((s) => {
              const key = s.projectId ?? "own";
              const sum = summarize(s.lines);
              const shut = collapsed.has(key);
              const targetId = s.projectId ?? rootProjectId;
              const headed = s.projectId !== null || showOwnHeader;
              return (
                <Fragment key={key}>
                  {headed && (
                    <tr className="border-t-2 border-neutral-200 bg-indigo-50 dark:border-neutral-700 dark:bg-indigo-950/40">
                      <td className="sticky left-0 z-10 bg-indigo-50 dark:bg-indigo-950" />
                      <td
                        className="sticky left-10 z-10 bg-indigo-50 px-2 py-2 dark:bg-indigo-950"
                        colSpan={1}
                      >
                        <button
                          type="button"
                          aria-expanded={!shut}
                          onClick={() =>
                            setCollapsed((c) => {
                              const next = new Set(c);
                              if (next.has(key)) next.delete(key);
                              else next.add(key);
                              return next;
                            })
                          }
                          className="flex w-full items-center gap-2 text-left font-semibold"
                        >
                          <span className="w-3 text-neutral-400">
                            {shut ? "▸" : "▾"}
                          </span>
                          <span
                            className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                            style={{ background: s.color ?? "#a3a3a3" }}
                          />
                          <span className="truncate">{s.title}</span>
                        </button>
                      </td>
                      <td colSpan={3} className="px-2 text-xs text-neutral-500">
                        {s.lines.length} line{s.lines.length === 1 ? "" : "s"}
                      </td>
                      <td className="px-2 text-right font-semibold tabular-nums">
                        {formatCents(sum.predictedCents)}
                      </td>
                      <td colSpan={cols.length - 4} />
                    </tr>
                  )}
                  {!shut &&
                    s.lines.map((l) => (
                      <Row
                        key={l.id}
                        line={l}
                        cols={cols}
                        projectOptions={projectOptions}
                        people={people}
                        canApprove={canApprove}
                        pendingRequest={pendingRequests[l.id] ?? null}
                        selected={selected.has(l.id)}
                        onToggle={() => onToggle(l.id)}
                        save={(field, value) => save(l, field, value)}
                        onDetails={() => setDetails(l)}
                        onDeleted={onChanged}
                      />
                    ))}
                  {!shut && (
                    <NewRow
                      cols={cols}
                      projectId={targetId}
                      rootProjectId={rootProjectId}
                      sectionTitle={s.title}
                      onAdded={(id) => {
                        if (id) setFocusNext(id);
                        onChanged();
                      }}
                      onError={onError}
                    />
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      {detailLine && (
        <Modal onClose={() => setDetails(null)}>
          <div className="overflow-y-auto p-5 sm:p-6">
            <h2 className="mb-4 pr-12 text-lg font-semibold">
              {detailLine.name}
            </h2>
            <BomLineEditor
              key={detailLine.id}
              line={detailLine}
              projectOptions={projectOptions}
              people={people}
              canApprove={canApprove}
              onSaved={onChanged}
              onDeleted={() => {
                setDetails(null);
                onChanged();
              }}
            />
          </div>
        </Modal>
      )}
    </>
  );
}

function Row({
  line: l,
  cols,
  projectOptions,
  people,
  canApprove,
  pendingRequest,
  selected,
  onToggle,
  save,
  onDetails,
  onDeleted,
}: {
  line: Line;
  cols: Col[];
  projectOptions: Option[];
  people: Option[];
  canApprove: boolean;
  pendingRequest: number | null;
  selected: boolean;
  onToggle: () => void;
  save: (field: BomField, value: string) => Promise<boolean>;
  onDetails: () => void;
  onDeleted: () => void;
}) {
  const filed = reimbursedState(l) !== "none";
  const allowance = l.kind === "allowance";
  return (
    <tr className="group border-t border-neutral-100 hover:bg-neutral-50/60 dark:border-neutral-800 dark:hover:bg-neutral-800/30">
      <td className="sticky left-0 z-10 bg-white text-center group-hover:bg-neutral-50 dark:bg-neutral-900 dark:group-hover:bg-neutral-800">
        <input
          type="checkbox"
          aria-label={`Select ${l.name}`}
          checked={selected}
          onChange={onToggle}
          disabled={filed}
          title={
            filed
              ? "Already filed for reimbursement"
              : "Select to file a reimbursement"
          }
        />
      </td>
      {cols.map((c, i) => {
        const pinned =
          i === 0
            ? "sticky left-10 z-10 bg-white group-hover:bg-neutral-50 dark:bg-neutral-900 dark:group-hover:bg-neutral-800"
            : "";
        const td = `border-l border-neutral-100 p-0 dark:border-neutral-800 ${pinned}`;
        if (c.kind === "computed")
          return (
            <td
              key={c.key}
              data-col={c.key}
              className={`${td} px-2 text-right font-medium tabular-nums`}
            >
              {formatCents(predictedCents(l))}
            </td>
          );
        if (allowance && (c.key === "quantity" || c.key === "shippingCents"))
          return (
            <td
              key={c.key}
              className={`${td} px-2 text-right text-neutral-400`}
              title="An allowance is a lump sum"
            >
              —
            </td>
          );
        if (c.kind === "status")
          return (
            <td key={c.key} data-col={c.key} className={`${td} px-1`}>
              <div className="flex items-center gap-1.5">
                <StatusSelect
                  line={l}
                  canApprove={canApprove}
                  onChange={(to) => void save("status", to)}
                />
                {pendingRequest !== null && (
                  <Link
                    href={`/purchase-requests?pr=${pendingRequest}`}
                    title="Waiting for a PVP on this purchase request"
                    className="whitespace-nowrap text-xs text-blue-600 hover:underline dark:text-blue-400"
                  >
                    PR-{pendingRequest}
                  </Link>
                )}
              </div>
            </td>
          );
        if (c.kind === "person")
          return (
            <td key={c.key} data-col={c.key} className={td}>
              <SelectCell
                key={l.purchaserId ?? ""}
                label={`Purchaser of ${l.name}`}
                value={l.purchaserId ?? ""}
                options={[
                  {
                    id: "",
                    label: l.purchaserName ? `${l.purchaserName} (typed)` : "—",
                  },
                  ...people,
                ]}
                onPick={(v) => save("purchaserId", v)}
              />
            </td>
          );
        if (c.kind === "project")
          return (
            <td key={c.key} data-col={c.key} className={td}>
              <SelectCell
                key={l.projectId}
                label={`Project of ${l.name}`}
                value={l.projectId}
                options={projectOptions}
                onPick={(v) => save("projectId", v)}
              />
            </td>
          );
        if (c.kind === "check")
          return (
            <td key={c.key} data-col={c.key} className={`${td} text-center`}>
              <input
                type="checkbox"
                aria-label={`${l.name} is a spare`}
                checked={l.spare}
                onChange={(e) => void save("spare", String(e.target.checked))}
              />
            </td>
          );
        return (
          <td key={c.key} data-col={c.key} className={td}>
            {c.key === "name" && l.subpath && (
              <span className="block truncate px-2 pt-1 text-[11px] leading-none text-neutral-400">
                {l.subpath} ›
              </span>
            )}
            <TextCell
              key={`${c.key}:${rawOf(l, c)}`}
              id={`${l.id}:${c.key}`}
              label={`${c.label} of ${l.name}`}
              value={rawOf(l, c)}
              kind={c.kind}
              placeholder={
                c.key === "unitCostCents" && allowance ? "amount" : undefined
              }
              onCommit={(v) => save(c.field!, v)}
            />
          </td>
        );
      })}
      <td className="border-l border-neutral-100 dark:border-neutral-800">
        <div className="flex items-center justify-center gap-1">
          <button
            type="button"
            onClick={onDetails}
            aria-label={`More fields of ${l.name}`}
            title="More: supplier, realized cost, purchaser, location, notes, allowance, linked task"
            className="rounded px-1.5 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
          >
            ⋯
          </button>
          {canApprove || l.status === "planned" ? (
            <ConfirmButton
              action={async (fd) => {
                await deleteBomLine(fd);
                onDeleted();
              }}
              id={l.id}
              ariaLabel={`Delete ${l.name}`}
              label={<TrashIcon />}
              className="rounded px-1 text-neutral-400 hover:text-red-600 dark:hover:text-red-400"
              title={`Delete “${l.name}”?`}
              message="It comes off this BOM and every BOM above it. History keeps a record."
              confirmLabel="Delete"
            />
          ) : (
            <span
              className="px-1 text-neutral-300 dark:text-neutral-600"
              title="Only a PVP can delete an approved line"
            >
              <TrashIcon />
            </span>
          )}
        </div>
      </td>
    </tr>
  );
}

function TrashIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      aria-hidden
    >
      <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />
    </svg>
  );
}

/** One editable cell. Saves when focus leaves it with a changed value; Enter
 * moves down, Escape puts the saved value back. A refused value stays in the
 * cell, outlined red, until it is fixed or Escaped. */
function TextCell({
  id,
  label,
  value,
  kind,
  placeholder,
  onCommit,
}: {
  id: string;
  label: string;
  value: string;
  kind: Kind;
  placeholder?: string;
  onCommit: (v: string) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState(value);
  const [bad, setBad] = useState(false);
  const [focused, setFocused] = useState(false);
  const skip = useRef(false);
  const right = kind === "money" || kind === "number";
  // A saved link reads as its site ("amazon.com ↗") until the cell is focused;
  // the input underneath stays the focus target for Tab, Enter and clicks.
  const shortLink = kind === "url" && !!value && !focused && !bad;
  return (
    <div className="relative">
      {shortLink && (
        <div className="pointer-events-none absolute inset-0 flex items-center px-2">
          <a
            href={value}
            target="_blank"
            rel="noopener noreferrer"
            title={value}
            onMouseDown={(e) => e.stopPropagation()}
            className="pointer-events-auto truncate text-sm text-blue-600 hover:underline dark:text-blue-400"
          >
            {linkHost(value)} ↗
          </a>
        </div>
      )}
      <input
        data-cell={id}
        aria-label={label}
        value={draft}
        type={kind === "date" ? "date" : "text"}
        inputMode={right ? "decimal" : undefined}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => {
          setFocused(true);
          e.target.select();
        }}
        onBlur={async () => {
          setFocused(false);
          if (skip.current) {
            skip.current = false;
            return;
          }
          if (draft.trim() === value) return setBad(false);
          setBad(!(await onCommit(draft)));
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            moveFocus(e.currentTarget, e.shiftKey ? -1 : 1);
          } else if (e.key === "Escape") {
            skip.current = true;
            setDraft(value);
            setBad(false);
            e.currentTarget.blur();
          } else if (
            (e.key === "ArrowDown" || e.key === "ArrowUp") &&
            kind !== "date"
          ) {
            e.preventDefault();
            moveFocus(e.currentTarget, e.key === "ArrowDown" ? 1 : -1);
          }
        }}
        className={`${cellInput} ${right ? "text-right tabular-nums" : ""} ${bad ? "ring-2 ring-inset ring-red-500" : ""} ${
          shortLink ? "text-transparent" : ""
        }`}
      />
    </div>
  );
}

function SelectCell({
  label,
  value,
  options,
  onPick,
}: {
  label: string;
  value: string;
  options: Option[];
  onPick: (v: string) => Promise<boolean>;
}) {
  // The parent keys this by the saved value, so a refresh resets it.
  const [current, setCurrent] = useState(value);
  return (
    <select
      aria-label={label}
      value={current}
      onChange={async (e) => {
        const prev = current;
        setCurrent(e.target.value);
        if (!(await onPick(e.target.value))) setCurrent(prev);
      }}
      className={`${cellInput} truncate`}
    >
      {options.map((o) => (
        <option key={o.id} value={o.id}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/** The empty last row of a section. Typing a name adds a part to the
 * section's project; pasting a block copied from a spreadsheet adds a row per
 * line (with a header row, columns are matched by name as on import; without,
 * they are read in this sheet's column order). */
function NewRow({
  cols,
  projectId,
  rootProjectId,
  sectionTitle,
  onAdded,
  onError,
}: {
  cols: Col[];
  projectId: string;
  rootProjectId: string;
  sectionTitle: string;
  onAdded: (id: string | null) => void;
  onError: (message: string | null) => void;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  async function add() {
    const n = name.trim();
    if (!n || busy) return;
    setBusy(true);
    try {
      const res = await addBomLine(projectId, { name: n });
      onError(res.error ?? null);
      if (!res.error) {
        setName("");
        onAdded(res.id ?? null);
      }
    } finally {
      setBusy(false);
    }
  }

  async function paste(text: string) {
    const rows: Cell[][] = text
      .replace(/\r/g, "")
      .split("\n")
      .filter((r) => r.trim())
      .map((r) => r.split("\t"));
    const asIs = parseSheet(sectionTitle, rows);
    const parsed = asIs.lines.length
      ? asIs
      : parseSheet(sectionTitle, [PASTE_HEADERS, ...rows]);
    if (!parsed.lines.length)
      return onError(
        "Nothing in that paste looked like a part (a name in the first column).",
      );
    setBusy(true);
    try {
      const res = await commitBomImport(rootProjectId, {
        fileName: "a paste",
        sheets: [{ sheet: sectionTitle, projectId, lines: parsed.lines }],
      });
      if (res.error) return onError(res.error);
      onError(
        res.demoted
          ? `Added ${res.added} rows. ${res.demoted} marked approved or ordered came in as Planned; a PVP approves them.`
          : null,
      );
      onAdded(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <tr className="border-t border-neutral-100 dark:border-neutral-800">
      <td className="sticky left-0 z-10 bg-white text-center text-neutral-300 dark:bg-neutral-900">
        +
      </td>
      <td
        data-col="name"
        className="sticky left-10 z-10 border-l border-neutral-100 bg-white p-0 dark:border-neutral-800 dark:bg-neutral-900"
      >
        <input
          aria-label={`Add a part to ${sectionTitle}`}
          value={name}
          disabled={busy}
          placeholder={busy ? "Adding…" : "Add a part, or paste rows"}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => void add()}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void add();
            }
            if (e.key === "Escape") setName("");
          }}
          onPaste={(e) => {
            const text = e.clipboardData.getData("text/plain");
            if (text.includes("\t") || text.trim().includes("\n")) {
              e.preventDefault();
              void paste(text);
            }
          }}
          className={`${cellInput} placeholder:text-neutral-400`}
        />
      </td>
      <td colSpan={cols.length} className="px-2 text-xs text-neutral-400">
        {name.trim() ? "Enter to add" : ""}
      </td>
    </tr>
  );
}
