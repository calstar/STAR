/** Thin fetch wrapper for the build-artifact endpoints in backend/main.py. */

import type {
  Browsed,
  BuildJob,
  Manifest,
  ModelSummary,
  OnshapeAssembly,
  OnshapeDocument,
  FinGuess,
  MotorSearchResult,
  OuterSurfaceGuess,
  StabilityRequest,
  StabilityResult,
} from '../types'

/** The server puts the real reason in `detail`; surfacing it beats a bare 502. */
async function fail(url: string, response: Response): Promise<never> {
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
  options: { limit?: number; signal?: AbortSignal } = {},
): Promise<MotorSearchResult> {
  const params = new URLSearchParams({ query })
  if (options.limit) params.set('limit', String(options.limit))
  return getJSON<MotorSearchResult>(`/api/motors?${params.toString()}`, options.signal)
}

/** CG, CoP and static margin from the approved (or auto-detected) surface. */
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
