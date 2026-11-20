/**
 * Backend origin resolution.
 *
 * One build has to serve three situations, decided at runtime from the URL the
 * browser used:
 *   - Vite dev server on :5173  → backend at <host>:8081
 *   - static GUI server on :3000 → backend at <host>:8081
 *   - Caddy on :80 / :443        → backend at same-origin /api and /ws,
 *                                  because :8081 is not published in production
 */

import { describe, it, expect, afterEach } from 'vitest';
import { getApiBaseUrl, getWebSocketFallbackUrls } from '@/lib/websocket';

const realLocation = window.location;

/** Point window.location at `href` for the duration of one test. */
function setLocation(href: string): void {
  const url = new URL(href);
  Object.defineProperty(window, 'location', {
    configurable: true,
    writable: true,
    value: {
      href: url.href,
      origin: url.origin,
      protocol: url.protocol,
      host: url.host,
      hostname: url.hostname,
      port: url.port,
    },
  });
}

afterEach(() => {
  Object.defineProperty(window, 'location', {
    configurable: true,
    writable: true,
    value: realLocation,
  });
});

describe('getApiBaseUrl', () => {
  it('targets :8081 when served by the Vite dev server', () => {
    setLocation('http://localhost:5173/sensor-info');
    expect(getApiBaseUrl()).toBe('http://localhost:8081');
  });

  it('targets :8081 when served by the static GUI server', () => {
    setLocation('http://192.168.1.50:3000/boards');
    expect(getApiBaseUrl()).toBe('http://192.168.1.50:8081');
  });

  it('uses same-origin behind a proxy on the default HTTPS port', () => {
    setLocation('https://daq-server.starberkeley.org/boards');
    expect(getApiBaseUrl()).toBe('https://daq-server.starberkeley.org');
  });

  it('uses same-origin behind a proxy on the default HTTP port', () => {
    setLocation('http://daq.internal/');
    expect(getApiBaseUrl()).toBe('http://daq.internal');
  });
});

describe('getWebSocketFallbackUrls', () => {
  it('offers host and loopback candidates on a direct port', () => {
    setLocation('http://192.168.1.50:3000/');
    expect(getWebSocketFallbackUrls()).toEqual([
      'ws://192.168.1.50:8081',
      'ws://localhost:8081',
      'ws://127.0.0.1:8081',
    ]);
  });

  it('offers only the proxied path behind a proxy', () => {
    // The loopback fallbacks must NOT appear here: they would point at the
    // viewer's own machine, not the server.
    setLocation('https://daq-server.starberkeley.org/boards');
    expect(getWebSocketFallbackUrls()).toEqual([
      'wss://daq-server.starberkeley.org/ws',
    ]);
  });
});
