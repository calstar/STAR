/**
 * The API client: SCHEMA.md's routes and nothing else.
 *
 * `connect()` decides once per page whether to talk to the backend or to the
 * in-browser mock: the mock when VITE_MOCK=1, or when /api/health does not
 * answer. The rest of the app only ever sees the `Api` interface.
 */
import type {
  Analysis, Component, ComponentType, Conditions, ExampleEntry, Health, MaterialDb, MotorSearchResult, RocketDocument,
} from '../types'

export interface Api {
  mode: 'live' | 'mock'
  health(): Promise<Health>
  examples(): Promise<ExampleEntry[]>
  example(name: string): Promise<RocketDocument>
  importOrk(file: File): Promise<RocketDocument>
  exportOrk(doc: RocketDocument): Promise<Blob>
  analyze(doc: RocketDocument, conditions: Conditions, signal?: AbortSignal): Promise<Analysis>
  defaults(type: ComponentType): Promise<Component>
  materials(): Promise<MaterialDb>
  searchMotors(q: string, diameter?: number | null): Promise<MotorSearchResult[]>
}

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function check(r: Response): Promise<Response> {
  if (r.ok) return r
  let msg = `${r.status} ${r.statusText}`
  try {
    const body = await r.json()
    if (body && typeof body.detail === 'string') msg = body.detail
    else if (body && body.detail) msg = JSON.stringify(body.detail)
  } catch {
    /* not JSON */
  }
  throw new ApiError(r.status, msg)
}

async function json<T>(r: Promise<Response>): Promise<T> {
  return (await check(await r)).json() as Promise<T>
}

export function httpApi(base = '/api'): Api {
  const post = (path: string, body: unknown, signal?: AbortSignal) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    })
  return {
    mode: 'live',
    health: () => json(fetch(`${base}/health`)),
    examples: () => json(fetch(`${base}/examples`)),
    example: (name) => json(fetch(`${base}/examples/${encodeURIComponent(name)}`)),
    importOrk: (file) => {
      const fd = new FormData()
      fd.append('file', file)
      return json(fetch(`${base}/ork/import`, { method: 'POST', body: fd }))
    },
    exportOrk: async (doc) => (await check(await post('/ork/export', doc))).blob(),
    analyze: (doc, conditions, signal) => json(post('/analyze', { document: doc, conditions }, signal)),
    defaults: (type) => json(fetch(`${base}/components/defaults/${type}`)),
    materials: () => json(fetch(`${base}/materials`)),
    searchMotors: (q, diameter) => {
      const u = new URLSearchParams({ q })
      if (diameter) u.set('diameter', String(diameter))
      return json(fetch(`${base}/motors/search?${u}`))
    },
  }
}

/** True when the build or the URL asks for the mock (?mock=1 is handy for screenshots). */
export function mockRequested(): boolean {
  if (import.meta.env?.VITE_MOCK === '1') return true
  try {
    return new URLSearchParams(globalThis.location?.search ?? '').get('mock') === '1'
  } catch {
    return false
  }
}

export async function connect(base = '/api', timeoutMs = 2500): Promise<Api> {
  if (mockRequested()) return (await import('./mock')).mockApi
  const live = httpApi(base)
  try {
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), timeoutMs)
    const r = await fetch(`${base}/health`, { signal: ctl.signal })
    clearTimeout(t)
    const body = (await r.json()) as Health
    if (r.ok && body?.ok) return live
  } catch {
    /* fall through to the mock */
  }
  return (await import('./mock')).mockApi
}
