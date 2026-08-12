/**
 * Backend client. Same `ApiResponse<T>` shape EngineDesign uses, so anyone
 * moving between the two apps reads the same error handling.
 *
 * Vite proxies /api to localhost:8100 (PLAN.md §11.1 -- distinct ports are
 * load-bearing, EngineDesign owns 8000/5173 and force-kills its own).
 *
 * Every endpoint here falls back to a local fixture when the backend is
 * absent, and reports which one it used via `stub`. The physics is being
 * written in parallel, so "no backend yet" is the expected state, not an
 * error state -- but it must be *visible*, never silent.
 */

import type { Climatology } from '../types/climatology'
import type { Kind } from '../lib/quantities'
import type {
  ChartSample, Config, Result, TrajectorySample,
} from '../types/schema'
import bundledClimatology from '../fixtures/climatology.json'
import { stubResult } from './fixture'

export const API_BASE = '/api'

/**
 * Why every request is on a timeout.
 *
 * Vite's dev proxy does NOT fail fast when its target is down -- with nothing
 * on :8100 it accepts the connection and then hangs forever rather than
 * returning a 502. So `fetch` never rejects, and without a deadline the UI
 * sits on "Running…" indefinitely instead of falling back to the fixture.
 * Since "no backend yet" is the *expected* state while the physics is written
 * in parallel, that is the common path, not an edge case.
 *
 * 6 s is far longer than any real response: §11.5 puts all four cases under
 * 100 ms, and a 16-corner sweep at 23 ms each is 0.4 s.
 */
const TIMEOUT_MS = 6000
/** The health probe only gates a status dot, so it should not make the header
 *  sit on "Connecting…" for six seconds on every cold load. */
const HEALTH_TIMEOUT_MS = 2500
/** The station lookup is the only route that leaves the process. See
 *  `getStationPad` for why it does not share the 6 s budget. */
const STATION_TIMEOUT_MS = 10_000
/** Reading and writing a fifteen-key JSON file. It fires on every preference
 *  change, and there is a localStorage fallback behind it, so waiting six
 *  seconds to discover the backend is down would be six seconds wasted. */
const SETTINGS_TIMEOUT_MS = 3000

/**
 * Distinguishes "nobody answered" from "the backend answered no".
 *
 * The difference decides whether falling back to a fixture is honest. If the
 * backend rejected a config -- schema.py sets `extra="forbid"` and validates
 * triggers against the start altitude -- then quietly showing fake output
 * would hide the one thing worth seeing.
 */
export type FailureKind = 'unreachable' | 'rejected'

export interface ApiResponse<T> {
  data?: T
  error?: string
  kind?: FailureKind
  /** HTTP status, when there was a response at all. */
  status?: number
  /** True when the payload came from a bundled fixture, not the backend. */
  stub?: boolean
}

/** One FastAPI validation error, as it appears inside a 422 `detail` array. */
interface ValidationError {
  loc?: (string | number)[]
  msg?: string
}

/**
 * Flatten whatever FastAPI put in `detail` into a single displayable string.
 *
 * `detail` is a plain string for HTTPException, but an array of
 * {type, loc, msg, input} for a 422. The array form is the useful one -- it
 * names the offending field -- so it is rendered as "vehicle.m: greater than 0"
 * rather than discarded.
 */
function describeDetail(detail: unknown, response: Response): string {
  if (typeof detail === 'string' && detail) return detail
  if (Array.isArray(detail) && detail.length) {
    return (detail as ValidationError[])
      .map((d) => {
        // loc[0] is always "body"; the useful path starts after it.
        const path = (d.loc ?? []).slice(1).join('.')
        return path ? `${path}: ${d.msg ?? 'invalid'}` : (d.msg ?? 'invalid')
      })
      .join('; ')
  }
  return `HTTP ${response.status}: ${response.statusText}`
}

