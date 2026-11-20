/**
 * Sync actuator commanded overrides across all tabs/windows (main + popups).
 * Uses localStorage so every pane sees the same overrides; storage event
 * notifies other windows when one window changes overrides.
 */

const STORAGE_KEY = 'sensor_system_actuator_commanded_overrides';

export type StoredOverrides = Record<string, number>;

export function persistActuatorOverrides(overrides: Record<string, number>): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
  } catch {
    // ignore quota / private mode
  }
}

export function getStoredOverrides(): StoredOverrides {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: StoredOverrides = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'number' && (v === 0 || v === 1 || v === 2)) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Call once at app load. Hydrates from localStorage and subscribes to
 * storage events so other windows' changes apply to this window.
 */
export function initActuatorOverridesSync(applyOverrides: (overrides: StoredOverrides) => void): () => void {
  if (typeof window === 'undefined') return () => {};
  applyOverrides(getStoredOverrides());
  const onStorage = (e: StorageEvent) => {
    if (e.key !== STORAGE_KEY || e.newValue == null) return;
    try {
      const overrides = JSON.parse(e.newValue) as StoredOverrides;
      applyOverrides(overrides);
    } catch {
      // ignore
    }
  };
  window.addEventListener('storage', onStorage);
  return () => window.removeEventListener('storage', onStorage);
}
