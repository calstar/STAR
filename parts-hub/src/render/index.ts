// Local thumbnails: render the uploaded CAD file on our server instead of asking
// Onshape (which would cost an API call per part).
import { Worker } from 'node:worker_threads';
import { RENDERABLE } from './cad.ts';

const TIMEOUT_MS = 3 * 60 * 1000;
let tail: Promise<unknown> = Promise.resolve();

export const canRenderLocally = (filename: string) => RENDERABLE.has(filename.toLowerCase().split('.').pop() ?? '');

/** Render a 300 px PNG of the model. One at a time: big STEP files use a lot of memory. */
export function renderLocally(filePath: string, filename: string, size = 300): Promise<Buffer> {
  const ext = filename.toLowerCase().split('.').pop() ?? '';
  const job = () =>
    new Promise<Buffer>((resolve, reject) => {
      const worker = new Worker(new URL('./worker.ts', import.meta.url), {
        workerData: { filePath, ext, size },
        resourceLimits: { maxOldGenerationSizeMb: 1536 },
        execArgv: ['--disable-warning=ExperimentalWarning'],
      });
      const timer = setTimeout(() => {
        void worker.terminate();
        reject(new Error('Rendering timed out'));
      }, TIMEOUT_MS);
      worker.once('message', (png: Uint8Array) => {
        clearTimeout(timer);
        resolve(Buffer.from(png));
      });
      worker.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      worker.once('exit', (code) => {
        clearTimeout(timer);
        if (code !== 0) reject(new Error(`Renderer exited with code ${code}`));
      });
    });
  const run = tail.then(job, job);
  tail = run.catch(() => {});
  return run;
}
