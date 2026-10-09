import { useMemo, useState, type ReactNode } from 'react';
import '../fonts';
import { DEFAULT_SYSTEM, UnitsProvider, useUnits, type UnitSystem } from '../units';
import {
  Badge, Button, DeltaChip, Field, Figure, Kbd, MarginBar, Menu, MenuItem, MenuLabel, MenuSeparator, NotComputed, Num, Panel,
  Segmented, Tabs, Term, Toggle, compareMargins, delta, deltaText, marginScale, tabPanelProps, worst, type LimitSpec, type Status,
} from '../ui';

/**
 * Every lx/ui primitive, in both themes side by side, with LE4 numbers (the 6.8 kN ethalox stand).
 * A specimen sheet for review and screenshots, not a page: mount it on its own.
 */
export function GalleryUI() {
  return (
    <main className="grid min-h-screen grid-cols-1 xl:grid-cols-2">
      {(['dark', 'light'] as const).map((theme) => (
        <div key={theme} className="lx min-w-0 px-6 py-8" data-theme={theme}>
          <UnitsProvider persist={false} initial={DEFAULT_SYSTEM} gaugeZeroPsia={14.5}>
            <Specimens theme={theme} />
          </UnitsProvider>
        </div>
      ))}
    </main>
  );
}

export default GalleryUI;

const PAGES = [
  { key: 'overview', label: 'Overview', q: 'Will it work?' },
  { key: 'feed', label: 'Feed', q: 'Where does the pressure go?' },
  { key: 'engine', label: 'Engine', q: 'What does the chamber see?' },
  { key: 'hardware', label: 'Hardware', q: 'What does the burn do to the engine?' },
  { key: 'flight', label: 'Flight', q: 'How does it fly?' },
  { key: 'stand', label: 'Stand', q: 'What should the stand read, and did it?' },
  { key: 'uncertainty', label: 'Uncertainty', q: 'What don\'t we know, and does it matter?' },
  { key: 'record', label: 'Record', q: 'Can I trust this run?' },
] as const;
type PageKey = (typeof PAGES)[number]['key'];

/** The LE4 limits, in display units: what the Overview's margin bars are built from. */
interface Limit { key: string; label: string; spec: LimitSpec; value: number; text: string; worst: string; limit: string; hint: string; term?: 'chugMargin' | 'stiffness' | 'mawp' | 'lockup' | 'tankPressure' }

function useLimits(): Limit[] {
  const u = useUnits();
  return useMemo(() => {
    const dp = (psi: number) => u.dp(psi).value;
    const gap = (psi: number) => u.gap(psi).value;
    return [
      { key: 'chug', label: 'Chug margin', spec: { limit: 1, warn: 1.2, direction: 'higher-is-safer' }, value: 1.33, text: u.fmt(u.ratio(1.33)),
        worst: 'worst at T+0.04 s', limit: '> 1', term: 'chugMargin',
        hint: 'The lowest gain margin over the burn, ignition included, worst over the mixing-lag band. Amber under 1.2: the margin rests on an unmeasured mixing lag.' },
      { key: 'lox-dp', label: 'LOX ΔP/Pc', spec: { limit: 20, direction: 'higher-is-safer', far: { warn: 40 } }, value: 35.6, text: u.fmt(u.pct(0.356)),
        worst: 'min at T+3.52 s', limit: '20–40 %', term: 'stiffness',
        hint: 'The design\'s band is 20–40 %. Too low invites chug; above the band the injector costs tank pressure for nothing.' },
      { key: 'lox-peak', label: 'LOX tank peak', spec: { limit: gap(1000), warn: gap(800), direction: 'lower-is-safer' }, value: gap(564),
        text: u.fmt(u.p(564 + 14.5, 'gauge')), worst: 'at T−2.10 s', limit: `≤ ${u.fmt(u.gap(1000))} MAWP`, term: 'mawp',
        hint: 'Highest pressure across the wall over the hold and the burn: 56 % of the drawing\'s MAWP (amber above 80 %).' },
      { key: 'bottle', label: 'Bottle at burnout', spec: { limit: gap(100), warn: gap(200), direction: 'higher-is-safer' }, value: gap(631),
        text: u.fmt(u.gap(631)), worst: 'at T+3.55 s', limit: `≥ ${u.fmt(u.gap(100))} over lockup`, term: 'lockup',
        hint: 'How far the bottle is above the tanks\' lockup when the burn ends. Under 100 psi the regulator stops holding tank pressure.' },
      { key: 'sag', label: 'Tank pressure sag', spec: { limit: dp(60), warn: dp(30), direction: 'lower-is-safer' }, value: dp(25.4),
        text: u.fmt(u.dp(25.4)), worst: 'at T+0.31 s', limit: `< ${u.fmt(u.gap(30))}`, term: 'tankPressure',
        hint: 'Deepest dip below the set tank pressure while firing (amber over 30, red over 60 psi).' },
    ];
  }, [u]);
}

