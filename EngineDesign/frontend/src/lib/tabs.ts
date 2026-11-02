/**
 * The app's views, and which of them the tab strip shows.
 *
 * Controller, Demo and Custom Plotter are prototypes: Controller opens on defaults that have
 * nothing to do with the design (a 100 kg vehicle), Demo is a scripted walk through the optimizer
 * layers, and the plotter starts empty. They stay mounted -- each owns a
 * slice of the stored design (lib/designState.ts), and an unmounted panel would drop its slice
 * from the next autosave -- but the strip lists them only with `?advanced=1` in the URL.
 */

export type Tab =
  | 'forward'
  | 'timeseries'
  | 'plotter'
  | 'flight'
  | 'geometry'
  | 'optimizer'
  | 'layerx'
  | 'controller'
  | 'demo'
  | 'config';

export interface TabDef {
  id: Tab;
  label: string;
  /** Hover text: what the view is for, in a sentence. */
  hint: string;
  /** Listed only with ?advanced=1. */
  advanced?: boolean;
}

export const TABS: TabDef[] = [
  { id: 'forward', label: 'Forward Mode', hint: 'The engine at one pair of tank pressures: thrust, Isp, chamber pressure, stability and cooling' },
  { id: 'timeseries', label: 'Time-Series', hint: 'The engine through a burn, on a tank-pressure profile you set' },
  { id: 'flight', label: 'Flight', hint: 'The vehicle flown on the Time-Series burn' },
  { id: 'geometry', label: 'Chamber Geometry', hint: 'The chamber, nozzle and injector as drawn from the design' },
  { id: 'optimizer', label: 'Optimizer', hint: 'Size the injector and chamber to the design requirements' },
  { id: 'layerx', label: 'Layer X', hint: 'The engine burned on the stand drawing, with the feed system, flight and limits' },
  { id: 'config', label: 'Configuration', hint: 'Every parameter the design carries' },
  { id: 'plotter', label: 'Custom Plotter', hint: 'Plot any Time-Series output against another', advanced: true },
  { id: 'controller', label: 'Controller', hint: 'Prototype: the throttle controller', advanced: true },
  { id: 'demo', label: 'Demo', hint: 'Prototype: the optimizer layers run one after another', advanced: true },
];

/** `?advanced=1` (or `true`/`yes`) lists the prototype views. */
export function wantsAdvanced(search: string): boolean {
  const v = new URLSearchParams(search).get('advanced');
  return v !== null && ['1', 'true', 'yes'].includes(v.toLowerCase());
}

export function visibleTabs(advanced: boolean): TabDef[] {
  return TABS.filter((t) => advanced || !t.advanced);
}

/** The tab to show: a remembered prototype tab falls back to Forward Mode when it is not listed,
 *  so the page never opens on a view its strip does not show. */
export function resolveTab(tab: Tab, advanced: boolean): Tab {
  const def = TABS.find((t) => t.id === tab);
  if (!def) return 'forward';
  return def.advanced && !advanced ? 'forward' : tab;
}
