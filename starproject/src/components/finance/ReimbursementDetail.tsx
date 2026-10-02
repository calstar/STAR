"use client";

import { CopyLinkButton } from "@/components/CopyLinkButton";
import { StatusPill } from "@/components/finance/StatusPill";
import { callinkRequestUrl } from "@/lib/finance/callink-import";
import { formatCents } from "@/lib/finance/money";
import type { FinanceDetail } from "@/lib/finance/queries";

const label = "text-xs font-medium uppercase tracking-wide text-neutral-500 dark:text-neutral-400";
const section = "rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4 shadow-sm";

const when = (iso: string) =>
  new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

// Our item dates are YYYY-MM-DD; imported ones are whatever was typed on CalLink.
const itemDate = (s: string) => (/^\d{4}-\d{2}-\d{2}$/.test(s) ? day(`${s}T12:00:00`) : s || "—");

const EVENT_LABEL: Record<string, string> = {
  created: "Submitted for approval",
  approved: "Approved",
  rejected: "Rejected",
  cancelled: "Cancelled",
  retried: "Queued again",
  claimed: "Worker started filing",
  released: "Worker released it",
  submitted: "Filed on CalLink",
  failed: "Filing failed",
  needs_check: "Filing outcome unknown",
  callink_status: "CalLink status changed",
};

function Field({ name, children }: { name: string; children: React.ReactNode }) {
  return (
    <div>
      <p className={label}>{name}</p>
      <div className="mt-1 text-sm">{children}</div>
    </div>
  );
}

