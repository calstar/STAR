/**
 * Config editor: drag-to-reorder, board names, the actuator role's board picker, a LabJack T7's
 * channel table living on the Roles tab, and the gauge colour palette.
 */
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { moveItem, reorderGridCols } from '@/lib/drag-reorder';
import { gaugeColorName, GAUGE_COLOR_FAMILIES } from '@/lib/gauge-colors';
import { boardDisplayName, validateConfigForRun } from '@/lib/config-validation';

vi.mock('@/lib/websocket', () => {
  const client = { on: () => () => {}, send: () => {}, onConnectionStatus: () => () => {} };
  return { getWebSocketClient: () => client, getApiBaseUrl: () => 'http://localhost:8081' };
});
vi.mock('@/lib/control-mode', () => ({
  useControlMode: () => ({ isOperator: true, controlEnabled: true }),
}));

const T7 = {
  type: 'T7', ip: '192.168.2.82', board_id: 82, enabled: true, name: 'Thrust LabJack',
  channels: [{ ain: 1, kind: 'PT', role: 'LOX Tank', signal: '0-5V', full_scale: 1000 }],
};

const CONFIG = {
  boards: {
    act_board: { type: 'ACTUATOR', board_id: 12, enabled: true, ip: '192.168.2.12', name: 'Engine Bay' },
    act_board_2: { type: 'ACTUATOR', board_id: 13, enabled: true, ip: '192.168.2.13' },
    act_off: { type: 'ACTUATOR', board_id: 14, enabled: false, ip: '192.168.2.14', name: 'Spare' },
    labjack_1: T7,
  },
  actuator_roles: {
    'LOX Main': ['NC', 1, 12],
    'Spare Valve': ['NC', 2, 14],
  },
  gui: { pressure_bars: [{ label: 'LOX', role: '', limits: '', color: '#2563eb' }] },
};

describe('moveItem', () => {
  it('moves an item and shifts the rest', () => {
    expect(moveItem(['a', 'b', 'c', 'd'], 0, 2)).toEqual(['b', 'c', 'a', 'd']);
    expect(moveItem(['a', 'b', 'c', 'd'], 3, 1)).toEqual(['a', 'd', 'b', 'c']);
  });
  it('leaves the list alone for a no-op or an out-of-range index', () => {
    const arr = ['a', 'b'];
    expect(moveItem(arr, 1, 1)).toBe(arr);
    expect(moveItem(arr, 0, 5)).toBe(arr);
  });
});

describe('reorderGridCols', () => {
  const grid = {
    states: ['Idle', 'Armed', 'Fire'],
    rows: [
      { key: 'Idle', cells: ['1', '1', '0'] },
      { key: 'Armed', cells: ['1', '1', '1'] },
      { key: 'Fire', cells: ['0', '1', '1'] },
    ],
  };
  it('moves each column, cells with it, to follow a dragged state order', () => {
    const out = reorderGridCols(grid, ['Fire', 'Idle', 'Armed'], false)!;
    expect(out.states).toEqual(['Fire', 'Idle', 'Armed']);
    expect(out.rows.map((r) => r.key)).toEqual(['Idle', 'Armed', 'Fire']);
    expect(out.rows[0].cells).toEqual(['0', '1', '1']);   // Idle row: Fire, Idle, Armed
  });
  it('moves the transitions matrix\'s from-rows too', () => {
    const out = reorderGridCols(grid, ['Fire', 'Idle', 'Armed'], true)!;
    expect(out.rows.map((r) => r.key)).toEqual(['Fire', 'Idle', 'Armed']);
    expect(out.rows[0].cells).toEqual(['1', '0', '1']);   // Fire row: Fire, Idle, Armed
  });
  it('leaves a column the state list does not name where it is', () => {
    const g = { states: ['Idle', 'Extra', 'Fire'], rows: [{ key: 'X', cells: ['a', 'b', 'c'] }] };
    expect(reorderGridCols(g, ['Fire', 'Idle'], false)!.states).toEqual(['Fire', 'Extra', 'Idle']);
  });
});

describe('gauge colours', () => {
  it('has several shades per family and names them', () => {
    for (const f of GAUGE_COLOR_FAMILIES) expect(f.shades.length).toBeGreaterThanOrEqual(4);
    expect(gaugeColorName('#DC2626')).toBe('Red · deep');
    expect(gaugeColorName('#123456')).toBeNull();
  });
});

