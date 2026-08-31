/**
 * The versioned-config API, bound to this app.
 *
 * The transport, the sharing model and the `(owner, id)` addressing all live in
 * `@stardesign-ui` — shared with EngineDesign and pid-designer, mirroring the
 * shared server router. What is app-specific is only what is below: the route
 * prefix and the payload shape.
 *
 * The client-side localStorage autosave (`lib/persist.ts`) stays as the instant
 * working cache; this store is the durable, versioned timeline.
 */

import { createDesignApi } from '@stardesign-ui'
import type { DesignMeta, DocRef } from '@stardesign-ui'
import type { UiConfig } from '../types/schema'
import { toStoredConfig } from '../lib/serialise'

export { keyOf, refOf, ApiError } from '@stardesign-ui'
export type {
  BrowseGroup,
  DocRef,
  MicroVersion,
  ReleaseVersion,
  TeamUser,
} from '@stardesign-ui'

/** Named `DocMeta` throughout this app; the shape is the shared one. */
export type DocMeta = DesignMeta

const api = createDesignApi<UiConfig>({
  base: '/api/recovery/documents',
  usersPath: '/api/recovery/users',
  codec: {
    // `toStoredConfig` is what keeps view state out of the saved design --
    // collapsing a device card must not count as an edit. See lib/serialise.ts.
    toBody: (config) => ({ config: toStoredConfig(config) }),
    fromBody: (body) => (body as { config: UiConfig }).config,
    empty: () => ({}) as UiConfig,
  },
})

/** The whole API object, for shared components that take it as a prop. */
export const designApi = api

// Named exports, so the call sites read the same as before the extraction.
export const listDocuments = api.list
export const browseDocuments = api.browse
export const listUsers = api.listUsers
export const createDocument = (name: string, config?: UiConfig) => api.create(name, config)
export const copyDocument = (ref: DocRef, name?: string) => api.copy(ref, name)
export const renameDocument = api.rename
export const shareDocument = api.share
export const leaveDocument = api.leave
export const autosaveDocument = api.autosave
export const flushDocument = api.flush
export const getHistory = api.getHistory
export const getVersion = api.getVersion
export const createRelease = api.createRelease
export const listReleases = api.listReleases
export const getRelease = api.getRelease

/** `/load` returns the config directly now; callers destructured `{ config }`. */
export const loadDocument = (ref: DocRef) => api.load(ref).then((config) => ({ config }))