function Specimens({ theme }: { theme: 'dark' | 'light' }) {
  const u = useUnits();
  const [page, setPage] = useState<PageKey>('overview');
  const limits = useLimits();
  const graded = limits
    .map((l) => ({ ...l, scale: marginScale(l.spec, l.value, { trackPx: 260 }) }))
    .sort((a, b) => compareMargins(a.scale, b.scale));
  const verdict: Status = worst(graded.map((g) => g.scale.status));
  const [jumped, setJumped] = useState<string | null>(null);

  return (
    <div className="mx-auto max-w-[760px] space-y-6">
      <div className="flex items-baseline justify-between gap-4">
        <h1 className="text-[15px] font-medium">lx/ui · {theme}</h1>
        <UnitsSwitch />
      </div>

      <Tabs ariaLabel="Pages" idPrefix={`gallery-${theme}`} value={page} onChange={setPage}
            tabs={PAGES.map((p) => ({ key: p.key, label: p.label, badge: p.key === 'overview' ? <Badge status={verdict} size="sm">{''}</Badge> : undefined }))}
            subtitle={PAGES.find((p) => p.key === page)?.q} />

      <div {...tabPanelProps(`gallery-${theme}`, page)} className="space-y-6 outline-none">
      {/* The verdict strip: a status line and the figures that matter. */}
      <Panel ariaLabel="Verdict">
        <div className="mb-4 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <Badge status={verdict} size="lg">{verdict === 'ok' ? `Within all ${graded.length} limits` : 'Within limits, 1 to check'}</Badge>
        </div>
        <div className="grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-4">
          <Figure label="Mean thrust" q={u.f(6804)} size="lg" termKey="thrust" sub={`${u.fmt(u.f(6512))}–${u.fmt(u.f(6981))}`} />
          <Figure label="Burn time" q={u.time(3.55)} size="lg" termKey="burnTime" delta={deltaText(delta(3.55, 3.44, 2), { digits: 2, unit: 's' })} sub="LOX ran out first" />
          <Figure label="Total impulse" q={u.impulse(24137)} size="lg" termKey="totalImpulse" delta={deltaText(delta(24137, 24857, 2), { digits: 2, mode: 'pct' })} />
          <Figure label="Bottle at burnout" q={u.p(1209, 'gauge')} size="lg" termKey="bottleFill" sub={`${u.fmt(u.gap(631))} over lockup`} />
        </div>
      </Panel>

      <Panel title="Limits" right={<span>worst first</span>}>
        <div className="-mx-2 space-y-0.5">
          {graded.map((g) => (
            <MarginBar key={g.key} label={g.label} value={g.text} status={g.scale.status} scale={g.scale} worstText={g.worst}
                       limitText={g.limit} termKey={g.term} hint={g.hint} onJump={() => setJumped(g.key)} />
          ))}
        </div>
        <div className="mt-3 text-[11px] text-[var(--lx-text-3)]" aria-live="polite">{jumped ? `Jumped to ${jumped}` : ''}</div>
      </Panel>

      <Panel title="Margin bar states">
        <div className="-mx-2 space-y-0.5">
          <MarginBar label="Chug margin" value="1.12" status="warn" scale={marginScale({ limit: 1, warn: 1.2, direction: 'higher-is-safer' }, 1.12)}
                     worstText="worst at T+0.04 s" limitText="> 1" termKey="chugMargin" />
          <MarginBar label="Fuel ΔP/Pc" value={u.fmt(u.pct(0.182))} status="bad" scale={marginScale({ limit: 20, direction: 'higher-is-safer', far: { warn: 40 } }, 18.2)}
                     worstText="min at T+3.50 s" limitText="20–40 %" termKey="stiffness" />
          <MarginBar label="Fuel tank peak" value={u.fmt(u.p(1180 + 14.5, 'gauge'))} status="bad"
                     scale={marginScale({ limit: 1000, warn: 800, direction: 'lower-is-safer', span: [0, 1100] }, 1180)} worstText="at T−1.20 s" limitText="≤ 1,000 psi MAWP" />
          <MarginBar label="Chug margin" value="—" status="warn" scale={marginScale({ limit: 1, warn: 1.2, direction: 'higher-is-safer' }, null)} limitText="> 1" />
        </div>
      </Panel>

      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        <Panel title="Before firing">
          <Fields />
        </Panel>
        <Panel title="Simulate">
          <div className="flex flex-col items-start gap-1">
            <Toggles />
          </div>
        </Panel>
      </div>

      <Panel title="Controls">
        <div className="space-y-4">
          <Row label="Buttons">
            <Button variant="primary" icon={<PlayIcon />}>Run</Button>
            <Button>Compare</Button>
            <Button variant="danger">Delete run</Button>
            <Button variant="bare" iconOnly aria-label="Collapse the rail"><RailIcon /></Button>
            <Button variant="primary" disabled>Run</Button>
            <Button size="sm">Export</Button>
          </Row>
          <Row label="Menus">
            <RunMenu />
            <Menu label="Export" align="end" variant="ghost">
              <MenuItem onClick={() => {}} note="Every series at 10 ms">CSV</MenuItem>
              <MenuItem onClick={() => {}} note="Thrust curve for OpenRocket">.eng</MenuItem>
              <MenuItem onClick={() => {}} disabled note="Needs a DAQ export">Test card vs DAQ</MenuItem>
            </Menu>
          </Row>
          <Row label="Segmented">
            <Segmented ariaLabel="Test mode" value="hot" onChange={() => {}}
                       options={[{ value: 'hot', label: 'Hot fire' }, { value: 'lox', label: 'LOX / LN2 cold flow' }, { value: 'water', label: 'Water + N2' }]} />
          </Row>
          <Row label="Deltas">
            <DeltaChip text={deltaText(delta(3.55, 3.44, 2), { digits: 2, unit: 's' })} />
            <DeltaChip text={deltaText(delta(6604, 6804, 0), { digits: 0, mode: 'pct' })} />
            <DeltaChip text={deltaText(delta(232.41, 232.4, 1), { digits: 1 })} />
          </Row>
          <Row label="Badges">
            <Badge status="ok" />
            <Badge status="warn" />
            <Badge status="bad" />
          </Row>
          <Row label="Keys">
            <span className="inline-flex items-center gap-1.5 text-[12px] text-[var(--lx-text-2)]"><Kbd>Space</Kbd> play</span>
            <span className="inline-flex items-center gap-1.5 text-[12px] text-[var(--lx-text-2)]"><Kbd>←</Kbd><Kbd>→</Kbd> step</span>
            <span className="inline-flex items-center gap-1.5 text-[12px] text-[var(--lx-text-2)]"><Kbd>[</Kbd><Kbd>]</Kbd> events</span>
            <span className="inline-flex items-center gap-1.5 text-[12px] text-[var(--lx-text-2)]"><Kbd>?</Kbd> shortcuts</span>
          </Row>
        </div>
      </Panel>

      <Panel title="Terms and numbers">
        <div className="space-y-3 text-[13px] text-[var(--lx-text-2)]">
          <p className="flex flex-wrap gap-x-4 gap-y-2">
            <Term k="stiffness" /> <Term k="chugMargin" /> <Term k="lockup" /> <Term k="cstar" /> <Term k="separation" />
            <Term k="waterHammer" /> <Term k="saturationMargin" />
          </p>
          <p className="flex flex-wrap gap-x-5 gap-y-1">
            <Num q={u.p(578.4)} /> <Num q={u.p(578.4, 'gauge')} /> <Num q={u.f(6804.4)} /> <Num q={u.impulse(24137)} /> <Num q={u.m(6.5)} />
            <Num q={u.len(0.03412)} /> <Num q={u.alt(2950.5)} /> <Num q={u.temp(90.18)} /> <Num q={u.isp(234.44)} /> <Num q={u.of(1.4321)} />
          </p>
          <div className="flex flex-wrap gap-3">
            {(['--lx-lox', '--lx-fuel', '--lx-gas', '--lx-hot', '--lx-ok', '--lx-warn', '--lx-bad', '--lx-accent', '--lx-ghost'] as const).map((v) => (
              <span key={v} className="inline-flex items-center gap-1.5 text-[11px] text-[var(--lx-text-3)]">
                <span aria-hidden className="inline-block h-0.5 w-5 rounded-full" style={{ background: `var(${v})` }} />
                {v.replace('--lx-', '')}
              </span>
            ))}
          </div>
        </div>
      </Panel>

      <Panel title="Throat recession" right={<span>not in this run</span>}>
        <NotComputed />
      </Panel>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[6rem_1fr] items-center gap-3">
      <span className="text-[12px] text-[var(--lx-text-3)]">{label}</span>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

function UnitsSwitch() {
  const u = useUnits();
  return (
    <Segmented<UnitSystem['pressure']> ariaLabel="Pressure unit" size="sm" value={u.system.pressure} onChange={(pressure) => u.setSystem({ pressure })}
               options={[{ value: 'psi', label: 'psi' }, { value: 'bar', label: 'bar' }]} />
  );
}

function Fields() {
  const u = useUnits();
  const [tank, setTank] = useState<number | null>(578);
  const [fill, setFill] = useState<number | null>(4514.7);
  const [cd, setCd] = useState<number | null>(0.72);
  const [lead, setLead] = useState<number | null>(0.25);
  return (
    <div className="space-y-2">
      <Field label="Tank pressure" termKey="tankPressure" value={tank} defaultValue={578} onCommit={setTank}
             scale={u.scale('pressure', { pressure: 'gauge' })} min={14.5} max={1014.5} />
      <Field label="Bottle fill" termKey="bottleFill" value={fill} defaultValue={4364.7} onCommit={setFill}
             scale={u.scale('pressure', { pressure: 'gauge' })} />
      <Field label="LOX orifice Cd" termKey="cd" value={cd} onCommit={setCd} digits={3} min={0.3} max={1}
             measured={{ pm: '±0.02', title: 'Water flow, 2026-09-14, 6 points' }} />
      <Field label="Fuel lead" termKey="fuelLead" value={lead} onCommit={setLead} unit="s" digits={2} min={0}
             validate={(v) => (v !== null && v > 1 ? 'Longer than the igniter burns' : null)} />
      <Field label="Ambient" value={14.5} unit="psia" digits={1} onCommit={() => {}} readOnly />
      <Field label="Dome setting" termKey="domeSetting" value={null} unit="psig" onCommit={() => {}} error="Not on the drawing" />
    </div>
  );
}

function Toggles() {
  const [walls, setWalls] = useState(true);
  const [vapour, setVapour] = useState(true);
  const [collapse, setCollapse] = useState(false);
  return (
    <>
      <Toggle label="Line-wall heat" checked={walls} onChange={setWalls} />
      <Toggle label="Propellant vapour" checked={vapour} onChange={setVapour} />
      <Toggle label="Ullage collapse" checked={collapse} onChange={setCollapse} />
      <Toggle label="Fly it" checked={false} onChange={() => {}} disabled />
    </>
  );
}

function RunMenu() {
  const [run, setRun] = useState('a');
  const runs = [
    { id: 'a', name: 'LE4 hot fire 3', note: '6.8 kN stand · 578 psia · GN2', fig: '24.14 kN·s' },
    { id: 'b', name: 'Oct 2, 01:45 PM', note: '6.8 kN stand · 600 psia · GN2 · what-if', fig: '24.86 kN·s' },
    { id: 'c', name: 'Oct 1, 11:02 AM', note: '6.8 kN stand · 578 psia · GN2 · flown', fig: '9,680 ft' },
  ];
  const cur = runs.find((r) => r.id === run)!;
  return (
    <Menu label={<span className="max-w-[12rem] truncate">{cur.name}</span>}>
      <MenuLabel>Pinned</MenuLabel>
      <MenuItem onClick={() => setRun('a')} checked={run === 'a'} note={runs[0].note} right={runs[0].fig}>{runs[0].name}</MenuItem>
      <MenuSeparator />
      <MenuLabel>Recent</MenuLabel>
      {runs.slice(1).map((r) => (
        <MenuItem key={r.id} onClick={() => setRun(r.id)} checked={run === r.id} note={r.note} right={r.fig}>{r.name}</MenuItem>
      ))}
    </Menu>
  );
}

function PlayIcon() {
  return <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden><path d="M2 1.2v7.6L8.6 5z" fill="currentColor" /></svg>;
}

function RailIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden>
      <rect x="1.5" y="2" width="11" height="10" rx="1.5" /><path d="M5 2v10" />
    </svg>
  );
}
