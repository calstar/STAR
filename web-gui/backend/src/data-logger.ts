/**
 * Binary Data Logger — Records all sensor data during runs.
 *
 * File format (.sensorlog):
 *   HEADER (written once on start):
 *     magic:       4 bytes  "SLOG"
 *     version:     2 bytes  uint16  (1)
 *     startTime:   8 bytes  float64 (epoch ms)
 *     channelCnt:  2 bytes  uint16
 *     FOR each channel:
 *       nameLen:   2 bytes  uint16
 *       name:      variable UTF-8
 *
 *   RECORDS (appended continuously):
 *     timestamp:   4 bytes  uint32  (ms offset from startTime)
 *     channelIdx:  2 bytes  uint16  (index into channel table)
 *     value:       8 bytes  float64
 *     = 14 bytes per record
 */

import * as fs from 'fs';
import * as path from 'path';

const MAGIC = Buffer.from('SLOG');
const VERSION = 1;
const RECORD_SIZE = 14; // 4 + 2 + 8

export class DataLogger {
  private fd: number | null = null;
  private startTime: number = 0;
  private channelMap: Map<string, number> = new Map();
  private channels: string[] = [];
  private filePath: string = '';
  private recordCount = 0;
  private writeBuf = Buffer.alloc(RECORD_SIZE);
  private isOpen = false;

  /**
   * Start a new logging session. Creates a timestamped .sensorlog file.
   */
  start(outputDir?: string): string {
    if (this.isOpen) this.stop();

    const dir = outputDir ?? path.join(process.cwd(), 'data', 'runs');
    fs.mkdirSync(dir, { recursive: true });

    const ts = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
    this.filePath = path.join(dir, `run_${ts}.sensorlog`);
    this.startTime = Date.now();
    this.channelMap.clear();
    this.channels = [];
    this.recordCount = 0;

    this.fd = fs.openSync(this.filePath, 'w');

    // Write header placeholder (will rewrite on stop to include full channel table)
    this.writeHeader();

    this.isOpen = true;
    console.log(`📝 DataLogger started → ${this.filePath}`);
    return this.filePath;
  }

  /**
   * Record a sensor value. Lazily registers new channels.
   */
  record(entityComponent: string, value: number): void {
    if (!this.isOpen || this.fd === null) return;
    if (!isFinite(value)) return;

    let idx = this.channelMap.get(entityComponent);
    if (idx === undefined) {
      idx = this.channels.length;
      this.channelMap.set(entityComponent, idx);
      this.channels.push(entityComponent);
    }

    const offset = Date.now() - this.startTime;
    this.writeBuf.writeUInt32LE(offset >>> 0, 0);
    this.writeBuf.writeUInt16LE(idx, 4);
    this.writeBuf.writeDoubleLE(value, 6);

    fs.writeSync(this.fd, this.writeBuf);
    this.recordCount++;
  }

  /**
   * Stop logging. Rewrites the header with the full channel table, then closes.
   */
  stop(): { filePath: string; records: number; channels: number; durationMs: number } | null {
    if (!this.isOpen || this.fd === null) return null;

    const durationMs = Date.now() - this.startTime;

    // Close the append fd
    fs.closeSync(this.fd);
    this.fd = null;

    // Now rewrite the file: new header + all existing records
    // Read all records from the file (skip the old header)
    const oldBuf = fs.readFileSync(this.filePath);
    const oldHeaderSize = this.calcHeaderSize(0); // initial header had 0 channels

    // Build new header with complete channel table
    const header = this.buildHeader();
    const records = oldBuf.subarray(oldHeaderSize);

    // Rewrite
    const newFd = fs.openSync(this.filePath, 'w');
    fs.writeSync(newFd, header);
    fs.writeSync(newFd, records);
    fs.closeSync(newFd);

    this.isOpen = false;
    const result = {
      filePath: this.filePath,
      records: this.recordCount,
      channels: this.channels.length,
      durationMs,
    };
    console.log(`📝 DataLogger stopped → ${this.recordCount} records, ${this.channels.length} channels, ${(durationMs / 1000).toFixed(1)}s`);
    return result;
  }

  get running(): boolean {
    return this.isOpen;
  }

  get stats() {
    return {
      running: this.isOpen,
      filePath: this.filePath,
      records: this.recordCount,
      channels: this.channels.length,
      durationMs: this.isOpen ? Date.now() - this.startTime : 0,
    };
  }

  // ── Private ──────────────────────────────────────────────────────────────────

  private writeHeader(): void {
    if (this.fd === null) return;
    const buf = this.buildHeader();
    fs.writeSync(this.fd, buf, 0, buf.length, 0);
  }

  private buildHeader(): Buffer {
    // Calculate total size
    let size = 4 + 2 + 8 + 2; // magic + version + startTime + channelCnt
    for (const name of this.channels) {
      size += 2 + Buffer.byteLength(name, 'utf-8');
    }

    const buf = Buffer.alloc(size);
    let off = 0;

    // Magic
    MAGIC.copy(buf, off); off += 4;

    // Version
    buf.writeUInt16LE(VERSION, off); off += 2;

    // Start time
    buf.writeDoubleLE(this.startTime, off); off += 8;

    // Channel count
    buf.writeUInt16LE(this.channels.length, off); off += 2;

    // Channel names
    for (const name of this.channels) {
      const nameBytes = Buffer.from(name, 'utf-8');
      buf.writeUInt16LE(nameBytes.length, off); off += 2;
      nameBytes.copy(buf, off); off += nameBytes.length;
    }

    return buf;
  }

  private calcHeaderSize(channelCount: number): number {
    // Compute exact byte size for a header with `channelCount` channels.
    // Used by stop() to skip the initial placeholder (written with 0 channels).
    let size = 4 + 2 + 8 + 2; // magic(4) + version(2) + startTime(8) + channelCnt(2)
    for (let i = 0; i < channelCount; i++) {
      // Variable-length: we would need the actual name lengths, which we don't have here.
      // Callers always pass 0 (initial placeholder had 0 channels), so the loop never runs.
      size += 2; // nameLen field only; can't add name bytes without the names
    }
    return size;
  }
}
