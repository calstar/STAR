/**
 * Ethernet OTA firmware flash for DiabloAvionics ESP32-S3 boards.
 * Protocol (from external/DiabloAvionics/Ethernet OTA Testing):
 *   1. TCP connect to board IP:port (default 3232)
 *   2. Send 4-byte firmware size (big-endian)
 *   3. Send raw firmware binary in 4 KB chunks
 *   4. ESP32 responds "OK" before rebooting
 */
import * as net from 'net';
const CHUNK_SIZE = 4096;
const CONNECT_TIMEOUT_MS = 5000;
const TRANSFER_TIMEOUT_MS = 60000;
/**
 * Upload firmware binary to ESP32 over Ethernet TCP.
 * @param firmwareBuffer - Raw .bin file contents
 * @param ip - Board IP (e.g. 192.168.2.5)
 * @param port - OTA TCP port (default 3232)
 * @param onProgress - Optional progress callback
 */
export async function uploadFirmware(firmwareBuffer, ip, port, onProgress) {
    const fileSize = firmwareBuffer.length;
    const startTime = Date.now();
    if (fileSize === 0 || fileSize > 0x200000) {
        return {
            success: false,
            bytesSent: 0,
            durationMs: 0,
            error: `Invalid firmware size: ${fileSize} bytes (must be 1–2MB)`,
        };
    }
    return new Promise((resolve) => {
        const sock = new net.Socket();
        sock.setTimeout(TRANSFER_TIMEOUT_MS);
        sock.on('error', (err) => {
            resolve({
                success: false,
                bytesSent: 0,
                durationMs: Date.now() - startTime,
                error: err.message,
            });
        });
        sock.on('timeout', () => {
            sock.destroy();
            resolve({
                success: false,
                bytesSent: 0,
                durationMs: Date.now() - startTime,
                error: 'Transfer timed out',
            });
        });
        sock.connect(port, ip, () => {
            // 1. Send 4-byte size header (big-endian)
            const header = Buffer.allocUnsafe(4);
            header.writeUInt32BE(fileSize, 0);
            sock.write(header);
            let sent = 0;
            let lastPercent = -1;
            const sendNext = () => {
                if (sent >= fileSize) {
                    // Wait for "OK" response
                    const dataHandler = (data) => {
                        const msg = data.toString('utf8', 0, Math.min(data.length, 64)).trim();
                        if (msg.includes('OK')) {
                            sock.destroy();
                            resolve({
                                success: true,
                                bytesSent: fileSize,
                                durationMs: Date.now() - startTime,
                            });
                        }
                    };
                    sock.once('data', dataHandler);
                    sock.setTimeout(5000);
                    return;
                }
                const chunk = firmwareBuffer.subarray(sent, Math.min(sent + CHUNK_SIZE, fileSize));
                sock.write(chunk, (err) => {
                    if (err) {
                        sock.destroy();
                        resolve({
                            success: false,
                            bytesSent: sent,
                            durationMs: Date.now() - startTime,
                            error: err.message,
                        });
                        return;
                    }
                    sent += chunk.length;
                    const percent = Math.floor((sent * 100) / fileSize);
                    const elapsed = (Date.now() - startTime) / 1000;
                    const rateKbps = elapsed > 0 ? sent / 1024 / elapsed : 0;
                    if (onProgress && percent !== lastPercent) {
                        lastPercent = percent;
                        onProgress({ percent, bytesSent: sent, totalBytes: fileSize, rateKbps });
                    }
                    setImmediate(sendNext);
                });
            };
            sendNext();
        });
        sock.setTimeout(CONNECT_TIMEOUT_MS);
    });
}
