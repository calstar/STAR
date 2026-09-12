/** Thin fetch wrapper for the build-artifact endpoints in backend/main.py. */

import type {
  Browsed,
  BuildJob,
  Manifest,
  ModelSummary,
  OnshapeAssembly,
  OnshapeDocument,
  FinGuess,
  FlightDynamicsRequest,
  FlightDynamicsResult,
  FlightResult,
  MotorDetail,
  MotorSearchResult,
  OuterSurfaceGuess,
  StabilityRequest,
  StabilityResult,
} from '../types'

/** The server puts the real reason in `detail`; surfacing it beats a bare 502. */
async function fail(url: string, response: Response): Promise<never> {
  // A 403 here is the auth gate, not the app: searching or building from Onshape
  // is limited to approved users, while the rest of the app is open to any
  // Berkeley login. (The backend never 403s itself -- missing credentials are a
  // 503, a bad request a 4xx with a `detail`.)
  if (response.status === 403) {
    throw new Error(
      'Importing or building from Onshape is limited to approved users. Contact Aidan for access.',
    )
  }
  let detail = ''
  try {
    const body = await response.json()
    detail = typeof body?.detail === 'string' ? body.detail : ''
  } catch {
    // Not JSON; the status alone will have to do.
  }
  throw new Error(detail || `${url} -> HTTP ${response.status}`)
}

async function getJSON<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal })
  if (!response.ok) await fail(url, response)
  return response.json() as Promise<T>
}

export function listModels(): Promise<ModelSummary[]> {
  return getJSON<ModelSummary[]>('/api/models')
}

export function fetchManifest(modelId: string): Promise<Manifest> {
  return getJSON<Manifest>(`/api/models/${modelId}/manifest.json`)
}

export function glbUrl(modelId: string): string {
  return `/api/models/${modelId}/model.glb`
}

/**
 * Documents these credentials own.
 *
 * `refresh` is the difference between free and billed: without it the server
 * filters what it already knows and issues no Onshape call, with it one call
 * goes out. Only pass it when the user asked for fresh data.
 */
export function searchDocuments(
  q: string,
  options: { refresh?: boolean; signal?: AbortSignal } = {},
): Promise<Browsed<OnshapeDocument>> {
  const query = new URLSearchParams({ q })
  if (options.refresh) query.set('refresh', 'true')
  return getJSON<Browsed<OnshapeDocument>>(
    `/api/onshape/documents?${query.toString()}`,
    options.signal,
  )
}

/** Assembly tabs of one document. Cached after the first look; see above. */
export function listAssemblies(
  documentId: string,
  workspaceId: string,
  options: { refresh?: boolean; signal?: AbortSignal } = {},
): Promise<Browsed<OnshapeAssembly>> {
  const query = options.refresh ? '?refresh=true' : ''
  return getJSON<Browsed<OnshapeAssembly>>(
    `/api/onshape/documents/${documentId}/w/${workspaceId}/assemblies${query}`,
    options.signal,
  )
}

export async function startBuild(
  request: { url: string } | { documentId: string; workspaceId: string; elementId: string },
): Promise<{ jobId: string }> {
  const response = await fetch('/api/build', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  })
  if (!response.ok) await fail('/api/build', response)
  return response.json()
}

export function buildStatus(jobId: string): Promise<BuildJob> {
  return getJSON<BuildJob>(`/api/build/${jobId}`)
}

/** Auto-detected outer airframe faces, to seed the approval UI. Offline. */
export function fetchOuterSurface(modelId: string): Promise<OuterSurfaceGuess> {
  return getJSON<OuterSurfaceGuess>(`/api/models/${modelId}/outer-surface`)
}

/** Auto-detected fin faces + count, to seed the fin approval UI. Offline. */
export function fetchFins(modelId: string): Promise<FinGuess> {
  return getJSON<FinGuess>(`/api/models/${modelId}/fins`)
}

/**
 * Search the offline motor mirror (thrustcurve.org catalog). Offline; `available`
 * is false until `python -m backend.motors.fetch` has populated cache/motors.
 */
export function searchMotors(
  query: string,
  options: { limit?: number; impulseClass?: string; model?: string; signal?: AbortSignal } = {},
): Promise<MotorSearchResult> {
  const params = new URLSearchParams({ query })
  if (options.limit) params.set('limit', String(options.limit))
  if (options.impulseClass) params.set('impulseClass', options.impulseClass)
  if (options.model) params.set('model', options.model)
  return getJSON<MotorSearchResult>(`/api/motors?${params.toString()}`, options.signal)
}

/** CG, CP and static margin from the approved (or auto-detected) surface. */
export async function computeStability(
  modelId: string,
  request: StabilityRequest,
): Promise<StabilityResult> {
  const url = `/api/models/${modelId}/stability`
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  })
  if (!response.ok) await fail(url, response)
  return response.json() as Promise<StabilityResult>
}

/** Full detail for one motor: every datafile (Full/Basic) with its thrust/mass/CG curves. */
export function fetchMotor(motorId: string): Promise<MotorDetail> {
  return getJSON<MotorDetail>(`/api/motors/${encodeURIComponent(motorId)}`)
}

/** Ascent flight profile (altitude/velocity/acceleration + static margin over time). */
export async function computeFlight(
  modelId: string,
  request: StabilityRequest,
): Promise<FlightResult> {
  const url = `/api/models/${modelId}/flight`
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  })
  if (!response.ok) await fail(url, response)
  return response.json() as Promise<FlightResult>
}

/** 6-DOF ascent via RocketPy: full trajectory, stability, loads and drift to apogee. */
export async function computeFlightDynamics(
  modelId: string,
  request: FlightDynamicsRequest,
): Promise<FlightDynamicsResult> {
  const url = `/api/models/${modelId}/flight-dynamics`
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  })
  if (!response.ok) await fail(url, response)
  return response.json() as Promise<FlightDynamicsResult>
}
