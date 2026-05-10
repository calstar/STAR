/**
 * Send one-line commands to C++ ota_service (TCP). Build + flash runs inside ota_service (pio run).
 */
import * as net from 'net';
function host() {
    return process.env.OTA_SERVICE_HOST || '127.0.0.1';
}
function port() {
    const n = parseInt(process.env.OTA_SERVICE_PORT || '9997', 10);
    return Number.isFinite(n) && n > 0 ? n : 9997;
}
export function otaSendLine(line, timeoutMs = 900_000) {
    const payload = line.endsWith('\n') ? line : `${line}\n`;
    return new Promise((resolve) => {
        let done = false;
        const finish = (ok, reply) => {
            if (done)
                return;
            done = true;
            try {
                sock.destroy();
            }
            catch {
                /* ignore */
            }
            resolve({ ok, reply });
        };
        const sock = net.createConnection({ host: host(), port: port() }, () => sock.write(payload));
        let buf = '';
        sock.on('data', (c) => {
            buf += c.toString();
            if (buf.includes('\n'))
                finish(buf.trim().startsWith('OK'), buf.trim());
        });
        sock.on('close', () => {
            if (!done)
                finish(buf.trim().startsWith('OK'), buf.trim() || 'connection closed');
        });
        sock.on('error', (err) => {
            finish(false, err.code === 'ECONNREFUSED' ? `ota_service not running (${host()}:${port()})` : err.message);
        });
        sock.setTimeout(timeoutMs, () => finish(false, 'timeout talking to ota_service'));
    });
}
/** Path must not contain '|'. boardId 0 = no TEMP_HARDCODE_BOARD_ID. */
export function otaBuildFlash(boardIp, absProjectDir, boardId) {
    return otaSendLine(`OTA_BUILD_FLASH|${boardIp}|${absProjectDir}|${boardId}`);
}
export function otaFlashFirmwareFile(boardIp, absBinPath) {
    return otaSendLine(`OTA_FLASH:${boardIp}:${absBinPath}`);
}
