import path from 'node:path';

function env(name: string, fallback = ''): string {
  return (process.env[name] ?? fallback).trim();
}

function flag(name: string): boolean {
  return ['1', 'true', 'yes'].includes(env(name).toLowerCase());
}

const mock = flag('MOCK_ONSHAPE');

export const config = {
  port: Number(env('PORT', '8080')),
  publicBaseUrl: env('PUBLIC_BASE_URL', 'http://localhost:8080').replace(/\/+$/, ''),
  dataDir: path.resolve(env('DATA_DIR', './data')),
  sessionSecret: env('SESSION_SECRET', mock ? 'mock-mode-secret' : ''),
  maxUploadMb: Number(env('MAX_UPLOAD_MB', '200')),

  // Fake Onshape + seeded parts, for UI development and demos.
  mock,

  // Hub (school login). "header": trust an identity header set by the reverse-proxy
  // auth layer (oauth2-proxy, Authelia, Caddy forward_auth, ...). "dev": everyone is
  // DEV_USER_EMAIL; never use on the server.
  auth: {
    mode: env('AUTH_MODE', 'header') as 'header' | 'dev',
    // STAR's Caddy gate (deploy/caddy/Caddyfile in the STAR repo) sets these from auth's /verify.
    emailHeader: env('AUTH_EMAIL_HEADER', 'x-auth-email').toLowerCase(),
    nameHeader: env('AUTH_NAME_HEADER', 'x-auth-user').toLowerCase(),
    allowedDomains: env('ALLOWED_EMAIL_DOMAINS', 'berkeley.edu')
      .split(',')
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean),
    devUserEmail: env('DEV_USER_EMAIL', 'dev@berkeley.edu'),
  },

  onshape: {
    // STAR's Onshape Enterprise domain.
    baseUrl: env('ONSHAPE_BASE_URL', 'https://starberkeley.onshape.com').replace(/\/+$/, ''),
    oauthBaseUrl: env('ONSHAPE_OAUTH_URL', 'https://oauth.onshape.com').replace(/\/+$/, ''),
    clientId: env('ONSHAPE_CLIENT_ID'),
    clientSecret: env('ONSHAPE_CLIENT_SECRET'),
    oauthRedirectUrl: env('OAUTH_REDIRECT_URL'),
    // Falls back to the names the rest of the STAR stack uses for the same key pair.
    accessKey: env('ONSHAPE_API_ACCESS_KEY') || env('ONSHAPE_ACCESS_KEY'),
    secretKey: env('ONSHAPE_API_SECRET_KEY') || env('ONSHAPE_SECRET_KEY'),
    libraryDocumentId: env('LIBRARY_DOCUMENT_ID', mock ? 'aaaaaaaaaaaaaaaaaaaaaaaa' : ''),
  },

  defaultCategories: ['Fittings', 'Valves', 'Fasteners', 'Sensors', 'Tubing', 'Electrical', 'Structural', 'Other'],
};

export function validateConfig(): string[] {
  const problems: string[] = [];
  if (!config.sessionSecret || config.sessionSecret.length < 16) problems.push('SESSION_SECRET must be at least 16 characters');
  if (config.auth.mode !== 'header' && config.auth.mode !== 'dev') problems.push('AUTH_MODE must be "header" or "dev"');
  if (config.mock) return problems;
  const o = config.onshape;
  for (const [key, value] of Object.entries({
    ONSHAPE_CLIENT_ID: o.clientId,
    ONSHAPE_CLIENT_SECRET: o.clientSecret,
    OAUTH_REDIRECT_URL: o.oauthRedirectUrl,
    ONSHAPE_API_ACCESS_KEY: o.accessKey,
    ONSHAPE_API_SECRET_KEY: o.secretKey,
    LIBRARY_DOCUMENT_ID: o.libraryDocumentId,
  })) {
    if (!value) problems.push(`${key} is required (or set MOCK_ONSHAPE=1)`);
  }
  return problems;
}
