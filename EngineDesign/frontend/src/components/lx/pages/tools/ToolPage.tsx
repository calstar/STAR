import { useMemo, type ReactNode } from 'react';
import type { EngineConfig } from '../../../../api/client';
import { layerx, type ChangeList, type HardwareObjective, type HardwareResult, type RunView, type SetpointResult } from '../../../../api/layerx';
import { useViewState } from '../../../../lib/viewState';
import { fmt } from '../../../layerx/format';
import { Badge, Button, Field, Figure, Menu, MenuItem, MenuLabel, Panel, Segmented, Toggle } from '../../ui';
import { STD_ATM_PSIA, useUnits } from '../../units';
import type { LayerXJob } from '../../useLayerXJob';
import { FigureRow, Hint, Table } from '../kit';
import { ChangeListView } from './ChangeList';
import { useToolJob, type ToolJob } from './useToolJob';

/**
 * The Optimize tool, rebuilt (docs/layerx/DATA-CONTRACT.md 6): what to dial and what to change.
 *
 *   Set point   the dome dial, lockup and bottle fill that give a target mean thrust (POST /setpoint)
 *   Hardware    catalogue parts for the components marked free, ranked by what the set point cannot
 *               fix -- O/F first, since one regulator presses both tanks (POST /hardware)
 *
 * Each answer is a change list in one diff format (ChangeList.tsx). Nothing here writes the design:
 * a list's stand settings go to the rail, its drawing to pid-designer as a file, and the one design
 * write is DesignWrite's, behind a confirmation and the checkout. The old compass search and the
 * removed trade study stay listed, read-only, as legacy runs.
 */

type Mode = 'setpoint' | 'hardware';

const OBJECTIVES: { value: HardwareObjective; label: string; title: string; words: string }[] = [
  { value: 'of_error', label: 'Design O/F', title: 'Bring the burn’s O/F to the design’s: what the set point cannot do', words: 'closest to the design’s O/F' },
  { value: 'target_thrust_error', label: 'Target thrust', title: 'Hit the target mean thrust', words: 'closest to the target thrust' },
  { value: 'thrust_flatness', label: 'Flat thrust', title: 'The least thrust spread through the burn', words: 'flattest thrust' },
  { value: 'impulse', label: 'Impulse', title: 'The most total impulse', words: 'most impulse' },
  { value: 'bottle_margin', label: 'Bottle left', title: 'The most bottle pressure over lockup at burnout', words: 'most bottle left' },
];

function Running({ run, onCancel }: { run: RunView; onCancel: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-3 text-[12px]" role="status">
      <span className="text-[var(--lx-text-2)]">{run.stage || 'Starting'}</span>
      <div className="h-1 min-w-[8rem] flex-1 overflow-hidden rounded-full bg-[var(--lx-line)]" role="progressbar" aria-label="Progress"
           aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((run.progress ?? 0) * 100)}>
        <div className="h-full bg-[var(--lx-accent)] transition-[width] duration-300" style={{ width: `${Math.max(run.progress ?? 0, 0.02) * 100}%` }} />
      </div>
      <Button size="sm" onClick={onCancel}>Cancel</Button>
    </div>
  );
}

function Past({ tool, word, plural }: { tool: ToolJob; word: string; plural: string }) {
  if (!tool.past.length) return null;
  const when = (r: RunView) => new Date(r.started * 1000).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  return (
    <Menu label={<span>Past {plural} <span className="lx-num text-[var(--lx-text-3)]">{tool.past.length}</span></span>} minWidth={260} title={`Open a past ${word}`}>
      <MenuLabel>{plural[0].toUpperCase() + plural.slice(1)}, newest first</MenuLabel>
      {tool.past.map((r) => (
        <MenuItem key={r.id} checked={tool.run?.id === r.id} onClick={() => tool.open(r.id)} note={r.status === 'done' ? undefined : r.status}>
          {when(r)}
        </MenuItem>
      ))}
    </Menu>
  );
}

function Status({ tool, idle }: { tool: ToolJob; idle: ReactNode }) {
  if (tool.run && tool.live) return <Running run={tool.run} onCancel={tool.cancel} />;
  if (tool.run?.status === 'failed') return <div role="alert" className="text-[12px] text-[var(--lx-bad)]">{(tool.run.error ?? 'It failed.').split('\n')[0]}</div>;
  if (tool.run?.status === 'cancelled') return <div className="text-[12px] text-[var(--lx-text-3)]">Cancelled.</div>;
  return <>{idle}</>;
}

