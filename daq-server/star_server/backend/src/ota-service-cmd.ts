/**
 * Send one-line commands to C++ ota_service (TCP). Build + flash runs inside ota_service (pio run).
 */
import * as net from 'net';

function host(): string {
  return process.env.OTA_SERVICE_HOST || '127.0.0.1';
}
function port(): number {
  const n = parseInt(process.env.OTA_SERVICE_PORT || '9997', 10);
  return Number.isFinite(n) && n > 0 ? n : 9997;
}

export function otaSendLine(line: string, timeoutMs = 900_000): Promise<{ ok: boolean; reply: string }> {
  const payload = line.endsWith('\n') ? line : `${line}\n`;
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok: boolean, reply: string) => {
      if (done) return;
      done = true;
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
      resolve({ ok, reply });
    };
    const sock = net.createConnection({ host: host(), port: port() }, () => sock.write(payload));
    let buf = '';
    sock.on('data', (c: Buffer) => {
      buf += c.toString();
      if (buf.includes('\n')) finish(buf.trim().startsWith('OK'), buf.trim());
    });
    sock.on('close', () => {
      if (!done) finish(buf.trim().startsWith('OK'), buf.trim() || 'connection closed');
    });
    sock.on('error', (err: NodeJS.ErrnoException) => {
      finish(
        false,
        err.code === 'ECONNREFUSED' ? `ota_service not running (${host()}:${port()})` : err.message,
      );
    });
    sock.setTimeout(timeoutMs, () => finish(false, 'timeout talking to ota_service'));
  });
}

/** Path must not contain '|'. boardId 0 = no TEMP_HARDCODE_BOARD_ID. */
export function otaBuildFlash(boardIp: string, absProjectDir: string, boardId: number): Promise<{ ok: boolean; reply: string }> {
  return otaSendLine(`OTA_BUILD_FLASH|${boardIp}|${absProjectDir}|${boardId}`);
}

export function otaFlashFirmwareFile(boardIp: string, absBinPath: string): Promise<{ ok: boolean; reply: string }> {
  return otaSendLine(`OTA_FLASH:${boardIp}:${absBinPath}`);
}
