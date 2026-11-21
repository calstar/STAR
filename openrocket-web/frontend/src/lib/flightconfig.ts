/**
 * Flight-configuration-dependent settings, as OpenRocket 24.12 keeps them:
 * stage separation (AxialStage.getSeparationConfigurations), recovery deployment
 * (RecoveryDevice.getDeploymentConfigurations) and motor ignition
 * (MotorConfiguration). Pure functions over the document; the Motors &
 * Configuration tab is a view of these.
 *
 * Each separation / deployment is a FlightConfigurableParameterSet: a default
 * (the component's own `separationevent`/`deployevent`... params) plus
 * per-configuration overrides (`separationconfiguration` / `deploymentconfiguration`
 * lists keyed by `configid`). A configuration resolves to its override if it
 * has one, else the default -- orweb/document.py flight_events, which the
 * backend tests hold to OpenRocket itself.
 *
 * Event values are the .ork's names: the Java enum name, lower-case, without
 * underscores (OpenRocketSaver.enumToXMLName; DocumentConfig.findEnum reads
 * nothing else, so `upper_ignition` would be dropped with a warning).
 */
import type { Component, MotorConfig, ParamValue, Params, RocketDocument } from '../types'
import { walk } from './tree'
import { motorMount } from './params'

export interface EventOption { value: string; label: string; short: string }

/** StageSeparationConfiguration.SeparationEvent, in enum order (the dialog's combo). */
export const SEPARATION_EVENTS: EventOption[] = [
  { value: 'launch', label: 'Launch', short: 'Launch' },
  { value: 'ignition', label: 'Current stage motor ignition', short: 'Current stage motor ignition' },
  { value: 'burnout', label: 'Current stage motor burnout', short: 'Current stage motor burnout' },
  { value: 'ejection', label: 'Current stage ejection charge', short: 'Current stage ejection charge' },
  { value: 'upperignition', label: 'Upper stage motor ignition', short: 'Upper stage motor ignition' },
  { value: 'altitudeascending', label: 'Specific altitude during ascent', short: 'Specific altitude during ascent' },
  { value: 'apogee', label: 'Apogee', short: 'Apogee' },
  { value: 'altitudedescending', label: 'Specific altitude during descent', short: 'Specific altitude during descent' },
  { value: 'never', label: 'Never', short: 'Never' },
]

/** DeploymentConfiguration.DeployEvent (24.12 has no CURRENT_STAGE_SEPARATION). */
export const DEPLOY_EVENTS: EventOption[] = [
  { value: 'launch', label: 'Launch (plus NN seconds)', short: 'Launch' },
  { value: 'ejection', label: 'First ejection charge of this stage', short: 'Ejection charge' },
  { value: 'apogee', label: 'Apogee', short: 'Apogee' },
  { value: 'altitude', label: 'Specific altitude during descent', short: 'Altitude' },
  { value: 'lowerstageseparation', label: 'Lower stage separation', short: 'Lower stage separation' },
  { value: 'never', label: 'Never', short: 'Never' },
]

/** IgnitionEvent. */
export const IGNITION_EVENTS: EventOption[] = [
  { value: 'automatic', label: 'Automatic (launch or ejection charge)', short: 'Automatic' },
  { value: 'launch', label: 'Launch', short: 'Launch' },
  { value: 'ejectioncharge', label: 'First ejection charge of previous stage', short: 'Ejection charge' },
  { value: 'burnout', label: 'First burnout of previous stage', short: 'Burnout' },
  { value: 'never', label: 'Never', short: 'Never' },
]

/** The .ork name of an event, whatever spelling a document carries (`UPPER_IGNITION`, `upper_ignition`). */
export function normEvent(v: unknown, fallback: string): string {
  return typeof v === 'string' && v.trim() ? v.trim().toLowerCase().replace(/_/g, '') : fallback
}

export function eventOption(list: EventOption[], v: string): EventOption {
  return list.find((o) => o.value === v) ?? { value: v, label: v, short: v }
}

// ---------------------------------------------------------------- separation / deployment

export type EventKind = 'separation' | 'deployment'

export interface EventSetting { event: string; altitude: number; delay: number }

const KEYS = {
  separation: { list: 'separationconfiguration', event: 'separationevent', altitude: 'separationaltitude', delay: 'separationdelay' },
  deployment: { list: 'deploymentconfiguration', event: 'deployevent', altitude: 'deployaltitude', delay: 'deploydelay' },
} as const

