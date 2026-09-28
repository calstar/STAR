// Onshape OAuth for the in-Onshape panel.
//
// The panel lives in an iframe on cad.onshape.com, where our cookies would be
// third-party (and the school-login cookie won't be sent at all). So nothing here
// uses cookies:
//  - the OAuth `state` is an HMAC-signed blob carrying the panel's query string;
//  - after the callback we hand the panel an opaque session handle in the URL
//    fragment; the panel keeps it in localStorage and sends it as a Bearer token;
//  - Onshape access/refresh tokens stay server-side, encrypted in SQLite.
import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import { config } from '../config.ts';
import { getDb } from '../db.ts';
import { OnshapeError } from '../onshape/client.ts';

const STATE_TTL_MS = 10 * 60 * 1000;
const SESSION_IDLE_MS = 60 * 24 * 60 * 60 * 1000; // forget sessions unused for 60 days
const PANEL_PARAMS = ['documentId', 'workspaceOrVersion', 'workspaceOrVersionId', 'elementId', 'server', 'companyId', 'userId', 'locale'];

type Tokens = { accessToken: string; refreshToken: string };

declare module 'express-serve-static-core' {
  interface Request {
    panelSession?: string; // session row id
  }
}

// ---- crypto helpers --------------------------------------------------------

const key = () => crypto.createHash('sha256').update(config.sessionSecret).digest();
const hmac = (data: string) => crypto.createHmac('sha256', key()).update(data).digest('base64url');
const hashHandle = (handle: string) => crypto.createHash('sha256').update(handle).digest('hex');

function encrypt(tokens: Tokens): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(tokens)), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString('base64url')).join('.');
}

function decrypt(blob: string): Tokens {
  const [iv, tag, data] = blob.split('.').map((s) => Buffer.from(s, 'base64url'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), iv);
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(data), decipher.final()]).toString());
}

function signState(panelQuery: string): string {
  const payload = Buffer.from(JSON.stringify({ q: panelQuery, t: Date.now(), n: crypto.randomBytes(8).toString('hex') })).toString('base64url');
  return `${payload}.${hmac(payload)}`;
}

function verifyState(state: string): string | null {
  const [payload, sig] = state.split('.');
  if (!payload || !sig) return null;
  const expected = Buffer.from(hmac(payload));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
  const { q, t } = JSON.parse(Buffer.from(payload, 'base64url').toString());
  return Date.now() - t < STATE_TTL_MS ? String(q) : null;
}

/** Keep only the Onshape action-URL parameters, so the post-login redirect can't be steered elsewhere. */
function panelQuery(source: Record<string, unknown>): string {
  const q = new URLSearchParams();
  for (const k of PANEL_PARAMS) if (typeof source[k] === 'string') q.set(k, source[k] as string);
  return q.toString();
}

// ---- token endpoint --------------------------------------------------------

