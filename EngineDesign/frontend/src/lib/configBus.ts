import { useEffect } from 'react';

/**
 * Lightweight global "engine config changed" bus (INJECTOR_PARITY_PLAN W5).
 *
 * When the user switches injector/propellant (or otherwise mutates the backend config), any component
 * that derives injector-dependent UI (frozen-param fields, geometry editor, schema-driven forms) must
 * re-fetch — even though tabs hold their own state and don't all receive the config via props. Emitting
 * one window event and subscribing via `useConfigChanged` decouples this without prop-drilling, so the
 * fix generalizes across the whole app instead of being wired per-component.
 */

const EVENT = 'engine-config-changed';

export function emitConfigChanged(detail?: unknown): void {
  window.dispatchEvent(new CustomEvent(EVENT, { detail }));
}

/** Subscribe to config-changed events. `cb` runs on every switch/config mutation. */
export function useConfigChanged(cb: () => void): void {
  useEffect(() => {
    const handler = () => cb();
    window.addEventListener(EVENT, handler);
    return () => window.removeEventListener(EVENT, handler);
  }, [cb]);
}
