/**
 * The component tree (OpenRocket's ComponentTree / ComponentTreeRenderer):
 * the rocket's name as the root row, then each component with its small
 * icon, expand/collapse handles and dotted guide lines. Click selects,
 * double-click edits, F2 renames in place, arrow keys walk, Delete deletes.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Component } from '../types'
import { componentIcon } from '../workbench/icons'

const INDENT = 26
const ROW = 22

interface Row {
  c: Component
  depth: number
  /** For guide lines: whether each ancestor level continues below. */
  last: boolean
  hasKids: boolean
}

export function ComponentTree({
  root, selectedId, onSelect, onEdit, onRename, onDelete, style,
}: {
  root: Component
  selectedId: string | null
  onSelect: (id: string) => void
  onEdit: (id: string) => void
  onRename: (id: string, name: string) => void
  onDelete: (id: string) => void
  style?: React.CSSProperties
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [renaming, setRenaming] = useState<string | null>(null)
  const box = useRef<HTMLDivElement>(null)

  const rows = useMemo(() => {
    const out: Row[] = []
    const visit = (c: Component, depth: number, last: boolean) => {
      out.push({ c, depth, last, hasKids: c.children.length > 0 })
      if (collapsed.has(c.id) && depth > 0) return
      c.children.forEach((ch, i) => visit(ch, depth + 1, i === c.children.length - 1))
    }
    visit(root, 0, true)
    return out
  }, [root, collapsed])

  // Keep the selection visible: expand its ancestors.
  useEffect(() => {
    if (!selectedId) return
    const path: string[] = []
    const find = (c: Component): boolean => {
      if (c.id === selectedId) return true
      for (const ch of c.children) {
        if (find(ch)) {
          path.push(c.id)
          return true
        }
      }
      return false
    }
    find(root)
    if (path.some((id) => collapsed.has(id))) {
      setCollapsed((s) => {
        const n = new Set(s)
        path.forEach((id) => n.delete(id))
        return n
      })
    }
  }, [selectedId, root, collapsed])

  const toggle = (id: string) =>
    setCollapsed((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })

  const onKey = (e: React.KeyboardEvent) => {
    if (renaming) return
    const i = rows.findIndex((r) => r.c.id === selectedId)
    if (e.key === 'ArrowDown' && i < rows.length - 1) {
      e.preventDefault()
      onSelect(rows[i + 1].c.id)
    } else if (e.key === 'ArrowUp' && i > 0) {
      e.preventDefault()
      onSelect(rows[i - 1].c.id)
    } else if (e.key === 'ArrowLeft' && i >= 0 && rows[i].hasKids && !collapsed.has(rows[i].c.id) && rows[i].depth > 0) {
      toggle(rows[i].c.id)
    } else if (e.key === 'ArrowRight' && i >= 0 && collapsed.has(rows[i].c.id)) {
      toggle(rows[i].c.id)
    } else if (e.key === 'Enter' && selectedId) {
      onEdit(selectedId)
    } else if (e.key === 'F2' && selectedId) {
      setRenaming(selectedId)
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId && i > 0) {
      e.preventDefault()
      onDelete(selectedId)
    }
  }

  // Vertical guide lines: from each expanded parent's handle down to its last child.
  const guides: { x: number; y0: number; y1: number }[] = []
  const elbows: { x: number; y: number; w: number }[] = []
  rows.forEach((r, i) => {
    if (r.depth === 0) return
    const x = 3 + (r.depth - 1) * INDENT + 11
    elbows.push({ x, y: i * ROW + ROW / 2, w: 10 })
    if (r.hasKids && !collapsed.has(r.c.id)) {
      // find last descendant child row index
      let last = i
      for (let j = i + 1; j < rows.length && rows[j].depth > r.depth; j++) if (rows[j].depth === r.depth + 1) last = j
      guides.push({ x: x + INDENT, y0: i * ROW + ROW / 2, y1: last * ROW + ROW / 2 })
    }
  })
  // root -> stages
  const stageRows = rows.map((r, i) => ({ r, i })).filter(({ r }) => r.depth === 1)
  if (stageRows.length) guides.push({ x: 14, y0: ROW - 3, y1: stageRows[stageRows.length - 1].i * ROW + ROW / 2 })

  return (
    <div
      ref={box}
      className="orw-tree"
      tabIndex={0}
      role="tree"
      aria-label="Component tree"
      onKeyDown={onKey}
      style={style}
    >
      <div style={{ position: 'relative', minHeight: rows.length * ROW }}>
        {guides.map((g, k) => (
          <div key={`g${k}`} className="guide" style={{ left: g.x, top: g.y0, height: g.y1 - g.y0, borderLeftWidth: 1 }} />
        ))}
        {elbows.map((g, k) => (
          <div key={`e${k}`} className="guide" style={{ left: g.x, top: g.y, width: g.w, borderTopWidth: 1 }} />
        ))}
        {rows.map((r) => {
          const icon = r.depth > 0 ? componentIcon(r.c.type, 'small', r.c.params) : null
          const left = r.depth === 0 ? 3 : 11 + (r.depth - 1) * INDENT + 22 - 8
          const sel = r.c.id === selectedId
          return (
            <div
              key={r.c.id}
              role="treeitem"
              aria-selected={sel}
              aria-expanded={r.hasKids ? !collapsed.has(r.c.id) : undefined}
              className={`row ${sel ? 'sel' : ''}`}
              style={{ paddingLeft: left }}
              onMouseDown={() => onSelect(r.c.id)}
              onDoubleClick={() => r.depth > 0 && onEdit(r.c.id)}
              data-testid={`tree-${r.c.name}`}
            >
              {r.depth > 0 && r.hasKids && (
                <span
                  className={`twist ${collapsed.has(r.c.id) ? 'closed' : ''}`}
                  style={{ position: 'absolute', left: left - 16 }}
                  onMouseDown={(e) => {
                    e.stopPropagation()
                    toggle(r.c.id)
                  }}
                />
              )}
              {icon && <img src={icon} alt="" width={30} height={11} style={{ marginRight: 4, position: 'relative', zIndex: 1, background: 'white' }} />}
              {renaming === r.c.id ? (
                <input
                  className="rename"
                  autoFocus
                  defaultValue={r.c.name}
                  onMouseDown={(e) => e.stopPropagation()}
                  onBlur={(e) => {
                    onRename(r.c.id, e.target.value)
                    setRenaming(null)
                    box.current?.focus()
                  }}
                  onKeyDown={(e) => {
                    e.stopPropagation()
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                    if (e.key === 'Escape') {
                      setRenaming(null)
                      box.current?.focus()
                    }
                  }}
                />
              ) : (
                <span className="label">{r.c.name}</span>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