async function request<T>(
  endpoint: string,
  options: RequestInit = {},
  timeoutMs: number = TIMEOUT_MS,
): Promise<ApiResponse<T>> {
  try {
    const response = await fetch(`${API_BASE}${endpoint}`, {
      headers: { 'Content-Type': 'application/json', ...options.headers },
      signal: AbortSignal.timeout(timeoutMs),
      ...options,
    })
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}))
      return {
        // MUST be flattened to a string. FastAPI returns `detail` as an ARRAY
        // of {type, loc, msg, input} objects for a 422, and handing that array
        // to React as a child throws "Objects are not valid as a React child"
        // -- which blanks the whole page. A validation error has to render as
        // a message, not take the app down.
        error: describeDetail(errorData.detail, response),
        // A 404 means the route is not mounted -- an absent backend, or a
        // static host with no API behind it. A 4xx is the backend having an
        // opinion and must surface. A 5xx is ambiguous and gets resolved by
        // the caller: see the health re-probe in simulate().
        kind: response.status === 404 ? 'unreachable' : 'rejected',
        status: response.status,
      }
    }
    return { data: await response.json() }
  } catch (err) {
    const timedOut = err instanceof DOMException && err.name === 'TimeoutError'
    return {
      error: timedOut
        ? `no response from the backend within ${timeoutMs / 1000} s`
        : err instanceof Error ? err.message : 'Network error',
      kind: 'unreachable',
    }
  }
}

export interface Health {
  status: string
  version: string
  git_sha: string
}

/**
 * Last known reachability, so the no-backend path costs nothing.
 *
 * Without this, every keystroke in live-edit mode would wait out the full
 * simulate timeout before showing the fixture -- six seconds per edit, in what
 * is currently the normal state of the app. Once the backend is known absent,
 * `simulate` short-circuits straight to the fixture.
 *
 * It re-probes after RECHECK_MS so that starting the backend mid-session picks
 * up on its own, without needing a page reload.
 */
const RECHECK_MS = 10_000
let backendUp: boolean | null = null
let lastProbe = 0

export async function getHealth() {
  const res = await request<Health>('/health', {}, HEALTH_TIMEOUT_MS)
  backendUp = !res.error
  lastProbe = Date.now()
  return res
}

/** True when it is worth attempting a real request. */
async function backendWorthTrying(): Promise<boolean> {
  if (backendUp === true) return true
  if (backendUp === null || Date.now() - lastProbe > RECHECK_MS) {
    // Read the probe's own answer rather than the module variable: TypeScript
    // has already narrowed `backendUp` to `false | null` on this branch and
    // cannot see that getHealth reassigns it.
    const res = await getHealth()
    return !res.error
  }
  return false
}

/**
 * POST /api/simulate. Falls back to the §11.11 canned fixture.
 *
 * A 4xx is NOT a reason to fall back: the backend rejecting a config is a real
 * answer about that config (schema.py sets `extra="forbid"` and validates
 * triggers against the start altitude), and papering over it with fake output
 * would hide exactly the bug worth seeing. Only an absent backend falls back.
 */
export async function simulate(config: Config): Promise<ApiResponse<Result>> {
  if (!(await backendWorthTrying())) {
    return { data: stubResult(config), stub: true }
  }
  const res = await request<Result>('/simulate', {
    method: 'POST',
    body: JSON.stringify(config),
  })
  if (res.data) return res

  if (res.kind === 'rejected') {
    // A 5xx is genuinely ambiguous. It is either the backend throwing on this
    // config -- which must surface -- or Vite's dev proxy reporting a dead
    // upstream, which it does with a 500 once it has seen the target come up
    // and go away again. Status alone cannot tell them apart, so ask health:
    // if the backend answers, the 500 was about the request.
    if (res.status !== undefined && res.status >= 500) {
      const probe = await getHealth()
      if (probe.error) return { data: stubResult(config), stub: true }
    }
    return res
  }

  backendUp = false
  lastProbe = Date.now()
  return { data: stubResult(config), stub: true }
}

export interface CatalogDevice {
  sku: string
  vendor: string
  name: string
  CdS: number
  D0: number
  m_c: number
  j: number
  /** Hand-entered devices from manual.csv are flagged lower-confidence. */
  manual: boolean
}

/**
 * GET /api/devices?q=. PLAN.md §11.3 calls this the highest-value control in
 * the application, because picking from the list removes the §4.1 trap by
 * construction -- nobody who picks a row can recompute S_p as pi*D^2/4 and
 * silently overstate CdS by 3.2%.
 *
 * The fallback list is four rows so the picker can be exercised. It is NOT the
 * catalog; `physics/data/parachutes.csv` is, and the backend serves it.
 */
