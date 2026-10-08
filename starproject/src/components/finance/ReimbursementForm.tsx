"use client";

import { useRouter } from "next/navigation";
import { useMemo, useRef, useState } from "react";

import { formatCents, parseMoney, sumCents } from "@/lib/finance/money";
import type { ProfileDefaults } from "@/lib/finance/queries";
import { RECEIPT_ACCEPT, checkReceipt } from "@/lib/finance/receipts";
import { EXPENDITURE_ACTIONS, MAX_ITEMS } from "@/lib/finance/schema";

// ASUC's own direct-deposit sign-up (linked from CalLink's form). ASUC is not
// connected to CalCentral/UCPath, so members sign up here separately.
const DIRECT_DEPOSIT_FORM =
  "https://na3.docusign.net/Member/PowerFormSigning.aspx?PowerFormId=30413e7e-b85b-4c0b-8f05-6ffe10bafb77&env=na3&acct=620e8a46-493a-4013-a8aa-1bce714f8b8a&v=2";

const control =
  "min-h-11 w-full rounded border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 py-1.5 text-sm sm:min-h-0";
const fieldLabel = "block text-xs font-medium text-neutral-500 dark:text-neutral-400";
const section = "rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4 shadow-sm";
const sectionTitle = "text-sm font-semibold";

type Item = {
  key: number;
  date: string;
  vendor: string;
  amount: string;
  comment: string;
  file: File | null;
  fileError: string | null;
};

let nextKey = 1;
const blankItem = (): Item => ({ key: nextKey++, date: "", vendor: "", amount: "", comment: "", file: null, fileError: null });

