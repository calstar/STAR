"use client";

import Link from "next/link";
import { useState } from "react";

import { type Option, StatusSelect } from "@/components/bom/shared";
import { ConfirmButton } from "@/components/ConfirmButton";
import { TaskLink } from "@/components/TaskLink";
import { deleteBomLine, updateBomField } from "@/lib/actions/bom";
import { type BomField, type BomLine, BOM_FIELD_LABEL, statusChangeNeedsApprover } from "@/lib/bom";
import { centsToPlain } from "@/lib/finance/money";

const label = "text-xs font-medium uppercase tracking-wide text-neutral-500 dark:text-neutral-400";
const input =
  "mt-1 min-h-11 w-full rounded border border-neutral-300 bg-white px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900 sm:min-h-0";

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const plainMoney = (c: number | null) => (c === null ? "" : centsToPlain(c));

/**
 * Every field of one BOM line. Each saves on its own (blur, Enter, or pick),
 * like a task's manufacturing details, and shows its own validation message.
 */
export function BomLineEditor({
  line,
  projectOptions,
  people,
  canApprove,
  onSaved,
  onDeleted,
}: {
  line: BomLine;
  projectOptions: Option[];
  people: Option[];
  canApprove: boolean;
  onSaved: () => void;
  onDeleted: () => void;
}) {
  const [errors, setErrors] = useState<Partial<Record<BomField, string>>>({});
  const save = async (field: BomField, value: string) => {
    const res = await updateBomField(line.id, field, value);
    setErrors((e) => ({ ...e, [field]: res.error }));
    if (!res.error) onSaved();
    return !res.error;
  };
  const allowance = line.kind === "allowance";
  // Text fields remount when the saved value changes, so a refresh shows it.
  const text = (field: BomField, value: string | null, extra: Partial<TextProps> = {}) => (
    <Text key={`${field}:${value ?? ""}`} field={field} value={value ?? ""} save={save} error={errors[field]} {...extra} />
  );
  const canDelete = canApprove || line.status === "planned";

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
      <div className="sm:col-span-2">{text("name", line.name)}</div>
      <Pick
        field="projectId"
        value={line.projectId}
        options={projectOptions.map((p) => ({ value: p.id, label: p.label }))}
        save={save}
        error={errors.projectId}
      />
      <Pick
        field="kind"
        value={line.kind}
        options={[
          { value: "part", label: "Part (unit × qty + shipping)" },
          { value: "allowance", label: "Allowance (a lump sum)" },
        ]}
        save={save}
        error={errors.kind}
      />

      {text("unitCostCents", plainMoney(line.unitCostCents), {
        label: allowance ? "Amount" : "Unit cost",
        inputMode: "decimal",
        prefix: "$",
      })}
      {!allowance && text("quantity", line.quantity === null ? "" : String(line.quantity), { inputMode: "decimal" })}
      {!allowance && text("shippingCents", plainMoney(line.shippingCents), { inputMode: "decimal", prefix: "$" })}
      {text("realizedCents", plainMoney(line.realizedCents), {
        inputMode: "decimal",
        prefix: "$",
        hint: "What was actually paid, from the receipt.",
      })}

      {text("supplier", line.supplier)}
      {text("url", line.url, { type: "url", placeholder: "https://…" })}
      {text("partNumber", line.partNumber, { placeholder: "91290A231" })}
      {text("manufacturer", line.manufacturer, { placeholder: "STMicroelectronics" })}
      {text("taskNumber", line.taskNumber === null ? "" : `#${line.taskNumber}`, {
        label: "Task",
        placeholder: "#412",
        after:
          line.taskId !== null && line.taskProjectId !== null ? (
            <TaskLink
              projectId={line.taskProjectId}
              taskId={line.taskId}
              className="mt-1 text-xs text-blue-600 hover:underline dark:text-blue-400"
            >
              Open task #{line.taskNumber}
            </TaskLink>
          ) : null,
      })}

      <div>
        <span className={label}>Status</span>
        <div className="mt-2">
          <StatusSelect line={line} canApprove={canApprove} onChange={(to) => void save("status", to)} />
        </div>
        {errors.status ? (
          <p className="mt-1 text-xs text-red-600 dark:text-red-400">{errors.status}</p>
        ) : (
          !canApprove &&
          statusChangeNeedsApprover(line.status, line.status === "planned" ? "approved" : "planned") && (
            <p className="mt-1 text-xs text-neutral-500">A PVP approves lines, through a purchase request.</p>
          )
        )}
      </div>
      {text("orderedAt", line.orderedAt, { type: "date", label: "Ordered on" })}
      <Pick
        field="purchaserId"
        value={line.purchaserId ?? ""}
        options={[{ value: "", label: line.purchaserName ? `— (typed: ${line.purchaserName})` : "—" }, ...people.map((p) => ({ value: p.id, label: p.label }))]}
        save={save}
        error={errors.purchaserId}
        label="Purchaser"
      />
      {text("location", line.location, { placeholder: "Snode" })}

      <div className="sm:col-span-4">
        <Notes value={line.notes ?? ""} save={save} error={errors.notes} key={`notes:${line.notes ?? ""}`} />
      </div>

      <div className="flex flex-wrap items-center gap-4 sm:col-span-4">
        <Check field="spare" checked={line.spare} save={save} label="Spare / backup" />
        <Check
          field="reimbursedElsewhere"
          checked={line.reimbursedElsewhere}
          save={save}
          label="Reimbursed"
        />
        {line.reimbursement && (
          <Link href={`/reimbursements?r=${line.reimbursement.number}`} className="text-sm text-blue-600 hover:underline dark:text-blue-400">
            Filed on R-{line.reimbursement.number}
          </Link>
        )}
        {canDelete ? (
          <ConfirmButton
            action={async (fd) => {
              await deleteBomLine(fd);
              onDeleted();
            }}
            id={line.id}
            label="Remove line"
            className="ml-auto rounded px-2 text-sm text-neutral-500 hover:text-red-600 dark:hover:text-red-400"
            title={`Remove “${line.name}”?`}
            message="It comes off this project's BOM and every BOM above it. History keeps a record."
            confirmLabel="Remove"
          />
        ) : (
          <span className="ml-auto text-xs text-neutral-500">Only a PVP can remove an approved line.</span>
        )}
      </div>
    </div>
  );
}