/** What a component gets when the file writes nothing (the configuration classes' field defaults). */
export const EVENT_DEFAULT: EventSetting = { event: 'ejection', altitude: 200, delay: 0 }

type Override = { configid: string } & Record<string, unknown>

function asNum(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

function overrides(p: Params, kind: EventKind): Override[] {
  const v = p[KEYS[kind].list]
  return Array.isArray(v) ? (v as unknown[]).filter((o): o is Override => !!o && typeof o === 'object' && 'configid' in o) : []
}

/** The component's default (FlightConfigurableParameterSet.getDefault). */
export function defaultEvent(c: Component, kind: EventKind): EventSetting {
  const k = KEYS[kind]
  return {
    event: normEvent(c.params[k.event], EVENT_DEFAULT.event),
    altitude: asNum(c.params[k.altitude], EVENT_DEFAULT.altitude),
    delay: asNum(c.params[k.delay], EVENT_DEFAULT.delay),
  }
}

/** This configuration's override, or null when it uses the default. */
export function overrideEvent(c: Component, kind: EventKind, configId: string): EventSetting | null {
  const k = KEYS[kind]
  const o = overrides(c.params, kind).find((x) => x.configid === configId)
  if (!o) return null
  // A field the element leaves out falls back to the default (flight_events' pick()).
  const base = defaultEvent(c, kind)
  return {
    event: normEvent(o[k.event], base.event),
    altitude: asNum(o[k.altitude], base.altitude),
    delay: asNum(o[k.delay], base.delay),
  }
}

/** FlightConfigurableParameterSet.get(fcid): the override if there is one, else the default. */
export function resolveEvent(c: Component, kind: EventKind, configId: string): EventSetting & { isDefault: boolean } {
  const o = overrideEvent(c, kind, configId)
  return o ? { ...o, isDefault: false } : { ...defaultEvent(c, kind), isDefault: true }
}

function encode(kind: EventKind, configId: string, s: EventSetting): Override {
  const k = KEYS[kind]
  return { configid: configId, [k.event]: s.event, [k.altitude]: s.altitude, [k.delay]: s.delay }
}

/** set(fcid, value): this configuration's override. */
export function setOverride(c: Component, kind: EventKind, configId: string, s: EventSetting): Component {
  const k = KEYS[kind]
  const list = overrides(c.params, kind)
  const i = list.findIndex((o) => o.configid === configId)
  const next = i >= 0 ? list.map((o, j) => (j === i ? encode(kind, configId, s) : o)) : [...list, encode(kind, configId, s)]
  return { ...c, params: { ...c.params, [k.list]: next as unknown as ParamValue } }
}

/** reset(fcid): back to the default ("Reset separation" / "Reset deployment", and a deleted configuration). */
export function clearOverride(c: Component, kind: EventKind, configId: string): Component {
  const k = KEYS[kind]
  const list = overrides(c.params, kind)
  if (!list.some((o) => o.configid === configId)) return c
  const rest = list.filter((o) => o.configid !== configId)
  const params = { ...c.params }
  if (rest.length) params[k.list] = rest as unknown as ParamValue
  else delete params[k.list]
  return { ...c, params }
}

/**
 * setDefault(value). The default's three params go ahead of the override list so
 * the file reads default-then-overrides, as OpenRocket writes it.
 * `clearOverrides`: SeparationSelectionDialog's "all configurations" calls
 * reset() first, dropping every override; DeploymentSelectionDialog's does not.
 */
export function setDefaultEvent(c: Component, kind: EventKind, s: EventSetting, clearOverrides: boolean): Component {
  const k = KEYS[kind]
  const params: Params = {}
  let placed = false
  const put = () => {
    params[k.event] = s.event
    params[k.altitude] = s.altitude
    params[k.delay] = s.delay
    placed = true
  }
  for (const [key, v] of Object.entries(c.params)) {
    if (key === k.event || key === k.altitude || key === k.delay) {
      if (!placed) put()
      continue
    }
    if (key === k.list) {
      if (!placed) put()
      if (!clearOverrides) params[key] = v
      continue
    }
    params[key] = v
  }
  if (!placed) put()
  return { ...c, params }
}

// ---------------------------------------------------------------- the components the tabs list

export function isStage(c: Component): boolean {
  return c.type === 'stage' || c.type === 'parallelstage'
}

export function isRecovery(c: Component): boolean {
  return c.type === 'parachute' || c.type === 'streamer'
}

/** Every stage with its OpenRocket stage number (depth-first, the sustainer is 0). */
export function stageList(doc: RocketDocument): { stage: Component; number: number }[] {
  const out: { stage: Component; number: number }[] = []
  walk(doc.rocket, (c) => {
    if (isStage(c)) out.push({ stage: c, number: out.length })
  })
  return out
}

/** The Stages sub-tab's columns: SeparationConfigurationPanel lists stages numbered above 0. */
export function separableStages(doc: RocketDocument): Component[] {
  return stageList(doc).filter((s) => s.number > 0).map((s) => s.stage)
}

export function recoveryDevices(doc: RocketDocument): Component[] {
  const out: Component[] = []
  walk(doc.rocket, (c) => {
    if (isRecovery(c)) out.push(c)
  })
  return out
}

/** The stage number a component belongs to (its nearest stage ancestor). */
export function stageNumberOf(doc: RocketDocument, id: string): number {
  const stages = stageList(doc)
  let found = 0
  const visit = (c: Component, current: number): boolean => {
    const n = isStage(c) ? (stages.find((s) => s.stage.id === c.id)?.number ?? current) : current
    if (c.id === id) {
      found = n
      return true
    }
    return c.children.some((k) => visit(k, n))
  }
  visit(doc.rocket, 0)
  return found
}

/** DeploymentSelectionDialog drops "Lower stage separation" for a device in the bottom stage. */
export function deployEventsFor(doc: RocketDocument, deviceId: string): EventOption[] {
  const bottom = stageNumberOf(doc, deviceId) + 1 === stageList(doc).length
  return bottom ? DEPLOY_EVENTS.filter((o) => o.value !== 'lowerstageseparation') : DEPLOY_EVENTS
}

function mapComponents(root: Component, fn: (c: Component) => Component): Component {
  const c = fn(root)
  const children = c.children.map((k) => mapComponents(k, fn))
  return children.every((k, i) => k === c.children[i]) ? c : { ...c, children }
}

export function updateComponent(doc: RocketDocument, id: string, fn: (c: Component) => Component): RocketDocument {
  return { ...doc, rocket: mapComponents(doc.rocket, (c) => (c.id === id ? fn(c) : c)) }
}

// ---------------------------------------------------------------- the selection dialogs' OK

/** "Override for the {config} flight configuration only" vs "Change all configurations using the default ...". */
export type Scope = 'config' | 'all'

export function applySeparation(doc: RocketDocument, stageId: string, configId: string, s: EventSetting, scope: Scope): RocketDocument {
  // SeparationSelectionDialog: NEVER separates with no delay.
  const v = s.event === 'never' ? { ...s, delay: 0 } : s
  return updateComponent(doc, stageId, (c) =>
    scope === 'all' ? setDefaultEvent(c, 'separation', v, true) : setOverride(c, 'separation', configId, v),
  )
}

export function applyDeployment(doc: RocketDocument, deviceId: string, configId: string, s: EventSetting, scope: Scope): RocketDocument {
  return updateComponent(doc, deviceId, (c) =>
    scope === 'all' ? setDefaultEvent(c, 'deployment', s, false) : setOverride(c, 'deployment', configId, s),
  )
}

export function resetEvent(doc: RocketDocument, kind: EventKind, id: string, configId: string): RocketDocument {
  return updateComponent(doc, id, (c) => clearOverride(c, kind, configId))
}

/** OpenRocket's preselection: "override" when the configuration has its own value. */
export function initialScope(c: Component, kind: EventKind, configId: string): Scope {
  return overrideEvent(c, kind, configId) ? 'config' : 'all'
}

// ---------------------------------------------------------------- ignition

export interface IgnitionSetting { event: string; delay: number }

/** The mount's default ignition (<motormount><ignitionevent/><ignitiondelay/>). */
export function mountIgnition(mount: Component): IgnitionSetting {
  const mm = motorMount(mount.params) ?? {}
  return { event: normEvent(mm.ignitionevent, 'automatic'), delay: asNum(mm.ignitiondelay, 0) }
}

/** A loaded motor's ignition (each MotorConfiguration carries its own; the file writes it per configuration). */
export function motorIgnition(doc: RocketDocument, configId: string, mount: Component): IgnitionSetting | null {
  const m = doc.motorConfigs.find((c) => c.id === configId)?.motors[mount.id]
  if (!m) return null
  const d = mountIgnition(mount)
  return { event: normEvent(m.ignitionEvent, d.event), delay: asNum(m.ignitionDelay, d.delay) }
}

function setMountDefault(doc: RocketDocument, mountId: string, s: IgnitionSetting): RocketDocument {
  return updateComponent(doc, mountId, (c) => ({
    ...c,
    params: { ...c.params, motormount: { ...(motorMount(c.params) ?? {}), ignitionevent: s.event, ignitiondelay: s.delay } },
  }))
}

function setMotorsIgnition(doc: RocketDocument, mountId: string, s: IgnitionSetting, only: string | null): RocketDocument {
  return {
    ...doc,
    motorConfigs: doc.motorConfigs.map((cfg) => {
      const m = cfg.motors[mountId]
      if (!m || (only !== null && cfg.id !== only)) return cfg
      return { ...cfg, motors: { ...cfg.motors, [mountId]: { ...m, ignitionEvent: s.event, ignitionDelay: s.delay } } }
    }),
  }
}

/**
 * IgnitionSelectionDialog's OK. "All configurations" sets the mount's default
 * and every loaded motor of that mount; "this configuration only" sets the one
 * motor. On a configuration with no motor in the mount the dialog edits the
 * mount's default instance (MotorConfigurationSet.get falls back to it), so
 * that is what changes.
 */
export function applyIgnition(doc: RocketDocument, mountId: string, configId: string, s: IgnitionSetting, scope: Scope): RocketDocument {
  const loaded = !!doc.motorConfigs.find((c) => c.id === configId)?.motors[mountId]
  if (scope === 'all') return setMotorsIgnition(setMountDefault(doc, mountId, s), mountId, s, null)
  if (!loaded) return setMountDefault(doc, mountId, s)
  return setMotorsIgnition(doc, mountId, s, configId)
}

/** The dialog's preselection: isDefault = curMotorInstance.isEmpty(). */
export function initialIgnitionScope(doc: RocketDocument, mountId: string, configId: string): Scope {
  return doc.motorConfigs.find((c) => c.id === configId)?.motors[mountId] ? 'config' : 'all'
}

/**
 * "Reset ignition": MotorConfiguration.useDefaultIgnition() in 24.12 sets the
 * motor to Automatic + 0 s -- not to the mount's default -- and the saver then
 * writes that per configuration. Reproduced as OpenRocket does it.
 */
export const RESET_IGNITION: IgnitionSetting = { event: 'automatic', delay: 0 }

export function resetIgnition(doc: RocketDocument, mountId: string, configId: string): RocketDocument {
  return setMotorsIgnition(doc, mountId, RESET_IGNITION, configId)
}

// ---------------------------------------------------------------- configurations

/** A new FlightConfiguration: no name (named after its motors), every stage active, no motors. */
export function newConfig(doc: RocketDocument, id: string): MotorConfig {
  const stages: Record<string, boolean> = {}
  for (const s of stageList(doc)) stages[String(s.number)] = true
  if (!Object.keys(stages).length) stages['0'] = true
  return { id, name: '', stages, motors: {} }
}

/**
 * Duplicate Configuration: FlightConfiguration.copy (name, stage activeness,
 * motors with their ignition) and every component's copyFlightConfiguration,
 * which stores the source's *resolved* separation / deployment as an override
 * of the copy -- so the copy keeps flying the same events if a default changes later.
 */
export function duplicateConfig(doc: RocketDocument, sourceId: string, newId: string): RocketDocument {
  const src = doc.motorConfigs.find((c) => c.id === sourceId)
  if (!src) return doc
  const copy: MotorConfig = { ...structuredClone(src), id: newId, default: false }
  const stageNo = new Map(stageList(doc).map((s) => [s.stage.id, s.number]))
  const rocket = mapComponents(doc.rocket, (c) => {
    // AxialStageSaver writes separations for stages above 0 only.
    if (isStage(c) && (stageNo.get(c.id) ?? 0) > 0) {
      const r = resolveEvent(c, 'separation', sourceId)
      return setOverride(c, 'separation', newId, { event: r.event, altitude: r.altitude, delay: r.delay })
    }
    if (isRecovery(c)) {
      const r = resolveEvent(c, 'deployment', sourceId)
      return setOverride(c, 'deployment', newId, { event: r.event, altitude: r.altitude, delay: r.delay })
    }
    return c
  })
  const at = doc.motorConfigs.findIndex((c) => c.id === sourceId)
  const motorConfigs = [...doc.motorConfigs.slice(0, at + 1), copy, ...doc.motorConfigs.slice(at + 1)]
  return { ...doc, rocket, motorConfigs, selectedConfig: newId }
}

/** Rocket.removeFlightConfiguration: the configuration and every component's override for it. */
export function deleteConfig(doc: RocketDocument, configId: string): RocketDocument {
  const at = doc.motorConfigs.findIndex((c) => c.id === configId)
  if (at < 0) return doc
  const motorConfigs = doc.motorConfigs.filter((c) => c.id !== configId)
  const rocket = mapComponents(doc.rocket, (c) =>
    isStage(c) ? clearOverride(c, 'separation', configId) : isRecovery(c) ? clearOverride(c, 'deployment', configId) : c,
  )
  const selectedConfig =
    doc.selectedConfig === configId ? (motorConfigs[Math.min(at, motorConfigs.length - 1)]?.id ?? null) : doc.selectedConfig
  return { ...doc, rocket, motorConfigs, selectedConfig }
}

// ---------------------------------------------------------------- stage activeness (the ribbon's Stages: buttons)

export function isStageActive(cfg: MotorConfig | undefined, number: number): boolean {
  if (!cfg) return true
  const v = cfg.stages[String(number)]
  return v === undefined ? true : v
}

/**
 * FlightConfiguration.toggleStage: flip the stage and set its sub-stages
 * (stages nested inside it, e.g. parallel boosters) to the same.
 */
export function toggleStage(doc: RocketDocument, configId: string, number: number): RocketDocument {
  const list = stageList(doc)
  const entry = list.find((s) => s.number === number)
  if (!entry) return doc
  const subs: number[] = []
  walk(entry.stage, (c) => {
    if (c !== entry.stage && isStage(c)) subs.push(list.find((s) => s.stage.id === c.id)!.number)
  })
  return {
    ...doc,
    motorConfigs: doc.motorConfigs.map((cfg) => {
      if (cfg.id !== configId) return cfg
      const on = !isStageActive(cfg, number)
      const stages = { ...cfg.stages }
      for (const s of list) if (stages[String(s.number)] === undefined) stages[String(s.number)] = true
      stages[String(number)] = on
      for (const n of subs) stages[String(n)] = on
      return { ...cfg, stages }
    }),
  }
}

/** OpenRocket disables the button of the only active stage (and of a stage with no children). */
export function stageButtonEnabled(doc: RocketDocument, cfg: MotorConfig | undefined, number: number): boolean {
  const list = stageList(doc)
  const entry = list.find((s) => s.number === number)
  if (!entry || entry.stage.children.length === 0) return false
  const activeCount = list.filter((s) => isStageActive(cfg, s.number) && s.stage.children.length > 0).length
  return !(isStageActive(cfg, number) && activeCount <= 1)
}

/** For tests: what flight_events(doc, config) in orweb/document.py returns. */
export function flightEvents(doc: RocketDocument, configId: string): { id: string; kind: string; event: string | undefined; altitude?: number; delay: number | undefined }[] {
  const cfg = doc.motorConfigs.find((c) => c.id === configId)
  if (!cfg) throw new Error(`no configuration ${configId}`)
  const out: { id: string; kind: string; event: string | undefined; altitude?: number; delay: number | undefined }[] = []
  walk(doc.rocket, (c) => {
    if (isStage(c)) {
      const r = resolveEvent(c, 'separation', configId)
      out.push({ id: c.id, kind: 'separation', event: r.event, altitude: r.altitude, delay: r.delay })
    } else if (isRecovery(c)) {
      const r = resolveEvent(c, 'deployment', configId)
      out.push({ id: c.id, kind: 'deployment', event: r.event, altitude: r.altitude, delay: r.delay })
    } else if (motorMount(c.params) && cfg.motors[c.id]) {
      const m = cfg.motors[c.id]
      out.push({ id: c.id, kind: 'ignition', event: m.ignitionEvent, delay: m.ignitionDelay })
    }
  })
  return out
}
