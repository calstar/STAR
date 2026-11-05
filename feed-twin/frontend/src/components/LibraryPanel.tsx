/**
 * The library: what has been imported, and what is loaded.
 *
 * Drop a drawing or an engine config on it, or pick a file. An artifact is
 * addressed by the hash of its own bytes, so importing the same drawing twice
 * is a no-op and the panel says so rather than making a second copy.
 */

import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { SourcePanel, importedNote, type Want } from './SourcePanel';
import {
  bytes,
  getFreshness,
  hasCard,
  when,
  importFile,
  removeArtifact,
  type Artifact,
  type Freshness,
} from '../api';

/** The design document a pulled artifact came from, without the stamp of
 *  the pull: ``<tool>:<owner>/<doc>``. Uploads and shipped files have none. */
export const pulledFrom = (a: Artifact): string | null => {
  const m = /^([\w-]+):(.+\/[^@]+)@/.exec(a.source);
  return m ? `${m[1]}:${m[2]}` : null;
};

/** Every artifact superseded by a later pull of the same design document:
 *  pulling the current design again leaves the old copy in place, under the
 *  same name, and it should not read as the one to pick. */
export function superseded(artifacts: Artifact[]): Set<string> {
  const newest = new Map<string, Artifact>();
  for (const a of artifacts) {
    const from = pulledFrom(a);
    if (!from) continue;
    const seen = newest.get(`${a.kind}|${from}`);
    if (!seen || Date.parse(a.imported_at) > Date.parse(seen.imported_at)) newest.set(`${a.kind}|${from}`, a);
  }
  const out = new Set<string>();
  for (const a of artifacts) {
    const from = pulledFrom(a);
    if (from && newest.get(`${a.kind}|${from}`)?.id !== a.id) out.add(a.id);
  }
  return out;
}

interface Props {
  artifacts: Artifact[];
  diagramId: string;
  engineId: string;
  onPick: (kind: 'diagram' | 'engine', id: string) => void;
  onChanged: () => void;
  busy: boolean;
  /** Put the bundled sample stand back in the library and open it. */
  onSample?: () => Promise<void>;
}