// ------------------------------------------------------------------ set point

function SetPointForm({ job, tool, config }: { job: LayerXJob; tool: ToolJob; config: EngineConfig | null }) {
  const u = useUnits();
  const designTarget = (config?.design_requirements as { target_thrust?: number } | undefined)?.target_thrust ?? null;
  const [target, setTarget] = useViewState<number | null>('lx.tool.setpoint.target', null);
  const [replay, setReplay] = useViewState<boolean>('lx.tool.setpoint.replay', true);
  const [margin, setMargin] = useViewState<number>('lx.tool.setpoint.margin', 100);
  const ready = !!job.payload && !!job.pf?.ok;
  const go = () => {
    if (!job.payload) return;
    void tool.start(() => layerx.startSetpoint({ settings: job.payload!, target_thrust_N: target, replay, margin_psi: margin }));
  };
  return (
    <Panel title="Find the set point" right={<Past tool={tool} word="set point" plural="set points" />} className="lg:col-span-12">
      <div className="grid gap-x-8 gap-y-2.5" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(17rem, 1fr))' }}>
        <Field label="Target mean thrust" termKey="thrust" scale={u.scale('force')} value={target ?? designTarget}
               defaultValue={designTarget ?? undefined} placeholder="design" allowEmpty min={1}
               onCommit={(v) => setTarget(v === null || (designTarget !== null && Math.abs(v - designTarget) < 1e-6) ? null : v)} />
        <Field label="Bottle left at burnout" termKey="lockup" scale={u.scale('pgap')} value={margin} defaultValue={100} min={0} max={3000}
               onCommit={(v) => setMargin(v ?? 100)} />
        <div className="flex min-h-7 items-center justify-between gap-3">
          <span className="pl-5 text-[12px] text-[var(--lx-text-2)]">
            <Hint text="Each burn with the nozzle eroding, as the real one will. Off is faster; the answer is then burned once more with it to check.">Nozzle erosion in every burn</Hint>
          </span>
          <Toggle label="Nozzle erosion in every burn" hideLabel checked={replay} onChange={setReplay} />
        </div>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button variant="primary" disabled={!ready || tool.live || tool.busy || tool.starting} onClick={go}>
          {tool.starting ? 'Starting…' : tool.live ? 'Solving…' : 'Find the set point'}
        </Button>
        <span className="text-[12px] text-[var(--lx-text-3)]">
          {!ready ? 'Set the burn up on the rail first' : tool.busy ? `A ${job.activeWord} is running` : 'a few minutes: every point is a whole burn, on the rail’s drawing'}
        </span>
      </div>
      {tool.error && <div role="alert" className="mt-2 text-[12px] text-[var(--lx-bad)]">{tool.error}</div>}
      <div className="mt-3"><Status tool={tool} idle={null} /></div>
    </Panel>
  );
}

