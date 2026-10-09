/**
 * A dead board must not borrow a live sibling's stream.
 *
 * Two LC boards routinely declare the SAME connector number (41 and 42 both on CH1 on the
 * stand). That makes the generic key LC_Cal.CH1.<comp> ambiguous: it maps onto BOTH boards.
 * Panes are board-scoped to avoid it — but data-cache's findSeries() walks a REVERSE alias,
 * and the walk can leave the board it was asked about:
 *
 *   ask LC2_Cal.CH1.force_kg_tared   (LOX Scale, board dead — no data)
 *     → reverse index → canonical LC_Cal.CH1.force_kg_tared
 *       → that canonical's fallbacks are [LC1_Cal.CH1…, LC2_Cal.CH1…]
 *         → first one with data wins → LC1 (Fuel Scale, alive)
 *
 * The plot then draws Fuel Scale's live weight under LOX Scale's label and colour, while the
 * readout beside it — which resolves through the store, with no reverse path — correctly shows
 * nothing. Seen on the stand 2026-09-16 with board 42 dead.
 */
import { describe, it, expect, vi } from 'vitest';

const listeners = new Map<string, (payload: unknown) => void>();

vi.mock('@/lib/websocket', () => ({
  getWebSocketClient: () => ({
    on: (type: string, cb: (payload: unknown) => void) => {
      listeners.set(type, cb);
      return () => listeners.delete(type);
    },
    setHistoricalQueryProvider: () => {},
    onConnectionStatus: () => () => {},
    isConnected: () => true,
    connect: () => {},
    send: () => {},
  }),
  getApiBaseUrl: () => 'http://localhost:8081',
}));

const T0 = 1_700_000_000_000;

/** The shipped digital-twin shape: two LC boards, both on connector 1. */
const TWO_LC_BOARDS = {
  boards: {
    lc_board: { type: 'LC', board_id: 41, enabled: true, active_connectors: [1] },
    lc_board_2: { type: 'LC', board_id: 42, enabled: true, active_connectors: [1] },
  },
  sensor_roles_lc_board: { 'Fuel Scale': 1 },
  sensor_roles_lc_board_2: { 'LOX Scale': 1 },
};

async function freshModules() {
  vi.resetModules();
  listeners.clear();
  const plotTime = await import('@/lib/plot-time');
  plotTime.resetPlotTimeForTests();
  const store = await import('@/lib/store');
  const dataCache = await import('@/lib/data-cache');
  return { store, dataCache };
}

describe('LC board-scoped series never resolve to a sibling board', () => {
  it('leaves the dead board\'s column empty instead of filling it from the live board', async () => {
    const { store, dataCache } = await freshModules();
    store.buildAliasesFromConfig(TWO_LC_BOARDS);

    const cache = dataCache.getDataCache();
    // Only board 41 (Fuel Scale) is alive. Board 42 (LOX Scale) never reports.
    for (let i = 0; i < 10; i++) {
      cache.addDataPoint('LC1_Cal.CH1', 'force_kg_tared', 100 + i, T0 + i * 50);
    }

    const out = cache.getAlignedHistory(
      ['LC1_Cal.CH1', 'LC2_Cal.CH1'],
      ['force_kg_tared', 'force_kg_tared'],
      60,
    );
    expect(out).not.toBeNull();

    // Fuel Scale draws its own data.
    expect(out!.values[0].some((v) => Number.isFinite(v))).toBe(true);
    expect(out!.values[0][9]).toBe(109);

    // LOX Scale is dead: every sample must be NaN. A finite number here is Fuel Scale's
    // weight wearing LOX Scale's name — the failure this test exists for.
    expect(out!.values[1].every((v) => Number.isNaN(v))).toBe(true);
  });

  it('still resolves a generic LC_Cal key when only one LC board is enabled', async () => {
    const { store, dataCache } = await freshModules();
    store.buildAliasesFromConfig({
      boards: { lc_board: { type: 'LC', board_id: 41, enabled: true, active_connectors: [1] } },
      sensor_roles_lc_board: { 'Fuel Scale': 1 },
    });

    const cache = dataCache.getDataCache();
    for (let i = 0; i < 5; i++) {
      cache.addDataPoint('LC1_Cal.CH1', 'force_kg', 10 + i, T0 + i * 50);
    }

    // Unambiguous: one board claims CH1, so the generic name may still find it.
    const out = cache.getAlignedHistory(['LC_Cal.CH1'], ['force_kg'], 60);
    expect(out).not.toBeNull();
    expect(out!.values[0][4]).toBe(14);
  });
});
