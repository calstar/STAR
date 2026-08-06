/**
 * Parts tree.
 *
 * Left click is navigation: it expands or collapses a group, or selects a leaf.
 * Shift and ctrl/cmd extend that into a multi-selection the way a file browser
 * does -- shift takes the range from the anchor row, ctrl/cmd toggles one row --
 * and the rows walked by shift are the ones actually on screen, so a collapsed
 * group counts as a single step and contributes all of its parts.
 *
 * Hiding is deliberately not a first-class control -- it lives on the
 * right-click menu, because inspecting the model is the common case and
 * changing what the centre of mass covers is the rare one. That menu acts on
 * the whole selection when the row under the cursor belongs to it, and
 * otherwise selects that row first, so what a menu item will touch is always
 * what is highlighted. Hidden entries stay in the tree, greyed, so it is always
 * visible what has been excluded.
 */

import { useMemo, useState } from 'react'

import type { Part } from '../../types'
import { formatMass } from '../../lib/cm'
import { ContextMenu, type MenuItem } from './ContextMenu'

interface Props {
  parts: Part[]
  visibleKeys: Set<string>
  selectedKeys: Set<string>
  onToggle: (keys: string[], visible: boolean) => void
  /** Replaces the selection outright; the last key is treated as primary. */
  onSelect: (keys: string[]) => void
  onHover: (keys: string[]) => void
}

interface Group {
  name: string
  parts: Part[]
}

/**
 * One clickable line, in the order it is drawn.
 *
 * Shift-select works over this list rather than over `parts`, so the range a
 * user sees between the two rows they clicked is exactly the range they get.
 */
interface Row {
  id: string
  keys: string[]
}

interface MenuState {
  x: number
  y: number
  items: MenuItem[]
}

/** Instance suffixes like "<2>" are stripped so copies collapse together. */
function baseName(name: string): string {
  return name.replace(/\s*<\d+>\s*$/, '').trim() || name
}

const groupRowId = (name: string) => `g:${name}`
const partRowId = (key: string) => `p:${key}`

