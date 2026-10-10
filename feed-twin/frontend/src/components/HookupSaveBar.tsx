/**
 * The one save bar for the hookup, wherever it is being edited: the P&ID's
 * Symbols list and DAQ box, the State machine tab, the Hookup page. They
 * share one draft (lib/useHookup), so the bar says the same thing on each --
 * and an edit made on one tab is still waiting to be saved on the next.
 */

import { useHookup } from '../lib/useHookup';

export function HookupSaveBar({ compact = false }: { compact?: boolean }) {
  const hookup = useHookup();
  if (!hookup.dirty && !hookup.error) return null;
  return (
    <div className={compact ? 'mt-1.5' : ''}>
      {hookup.dirty && (
        <div
          className={`flex items-center gap-2 rounded-md border border-blue-900/70 bg-blue-950/30 ${
            compact ? 'px-2 py-1' : 'px-3 py-2'
          }`}
        >
          <span className={`flex-1 text-blue-200 ${compact ? 'text-[11px]' : 'text-[12px]'}`}>
            {hookup.namesOnly ? 'Unsaved names' : 'Unsaved hookup — saving restarts the stand'}
          </span>
          <button
            type="button"
            onClick={hookup.discard}
            className="rounded px-1.5 py-0.5 text-[11px] text-gray-400 hover:text-white"
          >
            Discard
          </button>
          <button
            type="button"
            disabled={hookup.busy || hookup.locked}
            onClick={hookup.save}
            title={
              hookup.locked
                ? 'Take the stand (top bar) to change its hookup'
                : hookup.onStand
                  ? 'Kept with the stand: Save the stand to keep it for good'
                  : 'Kept for this drawing, for everyone'
            }
            className="rounded bg-blue-600 px-2.5 py-0.5 text-[11px] font-semibold text-white hover:bg-blue-500 disabled:opacity-40"
          >
            {hookup.busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      )}
      {hookup.error && <p className="mt-1 text-[11px] text-red-300">{hookup.error}</p>}
    </div>
  );
}
