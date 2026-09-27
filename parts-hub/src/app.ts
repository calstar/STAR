import path from 'node:path';
import express, { type Express, type Response } from 'express';
import { config } from './config.ts';
import { requireHubUser } from './auth/hub.ts';
import { oauthRouter } from './auth/panel.ts';
import { hubApi } from './routes/hub.ts';
import { panelApi } from './routes/panel.ts';

const PUBLIC = path.resolve(import.meta.dirname, '../public');

const csp = (frameAncestors: string) => (_req: unknown, res: Response, next: () => void) => {
  res.setHeader(
    'Content-Security-Policy',
    `default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors ${frameAncestors}`,
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
};

export function createApp(): Express {
  const app = express();
  app.disable('x-powered-by');

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });

  // ---- Onshape panel: outside the school-login gate ------------------------------
  // Everything under /panel/ must be exempted from the proxy's login (see README).
  const panel = express.Router();
  panel.use(csp(`${config.onshape.baseUrl} https://*.onshape.com`));
  panel.use('/oauth', oauthRouter);
  panel.use('/api', express.json(), panelApi);
  panel.use(
    '/media/thumbs',
    express.static(path.join(config.dataDir, 'thumbs'), { immutable: true, maxAge: '365d', fallthrough: false }),
  );
  panel.use('/shared', express.static(path.join(PUBLIC, 'shared')));
  panel.use(express.static(path.join(PUBLIC, 'panel')));
  app.use('/panel', panel);

  // ---- Hub: behind school login ------------------------------------------------
  app.use(csp("'self'"), requireHubUser);
  app.use('/api/hub', express.json({ limit: '1mb' }), hubApi);
  app.use('/shared', express.static(path.join(PUBLIC, 'shared')));
  app.use(express.static(path.join(PUBLIC, 'hub')));

  return app;
}
