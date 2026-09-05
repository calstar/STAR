/**
 * Model picker, in the header.
 *
 * Two ways in, because one is not enough:
 *
 *   Search covers documents these credentials own (Onshape's `filter=0`). It
 *   has to be a search rather than a dropdown of everything: this account has
 *   600+ documents and Onshape caps /documents at 20 per page, so enumerating
 *   would cost 30+ requests before the user typed anything -- and then one more
 *   call per document to find which of its tabs are assemblies.
 *
 *   A pasted URL covers everything search cannot reach: a document owned by
 *   someone else, a public one, or a specific version rather than whatever the
 *   workspace happens to hold right now.
 *
 * Typing costs nothing. Onshape bills per API call against a finite quota, and
 * this panel used to be the worst offender in the app: it searched on a 300 ms
 * debounce, so browsing for a model could cost more requests than building one
 * and produced no artifact for them. Now the field filters what the server has
 * already cached (backend/onshape/browse.py), and reaching Onshape is a button
 * the user presses. The panel says how stale the list is so that trade is
 * visible rather than a silent downgrade.
 *
 * Building is the slow part, so it runs as a polled job rather than a blocking
 * request.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import { buildStatus, listAssemblies, searchDocuments, startBuild } from '../../api/client'
import type { BuildJob, ModelSummary, OnshapeAssembly, OnshapeDocument } from '../../types'

interface Props {
  models: ModelSummary[]
  modelId: string | null
  onSelectModel: (id: string) => void
  /** Called with the new model id once a build finishes. */
  onBuilt: (modelId: string) => void
  /**
   * Read-only: which model the design points at is part of the design, so
   * picking or building one needs the checkout. Passed rather than read from
   * the shared context because this sits in the header, above the provider --
   * and because the copy shown on the no-model error screen deliberately stays
   * live, being the only way to build a first model on a fresh install.
   */
  disabled?: boolean
}

const POLL_INTERVAL_MS = 700

/** Matches an Onshape document URL well enough to tell it from a search term. */
function looksLikeUrl(text: string): boolean {
  return /^https?:\/\//i.test(text.trim())
}

