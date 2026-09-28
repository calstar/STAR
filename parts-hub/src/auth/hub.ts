// School login for the hub. The reverse proxy in front of our server apps does the
// actual sign-in and passes the user's email in a header; we only trust that header
// (the app must not be reachable except through the proxy, see README).
import type { NextFunction, Request, Response } from 'express';
import { config } from '../config.ts';

export type HubUser = { email: string; name: string };

declare module 'express-serve-static-core' {
  interface Request {
    user?: HubUser;
  }
}

export function currentUser(req: Request): HubUser | null {
  if (config.auth.mode === 'dev') return { email: config.auth.devUserEmail, name: config.auth.devUserEmail.split('@')[0] };
  const email = String(req.headers[config.auth.emailHeader] ?? '').trim().toLowerCase();
  if (!email) return null;
  const domain = email.split('@')[1] ?? '';
  const allowed = config.auth.allowedDomains;
  if (allowed.length && !allowed.some((d) => domain === d || domain.endsWith('.' + d))) return null;
  const name = String(req.headers[config.auth.nameHeader] ?? '').trim() || email.split('@')[0];
  return { email, name };
}

export function requireHubUser(req: Request, res: Response, next: NextFunction): void {
  const user = currentUser(req);
  if (!user) {
    const msg = 'Not signed in with a school account. Open the Parts Hub through the STAR login.';
    if (req.path.startsWith('/api/')) res.status(401).json({ error: msg });
    else res.status(401).type('text').send(msg);
    return;
  }
  req.user = user;
  next();
}
