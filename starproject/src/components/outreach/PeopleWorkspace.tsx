"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";

import { deleteContacts, retagContacts, saveContact, setDoNotContact } from "@/lib/actions/outreach";
import { AFFILIATIONS, type Affiliation } from "@/lib/outreach/constants";
import type { ContactRow } from "@/lib/outreach/queries";
import { CONTACT_PAGE } from "@/lib/outreach/page-size";

import { dollars, relative, titleCase } from "./format";
import { BTN, BTN_PRIMARY, BTN_SMALL, CARD, INPUT, MUTED, TAG, TD, TH, INPUT_INLINE } from "./ui";

type Params = { q?: string; tag?: string; aff?: string; page?: string; dnc?: string };

export function PeopleWorkspace({
  rows,
  total,
  page,
  tags,
  params,
}: {
  rows: ContactRow[];
  total: number;
  page: number;
  tags: { tag: string; count: number }[];
  params: Params;
}) {
  const router = useRouter();
  const [q, setQ] = useState(params.q ?? "");
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [tagText, setTagText] = useState("");
  const [adding, setAdding] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const activeTags = params.tag ? params.tag.split(",") : [];
  const activeAff = params.aff ? params.aff.split(",") : [];

  const go = (next: Partial<Params>) => {
    const p = new URLSearchParams();
    const merged = { ...params, page: undefined, ...next };
    for (const [k, v] of Object.entries(merged)) if (v) p.set(k, v);
    router.push(`/outreach/people${p.size ? `?${p}` : ""}`);
  };
  useEffect(() => {
    const t = setTimeout(() => {
      if ((params.q ?? "") !== q) go({ q: q || undefined });
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);
  useEffect(() => setSel(new Set()), [rows]);

  const toggleList = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]).join(",") || undefined;
  const ids = [...sel];
  const bulk = (fn: () => Promise<{ ok: boolean; error?: string }>, done: string) =>
    start(async () => {
      const r = await fn();
      setMsg(r.ok ? done : (r.error ?? "Failed"));
      router.refresh();
    });
  const listHref = () => {
    const filter = { search: params.q, tagsAny: activeTags.length ? activeTags : undefined, affiliations: activeAff.length ? activeAff : undefined };
    return `/outreach/lists?filter=${encodeURIComponent(JSON.stringify(filter))}`;
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <input className={`${INPUT} max-w-xs`} placeholder="Search name, email, org, notes…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select
          className={INPUT_INLINE}
          value=""
          onChange={(e) => e.target.value && go({ aff: toggleList(activeAff, e.target.value) })}
          aria-label="Affiliation"
        >
          <option value="">+ Affiliation</option>
          {AFFILIATIONS.map((a) => (
            <option key={a} value={a}>
              {titleCase(a)}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1.5 text-sm">
          <input type="checkbox" checked={params.dnc === "hide"} onChange={(e) => go({ dnc: e.target.checked ? "hide" : undefined })} />
          Hide do-not-contact
        </label>
        <div className="ml-auto flex gap-2">
          <Link className={BTN} href={listHref()}>
            Make a list from this
          </Link>
          <button className={BTN_PRIMARY} onClick={() => setAdding((a) => !a)}>
            + Person
          </button>
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {activeAff.map((a) => (
          <button key={a} className={`${TAG} ring-2 ring-blue-500`} onClick={() => go({ aff: toggleList(activeAff, a) })}>
            {titleCase(a)} ✕
          </button>
        ))}
        {tags.slice(0, 40).map((t) => (
          <button
            key={t.tag}
            className={`${TAG} ${activeTags.includes(t.tag) ? "ring-2 ring-blue-500" : ""}`}
            onClick={() => go({ tag: toggleList(activeTags, t.tag) })}
          >
            {t.tag} <span className="ml-1 opacity-60">{t.count}</span>
          </button>
        ))}
      </div>

      {adding && <NewPerson onDone={() => setAdding(false)} />}

      {sel.size > 0 && (
        <div className={`${CARD} flex flex-wrap items-center gap-2 p-2 text-sm`}>
          <span className="font-medium">{sel.size} selected</span>
          <input className={`${INPUT_INLINE} w-48`} placeholder="tag, tag" value={tagText} onChange={(e) => setTagText(e.target.value)} />
          <button className={BTN_SMALL} disabled={pending || !tagText} onClick={() => bulk(() => retagContacts(ids, [tagText], []), "Tagged")}>
            + Tag
          </button>
          <button className={BTN_SMALL} disabled={pending || !tagText} onClick={() => bulk(() => retagContacts(ids, [], [tagText]), "Untagged")}>
            − Tag
          </button>
          <button className={BTN_SMALL} disabled={pending} onClick={() => bulk(() => setDoNotContact(ids, true), "Marked do-not-contact")}>
            Do not contact
          </button>
          <button className={BTN_SMALL} disabled={pending} onClick={() => bulk(() => setDoNotContact(ids, false), "Cleared do-not-contact")}>
            OK to contact
          </button>
          <button
            className={`${BTN_SMALL} text-red-700`}
            disabled={pending}
            onClick={() => confirm(`Delete ${ids.length} people and their history?`) && bulk(() => deleteContacts(ids), "Deleted")}
          >
            Delete
          </button>
        </div>
      )}
      {msg && <p className={`text-sm ${MUTED}`}>{msg}</p>}

      <div className={`${CARD} overflow-x-auto`}>
        <table className="w-full border-collapse text-sm">
          <thead className="border-b border-neutral-200 dark:border-neutral-800">
            <tr>
              <th className={`${TH} w-8`}>
                <input
                  type="checkbox"
                  aria-label="Select all"
                  checked={rows.length > 0 && sel.size === rows.length}
                  onChange={(e) => setSel(e.target.checked ? new Set(rows.map((r) => r.id)) : new Set())}
                />
              </th>
              <th className={TH}>Person</th>
              <th className={`${TH} hidden md:table-cell`}>Org / affiliation</th>
              <th className={TH}>Tags</th>
              <th className={`${TH} hidden lg:table-cell`}>Referred by</th>
              <th className={`${TH} text-right`}>Given</th>
              <th className={`${TH} hidden sm:table-cell`}>Last touch</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className={`p-4 ${MUTED}`}>
                  No one matches. <Link className="text-blue-600 hover:underline" href="/outreach/import">Import a sheet</Link> to get started.
                </td>
              </tr>
            )}
            {rows.map((c) => (
              <tr key={c.id} className={`hover:bg-neutral-50 dark:hover:bg-neutral-800/50 ${c.doNotContact || c.bounced ? "opacity-60" : ""}`}>
                <td className={TD}>
                  <input
                    type="checkbox"
                    checked={sel.has(c.id)}
                    onChange={(e) => {
                      const n = new Set(sel);
                      if (e.target.checked) n.add(c.id);
                      else n.delete(c.id);
                      setSel(n);
                    }}
                    aria-label={`Select ${c.email ?? c.name}`}
                  />
                </td>
                <td className={TD}>
                  <Link href={`/outreach/people/${c.id}`} className="font-medium hover:text-blue-600">
                    {c.name || c.email || "(no name)"}
                  </Link>
                  {c.name && c.email && <div className={`text-xs ${MUTED}`}>{c.email}</div>}
                  {c.doNotContact && <div className="text-xs text-red-700">do not contact</div>}
                  {c.bounced && <div className="text-xs text-red-700">bounced</div>}
                </td>
                <td className={`${TD} hidden md:table-cell`}>
                  {c.org?.name ?? ""}
                  {c.affiliation && <div className={`text-xs ${MUTED}`}>{titleCase(c.affiliation)}</div>}
                </td>
                <td className={TD}>
                  <div className="flex max-w-xs flex-wrap gap-1">
                    {c.tags.map((t) => (
                      <span key={t} className={TAG}>
                        {t}
                      </span>
                    ))}
                  </div>
                </td>
                <td className={`${TD} hidden lg:table-cell`}>{c.referrers.join(", ")}</td>
                <td className={`${TD} text-right tabular-nums`}>{c.gifts ? dollars(c.givenCents) : ""}</td>
                <td className={`${TD} hidden whitespace-nowrap sm:table-cell`}>{c.lastTouchAt ? relative(c.lastTouchAt) : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className={`flex items-center gap-2 text-sm ${MUTED}`}>
        <span>
          {total} people{total > CONTACT_PAGE ? ` · page ${page + 1} of ${Math.ceil(total / CONTACT_PAGE)}` : ""}
        </span>
        {page > 0 && (
          <button className={BTN_SMALL} onClick={() => go({ page: String(page - 1) })}>
            ← Prev
          </button>
        )}
        {(page + 1) * CONTACT_PAGE < total && (
          <button className={BTN_SMALL} onClick={() => go({ page: String(page + 1) })}>
            Next →
          </button>
        )}
      </div>
    </div>
  );
}

function NewPerson({ onDone }: { onDone: () => void }) {
  const router = useRouter();
  const [f, setF] = useState({ email: "", firstName: "", lastName: "", orgName: "", affiliation: "" as Affiliation | "", tags: "" });
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const set = (k: keyof typeof f, v: string) => setF((c) => ({ ...c, [k]: v }));
  return (
    <form
      className={`${CARD} grid gap-2 p-3 sm:grid-cols-6`}
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const r = await saveContact({
            email: f.email || null,
            firstName: f.firstName,
            lastName: f.lastName,
            orgName: f.orgName || undefined,
            affiliation: f.affiliation || null,
            tags: f.tags.split(","),
          });
          if (!r.ok) return setErr(r.error);
          onDone();
          router.refresh();
        });
      }}
    >
      <input className={`${INPUT} sm:col-span-2`} placeholder="email" value={f.email} onChange={(e) => set("email", e.target.value)} />
      <input className={INPUT} placeholder="first name" value={f.firstName} onChange={(e) => set("firstName", e.target.value)} />
      <input className={INPUT} placeholder="last name" value={f.lastName} onChange={(e) => set("lastName", e.target.value)} />
      <input className={INPUT} placeholder="organization" value={f.orgName} onChange={(e) => set("orgName", e.target.value)} />
      <select className={INPUT} value={f.affiliation} onChange={(e) => set("affiliation", e.target.value)}>
        <option value="">affiliation…</option>
        {AFFILIATIONS.map((a) => (
          <option key={a} value={a}>
            {titleCase(a)}
          </option>
        ))}
      </select>
      <input className={`${INPUT} sm:col-span-4`} placeholder="tags, comma separated" value={f.tags} onChange={(e) => set("tags", e.target.value)} />
      <button className={`${BTN_PRIMARY} sm:col-span-2`} disabled={pending}>
        Add person
      </button>
      {err && <p className="text-sm text-red-600 sm:col-span-6">{err}</p>}
    </form>
  );
}
