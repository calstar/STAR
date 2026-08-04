/**
 * Next.js edge middleware — JWT auth gate for the DAQ server frontend.
 *
 * Runs before every request. When AUTH_ENABLED=true:
 *   - Valid `session` cookie  → request passes through
 *   - Missing / invalid cookie → redirect to auth.starberkeley.org/login
 *
 * AUTH_ENABLED is unset by default so local dev requires no login.
 */

import { NextRequest, NextResponse } from 'next/server';

const AUTH_ENABLED = process.env.AUTH_ENABLED === 'true';
const AUTH_URL = process.env.AUTH_URL ?? 'https://auth.starberkeley.org';
const JWT_SECRET = process.env.JWT_SECRET ?? '';

// Paths that are always public (health probes, static assets, etc.)
const PUBLIC_PREFIXES = ['/_next/', '/favicon', '/api/health'];

export async function middleware(request: NextRequest) {
  if (!AUTH_ENABLED) return NextResponse.next();

  const { pathname } = request.nextUrl;

  // Let public paths through
  if (PUBLIC_PREFIXES.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  const token = request.cookies.get('session')?.value;

  if (!token || !(await verifyJwt(token))) {
    const loginUrl = new URL('/login', AUTH_URL);
    loginUrl.searchParams.set('next', request.url);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

/**
 * Verify HS256 JWT using the Web Crypto API (available in the edge runtime).
 * Avoids importing Node-only `jsonwebtoken` / `pyjwt`.
 */
async function verifyJwt(token: string): Promise<boolean> {
  if (!JWT_SECRET) return false;
  try {
    const [headerB64, payloadB64, sigB64] = token.split('.');
    if (!headerB64 || !payloadB64 || !sigB64) return false;

    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      enc.encode(JWT_SECRET),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify'],
    );

    const data = enc.encode(`${headerB64}.${payloadB64}`);
    const sig = Uint8Array.from(atob(sigB64.replace(/-/g, '+').replace(/_/g, '/')), (c) =>
      c.charCodeAt(0),
    );

    const valid = await crypto.subtle.verify('HMAC', key, sig, data);
    if (!valid) return false;

    // Check expiry
    const payload = JSON.parse(atob(payloadB64.replace(/-/g, '+').replace(/_/g, '/')));
    if (payload.exp && Date.now() / 1000 > payload.exp) return false;

    return true;
  } catch {
    return false;
  }
}

export const config = {
  // Run on all routes except Next.js internals
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
