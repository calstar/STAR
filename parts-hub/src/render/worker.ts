// Runs in a worker thread so a large CAD file can't stall the server.
import { parentPort, workerData } from 'node:worker_threads';
import { readMeshes } from './cad.ts';
import { renderPng } from './raster.ts';

const { filePath, ext, size } = workerData as { filePath: string; ext: string; size: number };
const png = renderPng(await readMeshes(filePath, ext), size);
parentPort!.postMessage(png); // copied, not transferred: small Buffers live in a shared pool