describe('board names', () => {
  it('a given name replaces the type-and-number name; no name keeps it', () => {
    expect(boardDisplayName(CONFIG.boards, 'act_board')).toBe('Engine Bay');
    expect(boardDisplayName(CONFIG.boards, 'act_board_2')).toBe('Actuator Board #2');
    expect(boardDisplayName({ a: { type: 'BALL_VALVE', board_id: 71, name: '   ' } }, 'a')).toBe('Ball Valve Board');
  });

  it('two boards sharing a name is a warning on the Boards tab', () => {
    const cfg = { boards: { a: { type: 'PT', board_id: 1, name: 'Ox' }, b: { type: 'PT', board_id: 2, name: 'ox ' } } };
    const dup = validateConfigForRun(cfg).filter((i) => /both named/.test(i.message));
    expect(dup).toHaveLength(1);
    expect(dup[0]).toMatchObject({ page: 'boards', level: 'warn' });
  });

  it('a T7 channel problem points at Roles; a T7 board-setting problem at Boards', () => {
    const cfg = {
      boards: {
        labjack_1: { ...T7, scan_rate_hz: -1, channels: [{ ain: 1, kind: 'PT', role: '', signal: '0-5V', full_scale: 1000 }] },
      },
    };
    const issues = validateConfigForRun(cfg);
    expect(issues.find((i) => /needs a role/.test(i.message))?.page).toBe('roles');
    expect(issues.find((i) => /scan_rate_hz must be positive/.test(i.message))?.page).toBe('boards');
  });
});

