import * as path from 'path';
import {
  BOARD_TYPE_TO_PROJECT,
  getEnabledBoardsForFlash,
  getOtaWorkspaceRoot,
} from '../../../../../backend/src/ota-build';
import { otaServiceBuildFlash } from '@/lib/ota-service-tcp';

export async function POST() {
  const boards = getEnabledBoardsForFlash();
  if (boards.length === 0) {
    return new Response(JSON.stringify({ success: false, message: 'No enabled boards in config' }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const enc = new TextEncoder();
  const root = getOtaWorkspaceRoot();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      send('progress', { message: `Flash-all (${boards.length} boards) — ota_service builds + flashes…` });
      const results: Array<{
        key: string;
        type: string;
        ip: string;
        boardId: number;
        success: boolean;
        error?: string;
      }> = [];
      let flashed = 0;
      let failed = 0;
      try {
        for (let i = 0; i < boards.length; i++) {
          const b = boards[i];
          const rel = BOARD_TYPE_TO_PROJECT[b.type];
          if (!rel) {
            const r = { ...b, success: false as const, error: `No firmware project for type ${b.type}` };
            results.push(r);
            send('board_result', r);
            failed++;
            continue;
          }
          send('progress', {
            message: `[${i + 1}/${boards.length}] Build+flash ${b.type} (ID ${b.boardId}) → ${b.ip}…`,
          });
          const { ok, reply } = await otaServiceBuildFlash(b.ip, path.join(root, rel), b.boardId);
          if (ok) {
            const r = { ...b, success: true as const };
            results.push(r);
            send('board_result', r);
            flashed++;
          } else {
            const r = { ...b, success: false as const, error: reply };
            results.push(r);
            send('board_result', r);
            failed++;
          }
        }
        send('done', { success: failed === 0, total: boards.length, flashed, failed, results });
      } catch (e) {
        send('progress', { message: String(e) });
        send('done', { success: false, total: boards.length, flashed: 0, failed: boards.length, results: [] });
      }
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