export async function searchDevices(
  q: string, vendor = '',
): Promise<ApiResponse<CatalogDevice[]>> {
  const qs = `q=${encodeURIComponent(q)}`
    + (vendor ? `&vendor=${encodeURIComponent(vendor)}` : '')
  const res = (await backendWorthTrying())
    ? await request<CatalogDevice[]>(`/devices?${qs}`)
    : { error: 'backend unreachable', kind: 'unreachable' as const }
  if (res.data) return res
  const needle = q.trim().toLowerCase()
  const hits = STUB_CATALOG.filter(
    (d) => (!vendor || d.vendor === vendor)
      && (!needle || d.name.toLowerCase().includes(needle)
        || d.sku.toLowerCase().includes(needle)))
  return { data: hits, stub: true }
}

/**
 * GET /api/devices/vendors.
 *
 * The catalogue is multi-vendor -- only 68 of 121 rows are Fruity Chutes -- and
 * comparing canopies is nearly always comparing within one line, so the study's
 * canopy picker leads with this rather than making the user type a vendor name
 * into the search box and hope it matches.
 */
export async function listVendors(): Promise<ApiResponse<VendorCount[]>> {
  const res = (await backendWorthTrying())
    ? await request<VendorCount[]>('/devices/vendors')
    : { error: 'backend unreachable', kind: 'unreachable' as const }
  if (res.data) return res
  // Derived from the stub rather than hard-coded, so the placeholder picker
  // offers exactly the vendors its placeholder rows can actually match.
  const counts = new Map<string, number>()
  for (const d of STUB_CATALOG) counts.set(d.vendor, (counts.get(d.vendor) ?? 0) + 1)
  return {
    data: [...counts].map(([vendor, count]) => ({ vendor, count })),
    stub: true,
  }
}

export interface VendorCount {
  vendor: string
  count: number
}

const STUB_CATALOG: CatalogDevice[] = [
  { sku: 'IFC-48-S', vendor: 'Fruity Chutes', name: 'Iris Ultra 48" Standard',
    CdS: 2.489, D0: 1.601, m_c: 0.213, j: 2, manual: false },
  { sku: 'IFC-60-S', vendor: 'Fruity Chutes', name: 'Iris Ultra 60" Standard',
    CdS: 3.889, D0: 2.002, m_c: 0.298, j: 2, manual: false },
  { sku: 'CFC-24', vendor: 'Fruity Chutes', name: 'Classic Elliptical 24"',
    CdS: 0.437, D0: 0.61, m_c: 0.057, j: 2, manual: false },
  { sku: 'DRG-24', vendor: 'Fruity Chutes', name: 'Compact Elliptical 24" drogue',
    CdS: 0.15, D0: 0.6, m_c: 0.06, j: 2, manual: false },
]

/** The GUI preferences the backend persists. Only units so far, but the
 *  envelope is a container so adding a second kind of setting later is not a
 *  breaking change to the file on disk. */
export interface StoredSettings {
  units: Record<string, string>
  /** How precise numbers look. Read leniently -- `lib/quantities.parsePrecision`
   *  is what turns it into something safe to hand `toFixed`. */
  precision?: { maxDecimals?: number; minSigFigs?: number }
}

/**
 * GET/PUT /api/settings.
 *
 * The only route that persists anything, and the only one whose failure is
 * genuinely fine: with no backend the GUI falls back to localStorage and says
 * so. A unit preference is not worth blocking on.
 *
 * Deliberately short-timeout - this fires on every preference change, and a
 * hung save must not make the Units tab feel broken.
 */
export async function getSettings(): Promise<ApiResponse<StoredSettings>> {
  return request<StoredSettings>('/settings', {}, SETTINGS_TIMEOUT_MS)
}

export async function putSettings(
  units: Record<string, string>,
  precision: { maxDecimals: number; minSigFigs: number },
): Promise<ApiResponse<StoredSettings>> {
  return request<StoredSettings>('/settings', {
    method: 'PUT',
    body: JSON.stringify({ units, precision }),
  }, SETTINGS_TIMEOUT_MS)
}

/**
 * Per-user named config library (`/api/configs`).
 *
 * Server-side, keyed by the logged-in user (X-Auth-Email, or `local` in dev) --
 * the counterpart to the file-based Save/Load, which moves a config between
 * machines. Unlike simulate(), these never fall back to a fixture: with no
 * backend the library is simply unavailable, and the caller shows that.
 */
export interface SavedConfigMeta {
  slug: string
  name: string
  savedAt: string | null
}

export interface SavedConfig {
  name: string
  savedAt: string
  config: Config
}

