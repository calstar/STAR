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
  ApiError,
  ChangeModal,
  CheckoutControl,
  CheckoutLostDialog,
  btn,
  keyOf,
  primaryBtn,
  refOf,
  relativeTime,
  type DesignMeta,
  type DocRef,
} from '@stardesign-ui';
import { standApi } from '../stands';
import { useStand } from '../stand';

export function StandBar() {
  const { standDoc, openStand, closeStand, snapshot, checkout, locked } = useStand();
  const [documents, setDocuments] = useState<DesignMeta[]>([]);
  const [picking, setPicking] = useState(false);
  const [releasing, setReleasing] = useState(false);
  const [menu, setMenu] = useState(false);
  const [label, setLabel] = useState('');
  const [saved, setSaved] = useState('');
  const [error, setError] = useState('');

  const ref: DocRef | null = standDoc?.ref ?? null;

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
      // Somebody else has it now: say so the way pid-designer does.
      if (e instanceof ApiError && e.status === 423) checkout.lost();
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  // Saving needs the stand taken, as an edit does: Save used to take it
  // silently and overwrite whatever its holder had just saved.
  const save = () =>
    act(async () => {
      if (!ref || !checkout.held) return;
      await standApi.autosave(ref, await snapshot());
      setSaved(new Date().toISOString());
    });

  const release = () =>
    act(async () => {
      if (!ref || !label.trim() || !checkout.held) return;
      await standApi.createRelease(ref, label.trim(), await snapshot());
      setReleasing(false);
      setLabel('');
      setSaved(new Date().toISOString());
    });

  return (
    <div className="relative flex flex-shrink-0 items-center gap-2 font-mono text-[12px]">
      <button
        className={`${btn} max-w-[150px] truncate min-[1600px]:max-w-[240px]`}
        onClick={() => { void list(); setPicking(true); }}
        title={
          standDoc
            ? `Stand: ${standDoc.name}. A stand is the whole set-up as one shared, versioned document: drawing, engine, every setting, the hookup and the knobs. Click to open, create, share or copy one.`
            : 'This set-up is not saved as a stand. Click to open one, or save this set-up as a new stand to share it.'
        }
      >
        {standDoc ? standDoc.name : 'Unsaved stand'}
      </button>
      {standDoc && (
        <>
          {/* The checkout says "Read only" itself; the hover says what that
              covers -- running the stand never is. */}
          <span
            title={
              locked
                ? 'Read only: configuration, knobs, the hookup, the drawing and the engine are the stand\'s; take it to change them. States, valves, T-0 and Fire are operating it, and are never locked.'
                : undefined
            }
          >
            <CheckoutControl checkout={checkout} noun="stand" />
          </span>
          <button
            className={primaryBtn}
            onClick={() => void save()}
            disabled={checkout.busy || !checkout.held}
            title={
              checkout.held
                ? "Write the cockpit's drawing, engine, settings, hookup and knobs into this stand"
                : 'Take the stand to save it'
            }
          >
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
            <span className="relative">
              <button
                className={btn}
                onClick={() => setMenu((m) => !m)}
                aria-haspopup="menu"
                aria-expanded={menu}
                title="More: save a release, leave the stand"
              >
                ⋯
              </button>
              {menu && (
                <span
                  role="menu"
                  className="absolute right-0 top-full z-40 mt-1 flex min-w-[200px] flex-col border border-[var(--line-strong)] bg-black py-1"
                  onMouseLeave={() => setMenu(false)}
                >
                  <button
                    role="menuitem"
                    className="px-3 py-1.5 text-left text-[12px] text-[var(--ink-2)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--ink)] disabled:text-[var(--ink-4)]"
                    onClick={() => {
                      setMenu(false);
                      setReleasing(true);
                    }}
                    disabled={!checkout.held}
                    title={checkout.held ? 'Freeze the cockpit as a named, immutable version of this stand' : 'Take the stand to save a release'}
                  >
                    Save as release…
                  </button>
                  <button
                    role="menuitem"
                    className="px-3 py-1.5 text-left text-[12px] text-[var(--ink-2)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--ink)]"
                    onClick={() => {
                      setMenu(false);
                      closeStand();
                    }}
                    title="Leave the stand. The cockpit keeps its drawing, engine, settings and knobs, unsaved."
                  >
                    Close stand
                  </button>
                </span>
              )}
            </span>
          )}
          {saved && <span className="text-gray-500" title={saved}>saved {relativeTime(saved)}</span>}
          <CheckoutLostDialog checkout={checkout} noun="stand" name={standDoc.name} />
        </>
      )}
      {error && (
        <span className="max-w-[260px] truncate text-red-400" title={error}>
          {error}
        </span>
      )}
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
              await openStand(refOf({ ...made, mine: true }), made.name, true);
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
