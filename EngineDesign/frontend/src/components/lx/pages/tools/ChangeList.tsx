import { useMemo, useState } from 'react';
import type { EngineConfig } from '../../../../api/client';
import type { ChangeList, LayerXSettings } from '../../../../api/layerx';
import { Badge, Button, Panel } from '../../ui';
import { useUnits } from '../../units';
import { Hint, Table } from '../kit';
import { CAD_WORDS, changeListFilename, changeListJson, changeRows, effectRows, rowEffect, worstCad } from './changes';
import { DesignWrite, type DesignWriteSpec } from './DesignWrite';

/**
 * A tool's change list (engine/layerx/diff.py) as a diff: one row per change -- the component, its
 * P&ID node id, before -> after, its effect on the figures, and what it costs in CAD -- then the
 * figures the verifying burn moved. Shared by Optimize (set point, hardware) and the Injector tool.
 *
 * Nothing here writes the design. The settings patch fills the rail (view state); the pid-designer
 * graph and the list itself are files to take away; the one design write is DesignWrite's, behind
 * a confirmation and the checkout.
 */

const DOMAIN_WORDS: Record<string, string> = { operation: 'a stand setting', drawing: 'the drawing', design: 'the engine design', model: 'a fitted model number' };

const download = (text: string, filename: string, type = 'application/json') => {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

export function ChangeListView({ cl, runId, tool, designName, drawingName, onRail, onConfigUpdated, writeNote, title = 'What changes' }: {
  cl: ChangeList;
  runId: string;
  tool: string;
  designName?: string | null;
  drawingName?: string | null;
  /** Put the list's stand settings on the rail (Layer X view state). */
  onRail?: (patch: Partial<LayerXSettings>) => void;
  onConfigUpdated?: (c: EngineConfig) => void;
  /** Said instead of the design write when another control on the page owns it (the Injector tool). */
  writeNote?: string;
  title?: string;
}) {
  const u = useUnits();
  const rows = useMemo(() => changeRows(cl), [cl]);
  const effects = useMemo(() => effectRows(u, cl), [u, cl]);
  const [railed, setRailed] = useState(false);
  const cad = worstCad(cl);
  const patch = cl.exports?.settings_patch ?? null;
  const pid = cl.exports?.pid_designer ?? null;
  const write = (cl.exports?.design_write ?? null) as DesignWriteSpec | null;
  const designChanges = cl.changes.filter((c) => c.domain === 'design');
  const together = cl.changes.length > 1;
  const needs = (cl.needs_pid_designer ?? []) as { target?: string; what?: string; why?: string }[];

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
      <Panel title={<Hint text="Each change the tool proposes: the part, its id on the P&ID, the value before and after (in the units the stand and the shop use), its effect on the burn, and what it costs in CAD.">{title}</Hint>}
             right={cad ? <span>CAD: {CAD_WORDS[cad]}</span> : undefined} className="lg:col-span-12">
        {rows.length ? (
          <Table caption="The change list" head={['Component', 'P&ID node', 'Before', 'After', 'Change', together ? 'Effect, all together' : 'Effect', 'CAD']}
                 align={['l', 'l', 'r', 'r', 'r', 'l', 'l']}
                 rows={rows.map((r, k) => [
                   <span key="c" className="block min-w-[9rem]">
                     <Hint text={[`Changes ${DOMAIN_WORDS[r.domain] ?? r.domain}: ${r.field}.`, r.source ? `After: ${r.source}.` : '', r.note].filter(Boolean).join(' ')}>
                       <span className="text-[var(--lx-text)]">{r.component}</span>
                     </Hint>
                     <span className="block text-[11px] text-[var(--lx-text-3)]">{r.field}</span>
                   </span>,
                   <span key="n" className="whitespace-nowrap">{r.node ?? '—'}</span>,
                   <span key="b" className="whitespace-nowrap text-[var(--lx-text-2)]">{r.before}</span>,
                   <span key="a" className="whitespace-nowrap">{r.after}</span>,
                   <span key="d" className="whitespace-nowrap text-[var(--lx-text-2)]">{r.change ?? ''}</span>,
                   // One verifying burn for the whole list: its effect is printed once, on the first row.
                   <span key="e" className="block min-w-[8rem] font-sans text-[12px] text-[var(--lx-text-2)]">{together && k > 0 ? '' : rowEffect(u, cl, cl.changes[k]) || '—'}</span>,
                   <span key="x" className="whitespace-nowrap font-sans">{CAD_WORDS[r.cad] ?? r.cad}</span>,
                 ])} />
        ) : <p className="text-[12px] text-[var(--lx-text-2)]">No change: the design and the stand already do it.</p>}
        {(cl.notes?.length ?? 0) > 0 && <ul className="mt-3 space-y-1 text-[12px] text-[var(--lx-text-3)]">{cl.notes!.map((n, k) => <li key={k}>{n}</li>)}</ul>}
        {needs.length > 0 && (
          <ul className="mt-3 space-y-1 text-[12px]">
            {needs.map((n, k) => (
              <li key={k} className="flex gap-2">
                <Badge status="warn" size="sm">pid-designer</Badge>
                <span className="text-[var(--lx-text-2)]">{[n.what, n.why].filter(Boolean).join(': ')}</span>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-[var(--lx-line)] pt-3">
          <Button size="sm" onClick={() => download(changeListJson(cl, { runId, tool, design: designName, drawing: drawingName }), changeListFilename(tool, runId))}>
            Export the list (JSON)
          </Button>
          {patch && Object.keys(patch).length > 0 && onRail && (
            <Button size="sm" onClick={() => { onRail(patch); setRailed(true); }}
                    title="Fills the rail's tank pressure and bottle fill with these: view state, nothing is written">
              {railed ? 'On the rail' : 'Put the settings on the rail'}
            </Button>
          )}
          {pid && (
            <Button size="sm" onClick={() => download(`${JSON.stringify(pid, null, 2)}\n`, `${tool}-drawing-${runId}.json`)}
                    title="The drawing with these changes, for pid-designer">
              Drawing for pid-designer (JSON)
            </Button>
          )}
        </div>
        {designChanges.length > 0 && (
          <div className="mt-3">
            {write && !writeNote
              ? <DesignWrite write={write} changes={designChanges} designName={designName} onConfigUpdated={onConfigUpdated} />
              : writeNote ? <p className="text-[12px] text-[var(--lx-text-3)]">{writeNote}</p> : null}
          </div>
        )}
      </Panel>

      <Panel title={<Hint text={`The verifying burn's figures before and after${together ? ', for the whole list together (one burn verifies the list)' : ''}.`}>Effect on the figures</Hint>}
             className="lg:col-span-12">
        {effects.length
          ? <Table caption="The figures before and after" head={[{ sr: 'Figure' }, 'Before', 'After', 'Change']} align={['l', 'r', 'r', 'r']}
                   rows={effects.map((e) => [e.label, e.before, e.after, <span key="c" className="text-[var(--lx-text-2)]">{e.change}</span>])} />
          : <p className="text-[12px] text-[var(--lx-text-2)]">Not computed: the tool did not verify the list with a burn.</p>}
      </Panel>
    </div>
  );
}
