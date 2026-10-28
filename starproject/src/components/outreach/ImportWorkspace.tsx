"use client";

import { useState, useTransition } from "react";

import { commitImport, previewImport, type ImportPreview } from "@/lib/actions/outreach";
import { AFFILIATIONS, DEAL_TYPE_LABEL, STAGE_LABEL, type Affiliation } from "@/lib/outreach/constants";
import { IMPORT_PRESETS, PRESET_LABEL, type ImportPreset } from "@/lib/outreach/importer";

import { dollars, titleCase } from "./format";
import { BTN, BTN_PRIMARY, CARD, INPUT, LABEL, MUTED, TAG, TD, TH } from "./ui";

export function ImportWorkspace({
  campaigns,
  seasons,
  currentSeason,
}: {
  campaigns: { id: string; name: string }[];
  seasons: string[];
  currentSeason: string;
}) {
  const [text, setText] = useState("");
  const [preset, setPreset] = useState<ImportPreset>("auto");
  const [tags, setTags] = useState("");
  const [affiliation, setAffiliation] = useState<Affiliation | "">("");
  const [campaignId, setCampaignId] = useState("");
  const [season, setSeason] = useState(currentSeason);
  const [applyFixes, setApplyFixes] = useState(true);
  const [source, setSource] = useState("");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const input = () => ({
    text,
    preset,
    tags: tags.split(","),
    affiliation: affiliation || null,
    campaignId: campaignId || null,
    season,
    applyFixes,
    source: source || "import",
  });

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    setText(await f.text());
    if (!source) setSource(`import: ${f.name}`);
    setPreview(null);
  };

  const doPreview = () =>
    start(async () => {
      setResult(null);
      setError(null);
      const r = await previewImport(input());
      if (!r.ok) return setError(r.error);
      setPreview(r);
    });
  const doCommit = () =>
    start(async () => {
      const r = await commitImport(input());
      if (!r.ok) return setError(r.error);
      setResult(
        `Imported: ${r.contactsCreated} new people, ${r.contactsUpdated} updated, ${r.donations} gifts, ${r.deals} sponsor deals${r.rejected ? ` (${r.rejected} rows skipped)` : ""}.`,
      );
      setPreview(null);
    });

  const s = preview?.summary;
  return (
    <div className="space-y-4">
      <div className={`${CARD} space-y-3 p-4`}>
        <p className={`text-sm ${MUTED}`}>
          Paste a range copied from a Google Sheet (with its header row), or choose a CSV file. Nothing is written until
          you press Import; people are matched by email, so importing the same sheet twice is safe.
        </p>
        <textarea
          className={`${INPUT} min-h-48 font-mono text-xs`}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setPreview(null);
          }}
          placeholder={"NAME\tEMAILS\nAda L.\tparent@example.com\n…"}
        />
        <div className="flex flex-wrap items-center gap-2">
          <input type="file" accept=".csv,.tsv,.txt,text/csv" onChange={(e) => onFile(e.target.files?.[0])} className="text-sm" />
          {text && <span className={`text-xs ${MUTED}`}>{text.split(/\n/).length} lines</span>}
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <label>
            <span className={LABEL}>What is this sheet?</span>
            <select className={INPUT} value={preset} onChange={(e) => setPreset(e.target.value as ImportPreset)}>
              {IMPORT_PRESETS.map((p) => (
                <option key={p} value={p}>
                  {PRESET_LABEL[p]}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className={LABEL}>Tag everyone with</span>
            <input className={INPUT} value={tags} onChange={(e) => setTags(e.target.value)} placeholder="crowdfunding-2026, family" />
          </label>
          <label>
            <span className={LABEL}>Affiliation (when the row doesn&apos;t say)</span>
            <select className={INPUT} value={affiliation} onChange={(e) => setAffiliation(e.target.value as Affiliation)}>
              <option value="">—</option>
              {AFFILIATIONS.map((a) => (
                <option key={a} value={a}>
                  {titleCase(a)}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className={LABEL}>Campaign (for gifts)</span>
            <select className={INPUT} value={campaignId} onChange={(e) => setCampaignId(e.target.value)}>
              <option value="">None</option>
              {campaigns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className={LABEL}>Sponsor season</span>
            <select className={INPUT} value={season} onChange={(e) => setSeason(e.target.value)}>
              {seasons.map((x) => (
                <option key={x}>{x}</option>
              ))}
            </select>
          </label>
          <label>
            <span className={LABEL}>Source note</span>
            <input className={INPUT} value={source} onChange={(e) => setSource(e.target.value)} placeholder="CROWDFUNDING 2026 MAILING" />
          </label>
        </div>
        <label className="flex items-center gap-1.5 text-sm">
          <input type="checkbox" checked={applyFixes} onChange={(e) => setApplyFixes(e.target.checked)} />
          Fix obvious domain typos (berkeley.efu → berkeley.edu, gmial.com → gmail.com)
        </label>
        <div className="flex gap-2">
          <button className={BTN} disabled={pending || !text.trim()} onClick={doPreview}>
            Preview
          </button>
          <button className={BTN_PRIMARY} disabled={pending || !preview} onClick={doCommit}>
            Import
          </button>
        </div>
        {error && <p className="text-sm text-red-600">{error}</p>}
        {result && <p className="text-sm font-medium text-green-700 dark:text-green-400">{result}</p>}
      </div>

      {preview && s && (
        <div className="space-y-4">
          <div className={`${CARD} p-4`}>
            <h3 className="font-semibold">
              Read as: {PRESET_LABEL[preview.preset]} {preview.headerRow ? `(header on row ${preview.headerRow})` : ""}
            </h3>
            <div className="mt-2 grid gap-2 text-sm sm:grid-cols-4">
              <Stat n={s.newContacts} label="new people" />
              <Stat n={s.updatedContacts} label="already here (merged)" />
              <Stat n={s.merged} label="duplicate rows folded" />
              <Stat n={s.rejected} label="rows skipped" />
              {s.donations > 0 && <Stat n={s.newDonations} label={`new gifts (${dollars(s.donationCents)} total)`} />}
              {s.deals > 0 && <Stat n={s.deals} label="sponsor deals" />}
              {s.flagged > 0 && <Stat n={s.flagged} label="typos flagged" />}
            </div>
          </div>
          {preview.sampleDeals.length > 0 && (
            <div className={`${CARD} overflow-x-auto`}>
              <table className="w-full text-sm">
                <thead>
                  <tr>
                    <th className={TH}>Sponsor</th>
                    <th className={TH}>Type</th>
                    <th className={TH}>Stage</th>
                    <th className={TH}>Gives</th>
                    <th className={TH}>Notes</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
                  {preview.sampleDeals.map((d) => (
                    <tr key={d.orgName}>
                      <td className={TD}>
                        {d.orgName}
                        {d.renewal && <span className={`ml-1 text-xs ${MUTED}`}>returning</span>}
                      </td>
                      <td className={TD}>{DEAL_TYPE_LABEL[d.type]}</td>
                      <td className={TD}>{STAGE_LABEL[d.stage]}</td>
                      <td className={TD}>{d.theirDeliverables}</td>
                      <td className={`${TD} max-w-xs truncate ${MUTED}`}>{d.notes}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {preview.sampleContacts.length > 0 && (
            <div className={`${CARD} overflow-x-auto`}>
              <h3 className="p-3 text-sm font-semibold">First {preview.sampleContacts.length} people</h3>
              <table className="w-full text-sm">
                <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
                  {preview.sampleContacts.map((c, i) => (
                    <tr key={c.email ?? i}>
                      <td className={TD}>{c.email ?? <span className={MUTED}>no email</span>}</td>
                      <td className={TD}>{c.name}</td>
                      <td className={TD}>{c.org}</td>
                      <td className={TD}>
                        {c.tags.map((t) => (
                          <span key={t} className={`${TAG} mr-1`}>
                            {t}
                          </span>
                        ))}
                      </td>
                      <td className={TD}>{c.exists && <span className="text-xs text-blue-700">merge</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {(preview.rejected.length > 0 || preview.flagged.length > 0) && (
            <div className="grid gap-4 md:grid-cols-2">
              {preview.rejected.length > 0 && (
                <div className={`${CARD} p-3 text-sm`}>
                  <h3 className="mb-1 font-semibold">Skipped rows</h3>
                  <ul className="max-h-64 space-y-0.5 overflow-y-auto">
                    {preview.rejected.map((r, i) => (
                      <li key={i}>
                        <span className={MUTED}>row {r.row}:</span> {r.reason}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {preview.flagged.length > 0 && (
                <div className={`${CARD} p-3 text-sm`}>
                  <h3 className="mb-1 font-semibold">Likely typos</h3>
                  <ul className="max-h-64 space-y-0.5 overflow-y-auto">
                    {preview.flagged.map((f, i) => (
                      <li key={i}>
                        <span className={MUTED}>row {f.row}:</span> {f.email} → {f.suggestion} {f.applied ? "(fixed)" : "(kept as typed)"}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Stat({ n, label }: { n: number; label: string }) {
  return (
    <div>
      <span className="text-xl font-semibold tabular-nums">{n}</span> <span className={MUTED}>{label}</span>
    </div>
  );
}