function SetPointAnswer({ run, res, job, onConfigUpdated }: { run: RunView; res: SetpointResult; job: LayerXJob; onConfigUpdated?: (c: EngineConfig) => void }) {
  const u = useUnits();
  const card = res.settings_card ?? {};
  const sol = (res.solution ?? {}) as Record<string, number | undefined>;
  const gauge = (psig: number | undefined | null) => u.p(psig === undefined || psig === null ? null : psig + STD_ATM_PSIA, 'gauge', STD_ATM_PSIA);
  const bad = res.limits?.filter((l) => l.grade === 'bad') ?? [];
  const warn = res.limits?.filter((l) => l.grade === 'warn') ?? [];
  return (
    <>
      <Panel ariaLabel="The set point" className="lg:col-span-12">
        <div className="mb-4 flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <Badge status={!res.feasible || bad.length ? 'bad' : !res.converged || warn.length ? 'warn' : 'ok'} size="lg">
            {!res.feasible ? 'No set point reaches the target' : !res.converged ? 'Close, not converged' : 'Dial this'}
          </Badge>
          <span className="text-[12px] text-[var(--lx-text-2)]">
            for {u.fmt(u.f(res.target?.mean_thrust_N))} mean{res.target?.source === 'request' ? '' : ', the design’s target'} · {res.burns} burns
            {warn.length > 0 && <> · <Hint text={warn.map((l) => l.label).join(' · ')}>{warn.length} limit{warn.length > 1 ? 's' : ''} to check</Hint></>}
            {bad.length > 0 && <> · <span style={{ color: 'var(--lx-bad)' }}>breaks {bad.map((l) => l.label).join(', ')}</span></>}
          </span>
        </div>
        <FigureRow min="9rem">
          <Figure size="lg" label="Dome dial" termKey="domeSetting" q={gauge(card.dome_psig)}
                  sub={card.dome_per_1000psi_fill ? `+${fmt(card.dome_per_1000psi_fill, 0)} psi per 1000 psi of fill` : undefined} />
          <Figure size="lg" label="Tank lockup" termKey="lockup" q={u.p(card.lockup_psia ?? null)} />
          <Figure size="lg" label="Bottle fill" termKey="bottleFill" q={gauge(card.copv_fill_psig)}
                  sub={res.fill_status && res.fill_status !== 'solved' ? res.fill_status : undefined} />
          <Figure size="lg" label="Mean thrust" termKey="thrust" q={u.f(sol.mean_thrust_N ?? null)} sub={`target ${u.fmt(u.f(res.target?.mean_thrust_N))}`} />
          <Figure size="lg" label="Bottle left" q={u.gap(sol.copv_spare_psi ?? null)} sub="over lockup at burnout" />
        </FigureRow>
        {typeof res.of?.note === 'string' && (
          <p className="mt-4 max-w-[70ch] text-[12px] text-[var(--lx-text-3)]">
            <Hint text={res.of.note}>O/F is not set here</Hint>: {fmt(res.of.of_mean as number, 3)} against the design’s {fmt(res.of.design_of as number, 2)}. Hardware mode moves it.
          </p>
        )}
        {(res.notes?.length ?? 0) > 0 && <ul className="mt-2 space-y-1 text-[12px] text-[var(--lx-text-3)]">{res.notes!.map((n, k) => <li key={k}>{n}</li>)}</ul>}
      </Panel>
      {res.change_list && (
        <div className="lg:col-span-12">
          <ChangeListView cl={res.change_list} runId={run.id} tool="setpoint" designName={run.design} drawingName={run.drawing?.name}
                          onRail={(p) => job.setSettings((s) => ({ ...s, ...p }))} onConfigUpdated={onConfigUpdated} />
        </div>
      )}
    </>
  );
}

// ------------------------------------------------------------------ hardware

interface Choice { key: string; target: string; kind?: string; label: string; hint: string }

/** What the rail's drawing lets Hardware mode change: the first line of each side, its press solenoid, the holes. */
function choicesOf(job: LayerXJob): Choice[] {
  const d = job.derived as { vehicle_lines?: { side: string; lines?: string[] }[]; binding?: Record<string, string> } | undefined;
  const line = (side: string) => d?.vehicle_lines?.find((l) => l.side === side)?.lines?.[0];
  const out: Choice[] = [];
  for (const [side, word] of [['oxidiser', 'LOX'], ['fuel', 'Fuel']] as const) {
    const l = line(side);
    if (l) out.push({ key: `trim-${side}`, target: `edge:${l}`, kind: 'trim_orifice', label: `${word} line trim orifice (${l})`, hint: `A drilled plate in ${l}, sized from the catalogue's drills: it adds a loss on the ${word} side only, which is how O/F moves without the regulator.` });
  }
  for (const [key, word] of [['LOX Press', 'LOX'], ['Fuel Press', 'Fuel']] as const) {
    const id = d?.binding?.[key];
    if (id) out.push({ key: `sol-${word}`, target: `node:${id}`, label: `${word} press solenoid (${id})`, hint: `Another catalogue solenoid for ${id}: its Cv sets the drop between the regulator and the ${word} tank.` });
  }
  out.push({ key: 'holes-ox', target: 'design:oxidizer.d_jet', label: 'LOX injector holes', hint: 'The next drills either side of the design’s LOX hole: a re-drill or a new plate.' });
  out.push({ key: 'holes-fuel', target: 'design:fuel.d_jet', label: 'Fuel injector holes', hint: 'The next drills either side of the design’s fuel hole: a re-drill or a new plate.' });
  return out;
}