async function tokenRequest(params: Record<string, string>): Promise<{ tokens: Tokens; expiresAt: number }> {
  const res = await fetch(`${config.onshape.oauthBaseUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...params, client_id: config.onshape.clientId, client_secret: config.onshape.clientSecret }),
  });
  if (!res.ok) throw new OnshapeError(res.status, await res.text(), 'OAuth token request');
  const body = (await res.json()) as { access_token: string; refresh_token: string; expires_in: number };
  return {
    tokens: { accessToken: body.access_token, refreshToken: body.refresh_token },
    expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
  };
}

// ---- sessions --------------------------------------------------------------

function createSession(tokens: Tokens, expiresAt: number): string {
  const handle = crypto.randomBytes(32).toString('base64url');
  const t = Date.now();
  const db = getDb();
  db.prepare('DELETE FROM panel_sessions WHERE last_used_at < ?').run(t - SESSION_IDLE_MS);
  db.prepare('INSERT INTO panel_sessions (id, tokens, expires_at, created_at, last_used_at) VALUES (?, ?, ?, ?, ?)').run(
    hashHandle(handle), encrypt(tokens), expiresAt, t, t,
  );
  return handle;
}

function loadSession(id: string): { tokens: Tokens; expiresAt: number } | null {
  const row = getDb().prepare('SELECT tokens, expires_at FROM panel_sessions WHERE id = ?').get(id) as
    | { tokens: string; expires_at: number }
    | undefined;
  if (!row) return null;
  try {
    return { tokens: decrypt(row.tokens), expiresAt: Number(row.expires_at) };
  } catch {
    return null; // SESSION_SECRET changed
  }
}

export function deleteSession(id: string): void {
  getDb().prepare('DELETE FROM panel_sessions WHERE id = ?').run(id);
}

async function refresh(id: string, refreshToken: string): Promise<string> {
  const { tokens, expiresAt } = await tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken });
  getDb().prepare('UPDATE panel_sessions SET tokens = ?, expires_at = ? WHERE id = ?').run(encrypt(tokens), expiresAt, id);
  return tokens.accessToken;
}

export class SessionExpired extends Error {}

/**
 * Run `fn` with a valid Onshape access token for this panel session, refreshing
 * it when it's about to expire or Onshape answers 401.
 */
export async function withUserToken<T>(id: string, fn: (token: string) => Promise<T>): Promise<T> {
  const session = loadSession(id);
  if (!session) throw new SessionExpired('Panel session not found');
  let token = session.tokens.accessToken;
  try {
    if (session.expiresAt - Date.now() < 60_000) token = await refresh(id, session.tokens.refreshToken);
    return await fn(token);
  } catch (err) {
    if (err instanceof OnshapeError && err.status === 401) {
      try {
        token = await refresh(id, session.tokens.refreshToken);
      } catch {
        deleteSession(id);
        throw new SessionExpired('Onshape sign-in expired');
      }
      return fn(token);
    }
    if (err instanceof OnshapeError && err.body.includes('invalid_grant')) {
      deleteSession(id);
      throw new SessionExpired('Onshape sign-in expired');
    }
    throw err;
  }
}

export function requirePanelSession(req: Request, res: Response, next: NextFunction): void {
  const handle = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
  const id = handle ? hashHandle(handle) : '';
  if (!id || !loadSession(id)) {
    res.status(401).json({ error: 'Sign in to Onshape' });
    return;
  }
  getDb().prepare('UPDATE panel_sessions SET last_used_at = ? WHERE id = ?').run(Date.now(), id);
  req.panelSession = id;
  next();
}

// ---- routes (mounted at /panel/oauth) --------------------------------------

export const oauthRouter = Router();

oauthRouter.get('/start', (req, res) => {
  const query = panelQuery(req.query);
  if (config.mock) {
    const handle = createSession({ accessToken: 'mock-access', refreshToken: 'mock-refresh' }, Date.now() + 3600_000);
    res.redirect(`${config.publicBaseUrl}/panel/?${query}#session=${handle}`);
    return;
  }
  const url = new URL(`${config.onshape.oauthBaseUrl}/oauth/authorize`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', config.onshape.clientId);
  url.searchParams.set('redirect_uri', config.onshape.oauthRedirectUrl);
  url.searchParams.set('state', signState(query));
  res.redirect(url.toString());
});

oauthRouter.get('/callback', async (req, res) => {
  const query = verifyState(String(req.query.state ?? ''));
  if (query === null) {
    res.status(400).type('text').send('Sign-in link expired or invalid. Close and reopen the Parts panel.');
    return;
  }
  if (req.query.error || !req.query.code) {
    res.status(403).type('text').send(`Onshape did not grant access (${req.query.error ?? 'no code'}). Reopen the panel to try again.`);
    return;
  }
  try {
    const { tokens, expiresAt } = await tokenRequest({
      grant_type: 'authorization_code',
      code: String(req.query.code),
      redirect_uri: config.onshape.oauthRedirectUrl,
    });
    const handle = createSession(tokens, expiresAt);
    // The fragment never reaches servers or logs; the panel moves it to localStorage.
    res.redirect(`${config.publicBaseUrl}/panel/?${query}#session=${handle}`);
  } catch (err) {
    console.error('[oauth] token exchange failed:', err);
    res.status(502).type('text').send('Could not complete Onshape sign-in. Reopen the panel to try again.');
  }
});
