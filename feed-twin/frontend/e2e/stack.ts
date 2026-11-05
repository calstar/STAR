/**
 * Where the end-to-end stack listens. Shared by playwright.config.ts, which
 * boots it, and the specs, which talk to its API directly.
 *
 * Ports of its own, not dev.sh's 8003/5177 or the demo's 8103/5277: the demo
 * path spec empties the library it is pointed at, so it must only ever be
 * pointed at the throwaway one this config starts.
 */
export const API_PORT = Number(process.env.FEEDTWIN_E2E_API_PORT ?? 8203);
export const UI_PORT = Number(process.env.FEEDTWIN_E2E_UI_PORT ?? 5377);
export const API = `http://127.0.0.1:${API_PORT}`;