export async function listSavedConfigs(): Promise<ApiResponse<{ configs: SavedConfigMeta[] }>> {
  return request<{ configs: SavedConfigMeta[] }>('/configs', {}, SETTINGS_TIMEOUT_MS)
}

export async function getSavedConfig(slug: string): Promise<ApiResponse<SavedConfig>> {
  return request<SavedConfig>(`/configs/${encodeURIComponent(slug)}`, {}, SETTINGS_TIMEOUT_MS)
}

export async function saveNamedConfig(
  name: string, config: Config,
): Promise<ApiResponse<SavedConfigMeta>> {
  return request<SavedConfigMeta>('/configs', {
    method: 'POST',
    body: JSON.stringify({ name, config }),
  }, SETTINGS_TIMEOUT_MS)
}

export async function deleteSavedConfig(
  slug: string,
): Promise<ApiResponse<{ status: string; slug: string }>> {
  return request<{ status: string; slug: string }>(
    `/configs/${encodeURIComponent(slug)}`, { method: 'DELETE' }, SETTINGS_TIMEOUT_MS,
  )
}

/**
 * GET /api/climatology. Always succeeds: the bundle is compiled in, so the
 * Atmospheric Data tab works with no server at all.
 *
 * Unlike simulate(), a stub here is not a placeholder for missing physics --
 * these are the real measured numbers out of site-climatology, just delivered
 * as a file instead of over HTTP. The backend route would serve the identical
 * bytes.
 */
export async function getClimatology(): Promise<ApiResponse<Climatology>> {
  if (await backendWorthTrying()) {
    const res = await request<Climatology>('/climatology')
    if (res.data) return res
  }
  return { data: BUNDLED, stub: true }
}

/**
 * A plain assignment, deliberately -- NOT an `as` cast.
 *
 * `resolveJsonModule` gives TypeScript the real inferred shape of the
 * committed JSON, so this line typechecks the actual data file against the
 * declared interface on every build. Rename a column in export_json.py and
 * `npm run build` fails instead of the chart silently going blank. An `as`
 * cast would have thrown that check away, which is most of the value.
 */
const BUNDLED: Climatology = bundledClimatology

export interface StationPad {
  station: string
  name: string
  observed: string | null
  raw: string
  station_elev_m: number
  /** Station elevation minus pad elevation. This sizes the eq (7b) error. */
  gap_m: number
  temp_c: number
  dewpoint_c: number | null
  maintenance_flag: boolean
  T_pad: number
  p_pad: number | null
  T_transferred: boolean
  p_pad_isa: number
}

/**
 * GET /api/atmosphere/station/{icao}.
 *
 * Deliberately NOT stubbed. Every other endpoint here falls back to a fixture
 * when the backend is absent, because "no backend yet" was the expected state
 * while the physics was written. This one must not: a fabricated temperature
 * presented as a station observation is a lie about provenance, and the whole
 * point of resolving from a station is that the number came from somewhere.
 * With no backend the caller gets an error and the source stays unresolved.
 */
export async function getStationPad(icao: string): Promise<ApiResponse<StationPad>> {
  if (!(await backendWorthTrying())) {
    return { error: 'backend unreachable - cannot resolve a live observation',
             kind: 'unreachable' }
  }
  // Longer than TIMEOUT_MS on purpose. Every other route is arithmetic in the
  // same process; this one waits on the AWC observation API, and the backend
  // already caps that at 4 s. Giving the browser the same 6 s as a local
  // computation makes a slow upstream surface as "the backend did not answer",
  // which points at the wrong service. With room to spare, the backend's own
  // 502 -- which names the observation API -- gets through instead.
  return request<StationPad>(
    `/atmosphere/station/${encodeURIComponent(icao)}`, {}, STATION_TIMEOUT_MS)
}

/** One visited corner and what it produced. */
export interface SweepCorner {
  /** Stable handle, "c0".."c31". Selection and colour key off this rather than
   *  off the float dict, and the worst-case entries point at it. */
  id: string
  corner: Record<string, number>
  /** The §6.4 name for `corner.CdS_body`: axial, broadside, or custom. */
  attitude: string
  /** The eq (36) maximum BEFORE the safety factor -- the load the hardware
   *  actually sees, and so the number to compare a rating against. F_design is
   *  this times SF, which is constant across corners, so the two rank the same. */
  F_peak: number | null
  F_design: number | null
  governing_device: string | null
  governing_candidate: string | null
  descent_time: number
  impact_velocity: number
  impact_ke: number
  /** Present only when the request asked for it. Coarser than /api/simulate's
   *  grid -- 32 histories at that resolution is 6 MB -- but the tension peak
   *  is preserved regardless of stride. */
  trajectory?: TrajectorySample[]
}