/** "3 Aug, 14:02" — enough to judge staleness without eating the panel width. */
function whenCached(stamp: string | null): string {
  if (!stamp) return 'never'
  const parsed = new Date(stamp)
  if (Number.isNaN(parsed.getTime())) return stamp
  return parsed.toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function ModelPicker({ models, modelId, onSelectModel, onBuilt, disabled = false }: Props) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [documents, setDocuments] = useState<OnshapeDocument[]>([])
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)

  const [documentsCachedAt, setDocumentsCachedAt] = useState<string | null>(null)

  const [chosen, setChosen] = useState<OnshapeDocument | null>(null)
  const [assemblies, setAssemblies] = useState<OnshapeAssembly[] | null>(null)
  const [assembliesCachedAt, setAssembliesCachedAt] = useState<string | null>(null)

  const [job, setJob] = useState<BuildJob | null>(null)
  const [buildError, setBuildError] = useState<string | null>(null)

  const panel = useRef<HTMLDivElement>(null)
  const busy = job?.status === 'queued' || job?.status === 'running'

  // The header is a fixed title now, so this button is the only thing naming
  // what is loaded -- it carries the assembly as well as the document.
  const current = models.find((model) => model.id === modelId)
  const label = current?.documentName ?? 'Select a model'

  // Close on outside click or Escape, the same housekeeping ContextMenu does.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (panel.current && !panel.current.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  // Filter the cached index as the user types. This never reaches Onshape --
  // it is a local substring match on our own server -- so there is no debounce
  // and no quota cost, and the results land as fast as the keystrokes. The
  // abort still matters for ordering: a slow early response must not overwrite
  // a fresher one.
  useEffect(() => {
    if (!open) return
    const term = query.trim()
    if (looksLikeUrl(term)) {
      setDocuments([])
      setSearchError(null)
      return
    }

    const controller = new AbortController()
    setSearchError(null)
    searchDocuments(term, { signal: controller.signal })
      .then((found) => {
        setDocuments(found.items)
        setDocumentsCachedAt(found.cachedAt)
      })
      .catch((exc: unknown) => {
        if (controller.signal.aborted) return
        setSearchError(exc instanceof Error ? exc.message : String(exc))
      })

    return () => controller.abort()
  }, [query, open])

  /** The one path that spends an Onshape API call to look things up. */
  const refreshDocuments = useCallback(() => {
    setSearching(true)
    setSearchError(null)
    searchDocuments(query.trim(), { refresh: true })
      .then((found) => {
        setDocuments(found.items)
        setDocumentsCachedAt(found.cachedAt)
      })
      .catch((exc: unknown) => {
        setSearchError(exc instanceof Error ? exc.message : String(exc))
      })
      .finally(() => setSearching(false))
  }, [query])

  // Poll a running build.
  useEffect(() => {
    if (!job || (job.status !== 'queued' && job.status !== 'running')) return
    const timer = window.setInterval(() => {
      buildStatus(job.id)
        .then((next) => {
          setJob(next)
          if (next.status === 'done' && next.modelId) {
            onBuilt(next.modelId)
            setOpen(false)
            setJob(null)
          } else if (next.status === 'error') {
            setBuildError(next.message)
          }
        })
        .catch((exc: unknown) => setBuildError(exc instanceof Error ? exc.message : String(exc)))
    }, POLL_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [job, onBuilt])

  // Free on a repeat visit; the first expansion of a document has to spend one
  // call, because there is nothing cached to serve and no other way to learn
  // which of its tabs are assemblies.
  const loadAssemblies = useCallback(
    (document: OnshapeDocument, refresh: boolean) => {
      setAssemblies(null)
      listAssemblies(document.documentId, document.workspaceId, { refresh })
        .then((found) => {
          setAssemblies(found.items)
          setAssembliesCachedAt(found.cachedAt)
        })
        .catch((exc: unknown) => {
          setAssemblies([])
          setSearchError(exc instanceof Error ? exc.message : String(exc))
        })
    },
    [],
  )

  const chooseDocument = useCallback(
    (document: OnshapeDocument) => {
      setChosen(document)
      loadAssemblies(document, false)
    },
    [loadAssemblies],
  )

  const launch = useCallback(
    async (request: Parameters<typeof startBuild>[0]) => {
      setBuildError(null)
      try {
        const { jobId } = await startBuild(request)
        setJob({
          id: jobId,
          status: 'queued',
          message: 'Queued.',
          log: [],
          url: '',
          modelId: null,
          startedAt: '',
        })
      } catch (exc: unknown) {
        setBuildError(exc instanceof Error ? exc.message : String(exc))
      }
    },
    [],
  )

  return (
    <div className="relative" ref={panel}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        disabled={disabled}
        title={disabled ? 'Take the design to change its model' : undefined}
        className="flex items-center gap-2 rounded border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-2 py-1 text-sm text-[var(--color-text-primary)] hover:bg-[var(--color-bg-tertiary)] disabled:cursor-not-allowed disabled:opacity-50"
      >
        <span className="max-w-56 truncate">{label}</span>
        {current?.assemblyName && (
          <span className="max-w-40 truncate text-xs text-[var(--color-text-muted)]">{current.assemblyName}</span>
        )}
        {busy && <span className="text-xs text-[var(--color-accent)]">building…</span>}
        <span className="text-[var(--color-text-muted)]">▾</span>
      </button>

      {open && (
        <div className="absolute left-0 top-full z-40 mt-1 w-[26rem] rounded border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] p-3 text-sm shadow-xl">
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            // Enter is the same explicit gesture as the button: the user asking
            // for documents this cache has not seen yet.
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !looksLikeUrl(query)) refreshDocuments()
            }}
            placeholder="Filter cached documents, or paste an Onshape URL"
            className="w-full rounded border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-2 py-1.5 text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)]"
          />

          {looksLikeUrl(query) ? (
            <div className="mt-3">
              <p className="mb-2 text-xs text-[var(--color-text-muted)]">
                Builds this URL directly. Use this for documents you do not own, or to pin a
                specific version.
              </p>
              <button
                type="button"
                disabled={busy || disabled}
                onClick={() => launch({ url: query.trim() })}
                className="rounded bg-[var(--color-accent)] px-3 py-1.5 text-white hover:bg-[var(--color-accent-hover)] disabled:opacity-50"
              >
                Build from URL
              </button>
            </div>
          ) : chosen ? (
            <div className="mt-3">
              <button
                type="button"
                onClick={() => {
                  setChosen(null)
                  setAssemblies(null)
                }}
                className="mb-2 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
              >
                ‹ back to results
              </button>
              <div className="mb-1 flex items-baseline gap-2">
                <p className="min-w-0 flex-1 truncate font-medium text-[var(--color-text-primary)]">
                  {chosen.name}
                </p>
                <button
                  type="button"
                  onClick={() => loadAssemblies(chosen, true)}
                  title="Re-read this document's tabs from Onshape (1 API call)"
                  className="shrink-0 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
                >
                  ↻ refresh
                </button>
              </div>
              {assembliesCachedAt && (
                <p className="mb-1 text-2xs text-[var(--color-text-muted)]">
                  cached {whenCached(assembliesCachedAt)}
                </p>
              )}

              {assemblies === null ? (
                <p className="text-xs text-[var(--color-text-muted)]">Loading assemblies…</p>
              ) : assemblies.length === 0 ? (
                <p className="text-xs text-amber-300">
                  This document has no assembly tabs. Only assemblies can be built.
                </p>
              ) : (
                <ul className="max-h-56 overflow-y-auto">
                  {assemblies.map((assembly) => (
                    <li key={assembly.elementId}>
                      <button
                        type="button"
                        disabled={busy || disabled}
                        onClick={() =>
                          launch({
                            documentId: chosen.documentId,
                            workspaceId: chosen.workspaceId,
                            elementId: assembly.elementId,
                          })
                        }
                        className="block w-full truncate rounded px-2 py-1.5 text-left text-[var(--color-text-primary)] hover:bg-[var(--color-bg-tertiary)] disabled:opacity-50"
                      >
                        {assembly.name}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : (
            <div className="mt-3">
              {models.length > 0 && (
                <>
                  <p className="mb-1 text-2xs uppercase tracking-wide text-[var(--color-text-muted)]">
                    Already built
                  </p>
                  <ul className="mb-3">
                    {models.map((model) => (
                      <li key={model.id}>
                        <button
                          type="button"
                          onClick={() => {
                            onSelectModel(model.id)
                            setOpen(false)
                          }}
                          disabled={disabled}
                          className={`block w-full truncate rounded px-2 py-1.5 text-left hover:bg-[var(--color-bg-tertiary)] disabled:cursor-not-allowed disabled:opacity-50 ${
                            model.id === modelId ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-primary)]'
                          }`}
                        >
                          {model.documentName ?? model.id}
                          <span className="ml-2 text-xs text-[var(--color-text-muted)]">{model.assemblyName}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              )}

              <div className="mb-1 flex items-baseline gap-2">
                <p className="flex-1 text-2xs uppercase tracking-wide text-[var(--color-text-muted)]">
                  Documents
                </p>
                <button
                  type="button"
                  disabled={searching}
                  onClick={refreshDocuments}
                  title="Ask Onshape for documents matching this text (1 API call)"
                  className="shrink-0 rounded border border-[var(--color-border)] px-1.5 py-0.5 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)] disabled:opacity-50"
                >
                  {searching ? 'searching…' : '↻ search Onshape'}
                </button>
              </div>
              {/* Naming the cost is the point: without it, "search Onshape"
                  looks like a slower version of typing rather than the only
                  thing here that spends quota. */}
              <p className="mb-1 text-2xs text-[var(--color-text-muted)]">
                Filtering {documents.length} cached {documents.length === 1 ? 'document' : 'documents'}
                {' · last fetched '}
                {whenCached(documentsCachedAt)}
              </p>
              {!searching && documents.length === 0 && (
                <p className="text-xs text-[var(--color-text-muted)]">
                  {documentsCachedAt
                    ? 'Nothing cached matches. Search Onshape to look it up.'
                    : 'No documents cached yet. Search Onshape to fetch some.'}
                </p>
              )}
              <ul className="max-h-56 overflow-y-auto">
                {documents.map((document) => (
                  <li key={document.documentId}>
                    <button
                      type="button"
                      onClick={() => chooseDocument(document)}
                      className="block w-full truncate rounded px-2 py-1.5 text-left text-[var(--color-text-primary)] hover:bg-[var(--color-bg-tertiary)]"
                    >
                      {document.name}
                      {document.owner && (
                        <span className="ml-2 text-xs text-[var(--color-text-muted)]">{document.owner}</span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {searchError && <p className="mt-2 text-xs text-amber-300">{searchError}</p>}

          {job && (
            <div className="mt-3 border-t border-[var(--color-border)] pt-2">
              <p className="text-xs text-[var(--color-accent)]">{job.message}</p>
              {job.log.length > 0 && (
                <p className="mt-1 truncate text-2xs text-[var(--color-text-muted)]">
                  {job.log[job.log.length - 1]}
                </p>
              )}
            </div>
          )}

          {buildError && (
            <p className="mt-2 rounded bg-amber-500/15 px-2 py-1 text-xs text-amber-300">
              {buildError}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