function HardwareForm({ job, tool }: { job: LayerXJob; tool: ToolJob }) {
  const choices = useMemo(() => choicesOf(job), [job]);
  const [picked, setPicked] = useViewState<string[]>('lx.tool.hardware.picked', ['trim-oxidiser']);
  const [objective, setObjective] = useViewState<HardwareObjective>('lx.tool.hardware.objective', 'of_error');
  const chosen = choices.filter((c) => picked.includes(c.key));
  const ready = !!job.payload && !!job.pf?.ok && chosen.length > 0;
  const go = () => {
    if (!job.payload) return;
    void tool.start(() => layerx.startHardware({
      settings: job.payload!, objective,
      components: chosen.map((c) => ({ target: c.target, ...(c.kind ? { kind: c.kind } : {}) })),
    }));
  };
  return (
    <Panel title="Choose the hardware" right={<Past tool={tool} word="hardware search" plural="hardware searches" />} className="lg:col-span-12">
      <div className="grid gap-x-8 gap-y-4 lg:grid-cols-2">
        <fieldset className="min-w-0">
          <legend className="mb-2 text-[12px] text-[var(--lx-text-2)]">What may change</legend>
          <ul className="space-y-1">
            {choices.map((c) => (
              <li key={c.key} className="flex min-h-7 items-center justify-between gap-3">
                <span className="min-w-0 truncate pl-5 text-[12px] text-[var(--lx-text-2)]"><Hint text={c.hint}>{c.label}</Hint></span>
                <Toggle label={c.label} hideLabel checked={picked.includes(c.key)}
                        onChange={(v) => setPicked((p) => (v ? [...new Set([...p, c.key])] : p.filter((k) => k !== c.key)))} />
              </li>
            ))}
          </ul>
        </fieldset>
        <div className="min-w-0 space-y-3">
          <div>
            <div className="mb-2 text-[12px] text-[var(--lx-text-2)]">Rank them by</div>
            <Segmented ariaLabel="Rank the candidates by" size="sm" value={objective} onChange={setObjective} options={OBJECTIVES} />
          </div>
          <p className="max-w-[60ch] text-[12px] text-[var(--lx-text-3)]">
            Each candidate is a whole burn on a copy of the drawing; the winner’s set point is then solved again for the design’s target thrust.
          </p>
        </div>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button variant="primary" disabled={!ready || tool.live || tool.busy || tool.starting} onClick={go}>
          {tool.starting ? 'Starting…' : tool.live ? 'Searching…' : 'Search the catalogue'}
        </Button>
        <span className="text-[12px] text-[var(--lx-text-3)]">
          {!job.payload || !job.pf?.ok ? 'Set the burn up on the rail first' : !chosen.length ? 'Pick at least one part' : tool.busy ? `A ${job.activeWord} is running` : 'several minutes: a burn per candidate'}
        </span>
      </div>
      {tool.error && <div role="alert" className="mt-2 text-[12px] text-[var(--lx-bad)]">{tool.error}</div>}
      <div className="mt-3"><Status tool={tool} idle={null} /></div>
    </Panel>
  );
}

function HardwareAnswer({ run, res, job, onConfigUpdated }: { run: RunView; res: HardwareResult; job: LayerXJob; onConfigUpdated?: (c: EngineConfig) => void }) {
  const u = useUnits();
  const winner = (res.winner ?? null) as { summary?: string } | null;
  const objective = OBJECTIVES.find((o) => o.value === res.objective)?.words ?? res.objective;
  const rows = [...(res.candidates ?? [])].sort((a, b) => a.rank - b.rank);
  const fig = (c: (typeof rows)[number], k: string) => (c.figures as Record<string, number> | undefined)?.[k];
  return (
    <>
      <Panel ariaLabel="The hardware answer" className="lg:col-span-12">
        <div className="mb-4 flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <Badge status={res.improves ? 'ok' : 'warn'} size="lg">{res.improves ? 'A better part' : 'Nothing beats what is there'}</Badge>
          <span className="text-[12px] text-[var(--lx-text-2)]">best first: {objective} · {res.burns ?? rows.length} burns</span>
        </div>
        {winner?.summary && <p className="mb-3 text-[13px] text-[var(--lx-text)]">{winner.summary}</p>}
        <Table caption="The candidates, best first" head={['Rank', 'Candidate', 'Mean thrust', 'O/F', 'Burn time', 'Limits']} align={['r', 'l', 'r', 'r', 'r', 'l']}
               rows={rows.map((c) => [
                 c.rank,
                 <span key="s" className="font-sans text-[var(--lx-text)]">{String(c.summary ?? c.label ?? '—')}</span>,
                 u.fmt(u.f(fig(c, 'mean_thrust_N') ?? null)),
                 u.fmt(u.of(fig(c, 'of_mean') ?? null)),
                 u.fmt(u.time(fig(c, 'burn_time_s') ?? null)),
                 <span key="l" className="font-sans">{Array.isArray(c.limits_bad) && c.limits_bad.length
                   ? <Badge status="bad" size="sm">{c.limits_bad.length} broken</Badge>
                   : Array.isArray(c.limits_warn) && (c.limits_warn as string[]).length
                     ? <Hint text={(c.limits_warn as string[]).join(' · ')}><Badge status="warn" size="sm">{(c.limits_warn as string[]).length} to check</Badge></Hint>
                     : <Badge status="ok" size="sm">within</Badge>}</span>,
               ])} />
        {(res.catalog_problems?.length ?? 0) > 0 && <p className="mt-2 text-[12px] text-[var(--lx-warn)]">Catalogue files that did not read: {res.catalog_problems!.join('; ')}</p>}
      </Panel>
      {res.change_list && (
        <div className="lg:col-span-12">
          <ChangeListView cl={res.change_list as ChangeList} runId={run.id} tool="hardware" designName={run.design} drawingName={run.drawing?.name}
                          onRail={(p) => job.setSettings((s) => ({ ...s, ...p }))} onConfigUpdated={onConfigUpdated} />
        </div>
      )}
    </>
  );
}