export function ReimbursementDetail({
  data,
  actions,
}: {
  data: FinanceDetail;
  /** The admin/owner buttons, when the viewer has any. */
  actions?: React.ReactNode;
}) {
  const d = data;
  return (
    <div>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 pr-10 text-sm text-neutral-500 dark:text-neutral-400">
        <span>Finance</span>
        <span>/</span>
        <span>{d.source === "callink" ? "Imported from CalLink" : "Filed in STARProject"}</span>
        <span className="ml-auto">
          <CopyLinkButton param="r" value={String(d.number)} />
        </span>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3 pr-10">
        <span className="text-2xl font-semibold text-neutral-400 dark:text-neutral-500">R-{d.number}</span>
        <h2 className="text-xl font-semibold">{d.subject}</h2>
        <StatusPill label={d.display.label} tone={d.display.tone} />
      </div>
      <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
        {d.createdBy ? `Filed by ${d.createdBy} · ${when(d.createdAt)}` : d.submittedOn ? `Submitted ${when(d.submittedOn)}` : null}
        {d.submitterName && !d.createdBy && ` by ${d.submitterName}`}
        {d.callinkId && (
          <>
            {" · "}
            <a href={callinkRequestUrl(d.callinkId)} target="_blank" rel="noreferrer" className="underline hover:no-underline">
              CalLink #{d.callinkRequestNumber}
            </a>
            {d.callinkStage && ` (${d.callinkStage})`}
          </>
        )}
      </p>

      {d.status === "rejected" && d.reviewNote && (
        <p className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
          Rejected: {d.reviewNote}
        </p>
      )}
      {d.lastError && (d.status === "failed" || d.needsCheck) && (
        <p className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
          {d.needsCheck
            ? "The worker may have filed this but could not confirm it. Check CalLink before retrying. "
            : "Filing failed: "}
          {d.lastError}
        </p>
      )}

      {actions && <div className="mt-4 flex flex-wrap items-center gap-2">{actions}</div>}

      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        <div className={section}>
          <div className="grid grid-cols-2 gap-3">
            <Field name="Amount">
              <span className="text-lg font-semibold tabular-nums">{formatCents(d.amountCents)}</span>
            </Field>
            {d.approvedAmountCents != null && (
              <Field name="Approved">
                <span className="tabular-nums">{formatCents(d.approvedAmountCents)}</span>
              </Field>
            )}
            <Field name="Payment">
              {d.expenditureAction}
              {d.expenditureAction === "Direct Deposit" && d.directDepositSignedUp === false && (
                <span className="block text-xs text-amber-700 dark:text-amber-300">Sign-up still to be completed</span>
              )}
            </Field>
            {d.category && d.category !== "Reimbursement" && <Field name="Category">{d.category}</Field>}
          </div>
        </div>

        <div className={section}>
          <div className="grid grid-cols-2 gap-3">
            <Field name="Payee">{d.payeeName || "—"}</Field>
            <Field name="Email">{d.payeeEmail ?? "—"}</Field>
            {d.pii ? (
              <>
                <Field name="Address">
                  {d.pii.street}
                  {d.pii.street2 && <>, {d.pii.street2}</>}
                  <br />
                  {d.pii.city}, {d.pii.state} {d.pii.zip}
                </Field>
                <Field name="Phone / UID">
                  {d.pii.phone ?? "—"}
                  <br />
                  {d.pii.uid ? `UID ${d.pii.uid}` : "No UID"}
                </Field>
              </>
            ) : (
              <p className="col-span-2 text-xs text-neutral-500 dark:text-neutral-400">
                Address, phone, UID and receipts are visible to the payee, the submitter and admins.
              </p>
            )}
          </div>
        </div>
      </div>

      {(d.description || d.eventDetails || d.specialInstructions) && (
        <div className={`${section} mt-4 space-y-3`}>
          {d.description && <Field name="Description"><p className="whitespace-pre-wrap">{d.description}</p></Field>}
          {d.eventDetails && <Field name="Event details"><p className="whitespace-pre-wrap">{d.eventDetails}</p></Field>}
          {d.specialInstructions && (
            <Field name="Special instructions"><p className="whitespace-pre-wrap">{d.specialInstructions}</p></Field>
          )}
        </div>
      )}

      <div className={`${section} mt-4`}>
        <p className={label}>Items</p>
        {d.items.length === 0 ? (
          <p className="mt-2 text-sm text-neutral-500 dark:text-neutral-400">
            No items recorded. Requests filed on CalLink before mid-2020 kept only the total.
          </p>
        ) : (
          <ul className="mt-2 divide-y divide-neutral-100 dark:divide-neutral-800">
            {d.items.map((i) => (
              <li key={i.position} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2 text-sm">
                <span className="w-5 text-neutral-400">{i.position}.</span>
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{i.vendor || "—"}</span>
                  <span className="ml-2 text-xs text-neutral-500 dark:text-neutral-400">{itemDate(i.date)}</span>
                  {i.comment && <span className="block text-xs text-neutral-500 dark:text-neutral-400">{i.comment}</span>}
                  {i.receipts ? (
                    i.receipts.length > 0 && (
                      <span className="mt-0.5 flex flex-wrap gap-x-3 text-xs">
                        {i.receipts.map((f) => (
                          <a
                            key={f.id}
                            href={f.url}
                            target="_blank"
                            rel="noreferrer"
                            className="text-blue-700 underline hover:no-underline dark:text-blue-300"
                          >
                            {f.fileName}
                          </a>
                        ))}
                      </span>
                    )
                  ) : i.receiptCount > 0 ? (
                    <span className="block text-xs text-neutral-400">
                      {i.receiptCount} receipt{i.receiptCount > 1 ? "s" : ""} (hidden)
                    </span>
                  ) : null}
                </span>
                <span className="tabular-nums">
                  {i.amountCents != null ? formatCents(i.amountCents) : (i.amountText ?? "—")}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {d.events.length > 0 && (
        <div className={`${section} mt-4`}>
          <p className={label}>History</p>
          <ol className="mt-2 space-y-1.5 text-sm">
            {d.events.map((e) => (
              <li key={e.id} className="flex flex-wrap gap-x-2">
                <span className="text-neutral-500 dark:text-neutral-400">{when(e.at)}</span>
                <span>
                  {EVENT_LABEL[e.kind] ?? e.kind}
                  {e.kind === "callink_status" && e.toStatus && `: ${e.toStatus}`}
                  {e.by && <span className="text-neutral-500 dark:text-neutral-400"> · {e.by}</span>}
                </span>
                {e.note && <span className="w-full pl-0 text-neutral-600 dark:text-neutral-300 sm:pl-4">“{e.note}”</span>}
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}
