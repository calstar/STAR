/**
 * Import straight from the other design tools.
 *
 * The loop this replaces is: save in pid-designer, find the export button,
 * download, switch tabs, drag the file in. Five steps, and the third one is
 * where last week's drawing gets imported instead of this morning's.
 *
 * A design can be pulled at its working copy or at a named release. The
 * distinction is the point rather than a detail: a release is a label on bytes
 * that cannot change, so a run that names one can still be reproduced. The
 * working copy is what you want mid-session and is recorded as such, so nobody
 * later mistakes it for a milestone.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  importFromSource,
  listSourceDocuments,
  listSources,
  type Source,
  type SourceDocument,
} from '../api';

interface Props {
  onImported: (kind: 'diagram' | 'engine', id: string) => void;
  busy: boolean;
}

export function SourcePanel({ onImported, busy }: Props) {
  const [sources, setSources] = useState<Source[] | null>(null);
  const [docs, setDocs] = useState<Record<string, SourceDocument[]>>({});
  const [open, setOpen] = useState('');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [pulling, setPulling] = useState('');

  useEffect(() => {
    listSources()
      .then(setSources)
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : String(e)),
      );
  }, []);

  const expand = useCallback(
    async (key: string) => {
      const next = open === key ? '' : key;
      setOpen(next);
      if (!next || docs[key]) return;
      try {
        const found = await listSourceDocuments(key);
        setDocs((d) => ({ ...d, [key]: found }));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [open, docs],
  );

  async function pull(source: Source, doc: SourceDocument, release: string) {
    const tag = `${doc.id}@${release}`;
    setPulling(tag);
    setError('');
    setNote('');
    try {
      const result = await importFromSource(source.key, {
        doc_id: doc.id,
        owner: doc.owner,
        release,
        name: doc.name,
      });
      setNote(
        result.already_present
          ? `${doc.name} was already imported — identical bytes.`
          : `Imported ${doc.name}${release ? ` at ${release}` : ''}.`,
      );
      onImported(source.kind, result.artifact.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPulling('');
    }
  }

  if (!sources) {
    return (
      <p className="px-3 py-3 text-[12.5px] text-[var(--dim)]">
        Looking for the design tools…
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3 px-3 py-3">
      {error && (
        <p className="text-[12px]" style={{ color: 'var(--bad)' }}>
          {error}
        </p>
      )}
      {note && !error && (
        <p className="text-[12px] text-[var(--dim)]">{note}</p>
      )}

      {sources.map((source) => (
        <section key={source.key}>
          <button
            type="button"
            onClick={() => void expand(source.key)}
            disabled={!source.reachable}
            className="flex w-full items-baseline gap-2 rounded px-1 py-1 text-left transition-colors hover:bg-[var(--lift)] disabled:cursor-not-allowed"
          >
            <span
              aria-hidden
              className="inline-block h-2 w-2 shrink-0 rounded-full"
              style={{
                background: source.reachable ? 'var(--ok)' : 'var(--edge-strong)',
              }}
            />
            <span className="text-[13px]">{source.label}</span>
            <span className="text-[11.5px] text-[var(--dim)]">
              {source.kind === 'diagram' ? 'drawings' : 'engines'}
            </span>
            <span className="num ml-auto text-[11px] text-[var(--dim)]">
              {source.reachable ? (open === source.key ? '−' : '+') : 'offline'}
            </span>
          </button>

          {!source.reachable && (
            <p className="px-1 pb-1 text-[11.5px] leading-snug text-[var(--dim)]">
              {source.detail}
            </p>
          )}

          {open === source.key && (
            <ul className="m-0 list-none p-0 pl-4">
              {docs[source.key]?.length === 0 && (
                <li className="py-1 text-[12px] text-[var(--dim)]">
                  Nothing there yet.
                </li>
              )}
              {(docs[source.key] ?? []).map((doc) => (
                <li key={`${doc.owner}/${doc.id}`} className="py-1">
                  <div className="flex items-baseline gap-2">
                    <span className="truncate text-[12.5px]">{doc.name}</span>
                    {!doc.mine && (
                      <span className="shrink-0 text-[11px] text-[var(--dim)]">
                        {doc.owner_name || doc.owner}
                      </span>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-1 pt-0.5">
                    {/* Working copy first: mid-session it is what you want, and
                        it is the only one guaranteed to exist. */}
                    <Pull
                      label="working copy"
                      busy={busy || pulling === `${doc.id}@`}
                      onClick={() => void pull(source, doc, '')}
                    />
                    {doc.releases.map((release) => (
                      <Pull
                        key={release}
                        label={release}
                        accent
                        busy={busy || pulling === `${doc.id}@${release}`}
                        onClick={() => void pull(source, doc, release)}
                      />
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}
    </div>
  );
}

function Pull({
  label,
  onClick,
  busy,
  accent = false,
}: {
  label: string;
  onClick: () => void;
  busy: boolean;
  accent?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className={`num rounded-[3px] border px-1.5 py-0.5 text-[11px] transition-colors disabled:cursor-wait disabled:opacity-60 ${
        accent
          ? 'border-[var(--edge-strong)] text-[var(--muted)] hover:border-[var(--accent)] hover:text-[var(--accent)]'
          : 'border-transparent text-[var(--dim)] hover:text-[var(--accent)]'
      }`}
    >
      {busy ? '…' : label}
    </button>
  );
}
