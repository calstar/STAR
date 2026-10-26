"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { saveContact, saveOrg } from "@/lib/actions/outreach";
import { gmailComposeUrl } from "@/lib/outreach/compose";
import { CHANNELS, ORG_KINDS, type Channel, type OrgKind } from "@/lib/outreach/constants";

import { CopyButton } from "./CopyButton";
import { titleCase } from "./format";
import { BTN, BTN_PRIMARY, BTN_SMALL, CARD, INPUT, LABEL, MUTED } from "./ui";

type Org = {
  id: string;
  name: string;
  kind: string;
  website: string | null;
  industry: string | null;
  channel: string;
  formUrl: string | null;
  notes: string | null;
};

/** How to reach an org: kind, website, and whether requests go by email or a web form. */
export function OrgEditor({ org }: { org: Org }) {
  const router = useRouter();
  const [f, setF] = useState({
    name: org.name,
    kind: org.kind as OrgKind,
    website: org.website ?? "",
    industry: org.industry ?? "",
    channel: org.channel as Channel,
    formUrl: org.formUrl ?? "",
    notes: org.notes ?? "",
  });
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((c) => ({ ...c, [k]: v }));
  return (
    <form
      className={`${CARD} space-y-3 p-4`}
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const r = await saveOrg({ id: org.id, ...f });
          setMsg(r.ok ? "Saved" : r.error);
          router.refresh();
        });
      }}
    >
      <h3 className="font-semibold">Organization</h3>
      <label className="block">
        <span className={LABEL}>Name</span>
        <input className={INPUT} value={f.name} onChange={(e) => set("name", e.target.value)} />
      </label>
      <div className="grid grid-cols-2 gap-3">
        <label>
          <span className={LABEL}>Kind</span>
          <select className={INPUT} value={f.kind} onChange={(e) => set("kind", e.target.value as OrgKind)}>
            {ORG_KINDS.map((k) => (
              <option key={k} value={k}>
                {titleCase(k)}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className={LABEL}>Requests go by</span>
          <select className={INPUT} value={f.channel} onChange={(e) => set("channel", e.target.value as Channel)}>
            {CHANNELS.map((c) => (
              <option key={c} value={c}>
                {c === "form" ? "Web form" : titleCase(c)}
              </option>
            ))}
          </select>
        </label>
      </div>
      {f.channel === "form" && (
        <label className="block">
          <span className={LABEL}>Form URL</span>
          <input className={INPUT} value={f.formUrl} onChange={(e) => set("formUrl", e.target.value)} placeholder="https://…" />
        </label>
      )}
      <label className="block">
        <span className={LABEL}>Website</span>
        <input className={INPUT} value={f.website} onChange={(e) => set("website", e.target.value)} />
      </label>
      <label className="block">
        <span className={LABEL}>Notes about them</span>
        <textarea className={`${INPUT} min-h-16`} value={f.notes} onChange={(e) => set("notes", e.target.value)} />
      </label>
      <div className="flex items-center gap-2">
        <button className={BTN} disabled={pending}>
          Save org
        </button>
        {msg && <span className={`text-sm ${MUTED}`}>{msg}</span>}
      </div>
    </form>
  );
}

/** The people at an org, with copy / write-to-all and a quick add. */
export function OrgContacts({
  orgId,
  orgName,
  contacts,
  viewerEmail,
}: {
  orgId: string;
  orgName: string;
  contacts: { id: string; email: string | null; name: string; title: string | null; bounced?: boolean }[];
  viewerEmail: string;
}) {
  const router = useRouter();
  const [adding, setAdding] = useState(false);
  const [email, setEmail] = useState("");
  const [first, setFirst] = useState("");
  const [last, setLast] = useState("");
  const [title, setTitle] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const emails = contacts.filter((c) => !c.bounced).map((c) => c.email).filter((e): e is string => !!e);

  return (
    <div className={`${CARD} p-4`}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="font-semibold">People at {orgName}</h3>
        <div className="flex gap-1">
          {emails.length > 0 && (
            <>
              <CopyButton text={emails.join(", ")} label="Copy" className={BTN_SMALL} />
              <a className={BTN_SMALL} href={gmailComposeUrl({ to: emails, authuser: viewerEmail })} target="_blank" rel="noreferrer">
                ✉ All
              </a>
            </>
          )}
          <button className={BTN_SMALL} onClick={() => setAdding((a) => !a)}>
            + Add
          </button>
        </div>
      </div>
      {contacts.length === 0 && <p className={`text-sm ${MUTED}`}>No contacts yet.</p>}
      <ul className="space-y-1.5 text-sm">
        {contacts.map((c) => (
          <li key={c.id} className="flex flex-wrap items-baseline gap-x-2">
            <Link href={`/outreach/people/${c.id}`} className="font-medium hover:text-blue-600">
              {c.name || c.email}
            </Link>
            {c.title && <span className={MUTED}>{c.title}</span>}
            {c.email && c.name && <span className={MUTED}>{c.email}</span>}
            {c.bounced && <span className="text-xs font-medium text-red-700 dark:text-red-300">bounced</span>}
          </li>
        ))}
      </ul>
      {adding && (
        <form
          className="mt-3 grid grid-cols-2 gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            start(async () => {
              const r = await saveContact({ email, firstName: first, lastName: last, title, orgId, affiliation: "industry", tags: ["sponsor-contact"] });
              if (!r.ok) return setErr(r.error);
              setAdding(false);
              setEmail("");
              setFirst("");
              setLast("");
              setTitle("");
              router.refresh();
            });
          }}
        >
          <input className={`${INPUT} col-span-2`} placeholder="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          <input className={INPUT} placeholder="first name" value={first} onChange={(e) => setFirst(e.target.value)} />
          <input className={INPUT} placeholder="last name" value={last} onChange={(e) => setLast(e.target.value)} />
          <input className={`${INPUT} col-span-2`} placeholder="title / role" value={title} onChange={(e) => setTitle(e.target.value)} />
          <button className={`${BTN_PRIMARY} col-span-2`} disabled={pending}>
            Add contact
          </button>
          {err && <p className="col-span-2 text-sm text-red-600">{err}</p>}
        </form>
      )}
    </div>
  );
}