// ------------------------------------------------------------------ legacy

function Legacy({ job }: { job: LayerXJob }) {
  const old = job.runs.filter((r) => r.legacy || r.kind === 'optimize' || r.kind === 'trade').sort((a, b) => b.started - a.started);
  if (!old.length) return null;
  const words: Record<string, string> = { optimize: 'Feed search (removed)', trade: 'Trade study (removed)' };
  return (
    <Panel title={<Hint text="Runs of the tools Set point and Hardware replaced. Kept, read-only, for one release.">Legacy runs</Hint>}
           right={<span className="lx-num">{old.length}</span>} className="lg:col-span-12">
      <Table caption="Legacy optimise and trade runs" head={['When', 'Tool', 'Status', 'Result']} align={['l', 'l', 'l', 'l']}
             rows={old.map((r) => {
               const s = r.summary as unknown as { objective?: string; best_objective?: number; best_x?: Record<string, number> } | null | undefined;
               const best = s?.best_x ? Object.entries(s.best_x).map(([k, v]) => `${k.replace(/_/g, ' ')} ${fmt(v, v > 100 ? 0 : 2)}`).join(', ') : '—';
               return [
                 new Date(r.started * 1000).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }),
                 words[r.kind ?? ''] ?? r.kind ?? '—',
                 r.status,
                 <span key="b" className="font-sans text-[var(--lx-text-2)]">{s?.objective ? `${s.objective}: ${best}` : best}</span>,
               ];
             })} />
    </Panel>
  );
}

// ------------------------------------------------------------------ the page

export function ToolPage({ job, isVisible, config, onConfigUpdated }: {
  job: LayerXJob; isVisible: boolean; config: EngineConfig | null; onConfigUpdated?: (c: EngineConfig) => void;
}) {
  const [mode, setMode] = useViewState<Mode>('lx.tool.mode', 'setpoint');
  const sp = useToolJob('setpoint', job, isVisible);
  const hw = useToolJob('hardware', job, isVisible);
  const tool = mode === 'setpoint' ? sp : hw;
  const run = tool.run;
  const res = run?.status === 'done' ? run.result : null;
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
      <div className="flex flex-wrap items-center justify-between gap-3 lg:col-span-12">
        <Segmented ariaLabel="What to optimise" value={mode} onChange={setMode}
                   options={[{ value: 'setpoint', label: 'Set point', title: 'Dome, lockup and bottle fill for a target thrust' },
                             { value: 'hardware', label: 'Hardware', title: 'Catalogue parts: trim orifices, solenoids, injector drills' }]} />
        <span className="text-[12px] text-[var(--lx-text-3)]">
          {mode === 'setpoint' ? 'What to dial on the stand for a target thrust.' : 'What to change when the dials are not enough (O/F).'}
        </span>
      </div>
      {mode === 'setpoint' ? <SetPointForm job={job} tool={sp} config={config} /> : <HardwareForm job={job} tool={hw} />}
      {run && res && mode === 'setpoint' && (res as SetpointResult).mode === 'setpoint' && <SetPointAnswer run={run} res={res as SetpointResult} job={job} onConfigUpdated={onConfigUpdated} />}
      {run && res && mode === 'hardware' && (res as HardwareResult).mode === 'hardware' && <HardwareAnswer run={run} res={res as HardwareResult} job={job} onConfigUpdated={onConfigUpdated} />}
      <Legacy job={job} />
    </div>
  );
}
