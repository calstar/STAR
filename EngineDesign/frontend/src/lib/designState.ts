/**
 * The half of a design that does not live in the backend config.
 *
 * Most of what you type into this app never reached the stored design. The
 * design payload was the backend session config, and `PintleEngineConfig` has
 * no section for controller commands, time-series pressure profiles, the flight
 * tab's atmosphere and apogee targets, Layer 4's vehicle definition, the layer
 * run settings, or a plot definition. Those lived in React state and were gone
 * on reload -- which is what "I changed it and it didn't save" actually meant.
 *
 * Rather than grow the physics schema with UI-only fields, the stored payload
 * became `{config, ui}` and panels register their slice of `ui` here. The
 * designs bar reads every slice on its autosave tick and writes them back on
 * load or restore.
 *
 * What belongs here: values the user authored that shape a design or a run.
 * What does not: view state (which tab, which sections are open, chart series)
 * -- that is per-user and goes to lib/viewState.ts, never into a shared design.
 * That separation is the rule commit 8b050885 established for these tools, and
 * it is what stops a collapsed card from showing up as somebody's edit.
 */

import { useEffect, useRef } from 'react';

/** `{ sliceName: sliceValue }` -- opaque JSON, stored next to the config. */
export type UiState = Record<string, unknown>;

interface Slice {
  read: () => unknown;
  write: (value: unknown) => void;
}

const slices = new Map<string, Slice>();

/**
 * Register one panel's state as part of the design.
 *
 * `value` is read on every autosave tick and `setValue` is called when a design
 * is opened or a version restored. Register only *committed* state: the
 * keystroke buffers in PressureProfileForm and SegmentCurveBuilder commit into
 * their parent on blur, and registering those instead would mark the design
 * dirty on every keypress.
 */
export function useDesignState<T>(
  key: string,
  value: T,
  setValue: (value: T) => void,
): void {
  // Through a ref so the registration effect runs once per key, not on every
  // change -- and so the registered reader always sees the latest value.
  const live = useRef({ value, setValue });
  // Refreshed after commit rather than during render: the registered reader is
  // only ever called from the designs bar's autosave tick, long after, so a
  // post-commit update is exactly as fresh and does not touch a ref mid-render.
  useEffect(() => {
    live.current = { value, setValue };
  });

  useEffect(() => {
    slices.set(key, {
      read: () => live.current.value,
      write: (v) => live.current.setValue(v as T),
    });
    return () => {
      slices.delete(key);
    };
  }, [key]);
}

/**
 * One field's `[value, setter]`, exactly as `useState` returns it.
 *
 * The setter is typed to take `never` so a `(v: CommandMode) => void` is
 * assignable: parameters are contravariant, and this is a bag of differently
 * typed fields. `useDesignSlice` casts once, at the single call site below.
 */
export type DesignField = readonly [unknown, (value: never) => void];

/**
 * Register a whole panel's fields at once.
 *
 * The panels hold a dozen or more separate `useState` values each, so this
 * takes them as a record and does the reading and writing, rather than making
 * every panel hand-write a snapshot object and a matching distribute function:
 *
 *     useDesignSlice('controller', {
 *       duration: [duration, setDuration],
 *       dt: [dt, setDt],
 *     })
 *
 * Fields missing from the stored slice are left alone, so a design saved before
 * a field existed does not blank it out.
 */
export function useDesignSlice(key: string, fields: Record<string, DesignField>): void {
  const live = useRef(fields);
  useEffect(() => {
    live.current = fields;
  });

  useEffect(() => {
    slices.set(key, {
      read: () => {
        const out: Record<string, unknown> = {};
        for (const [name, [value]] of Object.entries(live.current)) out[name] = value;
        return out;
      },
      write: (stored) => {
        if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return;
        const o = stored as Record<string, unknown>;
        for (const [name, [, set]] of Object.entries(live.current)) {
          if (Object.prototype.hasOwnProperty.call(o, name)) {
            (set as (value: unknown) => void)(o[name]);
          }
        }
      },
    });
    return () => {
      slices.delete(key);
    };
  }, [key]);
}

/** Every registered slice, for storing next to the config. */
export function snapshotUiState(): UiState {
  const out: UiState = {};
  for (const [key, slice] of slices) out[key] = slice.read();
  return out;
}

/**
 * Push a stored `ui` back into the panels that own it.
 *
 * Slices absent from `ui` are left alone rather than reset: a design saved
 * before a panel existed must not blank that panel out.
 */
export function applyUiState(ui: UiState | undefined | null): void {
  if (!ui) return;
  for (const [key, slice] of slices) {
    if (Object.prototype.hasOwnProperty.call(ui, key)) slice.write(ui[key]);
  }
}
