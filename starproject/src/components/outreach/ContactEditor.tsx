"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { deleteContacts, saveContact } from "@/lib/actions/outreach";
import { AFFILIATIONS, type Affiliation } from "@/lib/outreach/constants";
import type { ContactDetail } from "@/lib/outreach/queries";

import { titleCase } from "./format";
import { BTN, BTN_PRIMARY, CARD, INPUT, LABEL, MUTED } from "./ui";

export function ContactEditor({ contact: c }: { contact: ContactDetail["contact"] }) {
  const router = useRouter();
  const [f, setF] = useState({
    email: c.email ?? "",
    altEmails: c.altEmails.join(", "),
    firstName: c.firstName ?? "",
    lastName: c.lastName ?? "",
    title: c.title ?? "",
    phone: c.phone ?? "",
    orgName: c.org?.name ?? "",
    affiliation: (c.affiliation ?? "") as Affiliation | "",
    tags: c.tags.join(", "),
    address: c.address ?? "",
    city: c.city ?? "",
    state: c.state ?? "",
    zip: c.zip ?? "",
    country: c.country ?? "",
    doNotContact: c.doNotContact,
    bounced: c.bounced,
    notes: c.notes ?? "",
  });
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((cur) => ({ ...cur, [k]: v }));
  const text = (k: keyof typeof f, label: string, cls = "") => (
    <label className={cls}>
      <span className={LABEL}>{label}</span>
      <input className={INPUT} value={f[k] as string} onChange={(e) => set(k, e.target.value as never)} />
    </label>
  );

  return (
    <form
      className={`${CARD} space-y-3 p-4`}
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const r = await saveContact({
            id: c.id,
            ...f,
            email: f.email || null,
            altEmails: f.altEmails.split(",").map((s) => s.trim()).filter(Boolean),
            affiliation: f.affiliation || null,
            tags: f.tags.split(","),
          });
          setMsg(r.ok ? "Saved" : r.error);
          router.refresh();
        });
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        {text("email", "Email")}
        {text("altEmails", "Other emails")}
        {text("firstName", "First name")}
        {text("lastName", "Last name")}
        {text("orgName", "Organization")}
        {text("title", "Title / role")}
        <label>
          <span className={LABEL}>Affiliation</span>
          <select className={INPUT} value={f.affiliation} onChange={(e) => set("affiliation", e.target.value as Affiliation)}>
            <option value="">—</option>
            {AFFILIATIONS.map((a) => (
              <option key={a} value={a}>
                {titleCase(a)}
              </option>
            ))}
          </select>
        </label>
        {text("phone", "Phone")}
      </div>
      {text("tags", "Tags (comma separated)", "block")}
      <details className="text-sm">
        <summary className={`cursor-pointer ${MUTED}`}>Mailing address (for perks)</summary>
        <div className="mt-2 grid gap-3 sm:grid-cols-2">
          {text("address", "Street", "sm:col-span-2")}
          {text("city", "City")}
          {text("state", "State")}
          {text("zip", "ZIP")}
          {text("country", "Country")}
        </div>
      </details>
      <div className="flex flex-wrap gap-4 text-sm">
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={f.doNotContact} onChange={(e) => set("doNotContact", e.target.checked)} /> Do not contact
        </label>
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={f.bounced} onChange={(e) => set("bounced", e.target.checked)} /> Address bounced
        </label>
      </div>
      <label className="block">
        <span className={LABEL}>Notes</span>
        <textarea className={`${INPUT} min-h-16`} value={f.notes} onChange={(e) => set("notes", e.target.value)} />
      </label>
      <div className="flex items-center gap-2">
        <button className={BTN_PRIMARY} disabled={pending}>
          Save
        </button>
        {msg && <span className={`text-sm ${MUTED}`}>{msg}</span>}
        <button
          type="button"
          className={`${BTN} ml-auto text-red-700 dark:text-red-300`}
          disabled={pending}
          onClick={() => {
            if (!confirm("Delete this person, their gifts and history?")) return;
            start(async () => {
              await deleteContacts([c.id]);
              router.push("/outreach/people");
            });
          }}
        >
          Delete
        </button>
      </div>
    </form>
  );
}
