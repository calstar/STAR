/**
 * Per-user saved config library.
 *
 * Server-side, keyed by the logged-in user (X-Auth-Email behind Caddy, or a
 * `local` user in dev). Save names the current design; load pushes a saved
 * design back onto the backend (updateConfig) and hands it up so every tab
 * refreshes. Outputs are not stored -- they are a pure function of the input
 * and are recomputed on load.
 *
 * Degrades quietly with no backend: the list is empty and Save reports an error
 * inline rather than throwing.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  deleteSavedConfig, getSavedConfig, listSavedConfigs, loadConfigJson,
  saveNamedConfig, type EngineConfig, type SavedConfigMeta,
} from '../api/client';

export function SavedConfigs({ config, onLoad }: {
  config: EngineConfig | null;
  onLoad: (config: EngineConfig) => void;
}) {
  const [saved, setSaved] = useState<SavedConfigMeta[]>([]);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const res = await listSavedConfigs();
    setSaved(res.data?.configs ?? []);  // no backend -> empty, silently
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const save = useCallback(async () => {
    const n = name.trim();
    if (!n || !config) return;
    const res = await saveNamedConfig(n, { input: config });
    if (res.error) { setError(`could not save "${n}": ${res.error}`); return; }
    setName('');
    setError(null);
    void refresh();
  }, [name, config, refresh]);

  const load = useCallback(async (slug: string) => {
    const res = await getSavedConfig(slug);
    if (!res.data) { setError(res.error ?? 'could not load that config'); return; }
    // Replace the backend config wholesale, then hand the stored config up so
    // every tab refreshes.
    const applied = await loadConfigJson(res.data.config.input);
    if (applied.error) { setError(applied.error); return; }
    setError(null);
    onLoad(applied.data?.config ?? res.data.config.input);
  }, [onLoad]);

  const remove = useCallback(async (slug: string) => {
    const res = await deleteSavedConfig(slug);
    if (res.error) { setError(res.error); return; }
    void refresh();
  }, [refresh]);

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span className="font-medium text-[var(--color-text-secondary)]">My configs</span>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') void save(); }}
        placeholder="name…"
        className="w-36 rounded border border-[var(--color-border)] bg-transparent px-2 py-1 text-[var(--color-text-primary)]"
      />
      <button
        onClick={() => void save()}
        disabled={!name.trim() || !config}
        title={config ? 'Save the current design' : 'Load a config first'}
        className="rounded border border-[var(--color-border)] px-2 py-1 font-medium text-[var(--color-text-primary)] transition-colors hover:border-[var(--color-text-muted)] disabled:opacity-40"
      >
        Save
      </button>
      {saved.map((c) => (
        <span key={c.slug} className="inline-flex items-center rounded border border-[var(--color-border)]">
          <button
            onClick={() => void load(c.slug)}
            title={`Load "${c.name}"`}
            className="py-1 pl-2 text-[var(--color-text-primary)] hover:text-[var(--color-accent)]"
          >
            {c.name}
          </button>
          <button
            onClick={() => void remove(c.slug)}
            title="Delete" aria-label={`Delete ${c.name}`}
            className="px-1.5 py-1 text-[var(--color-text-muted)] hover:text-red-400"
          >
            ×
          </button>
        </span>
      ))}
      {error && <span className="text-red-400">{error}</span>}
    </div>
  );
}
