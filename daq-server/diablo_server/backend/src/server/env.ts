/**
 * server/env.ts — the backend process's environment knobs, read once.
 *
 * Owns nothing but these constants. Every other module takes a knob from here rather than
 * reading process.env itself (STYLE-S20 as amended by D44(1)); the two exceptions are kept
 * where they are: SEQUENCER_PORT belongs to sequencer-client.ts, which dials it, and USE_SIM is
 * read per call in elodin-link.ts's isSimulated(), verbatim. No disk, clock, log or socket at
 * import (DESIGN-WP6 M1). Never imports api-server.ts or api/*.
 *
 * Contract: the variable names are read by the systemd units, dev.sh, test_integration.sh and
 * the characterization harnesses (pipeline/run.sh, lifecycle.py); never renamed.
 */

export const WS_PORT = parseInt(process.env.WS_PORT ?? '8081', 10);
export const ELODIN_HOST = process.env.ELODIN_HOST ?? '127.0.0.1';
export const ELODIN_PORT = parseInt(process.env.ELODIN_PORT ?? '2240', 10);
export const THIN_VERBOSE_CONNECTION_LOG = process.env.THIN_VERBOSE_CONNECTION_LOG === '1';
export const THIN_HEARTBEAT_DIAG_LOG = process.env.THIN_HEARTBEAT_DIAG_LOG === '1';
export const THIN_STATS_LOG = process.env.THIN_STATS_LOG === '1';
// Serve the built SPA (frontend/dist) on GUI_PORT; 0 disables.
export const GUI_PORT = parseInt(process.env.GUI_PORT ?? '3000', 10);
