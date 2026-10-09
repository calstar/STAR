/**
 * The drawing's hookup, loaded and saved: shared by the Hookup page (the
 * regulator knobs) and the P&ID tab's symbol panel (which actuator drives
 * each valve, what the console calls things). On a stand the hookup is the
 * stand's, kept with it; off one it is the drawing's own, in the library.
 *
 * Console names apply live; a change of wiring or knobs reopens the stand
 * bound the new way, as it always has.
 */

import { useEffect, useMemo, useState } from 'react';
import { getHookup, resetHookup, saveHookup, type Hookup, type HookupBody } from '../api';
import { useStand } from '../stand';

export function useHookup() {
  const { where, restart, standDoc, standHookup, setStandHookup, locked, setAliases, setup, model } = useStand();
  // Rocket only: the wiring shown is what the stand runs on the rocket alone.
  const ignoreGse = Boolean(setup.ignore_gse);
  const at = { ...where, ignoreGse };
  const onStand = Boolean(standDoc);
  const [data, setData] = useState<Hookup | null>(null);
  const [draft, setDraft] = useState<HookupBody | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!where.diagram) return;
    setError('');
    getHookup(at)
      .then((h) => {
        const own = standHookup as unknown as HookupBody | null;
        const shown = own ? { ...h, hookup: own, saved: true } : h;
        setData(shown);
        setDraft(structuredClone(shown.hookup));
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [where.diagram, where.engine, standHookup, ignoreGse]);

  const dirty = useMemo(
    () => Boolean(data && draft && JSON.stringify(data.hookup) !== JSON.stringify(draft)),
    [data, draft],
  );
  // Only the console names changed: the stand takes them live, no reopen.
  const namesOnly = Boolean(
    data &&
      draft &&
      JSON.stringify(data.hookup.valves) === JSON.stringify(draft.valves) &&
      JSON.stringify(data.hookup.knobs) === JSON.stringify(draft.knobs),
  );

  const keep = (hookup: HookupBody, reopen = true) => {
    if (!data) return;
    setData({ ...data, hookup, saved: true });
    setDraft(structuredClone(hookup));
    setStandHookup(hookup as unknown as Record<string, unknown>, reopen);
    if (!reopen) setAliases(hookup.aliases ?? {});
  };

  const act = async (run: () => Promise<Hookup>, reopen = true) => {
    setBusy(true);
    setError('');
    try {
      const h = await run();
      setData(h);
      setDraft(structuredClone(h.hookup));
      if (reopen) restart(); // the stand reopens bound the new way
      else setAliases(h.hookup.aliases ?? {});
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const save = () => {
    if (!data || !draft) return;
    if (onStand) keep(draft, !namesOnly);
    else void act(() => saveHookup(at, draft), !namesOnly);
  };
  const reset = () => {
    if (!data) return;
    if (onStand) keep(data.suggested);
    else void act(() => resetHookup(at));
  };
  const discard = () => data && setDraft(structuredClone(data.hookup));

  const setAlias = (id: string, value: string) => {
    if (!draft) return;
    const aliases = { ...(draft.aliases ?? {}) };
    if (value.trim()) aliases[id] = value;
    else delete aliases[id];
    setDraft({ ...draft, aliases });
  };

  /** The actuator that drives a valve under the draft, '' for none: a pin
   *  wins; otherwise what the twin matched, unless that actuator was pinned
   *  somewhere else. */
  const driverOf = (valve: string): string => {
    if (!data || !draft) return '';
    for (const [actuator, pinned] of Object.entries(draft.valves)) if (pinned === valve) return actuator;
    for (const [actuator, bound] of Object.entries(data.bound)) {
      if (bound === valve && !(actuator in draft.valves)) return actuator;
    }
    return '';
  };

  /** Have `actuator` drive `valve` ('' : nothing drives it). Whatever drove
   *  it before is pinned to no valve, so two actuators never fight over one. */
  const drive = (valve: string, actuator: string) => {
    if (!draft) return;
    const valves = { ...draft.valves };
    const before = driverOf(valve);
    if (before && before !== actuator) valves[before] = '';
    if (actuator) valves[actuator] = valve;
    setDraft({ ...draft, valves });
  };

  /** A valve's tag, with its page on a drawing of several. */
  const valveLabel = (id: string) => {
    const v = data?.valves.find((x) => x.id === id);
    if (v) return `${v.label}${data && data.pages.length > 1 ? ` · ${v.page}` : ''}`;
    // Rocket only, a vent can be bound to the rocket's capped disconnect,
    // which the whole drawing mates rather than lists as a valve.
    const a = model?.actuators.find((x) => x.id === id);
    return a ? `${a.tag}${model?.pages?.[id] ? ` · ${model.pages[id]}` : ''}` : id;
  };

  return {
    data,
    draft,
    setDraft,
    error,
    busy,
    dirty,
    namesOnly,
    onStand,
    locked,
    save,
    reset,
    discard,
    setAlias,
    driverOf,
    drive,
    valveLabel,
  };
}
