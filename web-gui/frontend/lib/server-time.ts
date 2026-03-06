/**
 * Server Time Synchronization
 *
 * Tracks the offset between the local browser clock (Date.now()) and the
 * backend server's timestamp, which is included in every WebSocket message.
 * This guarantees that all connected clients render plots and data at the
 * exact same T+ time regardless of local clock drift.
 */

let serverTimeOffset = 0;
let offsetInitialized = false;

/**
 * Update the offset based on a timestamp received from the backend.
 * Called automatically by WebSocketClient on every message.
 */
export function updateServerTimeOffset(serverTimestamp: number) {
    const localNow = Date.now();
    const currentOffset = serverTimestamp - localNow;

    if (!offsetInitialized) {
        serverTimeOffset = currentOffset;
        offsetInitialized = true;
    } else {
        // Smoothed EMA to prevent jumping from network jitter
        serverTimeOffset = serverTimeOffset * 0.95 + currentOffset * 0.05;
    }
}

/**
 * Gets the current synchronized time in milliseconds.
 * Use this everywhere instead of Date.now() for time-series plots and caching.
 */
export function getServerTimeNow(): number {
    if (!offsetInitialized) return Date.now();
    return Date.now() + serverTimeOffset;
}
