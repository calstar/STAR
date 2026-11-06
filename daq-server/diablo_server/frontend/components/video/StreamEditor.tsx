'use client';

/**
 * Edit mode's side panel: the stream list, editable, applied with an explicit Save.
 *
 * Nothing reaches the other screens until Save, and Save is all-or-nothing (the backend
 * rejects the whole list if one stream is wrong). Passwords are write-only: the panel only
 * knows whether one is saved; leaving the field blank keeps it. "Test" plays a URL through
 * the gateway before it is saved, so a wrong IP shows up here and not on the bunker wall.
 *
 * The Layout section picks the stand layout: a preset, and a stream for each slot. The grid
 * behind the panel shows the draft as it is chosen (onDraftLayout).
 *
 * No red on this page (VIDCOMM decision): red belongs to the stand, so Remove is a plain
 * control here.
 */
import { useEffect, useMemo, useState } from 'react';
import VideoTile from '@/components/video/VideoTile';
import { createPreview, deletePreview, fetchVideoConfig, saveVideoConfig, VideoApiError, type GatewayChange } from '@/lib/video/api';
import {
  draftLayoutFrom, draftsFrom, isDirty, layoutIds, newDraft, toSave, withLabel, withPreset, type DraftStream,
} from '@/lib/video/editor';
import { geometry, PRESET_LABELS, PRESETS, type VideoLayout } from '@/lib/video/layout';
import { previewEndpoint } from '@/lib/video/whep';

const input = 'w-full border border-line-strong bg-black px-2 py-1 font-mono text-xs text-ink placeholder:text-ink-4 focus:border-ink-3 focus:outline-none';
const fieldLabel = 'mb-0.5 block font-mono text-[10px] uppercase tracking-[0.18em] text-ink-3';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className={fieldLabel}>{label}</span>
      {children}
    </label>
  );
}

/** A live look at a URL that may not be saved yet. Lives only while it is shown. */
function Preview({ draft }: { draft: DraftStream }) {
  const [id, setId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let created: string | null = null;
    let cancelled = false;
    createPreview({
      url: draft.url.trim(),
      username: draft.username.trim() || undefined,
      password: draft.newPassword || undefined,
      fromStreamId: draft.isNew ? undefined : draft.id,
    })
      .then(({ id }) => {
        created = id;
        if (cancelled) void deletePreview(id).catch(() => {});
        else setId(id);
      })
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
      if (created) void deletePreview(created).catch(() => {});
    };
    // A preview is of the URL as it was when Test was pressed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (error) return <div className="border border-line px-2 py-3 font-mono text-[11px] text-ink-2">{error}</div>;
  return (
    <div className="relative aspect-video border border-line">
      {id ? <div className="absolute inset-0 grid"><VideoTile label={draft.label || 'Preview'} endpoint={previewEndpoint(id)} /></div>
        : <div className="flex h-full items-center justify-center font-mono text-[11px] text-ink-3">STARTING PREVIEW</div>}
    </div>
  );
}

function StreamCard({
  draft, onChange, onLabel, onRemove,
}: {
  draft: DraftStream;
  onChange: (patch: Partial<DraftStream>) => void;
  onLabel: (label: string) => void;
  onRemove: () => void;
}) {
  const [previewing, setPreviewing] = useState(0); // a new number restarts the preview
  const passwordPlaceholder = draft.clearPassword ? 'will be cleared' : draft.passwordSet ? 'saved -- type to replace' : 'none';

  return (
    <li className="space-y-2 border-b border-line px-4 py-3" data-testid={`stream-editor-${draft.key}`}>
      <div className="grid grid-cols-[1fr_9rem] gap-2">
        <Field label="Label">
          <input className={input} value={draft.label} placeholder="Engine close-up" onChange={(e) => onLabel(e.target.value)} />
        </Field>
        <Field label="Id">
          {draft.isNew ? (
            <input className={input} value={draft.id} onChange={(e) => onChange({ id: e.target.value, idEdited: true })} />
          ) : (
            <div className="px-2 py-1 font-mono text-xs text-ink-3" title="Saved streams keep their id">{draft.id}</div>
          )}
        </Field>
      </div>
      <Field label="Main URL">
        <input className={input} value={draft.url} placeholder="rtsp://192.168.1.64:554/stream1" onChange={(e) => onChange({ url: e.target.value })} />
      </Field>
      <Field label="Low-res URL (optional)">
        <input className={input} value={draft.lowResUrl} placeholder="rtsp://192.168.1.64:554/stream2" onChange={(e) => onChange({ lowResUrl: e.target.value })} />
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Username">
          <input className={input} value={draft.username} autoComplete="off" onChange={(e) => onChange({ username: e.target.value })} />
        </Field>
        <Field label="Password">
          <div className="flex gap-1">
            <input
              className={input}
              type="password"
              autoComplete="new-password"
              value={draft.newPassword}
              placeholder={passwordPlaceholder}
              onChange={(e) => onChange({ newPassword: e.target.value, clearPassword: false })}
            />
            {draft.passwordSet && !draft.newPassword && (
              <button type="button" className="ctl h-[26px] shrink-0 px-2 text-[10px] text-ink-2" onClick={() => onChange({ clearPassword: !draft.clearPassword })}>
                {draft.clearPassword ? 'Keep' : 'Clear'}
              </button>
            )}
          </div>
        </Field>
      </div>
      <div className="flex items-center justify-between gap-2 pt-1">
        <label className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.18em] text-ink-2">
          <input type="checkbox" className="h-3.5 w-3.5" checked={draft.record} onChange={(e) => onChange({ record: e.target.checked })} />
          Include in recording
        </label>
        <div className="flex gap-1">
          <button type="button" className="ctl h-6 px-2 text-[10px] text-ink-2" disabled={!draft.url.trim()} onClick={() => setPreviewing((n) => (n ? 0 : Date.now()))}>
            {previewing ? 'Stop test' : 'Test'}
          </button>
          <button type="button" className="ctl h-6 px-2 text-[10px] text-ink-2" onClick={onRemove}>Remove</button>
        </div>
      </div>
      {previewing > 0 && <Preview key={previewing} draft={draft} />}
    </li>
  );
}