export interface SweepWorst {
  id: string
  corner: Record<string, number>
  attitude: string
  F_peak: number | null
  metric: string
  unit: string
  value: number
  /** Parameters that did not move THIS metric. Named so an arbitrary max()
   *  tie-break is never read as "that value is the dangerous one". */
  irrelevant: string[]
  F_design: number | null
  descent_time: number
  impact_velocity: number
  governing_device: string | null
  governing_candidate: string | null
}

/** The un-perturbed run: the config's own values, axial airframe. Not one of
 *  the corners -- the defaults sit inside the swept bands, not at their bounds
 *  -- which is exactly why it is the reference to read them against. */
export interface SweepNominal {
  F_peak: number | null
  F_design: number | null
  governing_device: string | null
  governing_candidate: string | null
  descent_time: number
  impact_velocity: number
  impact_ke: number
  trajectory?: TrajectorySample[]
}

export interface SweepResult {
  case: string
  runs: number
  nominal: SweepNominal
  /** The spec the backend resolved, after normalising bounds and applying
   *  defaults. Worth showing: 16 runs and 32 runs are different questions, not
   *  the same answer at different precision. */
  swept: { key: string; enabled: boolean; low: number; high: number }[]
  defaulted: boolean
  corners: SweepCorner[]
  /** Per failure category. There is no single worst corner -- for the worked
   *  vehicle structure is worst axial and drift is worst broadside, which are
   *  opposite corners. */
  worst_by_category: Record<'structure' | 'drift' | 'impact', SweepWorst>
  governing_candidates: Record<string, number>
  range: { min: number; max: number; ratio: number | null }
}

/**
 * POST /api/sweep. The §11.9 corner sweep.
 *
 * Takes the same body as `simulate` -- the corner spec rides on
 * `config.sweep` -- so there is one wire contract between them (§11.7).
 *
 * No stub fallback, unlike `simulate`. A fabricated sweep would be a table of
 * invented worst cases, which is the single most misleading thing this app
 * could show; with no backend the caller gets the error and shows nothing.
 */
export async function runSweep(
  config: Config, kase = 'nominal', trajectories = false,
): Promise<ApiResponse<SweepResult>> {
  const q = `case=${encodeURIComponent(kase)}${trajectories ? '&trajectories=1' : ''}`
  return request<SweepResult>(`/sweep?${q}`, {
    method: 'POST',
    body: JSON.stringify(config),
  })
}

/** The four figures the Recovery summary shows, for one design. Shared by the
 *  study's points and its nominal reference so the table can render a row from
 *  either without a branch. */
export interface StudyMetrics {
  descent_time: number
  impact_velocity: number
  impact_ke: number
  /** The eq (36) max BEFORE the safety factor -- the load the hardware
   *  actually sees, matching Recovery's "Max load (F_peak)". */
  F_peak: number | null
  F_design: number | null
  governing_device: string | null
  governing_candidate: string | null
  /** Present only when the request asked for it. */
  trajectory?: TrajectorySample[]
}

/** One design the study visited. */
export interface StudyPoint extends StudyMetrics {
  /** Stable handle, "p0".."p19". Colour and selection key off this. */
  id: string
  /** What made this design: axis key to its value, or to a canopy's label. */
  values: Record<string, number | string>
}

/** The resolved grid of one axis, echoed back. A study is only interpretable
 *  next to the values it actually visited -- 5 points from 800 to 2000 ft and
 *  5 from 800 to 1200 ft make tables of identical shape and different meaning. */
export interface StudyAxisEcho {
  key: string
  device: string | null
  mode: string
  labels: (number | string)[]
  /** What the config as posted has on this axis, so the reference row can say
   *  where today's design sits. Null on a canopy or pad-state axis means the
   *  one configured now is not among the ones being compared -- which is worth
   *  saying, and is not the same as "unknown". */
  current: number | string | null
}

