/**
 * C5-1: session start and stop re-read the board list (loadBoardsFromConfig). That used to
 * replace each board's status with the config baseline, dropping a heartbeating board's
 * lastHeartbeatMs, so the next stale sweep reported "connection lost" and its next heartbeat
 * "connected" a second later. The reload now merges: config fields update, liveness stays.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

let config: any = {
  boards: {
    pt_21: { type: 'PT', board_id: 21, enabled: true, ip: '127.0.0.21' },
  },
};
vi.mock('../routes/config.js', () => ({ readConfig: () => config, readDeployedConfig: () => config }));
const sent: any[] = [];
vi.mock('../server/ws-clients.js', () => ({ broadcast: (m: any) => { sent.push(m); }, wss: { clients: new Set() } }));

const bs = await import('../server/board-status.js');

/** A 16-byte [0x10, id] heartbeat row: board_type PT (1), engine_state 0, board_state ACTIVE (2). */
function heartbeat(): Buffer {
  const b = Buffer.alloc(16);
  b.writeUInt8(21, 8);
  b.writeUInt8(1, 9);
  b.writeUInt8(0, 10);
  b.writeUInt8(2, 11);
  return b;
}
const notes = () => sent.filter((m) => m.type === 'notification').map((m) => m.payload.message);

beforeEach(() => { sent.length = 0; });

describe('loadBoardsFromConfig merges into live board status', () => {
  it('a heartbeating board stays connected across a reload, with no lost/connected flash', () => {
    bs.loadBoardsFromConfig();
    bs.updateBoard(21, heartbeat());
    bs.markStaleBoards();
    expect(notes()).toEqual(['Board 21 (PT) connected']);
    sent.length = 0;

    // Session start (applyDeployedConfigChange) / stop (onStopped).
    bs.loadBoardsFromConfig();
    const st = bs.boardsStatus.get(21)!;
    expect(st.connected).toBe(true);
    expect(st.lastHeartbeatMs).not.toBeNull();

    bs.markStaleBoards();
    bs.updateBoard(21, heartbeat());
    bs.markStaleBoards();
    expect(notes()).toEqual([]);
  });

  it('config fields still follow the reloaded config', () => {
    config = {
      boards: {
        pt_21: { type: 'PT', board_id: 21, board_number: 4, enabled: true, ip: '127.0.0.99' },
      },
    };
    bs.loadBoardsFromConfig();
    const st = bs.boardsStatus.get(21)!;
    expect(st.ip).toBe('127.0.0.99');
    expect(st.boardNumber).toBe(4);
    expect(st.expected).toBe(true);
    expect(st.connected).toBe(true);
  });

  it('a board that really stopped still goes stale through the normal sweep', () => {
    const st = bs.boardsStatus.get(21)!;
    st.lastHeartbeatMs = Date.now() - bs.BOARD_HEARTBEAT_STALE_MS - 1;
    bs.markStaleBoards();
    expect(st.connected).toBe(false);
    expect(notes()).toEqual(['Board 4 (PT) connection lost']);
  });
});