interface GatewayDraft {
  host: string;
  passwordSet: boolean;
  newPassword: string;
  clearPassword: boolean;
}

/** Where this machine's backend finds the gateway: blank = this machine (the workspace);
 *  the media Mac's name in the desert. Stored on this machine only, never committed. */
function GatewaySection({ draft, onChange }: { draft: GatewayDraft; onChange: (p: Partial<GatewayDraft>) => void }) {
  const placeholder = draft.clearPassword ? 'will be cleared' : draft.passwordSet ? 'saved -- type to replace' : 'none';
  return (
    <section className="space-y-2 border-b border-line px-4 py-3">
      <span className={fieldLabel}>Gateway (this machine's setting)</span>
      <div className="grid grid-cols-[1fr_10rem] gap-2">
        <Field label="Host">
          <input className={input} value={draft.host} placeholder="this machine" onChange={(e) => onChange({ host: e.target.value })} />
        </Field>
        <Field label="Password">
          <div className="flex gap-1">
            <input
              className={input}
              type="password"
              autoComplete="new-password"
              value={draft.newPassword}
              placeholder={placeholder}
              onChange={(e) => onChange({ newPassword: e.target.value, clearPassword: false })}
            />
            {draft.passwordSet && !draft.newPassword && (
              <button type="button" className="ctl h-[26px] shrink-0 px-2 text-[10px] text-ink-2" onClick={() => onChange({ clearPassword: !draft.clearPassword })}>
                {draft.clearPassword ? 'Keep' : 'Clear'}
              </button>
            )}
          </div>
        </Field>
      </div>
      <p className="font-mono text-[10px] leading-relaxed text-ink-3">
        Blank: the gateway on this machine. Another machine (e.g. theombp.local): run
        scripts/video-gateway.sh --set-password there and enter the same password here.
      </p>
    </section>
  );
}

function gatewayChange(d: GatewayDraft): GatewayChange {
  return { host: d.host.trim(), ...(d.newPassword ? { password: d.newPassword } : d.clearPassword ? { password: null } : {}) };
}

/** Preset picker and a stream per slot. Slots hold draft keys (see lib/video/editor). */
function LayoutSection({ layout, drafts, onChange }: { layout: VideoLayout; drafts: DraftStream[]; onChange: (l: VideoLayout) => void }) {
  const cells = geometry(layout.preset).cells;
  return (
    <section className="space-y-2 border-b border-line px-4 py-3">
      <span className={fieldLabel}>Stand layout</span>
      <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="Layout preset">
        {PRESETS.map((p) => (
          <button
            key={p}
            type="button"
            role="radio"
            aria-checked={layout.preset === p}
            className={`ctl h-6 min-w-[2.75rem] px-2 text-[10px] ${layout.preset === p ? 'border-ink-3 text-ink' : 'text-ink-3'}`}
            onClick={() => onChange(withPreset(layout, p))}
          >
            {PRESET_LABELS[p]}
          </button>
        ))}
      </div>
      {layout.preset === 'auto' ? (
        <p className="font-mono text-[11px] text-ink-3">Every stream, in list order, on an even grid.</p>
      ) : (
        <ol className="space-y-1">
          {layout.slots.map((key, i) => (
            <li key={i} className="grid grid-cols-[4.5rem_1fr] items-center gap-2">
              <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-3">
                {cells[i]?.large ? 'Large' : `Slot ${i + 1}`}
              </span>
              <select
                className={input}
                aria-label={`Slot ${i + 1}`}
                value={key ?? ''}
                onChange={(e) => onChange({ ...layout, slots: layout.slots.map((k, j) => (j === i ? e.target.value || null : k)) })}
              >
                <option value="">Empty</option>
                {drafts.map((d) => <option key={d.key} value={d.key}>{d.label || d.id}{d.isNew ? ' (unsaved)' : ''}</option>)}
              </select>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

export default function StreamEditor({
  onClose, onSaved, onDraftLayout,
}: {
  onClose: () => void;
  onSaved: () => void;
  /** The draft stand layout, in stream ids, as it changes (null when the editor closes). */
  onDraftLayout?: (layout: VideoLayout | null) => void;
}) {
  const [revision, setRevision] = useState<string | null>(null);
  const [original, setOriginal] = useState<DraftStream[]>([]);
  const [drafts, setDrafts] = useState<DraftStream[]>([]);
  const [originalLayout, setOriginalLayout] = useState<VideoLayout>({ preset: 'auto', slots: [] });
  const [layout, setLayout] = useState<VideoLayout>({ preset: 'auto', slots: [] });
  const [originalGateway, setOriginalGateway] = useState<GatewayDraft | null>(null);
  const [gateway, setGateway] = useState<GatewayDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);

  useEffect(() => {
    fetchVideoConfig()
      .then((cfg) => {
        const d = draftsFrom(cfg);
        const l = draftLayoutFrom(cfg.layout, d);
        setRevision(cfg.revision);
        setOriginal(d);
        setDrafts(d);
        setOriginalLayout(l);
        setLayout(l);
        const g = { host: cfg.gateway.host, passwordSet: cfg.gateway.passwordSet, newPassword: '', clearPassword: false };
        setOriginalGateway(g);
        setGateway(g);
      })
      .catch((e) => setErrors([e instanceof Error ? e.message : String(e)]));
  }, []);

  const dirty = useMemo(
    () => isDirty(drafts, original) || JSON.stringify(layout) !== JSON.stringify(originalLayout)
      || JSON.stringify(gateway) !== JSON.stringify(originalGateway),
    [drafts, original, layout, originalLayout, gateway, originalGateway],
  );

  // Show the draft on the grid as it is chosen; hand the grid back on close.
  useEffect(() => {
    if (revision !== null) onDraftLayout?.(layoutIds(layout, drafts.filter((d) => !d.isNew)));
  }, [layout, drafts, revision, onDraftLayout]);
  useEffect(() => () => onDraftLayout?.(null), [onDraftLayout]);
  const patch = (key: string, p: Partial<DraftStream>) => setDrafts((ds) => ds.map((d) => (d.key === key ? { ...d, ...p } : d)));

  const save = async () => {
    if (revision === null) return;
    setSaving(true);
    setErrors([]);
    try {
      const { streams, credentials } = toSave(drafts);
      await saveVideoConfig(revision, streams, credentials, layoutIds(layout, drafts), gatewayChange(gateway!));
      onSaved();
      onClose();
    } catch (e) {
      setErrors(e instanceof VideoApiError ? e.errors : [e instanceof Error ? e.message : String(e)]);
    } finally {
      setSaving(false);
    }
  };

  return (
    <aside className="flex h-full w-[440px] shrink-0 flex-col border-l border-line bg-black" aria-label="Edit streams">
      <header className="flex items-center justify-between border-b border-line px-4 py-3">
        <h2 className="font-mono text-[13px] font-semibold uppercase tracking-[0.32em] text-ink">Streams</h2>
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-3">
          {revision === null ? 'loading' : `${drafts.length} configured`}
        </span>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
      {gateway && <GatewaySection draft={gateway} onChange={(p) => setGateway((g) => (g ? { ...g, ...p } : g))} />}
      {revision !== null && <LayoutSection layout={layout} drafts={drafts} onChange={setLayout} />}
      <ul>
        {drafts.map((d) => (
          <StreamCard
            key={d.key}
            draft={d}
            onChange={(p) => patch(d.key, p)}
            onLabel={(label) => setDrafts((ds) => withLabel(ds, d.key, label))}
            onRemove={() => setDrafts((ds) => ds.filter((o) => o.key !== d.key))}
          />
        ))}
        <li className="px-4 py-3">
          <button type="button" className="ctl h-7 w-full text-[10px] text-ink-2" disabled={revision === null} onClick={() => setDrafts((ds) => [...ds, newDraft(ds)])}>
            Add stream
          </button>
        </li>
      </ul>
      </div>

      <footer className="border-t border-line px-4 py-3">
        {errors.length > 0 && (
          <ul className="mb-2 space-y-0.5 font-mono text-[11px] text-ink" role="alert">
            {errors.map((e) => <li key={e}>{e}</li>)}
          </ul>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className="ctl h-7 px-3 text-[10px] text-ink-2" onClick={onClose}>Cancel</button>
          <button type="button" className="ctl h-7 px-3 text-[10px]" disabled={!dirty || saving || revision === null} onClick={() => void save()}>
            {saving ? 'Saving' : 'Save'}
          </button>
        </div>
      </footer>
    </aside>
  );
}
