/**
 * Main-page layout set on the Config page: [gui] actuator_order (tile order) and the state grid
 * ([[states]] panel_row/panel_col, [gui] state_grid_rows/cols). See lib/panel-layout.ts.
 */
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { firstFreeCell, moveItem, orderByNames, stateGridSize } from '@/lib/panel-layout';

vi.mock('@/lib/websocket', () => {
  const client = { on: () => () => {}, send: () => {}, sendCommand: vi.fn(), onConnectionStatus: () => () => {}, isConnected: () => false };
  return { getWebSocketClient: () => client, getApiBaseUrl: () => 'http://localhost:8081' };
});
vi.mock('@/lib/control-mode', () => ({
  useControlMode: () => ({ isOperator: true, controlEnabled: true }),
}));

describe('panel-layout helpers', () => {
  it('orders by the listed names, then the rest in file order, skipping names that are gone', () => {
    expect(orderByNames(['A', 'B', 'C', 'D'], ['C', 'gone', 'A'])).toEqual(['C', 'A', 'B', 'D']);
    expect(orderByNames(['A', 'B'], undefined)).toEqual(['A', 'B']);
    expect(orderByNames(['A', 'B'], ['B', 'B'])).toEqual(['B', 'A']);
  });

  it('moves an item to the slot it is dropped on', () => {
    expect(moveItem(['A', 'B', 'C', 'D'], 0, 2)).toEqual(['B', 'C', 'A', 'D']);
    expect(moveItem(['A', 'B', 'C', 'D'], 3, 0)).toEqual(['D', 'A', 'B', 'C']);
  });

  it('sizes the grid to the placed states, or larger when [gui] asks', () => {
    const states = [{ panel_row: 0, panel_col: 0 }, { panel_row: 2, panel_col: 1 }, {}];
    expect(stateGridSize(states, undefined)).toEqual({ rows: 3, cols: 2 });
    expect(stateGridSize(states, { state_grid_rows: 5, state_grid_cols: 4 })).toEqual({ rows: 5, cols: 4 });
    // Never smaller than what is placed.
    expect(stateGridSize(states, { state_grid_rows: 1, state_grid_cols: 1 })).toEqual({ rows: 3, cols: 2 });
  });

  it('finds the first empty cell row by row', () => {
    const states = [{ panel_row: 0, panel_col: 0 }, { panel_row: 0, panel_col: 1 }];
    expect(firstFreeCell(states, { rows: 2, cols: 2 })).toEqual({ row: 1, col: 0 });
    expect(firstFreeCell(states, { rows: 1, cols: 2 })).toBeUndefined();
  });
});

const CONFIG = {
  boards: { act_board: { type: 'ACTUATOR', board_id: 12, enabled: true, ip: '192.0.2.12' } },
  actuator_roles: {
    'Fuel Main': ['NC', 1, 12],
    'LOX Main': ['NC', 2, 12],
    'Fuel Vent': ['NO', 3, 12],
  },
  gui: { state_grid_rows: 2, state_grid_cols: 3 },
  states: [
    { id: 1, name: 'Idle', panel_row: 0, panel_col: 0, is_boot: true },
    { id: 2, name: 'Armed', panel_row: 0, panel_col: 1 },
    { id: 3, name: 'Fire', panel_row: 1, panel_col: 0 },
  ],
};

let posted: any[] = [];
function stubFetch(config: unknown) {
  posted = [];
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    const u = String(url);
    if (init?.method === 'POST' && u.endsWith('/api/config')) posted.push(JSON.parse(String(init.body)).config);
    // The state tables are not under test: unloaded, they are neither checked nor saved.
    if (u.includes('/api/state-csv')) return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}), text: () => Promise.resolve('') });
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve(
        u.endsWith('/api/config') ? { config, active: 'default' }
          : u.endsWith('/api/config/running') ? { config }
            : {},
      ),
      text: () => Promise.resolve(''),
    });
  }));
}

