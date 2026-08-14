/**
 * Versioned-document API (/api/documents): the durable, server-side
 * timeline behind the localStorage working cache. Mirrors the pid-designer
 * model -- an autosaved working copy, throttled microversions, and immutable
 * named releases. See backend/routers/documents.py.
 *
 * Plain fetch (same-origin, the session cookie rides along). Unlike client.ts
 * there is no fixture fallback: version history has no meaningful stand-in when
 * the backend is absent, so callers treat a throw as "history unavailable".
 */

import type { ViewerConfig as UiConfig } from '../types/config'

const BASE = '/api/documents'

export interface DocMeta {
  id: string
  name: string
  createdAt: string
  updatedAt: string
}

export interface MicroVersion {
  versionId: string
  savedAt: string
  size?: number
}

export interface ReleaseVersion {
  label: string
  savedAt: string
  size?: number
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { detail?: string }
    throw new Error(body.detail || `HTTP ${res.status}`)
  }
  return res.json() as Promise<T>
}

export const listDocuments = () =>
  fetch(BASE).then(r => json<DocMeta[]>(r))

export const createDocument = (name: string, config?: UiConfig) =>
  fetch(BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, config }),
  }).then(r => json<DocMeta>(r))

export const renameDocument = (id: string, name: string) =>
  fetch(`${BASE}/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  }).then(r => json<DocMeta>(r))

export const deleteDocument = (id: string) =>
  fetch(`${BASE}/${encodeURIComponent(id)}`, { method: 'DELETE' }).then(r => json(r))

export const loadDocument = (id: string) =>
  fetch(`${BASE}/${encodeURIComponent(id)}/load`).then(r => json<{ config: UiConfig | Record<string, never> }>(r))

export const autosaveDocument = (id: string, config: UiConfig) =>
  fetch(`${BASE}/${encodeURIComponent(id)}/autosave`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ config }),
  }).then(r => json<{ ok: boolean; micro: boolean }>(r))

/** Best-effort final snapshot on tab close. Uses sendBeacon so it survives the
 *  page unload the way a normal fetch would not. */
export const flushDocument = (id: string, config: UiConfig): void => {
  const body = JSON.stringify({ config })
  navigator.sendBeacon(
    `${BASE}/${encodeURIComponent(id)}/flush`,
    new Blob([body], { type: 'application/json' }),
  )
}

export const getHistory = (id: string) =>
  fetch(`${BASE}/${encodeURIComponent(id)}/history`).then(r => json<MicroVersion[]>(r))

export const getVersion = (id: string, versionId: string) =>
  fetch(`${BASE}/${encodeURIComponent(id)}/version/${encodeURIComponent(versionId)}`)
    .then(r => json<{ config: UiConfig }>(r))

export const createRelease = (id: string, label: string, config?: UiConfig) =>
  fetch(`${BASE}/${encodeURIComponent(id)}/release`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label, config }),
  }).then(r => json<ReleaseVersion>(r))

export const listReleases = (id: string) =>
  fetch(`${BASE}/${encodeURIComponent(id)}/releases`).then(r => json<ReleaseVersion[]>(r))

export const getRelease = (id: string, label: string) =>
  fetch(`${BASE}/${encodeURIComponent(id)}/release/${encodeURIComponent(label)}`)
    .then(r => json<{ config: UiConfig }>(r))