function Field({
  label,
  error,
  hint,
  className = "",
  children,
}: {
  label: string;
  error?: string;
  hint?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  // The hint and error sit outside the <label> so they aren't read as part of the
  // field's name.
  return (
    <div className={className}>
      <label className="block">
        <span className={fieldLabel}>{label}</span>
        <span className="mt-1 block">{children}</span>
      </label>
      {hint && !error && <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">{hint}</p>}
      {error && (
        <p role="alert" className="mt-1 text-xs text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}

export function ReimbursementForm({
  defaults,
  seededFrom,
  accountEmail,
  projects,
  subteams,
}: {
  defaults: ProfileDefaults;
  /** CalLink request number the payee details were taken from, if any. */
  seededFrom: string | null;
  accountEmail: string;
  projects: { id: string; label: string }[];
  subteams: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [subject, setSubject] = useState("");
  const [description, setDescription] = useState("");
  const [projectId, setProjectId] = useState("");
  const [subteamId, setSubteamId] = useState("");
  const [payee, setPayee] = useState(defaults);
  const [expenditureAction, setExpenditureAction] = useState<(typeof EXPENDITURE_ACTIONS)[number]>("Direct Deposit");
  const [specialInstructions, setSpecialInstructions] = useState("");
  const [items, setItems] = useState<Item[]>(() => [blankItem()]);
  const [saveProfile, setSaveProfile] = useState(true);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const top = useRef<HTMLDivElement>(null);

  const total = useMemo(() => sumCents(items.map((i) => parseMoney(i.amount))), [items]);
  const setP = (k: keyof ProfileDefaults) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setPayee((p) => ({ ...p, [k]: k === "directDepositSignedUp" ? e.target.checked : e.target.value }));
  const setItem = (key: number, patch: Partial<Item>) =>
    setItems((list) => list.map((i) => (i.key === key ? { ...i, ...patch } : i)));

  async function pickFile(key: number, file: File | null) {
    if (!file) return setItem(key, { file: null, fileError: null });
    const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
    const check = checkReceipt(file.name, file.size, head);
    setItem(key, check.ok ? { file, fileError: null } : { file: null, fileError: check.error });
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    setErrors({});
    const missing = items.findIndex((i) => !i.file);
    if (missing >= 0) {
      setErrors({ [`items.${missing}.receipt`]: "Attach the receipt" });
      setFormError("Every item needs its receipt.");
      top.current?.scrollIntoView({ behavior: "smooth" });
      return;
    }
    const payload = {
      subject,
      description,
      projectId,
      subteamId,
      payee: {
        firstName: payee.firstName,
        lastName: payee.lastName,
        street: payee.street,
        street2: payee.street2,
        city: payee.city,
        state: payee.state,
        zip: payee.zip,
      },
      uid: payee.uid,
      email: payee.email,
      phone: payee.phone,
      expenditureAction,
      directDepositSignedUp: payee.directDepositSignedUp,
      specialInstructions,
      items: items.map((i) => ({ date: i.date, vendor: i.vendor, amount: i.amount, comment: i.comment })),
      saveProfile,
    };
    const body = new FormData();
    body.set("payload", JSON.stringify(payload));
    items.forEach((i, n) => i.file && body.set(`receipt-${n}`, i.file));

    setBusy(true);
    try {
      const res = await fetch("/api/finance/requests", { method: "POST", body });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErrors(out.fieldErrors ?? {});
        setFormError(out.error ?? `Something went wrong (${res.status}).`);
        top.current?.scrollIntoView({ behavior: "smooth" });
        return;
      }
      router.push(`/reimbursements?r=${out.number}`);
    } catch {
      setFormError("Couldn't reach the server. Your entries are still here; try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-6 space-y-4" noValidate>
      <div ref={top} />
      {formError && (
        <p className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
          {formError}
        </p>
      )}

      <div className={section}>
        <p className={sectionTitle}>What was it for?</p>
        <div className="mt-3 grid gap-3">
          <Field label="Subject" error={errors.subject} hint="Shown on CalLink, e.g. “LE3 fittings” or “Diablo avionics”.">
            <input className={control} value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={150} required />
          </Field>
          <Field label="Description (optional)" error={errors.description}>
            <textarea className={control} rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Project" error={errors.projectId} hint="What the purchase was for. Not sent to CalLink.">
              <select className={control} value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                <option value="">No project</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Subteam" error={errors.subteamId}>
              <select className={control} value={subteamId} onChange={(e) => setSubteamId(e.target.value)}>
                <option value="">No subteam</option>
                {subteams.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        </div>
      </div>

      <div className={section}>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className={sectionTitle}>Items and receipts</p>
          <p className="text-sm">
            Total <span className="font-semibold tabular-nums">{formatCents(total)}</span>
          </p>
        </div>
        <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
          One receipt per item, as a PDF, PNG or JPEG under 4 MB. The total requested is the sum of the items.
        </p>
        {errors.items && <p className="mt-2 text-xs text-red-600">{errors.items}</p>}
        <ol className="mt-3 space-y-3">
          {items.map((it, n) => (
            <li key={it.key} className="rounded-md border border-neutral-200 p-3 dark:border-neutral-800">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">Item {n + 1}</span>
                {items.length > 1 && (
                  <button
                    type="button"
                    onClick={() => setItems((list) => list.filter((i) => i.key !== it.key))}
                    className="text-sm text-red-600 hover:underline"
                  >
                    Remove
                  </button>
                )}
              </div>
              <div className="grid gap-3 sm:grid-cols-6">
                <Field label="Vendor" error={errors[`items.${n}.vendor`]} className="sm:col-span-3">
                  <input className={control} value={it.vendor} onChange={(e) => setItem(it.key, { vendor: e.target.value })} placeholder="McMaster-Carr" />
                </Field>
                <Field label="Date on receipt" error={errors[`items.${n}.date`]} className="sm:col-span-2">
                  <input type="date" className={control} value={it.date} onChange={(e) => setItem(it.key, { date: e.target.value })} />
                </Field>
                <Field label="Total" error={errors[`items.${n}.amount`]} className="sm:col-span-1">
                  <input
                    className={`${control} tabular-nums`}
                    inputMode="decimal"
                    value={it.amount}
                    onChange={(e) => setItem(it.key, { amount: e.target.value })}
                    placeholder="0.00"
                  />
                </Field>
                <Field label="Comment (optional)" error={errors[`items.${n}.comment`]} className="sm:col-span-3">
                  <input className={control} value={it.comment} onChange={(e) => setItem(it.key, { comment: e.target.value })} />
                </Field>
                <Field label="Receipt" error={it.fileError ?? errors[`items.${n}.receipt`]} className="sm:col-span-3">
                  <input
                    type="file"
                    accept={RECEIPT_ACCEPT}
                    onChange={(e) => pickFile(it.key, e.target.files?.[0] ?? null)}
                    className="block w-full text-sm file:mr-3 file:rounded file:border file:border-neutral-300 file:bg-white file:px-3 file:py-1.5 file:text-sm dark:file:border-neutral-700 dark:file:bg-neutral-900 dark:file:text-neutral-200"
                  />
                </Field>
              </div>
            </li>
          ))}
        </ol>
        {items.length < MAX_ITEMS ? (
          <button
            type="button"
            onClick={() => setItems((list) => [...list, blankItem()])}
            className="mt-3 rounded border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
          >
            Add item
          </button>
        ) : (
          <p className="mt-3 text-xs text-neutral-500 dark:text-neutral-400">
            Six items is CalLink&apos;s limit. For more, file a second request and say “2 of 2” in its subject.
          </p>
        )}
      </div>

      <div className={section}>
        <p className={sectionTitle}>Who gets paid</p>
        {seededFrom && (
          <p className="mt-2 rounded border border-blue-200 bg-blue-50 p-2 text-xs text-blue-800 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-200">
            Filled in from your last CalLink request (#{seededFrom}). Check it is still right.
          </p>
        )}
        <div className="mt-3 grid gap-3 sm:grid-cols-6">
          <Field label="First name" error={errors["payee.firstName"]} className="sm:col-span-3">
            <input className={control} autoComplete="given-name" value={payee.firstName} onChange={setP("firstName")} />
          </Field>
          <Field label="Last name" error={errors["payee.lastName"]} className="sm:col-span-3">
            <input className={control} autoComplete="family-name" value={payee.lastName} onChange={setP("lastName")} />
          </Field>
          <Field
            label="Email"
            error={errors.email}
            className="sm:col-span-3"
            hint={payee.email.toLowerCase() === accountEmail.toLowerCase() ? "Your account email." : undefined}
          >
            <input className={control} type="email" autoComplete="email" value={payee.email} onChange={setP("email")} />
          </Field>
          <Field label="Phone" error={errors.phone} className="sm:col-span-3">
            <input className={control} type="tel" autoComplete="tel" value={payee.phone} onChange={setP("phone")} />
          </Field>
          <Field
            label="UC Berkeley UID"
            error={errors.uid}
            className="sm:col-span-3"
            hint="7 or 8 digits, from CalCentral or the campus directory. Not your student ID (303…)."
          >
            {/* No autocomplete: a browser should never offer one member's UID to another. */}
            <input className={control} inputMode="numeric" autoComplete="off" value={payee.uid} onChange={setP("uid")} />
          </Field>
          <Field label="Street" error={errors["payee.street"]} className="sm:col-span-6">
            <input className={control} autoComplete="address-line1" value={payee.street} onChange={setP("street")} />
          </Field>
          <Field label="Apt / unit (optional)" error={errors["payee.street2"]} className="sm:col-span-6">
            <input className={control} autoComplete="address-line2" value={payee.street2} onChange={setP("street2")} />
          </Field>
          <Field label="City" error={errors["payee.city"]} className="sm:col-span-3">
            <input className={control} autoComplete="address-level2" value={payee.city} onChange={setP("city")} />
          </Field>
          <Field label="State" error={errors["payee.state"]} className="sm:col-span-1">
            <input className={control} autoComplete="address-level1" maxLength={2} value={payee.state} onChange={setP("state")} />
          </Field>
          <Field label="ZIP" error={errors["payee.zip"]} className="sm:col-span-2">
            <input className={control} autoComplete="postal-code" inputMode="numeric" value={payee.zip} onChange={setP("zip")} />
          </Field>
        </div>
      </div>

      <div className={section}>
        <p className={sectionTitle}>How to pay</p>
        <div className="mt-3 grid gap-3">
          <Field label="Payment" error={errors.expenditureAction}>
            <select
              className={control}
              value={expenditureAction}
              onChange={(e) => setExpenditureAction(e.target.value as (typeof EXPENDITURE_ACTIONS)[number])}
            >
              {EXPENDITURE_ACTIONS.map((a) => (
                <option key={a} value={a}>
                  {a === "Other" ? "Other (explain below)" : a}
                </option>
              ))}
            </select>
          </Field>
          {expenditureAction === "Direct Deposit" && (
            <div className="rounded border border-neutral-200 bg-neutral-50 p-3 text-xs text-neutral-600 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-300">
              Direct deposit is the fastest way to be paid. ASUC isn&apos;t connected to CalCentral, so you need to sign
              up with ASUC once:{" "}
              <a href={DIRECT_DEPOSIT_FORM} target="_blank" rel="noreferrer" className="underline hover:no-underline">
                ASUC direct deposit form
              </a>
              . Until that&apos;s done, you may be paid by check instead.
              <label className="mt-2 flex items-center gap-2 text-sm text-neutral-800 dark:text-neutral-100">
                <input type="checkbox" checked={payee.directDepositSignedUp} onChange={setP("directDepositSignedUp")} />
                I&apos;ve completed ASUC&apos;s direct deposit sign-up
              </label>
            </div>
          )}
          {expenditureAction === "Other" && (
            <Field label="How should they be paid?" error={errors.specialInstructions}>
              <textarea className={control} rows={2} value={specialInstructions} onChange={(e) => setSpecialInstructions(e.target.value)} />
            </Field>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={saveProfile} onChange={(e) => setSaveProfile(e.target.checked)} />
          Save these payee details for next time
        </label>
        <button
          type="submit"
          disabled={busy}
          className="min-h-11 rounded bg-neutral-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300 sm:min-h-0"
        >
          {busy ? "Submitting…" : `Submit ${formatCents(total)} for approval`}
        </button>
      </div>
    </form>
  );
}