export function LibraryPanel({
  artifacts,
  diagramId,
  engineId,
  onPick,
  onChanged,
  busy,
  onSample,
}: Props) {
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  // The row asking whether to remove it, and the one being removed.
  const [asking, setAsking] = useState('');
  const [removing, setRemoving] = useState('');
  const picker = useRef<HTMLInputElement>(null);
  // The design tool to open, from a link (`/library?import=engine`, the
  // first-run panel's) or an empty list's button.
  const [params] = useSearchParams();
  const asked = params.get('import');
  const [want, setWant] = useState<Want | null>(() =>
    asked === 'diagram' || asked === 'engine' ? { kind: asked, n: 1 } : null,
  );
  const ask = (kind: 'diagram' | 'engine') => setWant((w) => ({ kind, n: (w?.n ?? 0) + 1 }));
  const [sampling, setSampling] = useState(false);
  async function sample() {
    if (!onSample) return;
    setSampling(true);
    setError(null);
    try {
      await onSample();
      setNote('The sample stand is in the library and on the console.');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSampling(false);
    }
  }

  // Whether each pulled artifact is still what its design tool holds. Asked
  // once per artifact; an upload has nothing to compare with.
  const [fresh, setFresh] = useState<Record<string, Freshness | null>>({});
  const pulledIds = artifacts
    .filter((a) => pulledFrom(a) || a.aliases?.length)
    .map((a) => a.id)
    .join(',');
  useEffect(() => {
    for (const id of pulledIds ? pulledIds.split(',') : []) {
      if (id in fresh) continue;
      setFresh((f) => ({ ...f, [id]: null }));
      getFreshness(id)
        .then((r) => setFresh((f) => ({ ...f, [id]: r })))
        .catch(() => undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pulledIds]);
  const older = superseded(artifacts);

  async function remove(a: Artifact) {
    setRemoving(a.id);
    setError(null);
    try {
      await removeArtifact(a.id);
      setNote(`Removed ${a.name}.`);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRemoving('');
      setAsking('');
    }
  }

  async function take(files: FileList | null) {
    if (!files?.length) return;
    setError(null);
    setNote(null);
    for (const file of Array.from(files)) {
      // The extension decides: a P&ID is JSON, a Layer-1 config is YAML. That
      // is not a guess — it is what the two tools write.
      const kind = file.name.toLowerCase().endsWith('.json')
        ? 'diagram'
        : 'engine';
      try {
        if (kind === 'engine') setNote(`Importing ${file.name}… building its EngineDesign card (5-15 s).`);
        const result = await importFile(kind, file);
        setNote(importedNote(result, result.artifact.name));
        onPick(kind, result.artifact.id);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    }
    onChanged();
  }

  const group = (kind: 'diagram' | 'engine') =>
    artifacts.filter((a) => a.kind === kind);

  return (
    <div className="flex flex-col gap-3 overflow-auto px-3 py-3">
      {/* Pulling from the design tool is the primary path: it carries the
          caller's identity, and a release is bytes that cannot change. The file
          drop below stays for anything that arrived some other way. */}
      <SourcePanel
        onImported={(kind, id) => {
          onPick(kind, id);
          onChanged();
        }}
        busy={busy}
        want={want}
      />

      <div className="border-t border-[var(--edge)]" />

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          void take(e.dataTransfer.files);
        }}
        onClick={() => picker.current?.click()}
        className={`cursor-pointer rounded border border-dashed px-3 py-4 text-center text-[12.5px] transition-colors ${
          over
            ? 'border-[var(--accent)] bg-[var(--accent-dim)] text-[var(--accent)]'
            : 'border-[var(--edge-strong)] text-[var(--dim)] hover:border-[var(--accent)]'
        }`}
      >
        Or drop a P&amp;ID (.json) or an engine config (.yaml)
        <input
          ref={picker}
          type="file"
          multiple
          accept=".json,.yaml,.yml"
          className="hidden"
          onChange={(e) => void take(e.target.files)}
        />
      </div>

      {error && (
        <p className="text-[12px]" style={{ color: 'var(--bad)' }}>
          {error}
        </p>
      )}
      {note && !error && (
        <p className="text-[12px] text-[var(--dim)]">{note}</p>
      )}

      {(['diagram', 'engine'] as const).map((kind) => (
        <section key={kind}>
          <h3 className="pb-1 text-[12px] text-[var(--dim)]">
            {kind === 'diagram' ? 'P&ID' : 'Engines'}
          </h3>
          <ul className="m-0 list-none p-0">
            {group(kind).length === 0 && (
              <li className="flex flex-wrap items-baseline gap-x-4 gap-y-1 py-1 text-[12px] text-[var(--dim)]">
                <span title={kind === 'engine' ? 'Without one the engine is a pressure boundary: nothing lights.' : undefined}>
                  None yet.
                </span>
                <button
                  type="button"
                  onClick={() => ask(kind)}
                  className="text-[12px] text-[var(--muted)] underline decoration-[var(--edge-strong)] underline-offset-4 hover:text-[var(--text)]"
                >
                  {kind === 'engine' ? 'Pull one from Hotbench Engine' : 'Pull one from Hotbench P&ID'}
                </button>
                {onSample && (
                  <button
                    type="button"
                    onClick={() => void sample()}
                    disabled={sampling}
                    title="The LE4 stand drawing, with the team's ethalox engine and its engine card"
                    className="text-[12px] text-[var(--muted)] underline decoration-[var(--edge-strong)] underline-offset-4 hover:text-[var(--text)] disabled:opacity-50"
                  >
                    {sampling ? 'Loading the sample…' : 'Load the sample stand'}
                  </button>
                )}
              </li>
            )}
            {group(kind).map((a) => {
              const active =
                a.id === (kind === 'diagram' ? diagramId : engineId);
              const f = fresh[a.id];
              const stale = older.has(a.id);
              if (asking === a.id) {
                return (
                  <li key={a.id} className="flex flex-wrap items-center gap-2 border-l-2 border-l-[var(--bad)] bg-[var(--lift)] px-2 py-1 text-[12.5px]">
                    <span className="min-w-0 flex-1">
                      Remove <b>{a.name}</b> from the library
                      {kind === 'engine' && hasCard(a) ? ', with its EngineDesign card' : ''}? Runs that used it keep
                      their record; the file is gone for everyone here.
                    </span>
                    <button
                      type="button"
                      onClick={() => void remove(a)}
                      disabled={removing === a.id}
                      className="rounded border border-[var(--color-danger-solid)] px-2 py-0.5 text-[12px] text-[var(--bad)] hover:bg-[var(--bad)]/10 disabled:opacity-50"
                    >
                      {removing === a.id ? 'Removing…' : 'Remove'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setAsking('')}
                      autoFocus
                      className="rounded border border-[var(--edge-strong)] px-2 py-0.5 text-[12px] text-[var(--muted)] hover:text-[var(--text)]"
                    >
                      Keep
                    </button>
                  </li>
                );
              }
              return (
                <li key={a.id} className="flex items-center gap-2 py-0.5">
                  <button
                    type="button"
                    onClick={() => onPick(kind, active && kind === 'engine' ? '' : a.id)}
                    disabled={busy}
                    aria-current={active ? 'true' : undefined}
                    title={`${a.name}\n${a.id} · ${bytes(a.size)}\nfrom ${pulledFrom(a) ? a.source : a.source === 'upload' ? 'an uploaded file: nothing to compare it with' : a.source}\nimported ${a.imported_at}`}
                    className={`flex min-w-0 flex-1 items-baseline gap-2 rounded border-l-2 px-2 py-1 text-left transition-colors disabled:cursor-wait ${
                      active
                        ? 'border-l-[var(--accent)] bg-[var(--lift)]'
                        : 'border-l-transparent hover:bg-[var(--lift)]'
                    }`}
                  >
                    <span className={`truncate text-[13px] ${stale ? 'text-[var(--dim)]' : ''}`}>{a.name}</span>
                    {a.featured && (
                      <span className="shrink-0 text-[10px] uppercase tracking-wider text-[var(--dim)]" title="The stand a new viewer opens on">
                        sample
                      </span>
                    )}
                    {a.problem && (
                      <span
                        className="shrink-0 text-[10px] uppercase tracking-wider text-[var(--bad)]"
                        title={`Could not be built into a stand: ${a.problem}`}
                      >
                        cannot run
                      </span>
                    )}
                    {kind === 'engine' && (
                      <span
                        className={`shrink-0 rounded px-1 text-[10px] ${
                          hasCard(a) ? 'text-[var(--ok)]' : 'text-[var(--warn)]'
                        }`}
                        title={
                          hasCard(a)
                            ? "Fires EngineDesign's engine (its engine card), as Layer X does."
                            : "No EngineDesign card: fires feedtwin's simplified engine. Load it, then Build EngineDesign card on the Engine page."
                        }
                      >
                        {hasCard(a) ? 'card' : 'simplified'}
                      </span>
                    )}
                    {stale ? (
                      <span className="shrink-0 text-[10px] uppercase tracking-wider text-[var(--dim)]" title="A later pull of the same design is above">
                        older pull
                      </span>
                    ) : f ? (
                      <FreshChip f={f} />
                    ) : null}
                    <span className="num ml-auto shrink-0 text-[10.5px] text-[var(--dim)]">
                      {active ? 'loaded · ' : ''}
                      {when(a.imported_at)}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setAsking(a.id)}
                    disabled={busy || active}
                    aria-label={`Remove ${a.name}`}
                    title={
                      active
                        ? `Loaded on the stand now. ${kind === 'diagram' ? 'Open another drawing' : 'Pick another engine, or click this one to unload it'} before removing it.`
                        : `Remove ${a.name}…`
                    }
                    className="shrink-0 px-1 text-[12px] text-[var(--dim)] hover:text-[var(--bad)] disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:text-[var(--dim)]"
                  >
                    ×
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** Whether a pulled artifact is still what its design tool holds. */
function FreshChip({ f }: { f: Freshness }) {
  if (!f.tracked) return null;
  if (f.current === null) {
    return (
      <span className="shrink-0 text-[10px] uppercase tracking-wider text-[var(--dim)]" title={f.detail}>
        not checked
      </span>
    );
  }
  return f.current ? (
    <span className="shrink-0 text-[10px] uppercase tracking-wider text-[var(--dim)]" title={f.detail}>
      current
    </span>
  ) : (
    <span className="shrink-0 text-[10px] uppercase tracking-wider text-[var(--warn)]" title={f.detail}>
      changed since pulled
    </span>
  );
}
