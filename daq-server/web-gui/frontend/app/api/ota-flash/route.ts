import * as path from 'path';
import { NextResponse } from 'next/server';
import { getOtaWorkspaceRoot } from '../../../../backend/src/ota-build';
import { otaServiceBuildFlash, otaServiceFlashBuffer } from '@/lib/ota-service-tcp';

const MAX = 4 * 1024 * 1024;

export async function POST(req: Request) {
  try {
    const raw = await req.text();
    if (raw.length > MAX) {
      return NextResponse.json({ error: 'Firmware too large' }, { status: 413 });
    }
    const body = JSON.parse(raw) as Record<string, unknown>;
    const ip = body.ip;
    const port = typeof body.port === 'number' ? body.port : parseInt(String(body.port ?? '3232'), 10) || 3232;
    if (!ip || typeof ip !== 'string') {
      return NextResponse.json({ error: 'Missing or invalid ip' }, { status: 400 });
    }
    if (port !== 3232) {
      return NextResponse.json({ error: 'ota_service uses board OTA port 3232' }, { status: 400 });
    }

    const t0 = Date.now();
    if (body.projectPath && typeof body.projectPath === 'string') {
      const root = getOtaWorkspaceRoot();
      const abs = path.isAbsolute(body.projectPath)
        ? body.projectPath
        : path.join(root, body.projectPath);
      const boardId = body.boardId;
      const bid =
        typeof boardId === 'number' && boardId >= 0 && boardId <= 254 ? boardId : 0;
      const { ok, reply } = await otaServiceBuildFlash(ip, abs, bid);
      return NextResponse.json({
        success: ok,
        bytesSent: 0,
        durationMs: Date.now() - t0,
        error: ok ? undefined : reply,
      });
    }
    if (body.firmwareBase64 && typeof body.firmwareBase64 === 'string') {
      const firmware = Buffer.from(body.firmwareBase64, 'base64');
      return NextResponse.json(await otaServiceFlashBuffer(ip, firmware));
    }
    return NextResponse.json({ error: 'Provide firmwareBase64 or projectPath' }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
