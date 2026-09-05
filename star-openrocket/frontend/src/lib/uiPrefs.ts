/**
 * Per-browser UI state: things the person at the machine chose, which are not
 * part of the design.
 *
 * Which chart series you have ticked is the same class of thing as how wide you
 * dragged a sidebar (see components/viewer/ResizableSidebar.tsx) or which units
 * you read in — a preference belonging to the viewer, not to the rocket. It
 * used to live on the design's `flight` object, which had three consequences:
 * the choice travelled in the save file to anyone you shared with, ticking a
 * box marked the design dirty and demanded a checkout, and doing it while
 * read-only was a silent no-op that never persisted.
 *
 * localStorage, so it is per browser and never leaves it.
 */

import { useCallback, useState } from 'react'

/**
 * A set of string keys remembered under `key`.
 *
 * Every access is guarded: private mode, a cleared profile, a quota error or a
 * corrupt value must degrade to the default rather than blank the tab.
 */
export function useStoredSet(
  key: string,
  fallback: readonly string[],
): [Set<string>, (member: string) => void] {
  const [members, setMembers] = useState<Set<string>>(() => {
    try {
      const raw = window.localStorage.getItem(key)
      if (!raw) return new Set(fallback)
      const parsed = JSON.parse(raw)
      // An array of strings or nothing. A stored `null`, object or number is
      // treated as absent -- the default is always a valid answer here.
      return Array.isArray(parsed)
        ? new Set(parsed.filter((m): m is string => typeof m === 'string'))
        : new Set(fallback)
    } catch {
      return new Set(fallback)
    }
  })

  const toggle = useCallback((member: string) => {
    setMembers((current) => {
      const next = new Set(current)
      if (!next.delete(member)) next.add(member)
      try {
        window.localStorage.setItem(key, JSON.stringify([...next]))
      } catch {
        /* quota or private mode: the toggle still works, it just forgets */
      }
      return next
    })
  }, [key])

  return [members, toggle]
}
