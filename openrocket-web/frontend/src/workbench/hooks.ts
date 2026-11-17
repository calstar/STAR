import { useCallback, useEffect, useRef, useState } from 'react'
import type { Api } from '../api/client'
import type { Analysis, Conditions, RocketDocument } from '../types'
import { initHistory, push, redo, seal, undo, type History, type PushOptions } from '../lib/history'

export interface DocState {
  history: History<RocketDocument>
  doc: RocketDocument
  apply: (fn: (d: RocketDocument) => RocketDocument, opts?: PushOptions) => void
  replace: (d: RocketDocument) => void
  undo: () => void
  redo: () => void
  seal: () => void
}

/** The document and its undo history. `replace` starts a fresh history (New / Open). */
export function useDocumentHistory(initial: RocketDocument): DocState {
  const [history, setHistory] = useState(() => initHistory(initial))
  const apply = useCallback((fn: (d: RocketDocument) => RocketDocument, opts?: PushOptions) => {
    setHistory((h) => push(h, fn(h.present), opts))
  }, [])
  const replace = useCallback((d: RocketDocument) => setHistory(initHistory(d)), [])
  return {
    history,
    doc: history.present,
    apply,
    replace,
    undo: useCallback(() => setHistory((h) => undo(h)), []),
    redo: useCallback(() => setHistory((h) => redo(h)), []),
    seal: useCallback(() => setHistory((h) => seal(h)), []),
  }
}

export interface AnalysisState {
  analysis: Analysis | null
  error: string | null
  pending: boolean
}

/**
 * POST /api/analyze on every change, debounced, with the stale request
 * aborted so an old answer can never overwrite a newer one.
 */
export function useAnalysis(api: Api | null, doc: RocketDocument, cond: Conditions, debounceMs = 150): AnalysisState {
  const [state, setState] = useState<AnalysisState>({ analysis: null, error: null, pending: false })
  const seq = useRef(0)
  useEffect(() => {
    if (!api) return
    const my = ++seq.current
    const ctl = new AbortController()
    setState((s) => ({ ...s, pending: true }))
    const t = setTimeout(() => {
      api
        .analyze(doc, cond, ctl.signal)
        .then((a) => {
          if (my === seq.current) setState({ analysis: a, error: null, pending: false })
        })
        .catch((e: unknown) => {
          if ((e as { name?: string })?.name === 'AbortError') return
          if (my === seq.current) setState((s) => ({ ...s, error: String((e as Error)?.message ?? e), pending: false }))
        })
    }, debounceMs)
    return () => {
      clearTimeout(t)
      ctl.abort()
    }
  }, [api, doc, cond, debounceMs])
  return state
}

/** Element size via ResizeObserver. */
export function useSize<T extends HTMLElement>(): [React.RefObject<T | null>, { w: number; h: number }] {
  const ref = useRef<T>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, size]
}