export function PartList({
  parts,
  visibleKeys,
  selectedKeys,
  onToggle,
  onSelect,
  onHover,
}: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [menu, setMenu] = useState<MenuState | null>(null)
  // Where a shift-range starts. Held here rather than derived from the
  // selection because the selection is a set and has no "most recent row".
  const [anchorId, setAnchorId] = useState<string | null>(null)

  const groups = useMemo<Group[]>(() => {
    const byName = new Map<string, Part[]>()
    for (const part of parts) {
      const key = baseName(part.name)
      const existing = byName.get(key)
      if (existing) existing.push(part)
      else byName.set(key, [part])
    }
    return [...byName.entries()]
      .map(([name, groupParts]) => ({ name, parts: groupParts }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [parts])

  // Rebuilt whenever a group opens or closes, because that changes which rows
  // exist and therefore what a range between two of them covers.
  const rows = useMemo<Row[]>(() => {
    const list: Row[] = []
    for (const group of groups) {
      const keys = group.parts.map((part) => part.key)
      if (group.parts.length > 1) {
        list.push({ id: groupRowId(group.name), keys })
        if (expanded.has(group.name)) {
          for (const part of group.parts) list.push({ id: partRowId(part.key), keys: [part.key] })
        }
      } else {
        list.push({ id: partRowId(group.parts[0].key), keys })
      }
    }
    return list
  }, [groups, expanded])

  const rowIndex = useMemo(
    () => new Map(rows.map((row, index) => [row.id, index])),
    [rows],
  )

  const hiddenCount = parts.length - parts.filter((part) => visibleKeys.has(part.key)).length

  const toggleExpanded = (name: string) => {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  const isRowSelected = (row: Row) => row.keys.every((key) => selectedKeys.has(key))
  const isRowPartlySelected = (row: Row) =>
    !isRowSelected(row) && row.keys.some((key) => selectedKeys.has(key))

  const selectRange = (fromId: string, toId: string) => {
    const from = rowIndex.get(fromId)
    const to = rowIndex.get(toId)
    if (from === undefined || to === undefined) return
    const [lo, hi] = from <= to ? [from, to] : [to, from]
    const keys: string[] = []
    for (let i = lo; i <= hi; i += 1) keys.push(...rows[i].keys)
    // A collapsed group and its expanded children overlap, hence the dedupe.
    onSelect([...new Set(keys)])
  }

  /**
   * @param onPlain what an unmodified click means for this row -- expanding a
   *   group, in practice. Modified clicks are selection only: shift-clicking a
   *   group to extend a range should not also fold it away underneath the
   *   cursor.
   */
  const activateRow = (
    row: Row,
    event: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean },
    onPlain?: () => void,
  ) => {
    if (event.shiftKey && anchorId) {
      selectRange(anchorId, row.id)
      return
    }

    if (event.ctrlKey || event.metaKey) {
      const next = new Set(selectedKeys)
      // Whole-row toggle: a group half of whose parts are already selected
      // completes rather than empties, which is the less surprising direction.
      if (isRowSelected(row)) for (const key of row.keys) next.delete(key)
      else for (const key of row.keys) next.add(key)
      onSelect([...next])
      setAnchorId(row.id)
      return
    }

    onSelect(row.keys)
    setAnchorId(row.id)
    onPlain?.()
  }

  const openMenu = (event: React.MouseEvent, row: Row) => {
    // Suppresses the browser's own menu; the event is cancelable.
    event.preventDefault()
    event.stopPropagation()

    // Right-clicking inside the selection acts on all of it; right-clicking
    // outside moves the selection there first, so the menu never operates on
    // parts the user cannot see highlighted.
    const inSelection = selectedKeys.size > 0 && isRowSelected(row)
    const targetKeys = inSelection ? [...selectedKeys] : row.keys
    if (!inSelection) {
      onSelect(row.keys)
      setAnchorId(row.id)
    }

    setMenu({ x: event.clientX, y: event.clientY, items: menuFor(targetKeys) })
  }

  const menuFor = (keys: string[]): MenuItem[] => {
    const unique = [...new Set(keys)]
    const shown = unique.filter((key) => visibleKeys.has(key)).length
    const noun = unique.length === 1 ? 'part' : `${unique.length} parts`

    const items: MenuItem[] = [
      {
        label: shown > 0 ? `Hide ${noun}` : `Show ${noun}`,
        danger: shown > 0,
        onSelect: () => onToggle(unique, shown === 0),
      },
      {
        label: `Isolate ${noun}`,
        onSelect: () => {
          onToggle(parts.map((part) => part.key), false)
          onToggle(unique, true)
        },
      },
    ]

    if (shown > 0 && shown < unique.length) {
      items.splice(1, 0, {
        label: `Show the other ${unique.length - shown}`,
        onSelect: () => onToggle(unique, true),
      })
    }

    if (unique.length > 1) {
      items.push({ label: 'Clear selection', onSelect: () => onSelect([]) })
    }

    return items
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-slate-700 px-3 py-2">
        <span className="text-base font-semibold text-slate-200">Parts ({parts.length})</span>
        {hiddenCount > 0 && (
          <button
            type="button"
            className="rounded border border-slate-600 px-2 py-0.5 text-xs text-amber-300 hover:bg-slate-700"
            onClick={() => onToggle(parts.map((part) => part.key), true)}
          >
            Show {hiddenCount} hidden
          </button>
        )}
      </div>

      {selectedKeys.size > 0 && (
        <div className="flex items-center justify-between border-b border-slate-800 bg-slate-900/80 px-3 py-1 text-xs text-cyan-300">
          <span>
            {selectedKeys.size} selected
            {selectedKeys.size > 1 && (
              <span className="ml-1 text-slate-500">· right click to act on all</span>
            )}
          </span>
          <button
            type="button"
            className="rounded px-1.5 py-0.5 text-slate-400 hover:bg-slate-700 hover:text-slate-200"
            onClick={() => {
              onSelect([])
              setAnchorId(null)
            }}
          >
            Clear
          </button>
        </div>
      )}

      {/* select-none: without it, shift-clicking two rows drags a text
          selection across everything between them. */}
      <ul className="flex-1 select-none overflow-y-auto text-[15px]">
        {groups.map((group) => {
          const keys = group.parts.map((part) => part.key)
          const shown = keys.filter((key) => visibleKeys.has(key)).length
          const isHidden = shown === 0
          const hasChildren = group.parts.length > 1
          const isOpen = expanded.has(group.name)
          const groupMass = group.parts
            .filter((part) => visibleKeys.has(part.key))
            .reduce((sum, part) => sum + part.mass, 0)
          const anyEstimated = group.parts.some((part) => part.materialDefaulted)
          const leaf = group.parts[0]
          const row: Row = hasChildren
            ? { id: groupRowId(group.name), keys }
            : { id: partRowId(leaf.key), keys }
          const isSelected = isRowSelected(row)
          const isPartial = isRowPartlySelected(row)

          return (
            <li key={group.name} className="border-b border-slate-800">
              <div
                role="button"
                tabIndex={0}
                onClick={(event) =>
                  activateRow(row, event, hasChildren ? () => toggleExpanded(group.name) : undefined)
                }
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    activateRow(
                      row,
                      event,
                      hasChildren ? () => toggleExpanded(group.name) : undefined,
                    )
                  }
                }}
                onContextMenu={(event) => openMenu(event, row)}
                onMouseEnter={() => onHover(keys)}
                onMouseLeave={() => onHover([])}
                className={`flex cursor-pointer items-center gap-2 px-2 py-2 hover:bg-slate-800/60 ${
                  isSelected ? 'bg-cyan-500/15' : isPartial ? 'bg-cyan-500/5' : ''
                }`}
                title="Left click to expand · Shift or Ctrl click to select several · Right click for options"
              >
                <span
                  className={`w-5 shrink-0 text-center text-lg leading-none transition-transform ${
                    hasChildren ? 'text-slate-300' : 'text-transparent'
                  } ${isOpen ? 'rotate-90' : ''}`}
                >
                  {hasChildren ? '›' : ''}
                </span>
                <span
                  className={`flex-1 truncate ${
                    isHidden
                      ? 'text-slate-600 line-through'
                      : anyEstimated
                        ? 'text-amber-300'
                        : 'text-slate-200'
                  }`}
                >
                  {group.name}
                  {hasChildren && (
                    <span className="ml-1 text-xs text-slate-500">×{group.parts.length}</span>
                  )}
                </span>
                {shown > 0 && shown < keys.length && (
                  <span className="shrink-0 text-[10px] text-slate-500">{shown}/{keys.length}</span>
                )}
                <span
                  className={`shrink-0 tabular-nums text-sm ${
                    isHidden ? 'text-slate-600' : 'text-slate-400'
                  }`}
                >
                  {formatMass(groupMass)}
                </span>
              </div>

              {hasChildren && isOpen && (
                <ul className="bg-slate-900/40">
                  {group.parts.map((part) => {
                    const partHidden = !visibleKeys.has(part.key)
                    const childRow: Row = { id: partRowId(part.key), keys: [part.key] }
                    return (
                      <li key={part.key}>
                        <div
                          role="button"
                          tabIndex={0}
                          onClick={(event) => activateRow(childRow, event)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault()
                              activateRow(childRow, event)
                            }
                          }}
                          onContextMenu={(event) => openMenu(event, childRow)}
                          onMouseEnter={() => onHover([part.key])}
                          onMouseLeave={() => onHover([])}
                          className={`flex cursor-pointer items-center gap-2 py-1.5 pl-9 pr-2 text-sm hover:bg-slate-800/60 ${
                            selectedKeys.has(part.key) ? 'bg-cyan-500/15' : ''
                          }`}
                        >
                          <span
                            className={`flex-1 truncate ${
                              partHidden ? 'text-slate-600 line-through' : 'text-slate-300'
                            }`}
                          >
                            {part.name}
                          </span>
                          <span
                            className={`tabular-nums ${
                              partHidden ? 'text-slate-600' : 'text-slate-500'
                            }`}
                          >
                            {formatMass(part.mass)}
                          </span>
                        </div>
                      </li>
                    )
                  })}
                </ul>
              )}
            </li>
          )
        })}
      </ul>

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />
      )}
    </div>
  )
}
