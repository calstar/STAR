/**
 * The JMenuBar: File / Edit / Tools / Help with OpenRocket's items, icons and
 * accelerators (BasicFrame.createMenu). Items this milestone cannot do are
 * shown disabled rather than hidden, as OpenRocket greys what does not apply.
 */
import { useEffect, useRef, useState } from 'react'
import { pix } from '../workbench/icons'

export interface MenuItem {
  label?: string
  icon?: string
  acc?: string
  disabled?: boolean
  onClick?: () => void
  sub?: MenuItem[]
  sep?: boolean
}

export function MenuBar({ menus }: { menus: { title: string; items: MenuItem[] }[] }) {
  const [open, setOpen] = useState<number | null>(null)
  const [subOpen, setSubOpen] = useState<number | null>(null)
  const bar = useRef<HTMLDivElement>(null)
  const pos = useRef<number[]>([])

  useEffect(() => {
    if (open == null) return
    const close = (e: MouseEvent) => {
      if (!bar.current?.parentElement?.querySelector('.orw-menu-layer')?.contains(e.target as Node) && !bar.current?.contains(e.target as Node)) setOpen(null)
    }
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(null)
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', key)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', key)
    }
  }, [open])

  const run = (it: MenuItem) => {
    if (it.disabled || it.sub) return
    setOpen(null)
    it.onClick?.()
  }

  return (
    <>
      <div className="orw-menubar" ref={bar} role="menubar">
        {menus.map((m, i) => (
          <div
            key={m.title}
            role="menuitem"
            className={`orw-menu-title ${open === i ? 'open' : ''}`}
            ref={(el) => {
              if (el) pos.current[i] = el.offsetLeft
            }}
            onMouseDown={() => {
              setOpen(open === i ? null : i)
              setSubOpen(null)
            }}
            onMouseEnter={() => {
              if (open != null && open !== i) {
                setOpen(i)
                setSubOpen(null)
              }
            }}
          >
            {m.title}
          </div>
        ))}
      </div>
      {open != null && (
        <div className="orw-menu-layer">
          <div className="orw-popup" style={{ left: pos.current[open] ?? 0, top: 24 }} role="menu">
            {menus[open].items.map((it, k) =>
              it.sep ? (
                <hr key={k} />
              ) : (
                <div
                  key={k}
                  role="menuitem"
                  aria-disabled={it.disabled}
                  className={`orw-mi ${it.disabled ? 'dis' : ''} ${subOpen === k ? 'hot' : ''}`}
                  onMouseEnter={() => setSubOpen(it.sub && !it.disabled ? k : null)}
                  onMouseUp={() => run(it)}
                >
                  <span className="ic">{it.icon && <img src={pix(it.icon)} alt="" width={16} height={16} style={{ opacity: it.disabled ? 0.45 : 1 }} />}</span>
                  {it.label}
                  {it.acc && <span className="acc">{it.acc}</span>}
                  {it.sub && <span className="sub">›</span>}
                  {it.sub && subOpen === k && (
                    <div className="orw-popup" style={{ left: '100%', top: -4, color: 'black' }}>
                      {it.sub.map((s, j) => (
                        <div
                          key={j}
                          className={`orw-mi ${s.disabled ? 'dis' : ''}`}
                          onMouseUp={(e) => {
                            e.stopPropagation()
                            run(s)
                          }}
                        >
                          <span className="ic">{s.icon && <img src={pix(s.icon)} alt="" width={16} height={16} />}</span>
                          {s.label}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ),
            )}
          </div>
        </div>
      )}
    </>
  )
}
