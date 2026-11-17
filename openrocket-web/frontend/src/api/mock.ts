/**
 * The mock API: every SCHEMA.md route, answered in the browser. Used when
 * VITE_MOCK=1 or when /api/health does not answer, so the UI can be built and
 * reviewed before orweb/ exists. Its physics is mockPhysics.ts -- approximate,
 * and the UI says so while it is in use.
 */
import type { Api } from './client'
import type { Component, ComponentType, RocketDocument } from '../types'
import { SIMPLE_ROCKET } from './fixture'
import { defaultComponent, MATERIALS } from './mockDefaults'
import { mockAnalyze } from './mockPhysics'
import { searchMotors } from './motorDb'

const EXAMPLES: Record<string, RocketDocument> = {
  'A simple model rocket': SIMPLE_ROCKET,
}

function delay<T>(v: T, ms = 20): Promise<T> {
  return new Promise((res) => setTimeout(() => res(v), ms))
}

function abortable<T>(signal: AbortSignal | undefined, fn: () => T): Promise<T> {
  return new Promise((res, rej) => {
    if (signal?.aborted) return rej(new DOMException('Aborted', 'AbortError'))
    const t = setTimeout(() => {
      try {
        res(fn())
      } catch (e) {
        rej(e)
      }
    }, 15)
    signal?.addEventListener('abort', () => {
      clearTimeout(t)
      rej(new DOMException('Aborted', 'AbortError'))
    })
  })
}

export const mockApi: Api = {
  mode: 'mock',
  health: () => delay({ ok: true, openrocket: '24.12 (mock)' }),
  examples: () => delay(Object.keys(EXAMPLES).map((name) => ({ name }))),
  example: (name) => {
    const d = EXAMPLES[name]
    return d ? delay(structuredClone(d)) : Promise.reject(new Error(`No example "${name}"`))
  },
  importOrk: async (file) => {
    // The mock cannot parse .ork (zip + XML); the backend does. Saved-from-here
    // files carry the document as JSON (see exportOrk), so those round-trip.
    const text = await file.text().catch(() => '')
    try {
      const doc = JSON.parse(text) as RocketDocument
      if (doc && doc.rocket && Array.isArray(doc.motorConfigs)) return doc
    } catch {
      /* fall through */
    }
    throw new Error('The mock API cannot read .ork files; start the backend (port 8004) to open them.')
  },
  exportOrk: (doc) =>
    delay(new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' })),
  analyze: (doc, conditions, signal) => abortable(signal, () => mockAnalyze(doc, conditions)),
  defaults: (type: ComponentType): Promise<Component> => delay(defaultComponent(type)),
  materials: () => delay(structuredClone(MATERIALS)),
  searchMotors: (q, diameter) => delay(searchMotors(q, diameter ?? undefined)),
}
