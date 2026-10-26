"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, useTransition } from "react";

import { deleteSegment, previewSegment, saveSegment } from "@/lib/actions/outreach";
import { DEFAULT_BATCH, batches, clipboardText, gmailComposeUrl } from "@/lib/outreach/compose";
import { AFFILIATIONS, DEAL_STAGES, STAGE_LABEL, WON_STAGES } from "@/lib/outreach/constants";
import { toCsvLine } from "@/lib/outreach/csv";
import type { Recipient } from "@/lib/outreach/queries";
import { describeSegment, type SegmentFilter } from "@/lib/outreach/segments";

import { CopyButton } from "./CopyButton";
import { titleCase } from "./format";
import { BTN, BTN_PRIMARY, BTN_SMALL, CARD, INPUT, LABEL, MUTED, TAG } from "./ui";

type SavedList = { id: string; name: string; description: string | null; filter: SegmentFilter; count: number };
type Campaign = { id: string; name: string; kind: string };

function Multi({
  label,
  options,
  value,
  onChange,
  render = (v) => v,
}: {
  label: string;
  options: string[];
  value: string[] | undefined;
  onChange: (v: string[] | undefined) => void;
  render?: (v: string) => string;
}) {
  const cur = value ?? [];
  const toggle = (o: string) => {
    const n = cur.includes(o) ? cur.filter((x) => x !== o) : [...cur, o];
    onChange(n.length ? n : undefined);
  };
  return (
    <div>
      <span className={LABEL}>{label}</span>
      <div className="flex flex-wrap gap-1">
        {options.length === 0 && <span className={`text-xs ${MUTED}`}>none yet</span>}
        {options.map((o) => (
          <button
            type="button"
            key={o}
            onClick={() => toggle(o)}
            className={`${TAG} ${cur.includes(o) ? "bg-blue-100 text-blue-800 ring-1 ring-blue-500 dark:bg-blue-950 dark:text-blue-200" : ""}`}
          >
            {render(o)}
          </button>
        ))}
      </div>
    </div>
  );
}

