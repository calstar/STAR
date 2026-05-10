/**
 * Next.js API routes proxy OTA to C++ ota_service (TCP). Build (pio) runs inside ota_service.
 */
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

function cmdHost(): string {
  return process.env.OTA_SERVICE_HOST || '127.0.0.1';
}
function cmdPort(): number {
  const n = parseInt(process.env.OTA_SERVICE_PORT || '9997', 10);
  return Number.isFinite(n) && n > 0 ? n : 9997;
}

export function otaServiceSendLine(line: string, timeoutMs = 900_000): Promise<{ ok: boolean; reply: string }> {
  const payload = line.endsWith('\n') ? line : `${line}\n`;
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok: boolean, reply: string) => {
      if (done) return;
      done = true;
      try {
        s.destroy();
      } catch {
        /* ignore */
      }
      resolve({ ok, reply });
    };
    const s = net.createConnection({ host: cmdHost(), port: cmdPort() }, () => s.write(payload));
    let buf = '';
    s.on('data', (c: Buffer) => {
      buf += c.toString();
      if (buf.includes('\n')) finish(buf.trim().startsWith('OK'), buf.trim());
    });
    s.on('close', () => {
      if (!done) finish(buf.trim().startsWith('OK'), buf.trim() || 'connection closed');
    });
    s.on('error', (err: NodeJS.ErrnoException) => {
      finish(
        false,
        err.code === 'ECONNREFUSED'
          ? `ota_service not running (${cmdHost()}:${cmdPort()})`
          : err.message,
      );
    });
    s.setTimeout(timeoutMs, () => finish(false, 'timeout'));
  });
}

/** absProjectDir must not contain '|'. boardId 0 = no TEMP_HARDCODE_BOARD_ID. */
export function otaServiceBuildFlash(
  boardIp: string,
  absProjectDir: string,
  boardId: number,
): Promise<{ ok: boolean; reply: string }> {
  return otaServiceSendLine(`OTA_BUILD_FLASH|${boardIp}|${absProjectDir}|${boardId}`);
}

export function otaServiceFlashFile(boardIp: string, firmwareAbsPath: string): Promise<{ ok: boolean; reply: string }> {
  return otaServiceSendLine(`OTA_FLASH:${boardIp}:${firmwareAbsPath}`, 120_000);
}

export interface OtaFlashJson {
  success: boolean;
  bytesSent: number;
  durationMs: number;
  error?: string;
}

export async function otaServiceFlashBuffer(boardIp: string, firmware: Buffer): Promise<OtaFlashJson> {
  const t0 = Date.now();
  if (!firmware.length || firmware.length > 0x200000) {
    return { success: false, bytesSent: 0, durationMs: 0, error: 'bad firmware size' };
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diablo-ota-'));
  const fp = path.join(dir, 'firmware.bin');
  try {
    fs.writeFileSync(fp, firmware);
    const { ok, reply } = await otaServiceFlashFile(boardIp, fp);
    return {
      success: ok,
      bytesSent: ok ? firmware.length : 0,
      durationMs: Date.now() - t0,
      error: ok ? undefined : reply,
    };
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}