export interface StudyResult {
  runs: number
  max_runs: number
  axes: StudyAxisEcho[]
  /** The unstudied config, as the reference line and the first table row. It is
   *  generally NOT one of the points -- the config's own canopy need not be
   *  among the ones being compared. */
  nominal: StudyMetrics
  points: StudyPoint[]
  warnings: string[]
}

/**
 * POST /api/study. The design study.
 *
 * Not `runSweep`. That one asks how uncertain a design is and answers with the
 * governing corner; this asks which of several designs is better and answers
 * with the four summary figures for each. Same body -- both specs ride on
 * `Config` (§11.7) -- entirely different question.
 *
 * No stub fallback, for the same reason `runSweep` has none, and more sharply:
 * a fabricated trade study is a table of invented recommendations about which
 * parachute to buy.
 */
export async function runStudy(
  config: Config, trajectories = false,
): Promise<ApiResponse<StudyResult>> {
  return request<StudyResult>(`/study${trajectories ? '?trajectories=1' : ''}`, {
    method: 'POST',
    body: JSON.stringify(config),
  })
}

// --- /api/crosscheck --------------------------------------------------------

/** Which of the three models a column belongs to. */
export type CrossModel = 'ours' | 'openrocket' | 'mastersheet'

/**
 * One row of the comparison table.
 *
 * `values[model]` is **null** where that model does not compute the quantity at
 * all -- OpenRocket has no opening-load calculation anywhere in its codebase,
 * and the mastersheet assumes terminal velocity so has no acceleration. Render
 * null as "not computed", never as 0: an absence shown as a number reads as a
 * prediction, and in the load row it reads as a *safe* one.
 */
export interface CrossMetric {
  key: string
  label: string
  /** A `lib/quantities.ts` Kind, so the row converts with the unit switcher -
   *  or **null** for a quantity that has no imperial form and therefore no
   *  Kind, such as seconds. Passing an unknown kind to `unitFor` dereferences
   *  undefined and blanks the page, so this is nullable on purpose. */
  kind: Kind | null
  /** The literal unit, used only when `kind` is null. */
  unit: string | null
  values: Record<CrossModel, number | null>
  /** Why a model is absent, or what the row is really showing. */
  note: string | null
  /** max/min over the models that answered. Null when fewer than two did. */
  spread: number | null
}

/** A deployment, as each model sees it. Loads are null for OpenRocket. */
export interface CrossEvent {
  t: number
  device: string
  z: number | null
  v_deploy: number | null
  F_inf: number | null
  F_reduced: number | null
  X: number | null
}

export interface CrossModelResult {
  label: string
  trajectory: ChartSample[]
  events: CrossEvent[]
  /** False for OpenRocket. The tension channel must say so rather than
   *  rendering an empty chart the reader will take for a flat line. */
  computes_load: boolean
  /** OpenRocket only: the airframe area used before the first deployment. */
  coast_CdS?: number
  /** Mastersheet only: the points the workbook itself puts a number on, as
   *  against the closed form reconstructed between them. Drawn as dots so it
   *  is obvious which is which. */
  reported?: ChartSample[]
  /** Mastersheet only: what their own never-called DESCENT_TIME would say. */
  descent_time_layered?: number
}

/** One row of the differences table: an aspect, and what each model does. */
export interface ModelDifference {
  aspect: string
  ours: string
  openrocket: string
  mastersheet: string
}

export interface CrosscheckResult {
  git_sha: string
  openrocket_version: { release: string; commit: string }
  which: string
  wind: number
  metrics: CrossMetric[]
  /** `shared` is what all three take for granted; `differs` is where they part
   *  company. Kept apart so a reader can scan for disagreement without first
   *  filtering out the lines everyone agrees on. */
  assumptions: { shared: string[]; differs: ModelDifference[] }
  /** About this config, not about the models. */
  warnings: string[]
  models: Record<CrossModel, CrossModelResult>
}

/**
 * POST /api/crosscheck. Our model against OpenRocket and the mastersheet.
 *
 * No stub fallback, for the same reason `runStudy` has none and more sharply
 * still: a fabricated cross-check is a fabricated validation. The entire value
 * of this tab is that the numbers came from three real models, so inventing one
 * when the backend is down would defeat the only thing it is for.
 */
export async function runCrosscheck(
  config: Config, wind = 0,
): Promise<ApiResponse<CrosscheckResult>> {
  return request<CrosscheckResult>(`/crosscheck?wind=${wind}`, {
    method: 'POST',
    body: JSON.stringify(config),
  })
}
