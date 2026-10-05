import { useEffect, useState, type ReactNode } from 'react';
import { TimeContext } from './hooks';
import { createTimeStore, type TimeEvent, type TimeStore } from './store';

/**
 * Puts a TimeStore under a Burn page. Pass `store` to own it from outside (the shell keeps one
 * across page switches so the cursor survives a tab change); otherwise one is made here, and
 * paused on unmount. `series` and `events`, when given, are pushed into the store as they change.
 */
export function TimeProvider({ store, series, events, children }: {
  store?: TimeStore;
  series?: readonly number[];
  events?: readonly TimeEvent[];
  children: ReactNode;
}) {
  // Cheap enough to make even when unused, which keeps `active` defined if `store` comes and goes.
  const [own] = useState(createTimeStore);
  const active = store ?? own;

  // Pause, not destroy: StrictMode unmounts and remounts once in development, and a destroyed
  // store would come back dead. Paused, nothing is left running.
  useEffect(() => () => own.setPlaying(false), [own]);
  useEffect(() => {
    if (series) active.setSeries(series);
  }, [active, series]);
  useEffect(() => {
    if (events) active.setEvents(events);
  }, [active, events]);

  return <TimeContext.Provider value={active}>{children}</TimeContext.Provider>;
}
