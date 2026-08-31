/**
 * The versioned-design API, bound to this app.
 *
 * The transport, the sharing model and the `(owner, id)` addressing all live in
 * `@stardesign-ui` -- shared with recovery-calculator and pid-designer,
 * mirroring the shared server router. What is app-specific is only what is
 * below: the route prefix and the payload shape.
 *
 * The live editing config lives in the backend session; this store adds the
 * durable history on top of it.
 */

import { createDesignApi } from '@stardesign-ui';
import type { DesignMeta, DocRef } from '@stardesign-ui';
import type { EngineConfig } from './client';

export { keyOf, refOf, ApiError } from '@stardesign-ui';
export type {
  BrowseGroup,
  DocRef,
  MicroVersion,
  ReleaseVersion,
  TeamUser,
} from '@stardesign-ui';

/** Named `DocMeta` throughout this app; the shape is the shared one. */
export type DocMeta = DesignMeta;

const api = createDesignApi<EngineConfig>({
  base: '/api/engine/documents',
  usersPath: '/api/engine/users',
  codec: {
    toBody: (config) => ({ config }),
    fromBody: (body) => (body as { config: EngineConfig }).config,
    empty: () => ({}) as EngineConfig,
  },
});

/** The whole API object, for shared components that take it as a prop. */
export const designApi = api;

// Named exports, so the call sites read the same as before the extraction.
export const listDocuments = api.list;
export const browseDocuments = api.browse;
export const listUsers = api.listUsers;
export const createDocument = (name: string, config?: EngineConfig) => api.create(name, config);
export const copyDocument = (ref: DocRef, name?: string) => api.copy(ref, name);
export const renameDocument = api.rename;
export const shareDocument = api.share;
export const leaveDocument = api.leave;
export const autosaveDocument = api.autosave;
export const flushDocument = api.flush;
export const getHistory = api.getHistory;
export const getVersion = api.getVersion;
export const createRelease = api.createRelease;
export const listReleases = api.listReleases;
export const getRelease = api.getRelease;

/** `/load` returns the config directly now; callers destructured `{ config }`. */
export const loadDocument = (ref: DocRef) => api.load(ref).then((config) => ({ config }));