/**
 * A model of the browser's hit-testing during an HTML5 drag, enough to catch a feedback loop.
 *
 * jsdom has no layout, so `fireEvent.dragOver(el)` on a hand-picked element says nothing about
 * which element a real cursor is over. The editors place every child of their grid by inline
 * grid-row / grid-column, so this reads those to find the topmost child covering a grid cell,
 * skipping `pointer-events: none` the way the browser does.
 *
 * And it hit-tests where a tile is DRAWN, not where it now lays out: the editors slide a moved tile
 * from its old place (FLIP), so for a frame or more after a re-render it still sits visually
 * where it was. A drop target chosen from that visual position is what made a held tile swap
 * back and forth ~20 times before settling.
 */
type Span = [number, number];  // [start, end) grid lines
type Area = { r: Span; c: Span };
type Cell = { row: number; col: number };  // 1-based grid lines, as in the style

function spanOf(v: string): Span {
  const [a, b] = v.split('/').map((x) => x.trim());
  const start = parseInt(a, 10);
  if (!b) return [start, start + 1];
  if (b.startsWith('span')) return [start, start + parseInt(b.slice(4), 10)];
  const end = parseInt(b, 10);
  return [start, end < 0 ? Infinity : end];
}
const areaOf = (el: HTMLElement): Area | null =>
  el.style.gridRow && el.style.gridColumn ? { r: spanOf(el.style.gridRow), c: spanOf(el.style.gridColumn) } : null;
const covers = (a: Area, { row, col }: Cell) => a.r[0] <= row && row < a.r[1] && a.c[0] <= col && col < a.c[1];

function layout(grid: HTMLElement): Map<Element, Area | null> {
  return new Map(Array.from(grid.children).map((el) => [el, areaOf(el as HTMLElement)]));
}
/** The element a cursor over `cell` is on, with tiles where `drawn` has them. */
function hitTest(grid: HTMLElement, cell: Cell, drawn?: Map<Element, Area | null>): Element {
  for (const el of Array.from(grid.children).reverse()) {  // later children paint on top
    if ((el as HTMLElement).style.pointerEvents === 'none') continue;
    const a = drawn?.get(el) ?? areaOf(el as HTMLElement);
    if (a && covers(a, cell)) return el;
  }
  return grid;
}

const dataTransfer = () => ({ setData: () => {}, getData: () => '', effectAllowed: '', dropEffect: '' });

/**
 * Hold the cursor still over `cell` for `frames` dragover events (the browser sends one every
 * ~50 ms while you hold), each hit-tested one frame behind the layout, as during a slide.
 * Returns `snap()` after every frame.
 */
function hold<T>(grid: HTMLElement, cell: Cell, dt: unknown, frames: number, snap: () => T): T[] {
  let drawn = layout(grid);
  const seen: T[] = [];
  for (let i = 0; i < frames; i++) {
    const target = hitTest(grid, cell, drawn);
    const before = layout(grid);
    fireEvent.dragOver(target, { dataTransfer: dt });
    drawn = before;  // what this frame laid out is what the next frame still draws
    seen.push(snap());
  }
  return seen;
}

async function pickUp(el: Element) {
  const dt = dataTransfer();
  fireEvent.dragStart(el, { dataTransfer: dt });
  await act(() => new Promise((r) => setTimeout(r, 0)));  // the held state is set a tick later
  return dt;
}

/** Drag `from` to the grid cell `cell`, hold there a moment, and let go. */
async function drag(from: Element, grid: HTMLElement, cell: Cell) {
  const dt = await pickUp(from);
  hold(grid, cell, dt, 3, () => null);
  fireEvent.drop(hitTest(grid, cell), { dataTransfer: dt });
  fireEvent.dragEnd(from, { dataTransfer: dt });
}

async function openConfig(tab: string) {
  const { default: ConfigPage } = await import('@/app/config/page');
  render(<MemoryRouter initialEntries={[`/config?tab=${tab}`]}><ConfigPage /></MemoryRouter>);
}