describe('config page', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve({
      ok: true,
      json: () => Promise.resolve(String(url).endsWith('/api/config') ? { config: CONFIG, active: 'default' } : {}),
      text: () => Promise.resolve(''),
    })));
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it('Actuator Roles has one panel per board, headed by its name, and no board picker', async () => {
    const { default: ConfigPage } = await import('@/app/config/page');
    render(<MemoryRouter initialEntries={['/config?tab=roles']}><ConfigPage /></MemoryRouter>);

    const bay = await screen.findByTestId('actuator-panel:act_board');
    expect(bay).toHaveTextContent('Engine Bay');
    expect(within(bay).getByDisplayValue('LOX Main')).toBeInTheDocument();
    expect(within(screen.getByTestId('actuator-panel:act_board_2'))).toBeTruthy();
    expect(screen.getByTestId('actuator-panel:act_board_2')).toHaveTextContent('No roles on this board.');
    // A board that is not enabled still has its panel, marked so.
    const spare = screen.getByTestId('actuator-panel:act_off');
    expect(spare).toHaveTextContent('not enabled');
    expect(within(spare).getByDisplayValue('Spare Valve')).toBeInTheDocument();
    expect(screen.queryByTestId(/^actuator-board:/)).toBeNull();
  });

  it('dragging an actuator role onto another actuator board moves it there', async () => {
    const { default: ConfigPage } = await import('@/app/config/page');
    render(<MemoryRouter initialEntries={['/config?tab=roles']}><ConfigPage /></MemoryRouter>);

    const data = { setData: () => {}, setDragImage: () => {}, effectAllowed: '', dropEffect: '' };
    fireEvent.dragStart(await screen.findByTestId('actuator-handle:LOX Main'), { dataTransfer: data });
    const target = screen.getByTestId('actuator-panel:act_board_2');
    fireEvent.dragOver(target, { dataTransfer: data });
    expect(target.className).toMatch(/bg-blue-500/);
    fireEvent.drop(target, { dataTransfer: data });

    expect(within(screen.getByTestId('actuator-panel:act_board_2')).getByDisplayValue('LOX Main')).toBeInTheDocument();
    expect(screen.getByTestId('actuator-panel:act_board')).toHaveTextContent('No roles on this board.');
  });

  it('a T7 channel table is on the Roles tab, under the board\'s name', async () => {
    const { default: ConfigPage } = await import('@/app/config/page');
    render(<MemoryRouter initialEntries={['/config?tab=roles']}><ConfigPage /></MemoryRouter>);

    const panel = await screen.findByTestId('t7-roles:labjack_1');
    expect(panel).toHaveTextContent('Thrust LabJack — channels');
    expect(within(panel).getByDisplayValue('LOX Tank')).toBeInTheDocument();
  });

  it('the Boards tab T7 card has no channel table, and every card takes a name', async () => {
    const { default: ConfigPage } = await import('@/app/config/page');
    render(<MemoryRouter initialEntries={['/config?tab=boards']}><ConfigPage /></MemoryRouter>);

    const header = await screen.findByText('Thrust LabJack');
    fireEvent.click(header);
    expect(await screen.findByText(/named and set up on the/)).toBeInTheDocument();
    expect(screen.queryByDisplayValue('LOX Tank')).toBeNull();
    expect(screen.getByDisplayValue('Thrust LabJack')).toBeInTheDocument();
  });

  it('a board\'s IP follows its Board ID, and a file that disagrees gets a one-click fix', async () => {
    const { default: ConfigPage } = await import('@/app/config/page');
    render(<MemoryRouter initialEntries={['/config?tab=boards']}><ConfigPage /></MemoryRouter>);

    fireEvent.click(await screen.findByText('Engine Bay'));
    expect(await screen.findByTestId('board-ip:act_board')).toHaveTextContent('192.168.2.12');
    expect(screen.queryByText('Send Port')).toBeNull();
    expect(screen.queryByText('Listen Port')).toBeNull();

    const id = screen.getByDisplayValue('12');
    fireEvent.change(id, { target: { value: '15' } });
    fireEvent.blur(id);
    expect(await screen.findByTestId('board-ip:act_board')).toHaveTextContent('192.168.2.15');
    // The saved ip moved too: had it not, the file would now disagree and offer the fix.
    expect(screen.queryByRole('button', { name: 'Use 192.168.2.15' })).toBeNull();
  });

  it('a hand-edited IP that disagrees with the Board ID is flagged with a fix', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve({
      ok: true,
      json: () => Promise.resolve(String(url).endsWith('/api/config')
        ? { config: { ...CONFIG, boards: { act_board: { ...CONFIG.boards.act_board, ip: '10.0.0.5' } } }, active: 'default' }
        : {}),
      text: () => Promise.resolve(''),
    })));
    const { default: ConfigPage } = await import('@/app/config/page');
    render(<MemoryRouter initialEntries={['/config?tab=boards']}><ConfigPage /></MemoryRouter>);

    fireEvent.click(await screen.findByText('Engine Bay'));
    fireEvent.click(await screen.findByRole('button', { name: 'Use 192.168.2.12' }));
    expect(screen.queryByRole('button', { name: 'Use 192.168.2.12' })).toBeNull();
  });

  it('the Controller tab shows only what the controller reads, and there is no System tab', async () => {
    const { default: ConfigPage } = await import('@/app/config/page');
    render(<MemoryRouter initialEntries={['/config?tab=controller']}><ConfigPage /></MemoryRouter>);
    expect(await screen.findByText('PWM Frequency (Hz)')).toBeInTheDocument();
    for (const gone of ['Thrust Desired', 'Altitude Goal', 'Command Type', 'Fuel Pressure Target', 'Use C++ Controller'])
      expect(screen.queryByText(gone)).toBeNull();
    expect(screen.queryByRole('button', { name: 'System' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Controller' })).toBeInTheDocument();
  });

  it('a link to the profile issue (or any unknown tab) opens on Boards', async () => {
    const { default: ConfigPage } = await import('@/app/config/page');
    render(<MemoryRouter initialEntries={['/config?tab=profile']}><ConfigPage /></MemoryRouter>);
    expect(await screen.findByText('Engine Bay')).toBeInTheDocument();
  });

  it('the gauge colour is picked from the palette', async () => {
    const { default: ConfigPage } = await import('@/app/config/page');
    render(<MemoryRouter initialEntries={['/config?tab=gui']}><ConfigPage /></MemoryRouter>);

    const button = await screen.findByRole('button', { name: /Blue · deep/ });
    fireEvent.click(button);
    fireEvent.click(screen.getByRole('button', { name: 'Red · dark' }));
    expect(await screen.findByRole('button', { name: /Red · dark/ })).toBeInTheDocument();
    expect(document.querySelector('input[type="color"]')).toBeNull();
  });

  it('drag handles replace the up/down buttons', async () => {
    const { default: ConfigPage } = await import('@/app/config/page');
    render(<MemoryRouter initialEntries={['/config?tab=gui']}><ConfigPage /></MemoryRouter>);

    await screen.findByRole('button', { name: /Blue · deep/ });
    expect(screen.queryByTitle('Move up')).toBeNull();
    expect(screen.getAllByRole('button', { name: /Drag to reorder/ }).length).toBeGreaterThan(0);
  });
});
