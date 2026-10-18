/**
 * The DAQ box, as the drawing shows it: drawn whether or not the stand runs,
 * since wiring is done before anything is simulated.
 *
 * - while a cable is drawn from an empty connector, every symbol on this page
 *   that connector takes is outlined faintly (where it can go), and the one
 *   under the pointer is ringed -- blue if it fits, red if not;
 * - with the side panel open (Symbols or DAQ box), each cabled symbol
 *   carries its connector and, where the next badge leaves room, its name --
 *   "S12·3 LOX Main" -- small, above it (above its reading, when the stand
 *   is running). The name is in the text because nothing here takes the
 *   pointer, so a hover could never show it;
 * - the symbol of the connector under the mouse, or open in the panel, or
 *   waiting for a connector, is ringed, as LiveLayer rings the Symbols
 *   panel's.
 *
 * A child of DrawingView, in flow coordinates, taking no pointer events, so
 * the symbols under it still take their clicks.
 */

import { ViewportPortal, useNodes, useReactFlow } from '@xyflow/react';
import type { Node } from '@xyflow/react';
import { useEffect, useRef } from 'react';
import { type DaqUi, NOT_TARGETS, type Store, badgeLabel, badgeRoom } from '../lib/daqDrag';
import { accepts, channelAt } from '../lib/hookupDraft';
import { useHookup } from '../lib/useHookup';
import { useDaqUi } from './DaqBox';

const FOCUS = '#60A5FA';
/** What LiveLayer puts a reading above, so a badge goes above that. */
const READ = new Set(['PT', 'PG', 'TANK', 'KBOTTLE', 'DEWAR', 'ENGINE', 'RTD', 'TC']);

const typeOf = (n: Node) => (n.data as { componentType?: string }).componentType ?? n.type ?? '';

export function HookupOverlay({
  ui,
  badges,
  readings,
  ring = null,
}: {
  ui: Store<DaqUi>;
  /** The side panel is open: badge every cabled symbol. */
  badges: boolean;
  /** The stand is running, so instruments carry LiveLayer's reading. */
  readings: boolean;
  /** One more symbol to ring (the Symbols panel's, when LiveLayer is not
   *  drawn to ring it). */
  ring?: string | null;
}) {
  const nodes = useNodes();
  const hookup = useHookup();
  const { fitView } = useReactFlow();
  const drag = useDaqUi(ui, (s) => s.drag);
  const target = useDaqUi(ui, (s) => s.target);
  const hover = useDaqUi(ui, (s) => s.hover);
  const selected = useDaqUi(ui, (s) => s.selected);
  const picked = useDaqUi(ui, (s) => s.picked);
  const show = useDaqUi(ui, (s) => s.show);

  const shown = nodes.filter(
    (n) => !n.hidden && n.measured?.width && n.measured?.height && !NOT_TARGETS.has(typeOf(n)),
  );

  // "Show": once the symbol is on the page shown, bring it into view.
  const visible = Boolean(show && shown.some((n) => n.id === show.id));
  const shownFor = useRef(0);
  useEffect(() => {
    if (!show || !visible || shownFor.current === show.n) return;
    shownFor.current = show.n;
    void fitView({ nodes: [{ id: show.id }], maxZoom: 1.2, duration: 300, padding: 0.6 });
  }, [show, visible, fitView]);

  const draft = hookup.draft;
  const channels = draft?.channels ?? [];
  const open = selected && draft ? channelAt(draft, selected.board, selected.slot)?.symbol : undefined;
  const rings = new Set([hover, open, picked, ring].filter((x): x is string => Boolean(x)));
  const wiring = drag && !drag.moving ? hookup.board(drag.board) : undefined;
  const fits = wiring ? shown.filter((n) => n.id !== target?.id && accepts(wiring, hookup.symbol(n.id))) : [];
  const byId = new Map(shown.map((n) => [n.id, n]));
  const aim = target ? byId.get(target.id) : undefined;

  if (!badges && !rings.size && !fits.length && !aim) return null;

  // Where each badge sits: centred over its symbol, above the reading
  // LiveLayer puts over an instrument.
  const placed = badges
    ? channels.flatMap((c) => {
        const n = byId.get(c.symbol);
        if (!n) return [];
        const x = n.position.x + n.measured!.width! / 2;
        const y = n.position.y - (readings && READ.has(typeOf(n)) ? 19 : 6);
        const tag = String((n.data as { label?: string } | undefined)?.label ?? '');
        return [{ c, x, y, tag }];
      })
    : [];

  const box = (n: Node, pad: number) => ({
    x: n.position.x - pad,
    y: n.position.y - pad,
    width: n.measured!.width! + 2 * pad,
    height: n.measured!.height! + 2 * pad,
  });

  return (
    <ViewportPortal>
      <svg
        style={{ position: 'absolute', overflow: 'visible', pointerEvents: 'none', zIndex: 2 }}
        width={1}
        height={1}
      >
        {fits.map((n) => (
          <rect
            key={`fit-${n.id}`}
            {...box(n, 7)}
            rx={8}
            fill="none"
            stroke={FOCUS}
            strokeOpacity={0.45}
            strokeWidth={1.25}
            strokeDasharray="4 3"
          />
        ))}
        {[...rings].map((id) => {
          const n = byId.get(id);
          return n ? (
            <rect key={`ring-${id}`} {...box(n, 12)} rx={12} fill="none" stroke={FOCUS} strokeWidth={2.5} />
          ) : null;
        })}
        {aim && (
          <rect
            {...box(aim, 9)}
            rx={10}
            fill={target!.ok ? 'rgba(96,165,250,0.08)' : 'rgba(248,113,113,0.08)'}
            stroke={target!.ok ? FOCUS : 'var(--bad)'}
            strokeWidth={3}
          />
        )}
      </svg>
      {placed.map(({ c, x, y, tag }, i) => {
        const lit = rings.has(c.symbol);
        const room = badgeRoom({ x, y }, placed.filter((_, j) => j !== i));
        return (
          <div
            key={`badge-${c.symbol}`}
            className={`pointer-events-none absolute border bg-[var(--color-bg-primary)]/85 px-1 font-mono text-[10px] leading-[14px] tabular-nums ${
              lit ? 'text-[var(--ink)]' : 'border-[var(--line-strong)] text-[var(--ink-2)]'
            }`}
            style={{
              transform: `translate(${x}px, ${y}px) translate(-50%, -100%)`,
              zIndex: 2,
              borderColor: lit ? FOCUS : undefined,
              whiteSpace: 'nowrap',
            }}
          >
            {badgeLabel(c, room, tag)}
          </div>
        );
      })}
    </ViewportPortal>
  );
}
