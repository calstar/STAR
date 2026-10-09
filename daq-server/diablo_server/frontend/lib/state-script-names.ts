// Re-export of the shared name-checking helpers, so frontend code imports through @/lib like the
// rest of the config tooling does (see lib/config-validation.ts). The implementation lives in
// diablo_server/shared so the Start-button gate and the browser agree by construction rather than
// by review.
export * from '../../shared/state-script-names.js';
