/**
 * Wait for batched sensor writes in lib/store.ts to reach Zustand state.
 * Flush uses FLUSH_INTERVAL_MS (100ms) and requestAnimationFrame; 250ms is
 * enough margin for Vitest/jsdom timer scheduling (see data-flow tests).
 */
export function waitForSensorFlush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 250));
}