type Save = (field: BomField, value: string) => Promise<boolean>;

type TextProps = {
  field: BomField;
  value: string;
  save: Save;
  error?: string;
  label?: string;
  type?: "text" | "url" | "date";
  inputMode?: "decimal";
  placeholder?: string;
  prefix?: string;
  hint?: string;
  after?: React.ReactNode;
};

function Text({ field, value, save, error, label: text, type = "text", inputMode, placeholder, prefix, hint, after }: TextProps) {
  const [draft, setDraft] = useState(value);
  const commit = () => {
    if (draft.trim() !== value) void save(field, draft);
  };
  return (
    <label className="block">
      <span className={label}>{text ?? cap(BOM_FIELD_LABEL[field])}</span>
      <div className="relative">
        {prefix && <span className="pointer-events-none absolute left-2 top-1/2 mt-0.5 -translate-y-1/2 text-sm text-neutral-400">{prefix}</span>}
        <input
          value={draft}
          type={type}
          inputMode={inputMode}
          placeholder={placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            if (e.key === "Escape") setDraft(value);
          }}
          className={`${input} ${prefix ? "pl-5" : ""}`}
        />
      </div>
      {error ? (
        <p className="mt-1 text-xs text-red-600 dark:text-red-400">{error}</p>
      ) : hint ? (
        <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">{hint}</p>
      ) : null}
      {after}
    </label>
  );
}

function Notes({ value, save, error }: { value: string; save: Save; error?: string }) {
  const [draft, setDraft] = useState(value);
  return (
    <label className="block">
      <span className={label}>Notes &amp; alternate parts</span>
      <textarea
        rows={2}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => draft.trim() !== value && void save("notes", draft)}
        className={input}
      />
      {error && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{error}</p>}
    </label>
  );
}

function Pick({
  field,
  value,
  options,
  save,
  error,
  label: text,
}: {
  field: BomField;
  value: string;
  options: { value: string; label: string }[];
  save: Save;
  error?: string;
  label?: string;
}) {
  const [current, setCurrent] = useState(value);
  return (
    <label className="block">
      <span className={label}>{text ?? cap(BOM_FIELD_LABEL[field])}</span>
      <select
        value={current}
        onChange={async (e) => {
          const prev = current;
          setCurrent(e.target.value);
          if (!(await save(field, e.target.value))) setCurrent(prev);
        }}
        className={input}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {error && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{error}</p>}
    </label>
  );
}

function Check({ field, checked, save, label: text }: { field: BomField; checked: boolean; save: Save; label: string }) {
  const [on, setOn] = useState(checked);
  return (
    <label className="flex min-h-11 items-center gap-2 text-sm sm:min-h-0">
      <input
        type="checkbox"
        checked={on}
        onChange={async (e) => {
          const next = e.target.checked;
          setOn(next);
          if (!(await save(field, String(next)))) setOn(!next);
        }}
      />
      {text}
    </label>
  );
}
