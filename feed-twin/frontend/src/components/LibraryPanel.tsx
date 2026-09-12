/**
 * The library: what has been imported, and what is loaded.
 *
 * Drop a drawing or an engine config on it, or pick a file. An artifact is
 * addressed by the hash of its own bytes, so importing the same drawing twice
 * is a no-op and the panel says so rather than making a second copy.
 */

import { useRef, useState } from 'react';
import { SourcePanel } from './SourcePanel';
import {
  bytes,
  when,
  importFile,
  removeArtifact,
  type Artifact,
} from '../api';

interface Props {
  artifacts: Artifact[];
  diagramId: string;
  engineId: string;
  onPick: (kind: 'diagram' | 'engine', id: string) => void;
  onChanged: () => void;
  busy: boolean;
}

export function LibraryPanel({
  artifacts,
  diagramId,
  engineId,
  onPick,
  onChanged,
  busy,
}: Props) {
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const picker = useRef<HTMLInputElement>(null);

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
        const result = await importFile(kind, file);
        setNote(
          result.already_present
            ? `${result.artifact.name} was already imported — same file.`
            : `Imported ${result.artifact.name}.`,
        );
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
              <li className="py-1 text-[12px] text-[var(--dim)]">
                {kind === 'engine'
                  ? 'None — the engine stays a pressure boundary.'
                  : 'None imported.'}
              </li>
            )}
            {group(kind).map((a) => {
              const active =
                a.id === (kind === 'diagram' ? diagramId : engineId);
              return (
                <li key={a.id} className="flex items-center gap-2 py-0.5">
                  <button
                    type="button"
                    onClick={() => onPick(kind, active && kind === 'engine' ? '' : a.id)}
                    disabled={busy}
                    aria-current={active ? 'true' : undefined}
                    title={`${a.name}\n${a.id} · ${bytes(a.size)}\nfrom ${a.source}\nimported ${a.imported_at}`}
                    className={`flex min-w-0 flex-1 items-baseline gap-2 rounded border-l-2 px-2 py-1 text-left transition-colors disabled:cursor-wait ${
                      active
                        ? 'border-l-[var(--accent)] bg-[var(--lift)]'
                        : 'border-l-transparent hover:bg-[var(--lift)]'
                    }`}
                  >
                    <span className="truncate text-[13px]">{a.name}</span>
                    <span className="num ml-auto shrink-0 text-[10.5px] text-[var(--dim)]">
                      {a.id.slice(0, 7)} · {when(a.imported_at)}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      await removeArtifact(a.id);
                      onChanged();
                    }}
                    disabled={busy}
                    aria-label={`Remove ${a.name}`}
                    className="shrink-0 px-1 text-[12px] text-[var(--dim)] hover:text-[var(--bad)]"
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
