/**
 * "Export for DAQ": the drawing and its DAQ box as `stand_pid.json`, for the
 * DAQ's read-only schematic page (lib/daqBundle.ts says what is in it).
 *
 * The picture is taken from a copy of the drawing rendered off screen, one
 * page at a time, so the drawing being looked at is never moved, re-paged or
 * re-fitted. Each page is shot once every symbol on it is measured
 * (`useSheetReady`), the same moment the canvas itself fits on.
 *
 * Exported from the hookup as *saved*: an unsaved cable is a guess until it
 * is saved, and a guess must not end up on the stand's screen.
 */

import { useEffect, useRef, useState } from 'react';
import { useNodes } from '@xyflow/react';
import type { Node } from '@xyflow/react';
import { DrawingView, useSheetReady } from '@pid/DrawingView';
import { download, shootSheet } from '@pid/exportImage';
import { migrate } from '@pid/migrate';
import { listPages } from '@pid/pages';
import { composeStand } from '@pid/standSheet';
import type { SheetShot, StandNode } from '@pid/standSheet';
import type { Drawing } from '../api';
import { buildBundle, drawingHash, drawnLines } from '../lib/daqBundle';
import { useHookup } from '../lib/useHookup';

interface Props {
  diagram: string;
  drawing: Drawing;
  artifact: string | null;
}

type Shot = { shot: SheetShot; nodes: Node[] };

export function DaqExport({ diagram, drawing, artifact }: Props) {
  const hookup = useHookup();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [page, setPage] = useState<string | null>(null);
  const shots = useRef<Shot[]>([]);
  const pages = listPages(drawing.nodes);

  const blocked = !hookup.data
    ? 'The hookup has not loaded.'
    : hookup.dirty
      ? 'Save or discard the DAQ box first: the DAQ gets the hookup as saved.'
      : null;

  const start = () => {
    if (blocked || busy) return;
    shots.current = [];
    setMessage(null);
    setBusy(true);
    setPage(pages[0]);
  };

  const finish = async () => {
    try {
      const doc = migrate({ nodes: drawing.nodes, edges: drawing.edges });
      const nodes: StandNode[] = shots.current.flatMap(({ shot, nodes: ns }) =>
        ns.map((n) => {
          const d = (n.data ?? {}) as { label?: string; options?: Record<string, string> };
          return {
            id: n.id,
            page: shot.page,
            label: d.label ?? '',
            x: n.position.x,
            y: n.position.y,
            width: n.measured?.width ?? n.width ?? 0,
            height: n.measured?.height ?? n.height ?? 0,
            pairedWith: d.options?.pairedWith || undefined,
          };
        }),
      );
      const stand = composeStand(shots.current.map((s) => s.shot), nodes, drawnLines(doc));
      const actuated = new Set(hookup.data!.valves.map((v) => v.id));
      const out = buildBundle({
        stand,
        drawing: doc,
        diagram,
        artifact,
        sha256: await drawingHash(drawing),
        // Not dirty, so the draft is the saved hookup -- as a box even when
        // nothing was wired by hand (`draftOf`).
        channels: hookup.draft?.channels ?? [],
        actuated,
      });
      if ('error' in out) {
        setMessage(out.error);
        return;
      }
      const blob = new Blob([JSON.stringify(out.bundle)], { type: 'application/json' });
      download(blob, 'stand_pid.json');
      const mb = (blob.size / 1e6).toFixed(1);
      setMessage(
        `stand_pid.json (${mb} MB): commit it to daq-server/config/ beside config.toml. ` +
          `${out.bundle.channels.length} cabled connectors, ${pages.length} page(s).`,
      );
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'export failed');
    } finally {
      setBusy(false);
      setPage(null);
    }
  };

  const onShot = (shot: Shot) => {
    shots.current.push(shot);
    const next = pages[pages.indexOf(shot.shot.page) + 1];
    if (next) setPage(next);
    else void finish();
  };

  const onFail = (e: unknown) => {
    setMessage(e instanceof Error ? e.message : 'export failed');
    setBusy(false);
    setPage(null);
  };

  return (
    <>
      <button
        type="button"
        onClick={start}
        disabled={Boolean(blocked) || busy}
        title={
          blocked ??
          'The whole stand as one picture, with this DAQ box, for the DAQ\'s read-only schematic page (stand_pid.json).'
        }
        className="rounded border border-[var(--line-strong)] px-2 py-0.5 text-[11px] font-semibold text-[var(--ink-2)] hover:text-[var(--ink)] disabled:opacity-50"
      >
        {busy ? `Exporting ${page ?? ''}…` : 'Export for DAQ'}
      </button>
      {message && (
        <span className="text-[11px] text-[var(--ink-3)]" role="status">
          {message}
        </span>
      )}
      {busy && page && (
        // Off screen, not hidden: html-to-image copies computed styles, and a
        // hidden canvas photographs as nothing.
        <div
          aria-hidden
          style={{ position: 'fixed', left: -20000, top: 0, width: 1600, height: 1000, pointerEvents: 'none' }}
        >
          <DrawingView nodes={drawing.nodes} edges={drawing.edges} page={page}>
            <Shooter key={page} page={page} onShot={onShot} onFail={onFail} />
          </DrawingView>
        </div>
      )}
    </>
  );
}

/** Shoots its page once, as soon as every symbol on it is measured. */
function Shooter({ page, onShot, onFail }: { page: string; onShot: (s: Shot) => void; onFail: (e: unknown) => void }) {
  const ready = useSheetReady();
  const nodes = useNodes();
  const taken = useRef(false);
  const anchor = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!ready || taken.current) return;
    taken.current = true;
    const shown = nodes.filter((n) => !n.hidden);
    // Two frames: the lines are routed from the measured symbols a render
    // after the symbols themselves.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const flow = anchor.current?.closest('.react-flow') as HTMLElement | null;
        if (!flow) {
          onFail(new Error('no canvas to export'));
          return;
        }
        shootSheet(flow, shown, page).then((shot) => onShot({ shot, nodes: shown }), onFail);
      }),
    );
  }, [ready, nodes, page, onShot, onFail]);

  return <span ref={anchor} hidden />;
}