async function save() {
  fireEvent.click(await screen.findByRole('button', { name: /Save Config/ }));
  await waitFor(() => expect(posted.length).toBe(1));
  return posted[0];
}

const tileNames = () =>
  within(screen.getByTestId('actuator-layout-grid'))
    .getAllByTestId(/^actuator-layout-tile:/)
    // Tiles keep their DOM order mid-drag and move by grid position, so read the drawn order.
    .sort((a, b) => Number(a.getAttribute('data-pos')) - Number(b.getAttribute('data-pos')))
    .map((el) => el.getAttribute('data-testid')!.replace('actuator-layout-tile:', ''));

describe('Roles tab — main page actuator order', () => {
  beforeEach(() => stubFetch(CONFIG));
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it('drag reorders the tiles and Save writes [gui] actuator_order', async () => {
    await openConfig('roles');
    await screen.findByTestId('actuator-layout-tile:Fuel Vent');
    expect(tileNames()).toEqual(['Fuel Main', 'LOX Main', 'Fuel Vent']);

    await drag(screen.getByTestId('actuator-layout-tile:Fuel Vent'), screen.getByTestId('actuator-layout-grid'), { row: 1, col: 1 });
    expect(tileNames()).toEqual(['Fuel Vent', 'Fuel Main', 'LOX Main']);

    const cfg = await save();
    expect(cfg.gui.actuator_order).toEqual(['Fuel Vent', 'Fuel Main', 'LOX Main']);
  });

  it('mid-drag the others make room; letting go off the grid changes nothing', async () => {
    await openConfig('roles');
    const vent = await screen.findByTestId('actuator-layout-tile:Fuel Vent');
    const grid = screen.getByTestId('actuator-layout-grid');
    const dt = await pickUp(vent);
    hold(grid, { row: 1, col: 1 }, dt, 1, () => null);
    expect(tileNames()).toEqual(['Fuel Vent', 'Fuel Main', 'LOX Main']);   // the preview, not yet saved

    fireEvent.dragEnd(vent, { dataTransfer: dt });                            // no drop: released elsewhere
    expect(tileNames()).toEqual(['Fuel Main', 'LOX Main', 'Fuel Vent']);
    const cfg = await save();
    expect(cfg.gui?.actuator_order).toBeUndefined();
  });

  // The bug: held still over a place, the preview flipped back and forth ~20 times before it
  // settled, because the drop target was whichever tile was drawn under the cursor mid-slide.
  it.each([
    [{ row: 1, col: 1 }, ['Fuel Vent', 'Fuel Main', 'LOX Main']],
    [{ row: 1, col: 2 }, ['Fuel Main', 'Fuel Vent', 'LOX Main']],
  ])('held still over %o, the preview changes once and stays', async (cell, want) => {
    await openConfig('roles');
    const vent = await screen.findByTestId('actuator-layout-tile:Fuel Vent');
    const dt = await pickUp(vent);
    const frames = hold(screen.getByTestId('actuator-layout-grid'), cell, dt, 20, tileNames);
    expect(frames).toEqual(Array(20).fill(want));
    fireEvent.dragEnd(vent, { dataTransfer: dt });
  });

  it('a preview tile never sends a command', async () => {
    const ws = (await import('@/lib/websocket')).getWebSocketClient() as any;
    // Debug mode + control enabled: the state in which the main page's tile WOULD send.
    const { useSensorStore } = await import('@/lib/store');
    useSensorStore.setState({ debugMode: true });
    await openConfig('roles');
    const tile = await screen.findByTestId('actuator-layout-tile:LOX Main');
    fireEvent.click(within(tile).getByRole('button'));
    expect(ws.sendCommand).not.toHaveBeenCalled();
    useSensorStore.setState({ debugMode: false });
  });
});