export function ListBuilder({
  lists,
  tags,
  referrers,
  campaigns,
  seasons,
  currentSeason,
  initialFilter,
  initialListId,
  viewerEmail,
}: {
  lists: SavedList[];
  tags: string[];
  referrers: string[];
  campaigns: Campaign[];
  seasons: string[];
  currentSeason: string;
  initialFilter: SegmentFilter;
  initialListId: string | null;
  viewerEmail: string;
}) {
  const router = useRouter();
  const initialList = lists.find((l) => l.id === initialListId) ?? null;
  const [listId, setListId] = useState<string | null>(initialList?.id ?? null);
  const [name, setName] = useState(initialList?.name ?? "");
  const [description, setDescription] = useState(initialList?.description ?? "");
  const [filter, setFilter] = useState<SegmentFilter>(initialList?.filter ?? initialFilter);
  const [preview, setPreview] = useState<{ recipients: Recipient[]; withoutEmail: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [batchSize, setBatchSize] = useState(DEFAULT_BATCH);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const set = <K extends keyof SegmentFilter>(k: K, v: SegmentFilter[K]) =>
    setFilter((f) => {
      const n = { ...f, [k]: v };
      if (v === undefined || v === "" || v === false) delete n[k];
      return n;
    });

  useEffect(() => {
    let live = true;
    setLoading(true);
    const t = setTimeout(async () => {
      const r = await previewSegment(filter);
      if (live) {
        setPreview(r);
        setLoading(false);
      }
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [filter]);

  const recipients = useMemo(() => preview?.recipients ?? [], [preview]);
  const emails = recipients.map((r) => r.email);
  const chunks = useMemo(() => batches(emails, { size: batchSize, subject, body, authuser: viewerEmail }), [emails, batchSize, subject, body, viewerEmail]);
  const campaignName = (id: string) => campaigns.find((c) => c.id === id)?.name ?? "that campaign";
  const latestCrowdfunding = campaigns.find((c) => c.kind === "crowdfunding");

  const quickStarts: { label: string; filter: SegmentFilter }[] = [
    ...(latestCrowdfunding
      ? [
          { label: `Haven't given to ${latestCrowdfunding.name}`, filter: { notDonatedTo: latestCrowdfunding.id, tagsNone: ["sponsor-contact"] } },
          { label: `Donors to ${latestCrowdfunding.name} (thank-you)`, filter: { donatedTo: latestCrowdfunding.id } },
          { label: `Gave before, not to ${latestCrowdfunding.name}`, filter: { donatedTo: "any", notDonatedTo: latestCrowdfunding.id } },
        ]
      : []),
    { label: `Current sponsors' contacts (${currentSeason})`, filter: { dealStages: [...WON_STAGES], dealSeason: currentSeason } },
    { label: "Every sponsor contact", filter: { tagsAny: ["sponsor-contact"] } },
    { label: "Alumni", filter: { affiliations: ["alumni"] } },
  ];

  const downloadCsv = () => {
    const lines = [toCsvLine(["email", "first_name", "last_name", "organization"])];
    for (const r of recipients) lines.push(toCsvLine([r.email, r.firstName, r.lastName, r.org]));
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${(name || "outreach-list").replace(/[^\w-]+/g, "-")}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const save = () =>
    start(async () => {
      const r = await saveSegment({ id: listId ?? undefined, name, description, filter });
      if (!r.ok) return setMsg(r.error);
      setListId(r.id);
      setMsg("Saved");
      router.refresh();
    });

  const openList = (l: SavedList | null) => {
    setListId(l?.id ?? null);
    setName(l?.name ?? "");
    setDescription(l?.description ?? "");
    setFilter(l?.filter ?? {});
    setMsg(null);
  };

  return (
    <div className="grid gap-4 lg:grid-cols-[16rem_minmax(0,1fr)]">
      <aside className="space-y-4">
        <div className={`${CARD} p-3`}>
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-semibold">Saved lists</h3>
            <button className={BTN_SMALL} onClick={() => openList(null)}>
              + New
            </button>
          </div>
          {lists.length === 0 && <p className={`text-xs ${MUTED}`}>None yet. Build one and save it.</p>}
          <ul className="space-y-0.5">
            {lists.map((l) => (
              <li key={l.id}>
                <button
                  onClick={() => openList(l)}
                  className={`flex w-full justify-between rounded px-2 py-1 text-left text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800 ${l.id === listId ? "bg-blue-50 font-medium dark:bg-blue-950" : ""}`}
                >
                  <span className="truncate">{l.name}</span>
                  <span className={`tabular-nums ${MUTED}`}>{l.count}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
        <div className={`${CARD} p-3`}>
          <h3 className="mb-2 text-sm font-semibold">Quick starts</h3>
          <ul className="space-y-0.5">
            {quickStarts.map((q) => (
              <li key={q.label}>
                <button
                  className="w-full rounded px-2 py-1 text-left text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800"
                  onClick={() => {
                    openList(null);
                    setName(q.label);
                    setFilter(q.filter);
                  }}
                >
                  {q.label}
                </button>
              </li>
            ))}
          </ul>
        </div>
      </aside>

      <div className="space-y-4">
        <div className={`${CARD} space-y-3 p-4`}>
          <div className="grid gap-3 sm:grid-cols-2">
            <label>
              <span className={LABEL}>List name</span>
              <input className={INPUT} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Final push: haven't given" />
            </label>
            <label>
              <span className={LABEL}>Description</span>
              <input className={INPUT} value={description} onChange={(e) => setDescription(e.target.value)} />
            </label>
          </div>
          <p className={`text-sm ${MUTED}`}>{describeSegment(filter, campaignName)}</p>
          <label className="block">
            <span className={LABEL}>Text search</span>
            <input className={INPUT} value={filter.search ?? ""} onChange={(e) => set("search", e.target.value || undefined)} />
          </label>
          <Multi label="Tagged any of" options={tags} value={filter.tagsAny} onChange={(v) => set("tagsAny", v)} />
          <Multi label="Tagged all of" options={tags} value={filter.tagsAll} onChange={(v) => set("tagsAll", v)} />
          <Multi label="Not tagged" options={tags} value={filter.tagsNone} onChange={(v) => set("tagsNone", v)} />
          <Multi label="Affiliation" options={[...AFFILIATIONS]} value={filter.affiliations} onChange={(v) => set("affiliations", v)} render={titleCase} />
          <div className="grid gap-3 sm:grid-cols-3">
            <label>
              <span className={LABEL}>Gave to</span>
              <select className={INPUT} value={filter.donatedTo ?? ""} onChange={(e) => set("donatedTo", e.target.value || undefined)}>
                <option value="">—</option>
                <option value="any">Any campaign</option>
                {campaigns.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span className={LABEL}>Hasn&apos;t given to</span>
              <select className={INPUT} value={filter.notDonatedTo ?? ""} onChange={(e) => set("notDonatedTo", e.target.value || undefined)}>
                <option value="">—</option>
                {campaigns.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span className={LABEL}>Brought in by</span>
              <select className={INPUT} value={filter.referredBy ?? ""} onChange={(e) => set("referredBy", e.target.value || undefined)}>
                <option value="">Anyone</option>
                {referrers.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_10rem]">
            <Multi
              label="Their org's sponsorship stage"
              options={[...DEAL_STAGES]}
              value={filter.dealStages}
              onChange={(v) => set("dealStages", v)}
              render={(s) => STAGE_LABEL[s as keyof typeof STAGE_LABEL]}
            />
            <label>
              <span className={LABEL}>in season</span>
              <select className={INPUT} value={filter.dealSeason ?? ""} onChange={(e) => set("dealSeason", e.target.value || undefined)}>
                <option value="">any</option>
                {seasons.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="flex items-center gap-1.5 text-sm">
            <input type="checkbox" checked={!!filter.includeExcluded} onChange={(e) => set("includeExcluded", e.target.checked || undefined)} />
            Include do-not-contact and bounced addresses
          </label>
          <div className="flex flex-wrap items-center gap-2 border-t border-neutral-200 pt-3 dark:border-neutral-800">
            <button className={BTN_PRIMARY} disabled={pending || !name.trim()} onClick={save}>
              {listId ? "Save changes" : "Save list"}
            </button>
            {listId && (
              <>
                <Link className={BTN} href={`/outreach/compose?list=${listId}`}>
                  Compose to this list →
                </Link>
                <button
                  className={`${BTN} text-red-700`}
                  disabled={pending}
                  onClick={() =>
                    confirm("Delete this saved list? (No one is deleted.)") &&
                    start(async () => {
                      await deleteSegment(listId);
                      openList(null);
                      router.refresh();
                    })
                  }
                >
                  Delete list
                </button>
              </>
            )}
            {msg && <span className={`text-sm ${MUTED}`}>{msg}</span>}
          </div>
        </div>

        <div className={`${CARD} space-y-3 p-4`}>
          <div className="flex flex-wrap items-baseline gap-2">
            <h3 className="text-lg font-semibold tabular-nums">{loading && !preview ? "…" : `${recipients.length} addresses`}</h3>
            {preview && preview.withoutEmail > 0 && (
              <span className={`text-sm ${MUTED}`}>+ {preview.withoutEmail} matching people with no email</span>
            )}
            {loading && <span className={`text-xs ${MUTED}`}>updating…</span>}
          </div>
          <div className="flex flex-wrap gap-2">
            <CopyButton label="Copy emails" getText={() => clipboardText(recipients)} disabled={!recipients.length} />
            <CopyButton label="Copy as Name <email>" getText={() => clipboardText(recipients, "named")} disabled={!recipients.length} />
            <CopyButton label="Copy one per line" getText={() => clipboardText(recipients, "lines")} disabled={!recipients.length} />
            <button className={BTN} onClick={downloadCsv} disabled={!recipients.length}>
              Download CSV
            </button>
          </div>
          <details className="rounded border border-neutral-200 p-3 text-sm dark:border-neutral-800" open={recipients.length > 0}>
            <summary className="cursor-pointer font-medium">Open in Gmail as BCC batches</summary>
            <p className={`mt-1 ${MUTED}`}>
              Each button opens a Gmail draft in your own inbox ({viewerEmail}) with the batch in BCC. Gmail allows up to
              500 recipients per message; long subjects and bodies shrink the batches so the link stays short enough.
            </p>
            <div className="mt-2 grid gap-2 sm:grid-cols-[8rem_minmax(0,1fr)]">
              <label>
                <span className={LABEL}>Batch size</span>
                <input
                  className={INPUT}
                  type="number"
                  min={1}
                  max={500}
                  value={batchSize}
                  onChange={(e) => setBatchSize(Math.min(500, Math.max(1, Number(e.target.value) || 1)))}
                />
              </label>
              <label>
                <span className={LABEL}>Subject (optional)</span>
                <input className={INPUT} value={subject} onChange={(e) => setSubject(e.target.value)} />
              </label>
            </div>
            <label className="mt-2 block">
              <span className={LABEL}>Body (optional, plain text)</span>
              <textarea className={`${INPUT} min-h-20`} value={body} onChange={(e) => setBody(e.target.value)} />
            </label>
            <div className="mt-2 flex flex-wrap gap-2">
              {chunks.map((c, i) => (
                <span key={i} className="inline-flex gap-1">
                  <a
                    className={BTN_PRIMARY}
                    target="_blank"
                    rel="noreferrer"
                    href={gmailComposeUrl({ bcc: c, subject, body, authuser: viewerEmail })}
                  >
                    ✉ Batch {i + 1} ({c.length})
                  </a>
                  <CopyButton label="Copy" text={c.join(", ")} className={BTN_SMALL} />
                </span>
              ))}
            </div>
          </details>
          <div className="max-h-96 overflow-y-auto rounded border border-neutral-100 dark:border-neutral-800">
            <table className="w-full text-sm">
              <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
                {recipients.slice(0, 500).map((r) => (
                  <tr key={r.contactId}>
                    <td className="px-2 py-1">
                      <Link href={`/outreach/people/${r.contactId}`} className="hover:text-blue-600">
                        {r.name || <span className={MUTED}>—</span>}
                      </Link>
                    </td>
                    <td className="px-2 py-1">{r.email}</td>
                    <td className={`px-2 py-1 ${MUTED}`}>{r.org}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {recipients.length > 500 && <p className={`p-2 text-xs ${MUTED}`}>Showing 500 of {recipients.length}; copy and CSV include all.</p>}
          </div>
        </div>
      </div>
    </div>
  );
}
