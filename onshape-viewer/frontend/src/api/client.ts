/** Thin fetch wrapper for the build-artifact endpoints in backend/main.py. */

import type { Manifest, ModelSummary } from '../types'

async function getJSON<T>(url: string): Promise<T> {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`${url} -> HTTP ${response.status}`)
  }
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