describe('main page — tiles follow [gui] actuator_order', () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it('useActuatorsFromConfig returns the ordered roles, the unlisted ones after', async () => {
    stubFetch({ ...CONFIG, gui: { actuator_order: ['Fuel Vent', 'Fuel Main'] } });
    const { useActuatorsFromConfig } = await import('@/lib/dashboard-hooks');
    const { result } = renderHook(() => useActuatorsFromConfig());
    await waitFor(() => expect(result.current.map((a) => a.name)).toEqual(['Fuel Vent', 'Fuel Main', 'LOX Main']));
    expect(result.current[0]).toMatchObject({ channel: 3, boardId: 12, entity: 'ACT.Fuel_Vent' });
  });

  it('with no actuator_order the tiles stay in file order', async () => {
    stubFetch(CONFIG);
    const { useActuatorsFromConfig } = await import('@/lib/dashboard-hooks');
    const { result } = renderHook(() => useActuatorsFromConfig());
    await waitFor(() => expect(result.current.map((a) => a.name)).toEqual(['Fuel Main', 'LOX Main', 'Fuel Vent']));
  });
});

describe('State Machine tab — state grid', () => {
  beforeEach(() => stubFetch(CONFIG));
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  const statesOf = (cfg: any) => Object.fromEntries(cfg.states.map((s: any) => [s.name, [s.panel_row, s.panel_col]]));

  it('drag to an empty cell moves a state; onto another state swaps them', async () => {
    await openConfig('state');
    const fire = await screen.findByTestId('state-layout-tile:Fire');
    const grid = screen.getByTestId('state-layout-grid');
    await drag(fire, grid, { row: 2, col: 3 });                                          // cell 1:2, empty
    await drag(screen.getByTestId('state-layout-tile:Idle'), grid, { row: 1, col: 2 });  // onto Armed

    const cfg = await save();
    expect(statesOf(cfg)).toEqual({ Idle: [0, 1], Armed: [0, 0], Fire: [1, 2] });
  });

  it('held still over another state, the swap shows once and stays', async () => {
    await openConfig('state');
    const idle = await screen.findByTestId('state-layout-tile:Idle');
    const grid = screen.getByTestId('state-layout-grid');
    const where = () => ['Idle', 'Armed', 'Fire'].map((n) => {
      const el = screen.getByTestId(`state-layout-tile:${n}`) as HTMLElement;
      return `${n}@${el.style.gridRow},${el.style.gridColumn}`;
    }).join(' ');
    const dt = await pickUp(idle);
    const frames = hold(grid, { row: 1, col: 2 }, dt, 20, where);   // over Armed
    expect(frames).toEqual(Array(20).fill('Idle@1,2 Armed@1,1 Fire@2,1'));
    fireEvent.dragEnd(idle, { dataTransfer: dt });
  });

  it('the grid grows with the row/column buttons, and a new state takes the first empty cell', async () => {
    await openConfig('state');
    await screen.findByTestId('state-layout-grid');
    fireEvent.click(screen.getByRole('button', { name: 'More columns' }));
    expect(screen.getByTestId('state-grid-columns')).toHaveTextContent('4');
    fireEvent.click(screen.getByRole('button', { name: /Add state/ }));

    const cfg = await save();
    expect(cfg.gui).toMatchObject({ state_grid_rows: 2, state_grid_cols: 4 });
    expect(statesOf(cfg)['New State 4']).toEqual([0, 2]);
  });

  it('a full grid takes a new state on a new row, and the row count grows with it', async () => {
    stubFetch({ ...CONFIG, gui: { state_grid_rows: 1, state_grid_cols: 2 },
      states: CONFIG.states.slice(0, 2) });
    await openConfig('state');
    await screen.findByTestId('state-layout-grid');
    fireEvent.click(screen.getByRole('button', { name: /Add state/ }));

    const cfg = await save();
    expect(statesOf(cfg)['New State 3']).toEqual([1, 0]);
    expect(cfg.gui.state_grid_rows).toBe(2);
  });

  it('cannot shrink below the placed states', async () => {
    await openConfig('state');
    await screen.findByTestId('state-layout-grid');
    // 2 rows are needed (Fire is on row 1).
    expect(screen.getByRole('button', { name: 'Fewer rows' })).toBeDisabled();
  });
});
