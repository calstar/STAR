/**
 * Minimal static file server for the built frontend SPA (frontend/dist).
 *
 * Serves on GUI_PORT (default 3000 — the origin launch scripts, Playwright,
 * and operators already expect). No framework, matching api-server.ts style.
 *
 * - /assets/* files are content-hashed by Vite → served immutable, so browser
 *   caching is always correct (stale-bundle problems are impossible).
 * - Unknown extension-less paths fall back to index.html (SPA routing).
 * - If dist/ is missing, serves a hint page instead of dying — the stack still
 *   comes up, the operator sees "run npm run build".
 * - EADDRINUSE is non-fatal: during development `vite dev` owns :3000 and the
 *   static server just stands down.
 */

import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

function defaultDistDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..', 'frontend', 'dist');
}

export function startGuiStaticServer(port: number, distDir = defaultDistDir()): http.Server | null {
  if (!Number.isFinite(port) || port <= 0) {
    console.log('[GUI] Static GUI server disabled (GUI_PORT <= 0)');
    return null;
  }

  const server = http.createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405); res.end(); return;
    }
    const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/');
    // Normalize and confine to distDir (no path traversal).
    const rel = path.normalize(urlPath).replace(/^([/\\])+/, '').replace(/^(\.\.([/\\]|$))+/, '');
    let filePath = path.join(distDir, rel === '' ? 'index.html' : rel);
    if (!filePath.startsWith(distDir)) { res.writeHead(403); res.end(); return; }

    let stat = fs.existsSync(filePath) ? fs.statSync(filePath) : null;
    if (stat?.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
      stat = fs.existsSync(filePath) ? fs.statSync(filePath) : null;
    }

    if (!stat) {
      const ext = path.extname(filePath);
      if (ext && ext !== '.html') { res.writeHead(404); res.end(); return; }
      // SPA fallback: any route path serves the app shell.
      filePath = path.join(distDir, 'index.html');
      if (!fs.existsSync(filePath)) {
        res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<h1>Frontend not built</h1><p>Run <code>npm run build</code> in <code>diablo_server/frontend</code> (launch scripts do this automatically).</p>');
        return;
      }
    }

    const ext = path.extname(filePath).toLowerCase();
    const immutable = urlPath.startsWith('/assets/');
    res.writeHead(200, {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      // Hashed assets never change; the shell must always revalidate.
      'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(filePath).pipe(res);
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.warn(`[GUI] Port ${port} already in use (vite dev server?) — static GUI serving disabled`);
    } else {
      console.error('[GUI] Static server error:', err);
    }
  });

  server.listen(port, () => {
    console.log(`[GUI] Serving frontend from ${distDir} on port ${port}`);
  });
  return server;
}
