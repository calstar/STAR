/**
 * The stand document this cockpit is on: open one, save the cockpit into it,
 * share it, cut a named release ("TRR rev B").
 *
 * The dialog, the checkout and the store are pid-designer's own
 * (lib/stardesign-ui, lib/stardesign), so sharing works here exactly as it does
 * there. What differs is what "save" means: a stand is the cockpit's
 * configuration -- drawing, engine, settings, hookup, where the knobs sit --
 * and saving is a deliberate act, not an autosave of a stand that changes
 * every tick.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  ChangeModal,
  CheckoutControl,
  btn,
  keyOf,
  primaryBtn,
  refOf,
  relativeTime,
  useCheckout,
  type DesignMeta,
  type DocRef,
} from '@stardesign-ui';
import { standApi } from '../stands';
import { useStand } from '../stand';

export function StandBar() {
  const { standDoc, openStand, closeStand, snapshot } = useStand();
  const [documents, setDocuments] = useState<DesignMeta[]>([]);
  const [picking, setPicking] = useState(false);
  const [releasing, setReleasing] = useState(false);
  const [label, setLabel] = useState('');
  const [saved, setSaved] = useState('');
  const [error, setError] = useState('');

  const ref: DocRef | null = standDoc?.ref ?? null;
  // Taking the checkout must not reload the stand: that would reopen the
  // session and throw away the run on screen. Saving writes the cockpit as it
  // is, which is what a person pressing Save means.
  const checkout = useCheckout({ api: standApi, ref, reload: () => undefined });

  const list = useCallback(async () => {
    try {
      setDocuments(await standApi.list());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void list();
  }, [list]);

  const act = async (work: () => Promise<unknown>) => {
    setError('');
    try {
      await work();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const save = () =>
    act(async () => {
      if (!ref) return;
      if (!checkout.held) await checkout.take();
      await standApi.autosave(ref, await snapshot());
      setSaved(new Date().toISOString());
    });

  const release = () =>
    act(async () => {
      if (!ref || !label.trim()) return;
      await standApi.createRelease(ref, label.trim(), await snapshot());
      setReleasing(false);
      setLabel('');
      setSaved(new Date().toISOString());
    });

  return (
    <div className="flex flex-shrink-0 items-center gap-2 font-mono text-[12px]">
      <span className="caps text-[11px]" title="A stand is the whole set-up as one shared, versioned document: drawing, engine, every setting, the hookup and the knobs. Runs fired on it are kept with it.">
        Stand
      </span>
      <button className={btn} onClick={() => { void list(); setPicking(true); }} title="Open, create, share or copy a stand">
        {standDoc ? standDoc.name : 'Not on a stand'}
      </button>
      {standDoc && (
        <>
          <CheckoutControl checkout={checkout} noun="stand" />
          <button className={primaryBtn} onClick={() => void save()} disabled={checkout.busy} title="Write the cockpit's drawing, engine, settings, hookup and knobs into this stand">
            Save
          </button>
          {releasing ? (
            <span className="flex items-center gap-1">
              <input
                autoFocus
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void release();
                  if (e.key === 'Escape') setReleasing(false);
                }}
                placeholder="TRR rev B"
                className="w-32 border border-gray-700 bg-black px-2 py-0.5 text-[12px] text-gray-200"
              />
              <button className={btn} onClick={() => void release()} disabled={!label.trim()}>
                Save release
              </button>
            </span>
          ) : (
            <button className={btn} onClick={() => setReleasing(true)} title="Freeze the cockpit as a named, immutable version of this stand">
              Save as release…
            </button>
          )}
          <button className={btn} onClick={closeStand} title="Leave the stand; the cockpit keeps what it has">
            Close
          </button>
          {saved && <span className="text-gray-500" title={saved}>saved {relativeTime(saved)}</span>}
        </>
      )}
      {error && <span className="text-red-400">{error}</span>}
      {picking && (
        <ChangeModal
          open={picking}
          api={standApi}
          noun="stand"
          onClose={() => setPicking(false)}
          documents={documents}
          activeKey={ref ? keyOf(ref) : null}
          onSelect={(r) => {
            setPicking(false);
            const meta = documents.find((d) => keyOf(refOf(d)) === keyOf(r));
            void act(() => openStand(r, meta?.name ?? r.id));
          }}
          onCreate={(name) =>
            act(async () => {
              const made = await standApi.create(name, await snapshot());
              await list();
              setPicking(false);
              await openStand(refOf({ ...made, mine: true }), made.name);
            })
          }
          onRename={(r, name) => act(async () => { await standApi.rename(r, name); await list(); })}
          onShare={(r, emails) => act(async () => { await standApi.share(r, emails); await list(); })}
          onLeave={(r) => act(async () => { await standApi.leave(r); await list(); })}
          onCopy={(r) => act(async () => { await standApi.copy(r); await list(); })}
        />
      )}
    </div>
  );
}
