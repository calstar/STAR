"use client";

import type { User } from "@prisma/client";
import { useState } from "react";

import { ConfirmButton } from "@/components/ConfirmButton";
import { FieldSelect } from "@/components/fields/FieldSelect";
import {
  addManufacturing,
  removeManufacturing,
  updateManufacturingField,
} from "@/lib/actions/manufacturing";
import { MANUFACTURING_LABEL, type ManufacturingField } from "@/lib/manufacturing";
import { displayNameOf } from "@/lib/names";
import type { TaskDetailData } from "@/lib/task-detail";

type Details = NonNullable<TaskDetailData["task"]["manufacturing"]>;

const label =
  "text-xs font-medium uppercase tracking-wide text-neutral-500 dark:text-neutral-400";
const input =
  "min-h-11 w-full rounded border border-neutral-300 bg-white px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900 sm:min-h-0";

/**
 * A task's manufacturing details: shown only once the task is marked as a
 * manufacturing part, which an "Add manufacturing details" button does from
 * here. Each field saves on its own (on blur / Enter / pick), like the rest of
 * the task card.
 */
export function ManufacturingSection({
  taskId,
  details,
  users,
  onChanged,
}: {
  taskId: string;
  details: Details | null;
  users: User[];
  onChanged: () => void;
}) {
  const [adding, setAdding] = useState(false);

  if (!details) {
    return (
      <button
        type="button"
        disabled={adding}
        onClick={async () => {
          setAdding(true);
          try {
            await addManufacturing(taskId);
            onChanged();
          } finally {
            setAdding(false);
          }
        }}
        className="min-h-11 w-full rounded-lg border border-dashed border-neutral-300 px-4 py-2 text-left text-sm text-neutral-500 hover:border-neutral-400 hover:text-neutral-700 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-400 dark:hover:border-neutral-600 dark:hover:text-neutral-200 sm:min-h-0"
      >
        + Add manufacturing details
      </button>
    );
  }

  const people = [
    { value: "", label: "—" },
    ...users.map((u) => ({ value: u.id, label: displayNameOf(u) })),
  ];

  return (
    <div className="rounded-lg border border-neutral-200 bg-white p-4 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
      <div className="flex items-center gap-2">
        <span className={label}>Manufacturing</span>
        <ConfirmButton
          action={async (fd) => {
            await removeManufacturing(fd);
            onChanged();
          }}
          id={taskId}
          label="Remove"
          className="ml-auto rounded px-2 text-xs text-neutral-400 hover:text-red-600 dark:text-neutral-500 dark:hover:text-red-400"
          title="Remove manufacturing details?"
          message="This clears the part name, links, quantity, material and REs, and the task stops being a manufacturing task."
          confirmLabel="Remove"
        />
      </div>

      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <TextField taskId={taskId} field="partName" value={details.partName} onSaved={onChanged} />
        </div>
        <LinkField taskId={taskId} field="onshapeUrl" value={details.onshapeUrl} onSaved={onChanged} />
        <LinkField taskId={taskId} field="drawingUrl" value={details.drawingUrl} onSaved={onChanged} />
        <TextField
          taskId={taskId}
          field="quantity"
          value={details.quantity === null ? null : String(details.quantity)}
          inputMode="numeric"
          onSaved={onChanged}
        />
        <TextField taskId={taskId} field="material" value={details.material} onSaved={onChanged} />
        <PersonField
          taskId={taskId}
          field="designReId"
          value={details.designReId}
          options={people}
          onSaved={onChanged}
        />
        <PersonField
          taskId={taskId}
          field="mfgReId"
          value={details.mfgReId}
          options={people}
          onSaved={onChanged}
        />
      </div>
    </div>
  );
}

/** Saves `field` and reports a validation message instead of throwing. */
function useSave(taskId: string, field: ManufacturingField, onSaved: () => void) {
  const [error, setError] = useState<string | null>(null);
  const save = async (v: string) => {
    const res = await updateManufacturingField(taskId, field, v);
    setError(res.error ?? null);
    if (!res.error) onSaved();
    return !res.error;
  };
  return { error, save };
}

function FieldError({ error }: { error: string | null }) {
  return error ? <p className="mt-1 text-xs text-red-600 dark:text-red-400">{error}</p> : null;
}

function TextField({
  taskId,
  field,
  value,
  inputMode,
  onSaved,
}: {
  taskId: string;
  field: ManufacturingField;
  value: string | null;
  inputMode?: "numeric";
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState(value ?? "");
  const { error, save } = useSave(taskId, field, onSaved);
  const commit = () => {
    if (draft.trim() !== (value ?? "")) void save(draft);
  };
  return (
    <label className="block">
      <span className={label}>{MANUFACTURING_LABEL[field]}</span>
      <input
        value={draft}
        inputMode={inputMode}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") setDraft(value ?? "");
        }}
        className={`mt-1 ${input}`}
      />
      <FieldError error={error} />
    </label>
  );
}

/** A link: shown as a clickable link once set, with an edit button; an input
 * while empty or being edited. */
function LinkField({
  taskId,
  field,
  value,
  onSaved,
}: {
  taskId: string;
  field: ManufacturingField;
  value: string | null;
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? "");
  const { error, save } = useSave(taskId, field, onSaved);
  const showLink = value && !editing && !error;

  const commit = async () => {
    if (draft.trim() === (value ?? "")) {
      setEditing(false);
      return;
    }
    if (await save(draft)) setEditing(false);
  };

  return (
    <div>
      <span className={label}>{MANUFACTURING_LABEL[field]}</span>
      {showLink ? (
        <div className="mt-1 flex min-h-11 items-center gap-2 sm:min-h-0 sm:py-1">
          <a
            href={value}
            target="_blank"
            rel="noopener noreferrer"
            className="min-w-0 truncate text-sm text-blue-600 hover:underline dark:text-blue-400"
            title={value}
          >
            {linkText(value)} ↗
          </a>
          <button
            type="button"
            onClick={() => {
              setDraft(value);
              setEditing(true);
            }}
            className="shrink-0 text-xs text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200"
          >
            Edit
          </button>
        </div>
      ) : (
        <input
          value={draft}
          type="url"
          placeholder="https://…"
          autoFocus={editing}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            if (e.key === "Escape") {
              setDraft(value ?? "");
              setEditing(false);
            }
          }}
          className={`mt-1 ${input}`}
        />
      )}
      <FieldError error={error} />
    </div>
  );
}

/** "cad.onshape.com/documents/…" — enough of a link to recognise it. */
function linkText(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname.length > 1 ? `${u.pathname.split("/")[1]}/…` : "";
    return `${u.hostname}/${path}`.replace(/\/$/, "");
  } catch {
    return url;
  }
}

function PersonField({
  taskId,
  field,
  value,
  options,
  onSaved,
}: {
  taskId: string;
  field: ManufacturingField;
  value: string | null;
  options: { value: string; label: string }[];
  onSaved: () => void;
}) {
  const [current, setCurrent] = useState(value ?? "");
  const { error, save } = useSave(taskId, field, onSaved);
  return (
    <div>
      <span className={label}>{MANUFACTURING_LABEL[field]}</span>
      <div className="mt-1">
        <FieldSelect
          value={current}
          options={options}
          ariaLabel={MANUFACTURING_LABEL[field]}
          searchable
          onChange={async (v) => {
            const prev = current;
            setCurrent(v);
            if (!(await save(v))) setCurrent(prev);
          }}
        />
      </div>
      <FieldError error={error} />
    </div>
  );
}
