/**
 * <OpenRocketWorkbench/> -- the whole app as one component, so star-openrocket
 * can mount it as a tab. It owns: the API connection (live or mock), the
 * document and its undo history, the selection, the analysis conditions, and
 * OpenRocket's main-window layout (BasicFrame): menu bar, the three tabs, the
 * design panel over the RocketPanel.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './openrocket.css'
import { connect, connectLive, type Api } from '../api/client'
import type { Analysis, Component, ComponentType, Conditions, MaterialDb, Params, RocketDocument } from '../types'
import { UnitsProvider, useUnits } from './units'
import { useAnalysis, useDocumentHistory } from './hooks'
import { load, save } from '../lib/persist'
import { canRedo, canUndo, redoLabel, undoLabel } from '../lib/history'
import { addTarget } from '../lib/rules'
import { findById, findParent, insertChild, moveSibling, canMove, removeById, updateById, withFreshIds } from '../lib/tree'
import { MenuBar, type MenuItem } from '../components/MenuBar'
import { Btn, Combo, Tabs, Window } from '../components/swing'
import { ComponentTree } from '../components/ComponentTree'
import { AddComponentPanel } from '../components/AddComponentPanel'
import { RocketPanel } from '../components/RocketPanel'
import { MotorsTab } from '../components/MotorsTab'
import { toggleStage } from '../lib/flightconfig'
import { ComponentConfigDialog } from '../components/edit/ComponentConfigDialog'
import { LENGTH_UNITS, MASS_UNITS, IMPERIAL, METRIC } from '../lib/units'
import { pix } from './icons'

export const PROVENANCE = 'OpenRocket 24.12 Barrowman, ported'
const AUTOSAVE_KEY = 'document'
const DEFAULT_EXAMPLE = 'A simple model rocket'

/** What the workbench is showing, for a host that wants to read it (star-openrocket's ORK vs CAD tab). */
export interface WorkbenchState {
  document: RocketDocument
  /** The analysis at the workbench's own conditions (the figure's Mach/AoA); null until the first one lands. */
  analysis: Analysis | null
  conditions: Conditions
  /** The last analysis error, if the current document could not be analysed. */
  error: string | null
}

/** A document for the host to put in the workbench; a new `key` loads it again (a fresh undo history). */
export interface WorkbenchLoad {
  key: string | number
  document: RocketDocument
}

export interface OpenRocketWorkbenchProps {
  /** API prefix; '/api' by default (Vite proxies it to :8004). star-openrocket mounts it at '/api/ork'. */
  apiBase?: string
  /** Inject an Api (tests, or a host app with its own client). */
  api?: Api
  /**
   * Fall back to the in-browser mock when the API does not answer. True standalone;
   * a host passes false, so a dead backend shows as an error rather than as
   * approximate numbers that look like OpenRocket's.
   */
  allowMock?: boolean
  /**
   * Whether the workbench is the visible tab. Keyboard shortcuts (Ctrl+Z, Ctrl+S, ...)
   * act only while it is; a host keeps it mounted but hidden on other tabs so the
   * design and its undo history survive the switch. Default true.
   */
  active?: boolean
  /** Called with the document and its analysis whenever either changes. */
  onState?: (s: WorkbenchState) => void
  /** Replace the open document (e.g. the CAD's own .ork, imported by the host). */
  load?: WorkbenchLoad | null
}

export function OpenRocketWorkbench(props: OpenRocketWorkbenchProps) {
  return (
    <UnitsProvider>
      <Boot {...props} />
    </UnitsProvider>
  )
}

/** Connects, then finds the first document: the autosave, else the example, else a new rocket. */
function Boot({ apiBase = '/api', api: injected, allowMock = true, active = true, onState, load: toLoad }: OpenRocketWorkbenchProps) {
  const [api, setApi] = useState<Api | null>(injected ?? null)
  const [initial, setInitial] = useState<RocketDocument | null>(null)
  const [fatal, setFatal] = useState<string | null>(null)
  const [down, setDown] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let live = true
    setDown(null)
    ;(async () => {
      let a: Api
      if (injected) a = injected
      else if (allowMock) a = await connect(apiBase)
      else {
        try {
          a = await connectLive(apiBase)
        } catch (e) {
          if (live) setDown(String((e as Error)?.message ?? e))
          return
        }
      }
      if (!live) return
      setApi(a)
      const saved = load<RocketDocument | null>(AUTOSAVE_KEY, null)
      if (saved && saved.rocket && Array.isArray(saved.motorConfigs)) {
        setInitial(saved)
        return
      }
      try {
        setInitial(await a.example(DEFAULT_EXAMPLE))
      } catch {
        try {
          setInitial(await newDocument(a))
        } catch (e) {
          setFatal(String((e as Error)?.message ?? e))
        }
      }
    })()
    return () => {
      live = false
    }
  }, [apiBase, injected, allowMock, attempt])
  if (down)
    return (
      <div className="orw" style={{ padding: 20, gap: 10 }} data-testid="openrocket-workbench-down">
        <b>The OpenRocket API is not answering.</b>
        <span>
          {apiBase}/health: {down}
        </span>
        <span style={{ color: '#555' }}>Nothing here is computed in the browser, so there is nothing to show until it is back.</span>
        <span>
          <Btn isDefault onClick={() => setAttempt((n) => n + 1)}>
            Retry
          </Btn>
        </span>
      </div>
    )
  if (fatal) return <div className="orw" style={{ padding: 20 }}>Could not start: {fatal}</div>
  if (!api || !initial) return <div className="orw" style={{ padding: 20 }}>Loading…</div>
  return <Workbench api={api} initial={initial} active={active} onState={onState} load={toLoad ?? null} />
}

export async function newDocument(api: Api): Promise<RocketDocument> {
  const [rocket, stage] = await Promise.all([api.defaults('rocket'), api.defaults('stage')])
  const cfg = crypto.randomUUID?.() ?? String(Date.now())
  return {
    version: 1,
    rocket: { ...withFreshIds(rocket), name: 'Rocket', children: [{ ...withFreshIds(stage), name: 'Sustainer' }] },
    motorConfigs: [{ id: cfg, name: '', default: true, stages: { '0': true }, motors: {} }],
    selectedConfig: cfg,
  }
}

// No Flight simulations tab: this app makes .ork files and leaves flying them to
// OpenRocket. Motors & Configuration stays -- it carries stages, separation and ignition.
type MainTab = 'design' | 'motors'

interface EditState {
  id: string
  /** The document as it was when the dialog opened, for Cancel. */
  snapshot: RocketDocument
  isNew: boolean
}

interface WorkbenchInnerProps {
  api: Api
  initial: RocketDocument
  active: boolean
  onState?: (s: WorkbenchState) => void
  load: WorkbenchLoad | null
}

function Workbench({ api, initial, active, onState, load: toLoad }: WorkbenchInnerProps) {
  const units = useUnits()
  const d = useDocumentHistory(initial)
  const doc = d.doc
  const [tab, setTab] = useState<MainTab>('design')
  const [selectedId, setSelectedId] = useState<string | null>(() => initial.rocket.children[0]?.id ?? null)
  const [edit, setEdit] = useState<EditState | null>(null)
  const [ask, setAsk] = useState<{ type: ComponentType; parentId: string; index: number } | null>(null)
  const [materials, setMaterials] = useState<MaterialDb | null>(null)
  const [examples, setExamples] = useState<string[]>([])
  const [message, setMessage] = useState<string | null>(null)
  const [dialog, setDialog] = useState<'prefs' | 'about' | null>(null)
  const [topH, setTopH] = useState(310)
  const [cond, setCond] = useState<Omit<Conditions, 'configId'>>({ mach: 0.3, aoaDeg: 0, rollRate: 0, theta: 0 })
  const fileInput = useRef<HTMLInputElement>(null)

  const conditions = useMemo<Conditions>(() => ({ ...cond, configId: doc.selectedConfig }), [cond, doc.selectedConfig])
  const { analysis, error } = useAnalysis(api, doc, conditions)

  // Tell the host what is on screen. Through a ref, so a host that passes a new
  // callback every render does not make this fire every render.
  const onStateRef = useRef(onState)
  onStateRef.current = onState
  useEffect(() => {
    onStateRef.current?.({ document: doc, analysis, conditions, error })
  }, [doc, analysis, conditions, error])

  // The host hands over a document (star-openrocket's "Load CAD into OpenRocket").
  // Keyed, so the same load is applied once and a new one always is.
  const loadedKey = useRef<string | number | null>(null)
  useEffect(() => {
    if (!toLoad || toLoad.key === loadedKey.current) return
    loadedKey.current = toLoad.key
    d.replace(toLoad.document)
    setSelectedId(toLoad.document.rocket.children[0]?.id ?? null)
    setEdit(null)
  }, [toLoad, d.replace])
  const resolved = (analysis as (Analysis & { resolved?: Record<string, Record<string, number>> }) | null)?.resolved

  useEffect(() => {
    api.materials().then(setMaterials).catch(() => setMaterials(null))
    api.examples().then((e) => setExamples(e.map((x) => x.name))).catch(() => setExamples([]))
  }, [api])

  // Autosave (an improvement over OpenRocket): every change, per browser.
  useEffect(() => {
    const t = setTimeout(() => save(AUTOSAVE_KEY, doc), 400)
    return () => clearTimeout(t)
  }, [doc])

  // The selection must exist.
  useEffect(() => {
    if (selectedId && !findById(doc.rocket, selectedId)) setSelectedId(null)
    if (edit && !findById(doc.rocket, edit.id)) setEdit(null)
  }, [doc, selectedId, edit])

  const selected = findById(doc.rocket, selectedId)

  const flash = (m: string) => {
    setMessage(m)
    setTimeout(() => setMessage((x) => (x === m ? null : x)), 5000)
  }

  const onParams = useCallback(
    (id: string, fn: (p: Params) => Params, key: string) =>
      d.apply((x) => ({ ...x, rocket: updateById(x.rocket, id, (c) => ({ ...c, params: fn(c.params) })) }), {
        key: `${id}:${key}`,
        label: `Modify ${findById(doc.rocket, id)?.name ?? 'component'}`,
      }),
    [d, doc.rocket],
  )
  const onRename = useCallback(
    (id: string, name: string) =>
      d.apply((x) => (id === x.rocket.id ? { ...x, rocket: { ...x.rocket, name } } : { ...x, rocket: updateById(x.rocket, id, (c) => ({ ...c, name })) }), {
        key: `${id}:name`,
        label: 'Rename component',
      }),
    [d],
  )

  const openEdit = (id: string, isNew = false, base?: RocketDocument) => {
    d.seal()
    setSelectedId(id)
    setEdit({ id, snapshot: base ?? doc, isNew })
  }
  const closeEdit = () => {
    d.seal()
    setEdit(null)
  }
  const cancelEdit = () => {
    if (!edit) return
    const snap = edit.snapshot
    d.apply(() => snap, { label: edit.isNew ? 'Undo adding component' : 'Discard changes' })
    d.seal()
    setEdit(null)
  }

  const insert = async (type: ComponentType, parentId: string, index: number | null) => {
    try {
      const fresh = withFreshIds(await api.defaults(type))
      const before = doc
      d.apply((x) => ({ ...x, rocket: insertChild(x.rocket, parentId, fresh, index) }), { label: `Add ${fresh.name}` })
      openEdit(fresh.id, true, before)
    } catch (e) {
      flash(`Could not add: ${(e as Error).message}`)
    }
  }

  const onAdd = (type: ComponentType) => {
    const t = addTarget(doc.rocket, selected, type)
    if (!t) return
    if (t.ask && t.index != null) setAsk({ type, parentId: t.parentId, index: t.index })
    else insert(type, t.parentId, t.index)
  }

  const canDelete = (c: Component | null): boolean => {
    if (!c || c.type === 'rocket') return false
    if (c.type === 'stage' && doc.rocket.children.length <= 1) return false
    return true
  }
  const del = (id: string) => {
    const c = findById(doc.rocket, id)
    if (!canDelete(c)) return
    const parent = findParent(doc.rocket, id)
    const i = parent?.children.findIndex((x) => x.id === id) ?? -1
    d.apply((x) => ({ ...x, rocket: removeById(x.rocket, id) }), { label: `Delete ${c!.name}` })
    const sib = parent?.children[i + 1] ?? parent?.children[i - 1] ?? parent
    setSelectedId(sib?.id ?? null)
  }
  const duplicate = (id: string) => {
    const c = findById(doc.rocket, id)
    const parent = findParent(doc.rocket, id)
    if (!c || !parent) return
    const copy = withFreshIds(c)
    const i = parent.children.findIndex((x) => x.id === id)
    d.apply((x) => ({ ...x, rocket: insertChild(x.rocket, parent.id, copy, i + 1) }), { label: `Duplicate ${c.name}` })
    setSelectedId(copy.id)
  }
  const move = (delta: -1 | 1) => {
    if (!selectedId) return
    d.apply((x) => ({ ...x, rocket: moveSibling(x.rocket, selectedId, delta) }), { label: delta < 0 ? 'Move up' : 'Move down' })
  }

  // File operations
  const doNew = async () => {
    try {
      const n = await newDocument(api)
      d.replace(n)
      setSelectedId(n.rocket.children[0]?.id ?? null)
      setEdit(null)
    } catch (e) {
      flash(`New failed: ${(e as Error).message}`)
    }
  }
  const openExample = async (name: string) => {
    try {
      const n = await api.example(name)
      d.replace(n)
      setSelectedId(n.rocket.children[0]?.id ?? null)
      setEdit(null)
    } catch (e) {
      flash(`Could not open example: ${(e as Error).message}`)
    }
  }
  const openFile = async (f: File) => {
    try {
      const n = await api.importOrk(f)
      d.replace(n)
      setSelectedId(n.rocket.children[0]?.id ?? null)
      setEdit(null)
    } catch (e) {
      flash(`Could not open ${f.name}: ${(e as Error).message}`)
    }
  }
  const saveOrk = async () => {
    try {
      const blob = await api.exportOrk(doc)
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = `${doc.rocket.name || 'rocket'}${api.mode === 'mock' ? '.ork.json' : '.ork'}`
      a.click()
      setTimeout(() => URL.revokeObjectURL(a.href), 1000)
    } catch (e) {
      flash(`Save failed: ${(e as Error).message}`)
    }
  }

  // Shortcuts (not while typing, and only while this is the visible tab).
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')
      const mod = e.ctrlKey || e.metaKey
      if (!mod) return
      const k = e.key.toLowerCase()
      if (k === 'z' && !typing) {
        e.preventDefault()
        if (e.shiftKey) d.redo()
        else d.undo()
      } else if (k === 'y' && !typing) {
        e.preventDefault()
        d.redo()
      } else if (k === 's') {
        e.preventDefault()
        saveOrk()
      } else if (k === 'o') {
        e.preventDefault()
        fileInput.current?.click()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const h = d.history
  const menus: { title: string; items: MenuItem[] }[] = [
    {
      title: 'File',
      items: [
        { label: 'New', icon: 'icons/document-new.png', acc: 'Ctrl+N', onClick: doNew },
        { label: 'Open...', icon: 'icons/document-open.png', acc: 'Ctrl+O', onClick: () => fileInput.current?.click() },
        { label: 'Open recent', icon: 'icons/document-open.png', disabled: true, sub: [] },
        {
          label: 'Open example',
          icon: 'icons/document-open-example.png',
          sub: examples.map((n) => ({ label: n, onClick: () => openExample(n) })),
          disabled: !examples.length,
        },
        { label: 'Import', icon: 'icons/import.png', disabled: true, sub: [] },
        { sep: true },
        { label: 'Save', icon: 'icons/document-save.png', acc: 'Ctrl+S', onClick: saveOrk },
        { label: 'Save as...', icon: 'icons/document-save-as.png', acc: 'Ctrl+Shift+S', onClick: saveOrk },
        { label: 'Export as...', icon: 'icons/export.png', disabled: true, sub: [] },
        { sep: true },
        { label: 'Save decal image...', icon: 'icons/Painting-Transparent-PNG_16.png', disabled: true },
        { label: 'Print design info...', icon: 'icons/print-design.specs.png', acc: 'Ctrl+P', disabled: true },
        { label: 'Export simulation table as CSV file', icon: 'icons/sim_table_export.png', disabled: true },
        { sep: true },
        { label: 'Properties', icon: 'icons/preferences.png', acc: 'Ctrl+I', onClick: () => openEdit(doc.rocket.id) },
        { label: 'Close design', icon: 'icons/document-close.png', acc: 'Ctrl+W', onClick: doNew },
        { sep: true },
        { label: 'Quit', icon: 'icons/application-exit.png', acc: 'Ctrl+Q', disabled: true },
      ],
    },
    {
      title: 'Edit',
      items: [
        { label: `Undo${undoLabel(h) ? ` (${undoLabel(h)})` : ''}`, icon: 'icons/edit-undo.png', acc: 'Ctrl+Z', disabled: !canUndo(h), onClick: d.undo },
        { label: `Redo${redoLabel(h) ? ` (${redoLabel(h)})` : ''}`, icon: 'icons/edit-redo.png', acc: 'Ctrl+Y', disabled: !canRedo(h), onClick: d.redo },
        { sep: true },
        { label: 'Cut', icon: 'icons/edit-cut.png', acc: 'Ctrl+X', disabled: true },
        { label: 'Copy', icon: 'icons/edit-copy.png', acc: 'Ctrl+C', disabled: true },
        { label: 'Paste', icon: 'icons/edit-paste.png', acc: 'Ctrl+V', disabled: true },
        { label: 'Duplicate', icon: 'icons/edit-duplicate.png', disabled: !selected || selected.type === 'rocket', onClick: () => selectedId && duplicate(selectedId) },
        { label: 'Delete', icon: 'icons/edit-delete.png', acc: 'Delete', disabled: !canDelete(selected), onClick: () => selectedId && del(selectedId) },
        { sep: true },
        { label: 'Scale...', icon: 'icons/edit-scale.png', disabled: true },
        { sep: true },
        { label: 'Preferences', icon: 'icons/preferences.png', onClick: () => setDialog('prefs') },
      ],
    },
    {
      title: 'Tools',
      items: [
        { label: 'Component analysis', disabled: true },
        { label: 'Rocket optimization', disabled: true },
        { label: 'Custom expressions', disabled: true },
      ],
    },
    {
      title: 'Help',
      items: [{ label: 'About', icon: 'icons/help-about.png', onClick: () => setDialog('about') }],
    },
  ]

  const editComp = edit ? findById(doc.rocket, edit.id) : null
  const innerRadiusOf = (mount: Component): number | null => {
    const p = mount.params
    const r = typeof p.outerradius === 'number' ? p.outerradius : resolved?.[mount.id]?.radius ?? (p.radius as { value?: number })?.value ?? null
    const t = typeof p.thickness === 'number' ? p.thickness : 0
    return r == null ? null : Math.max(0, r - t)
  }

  return (
    <div className="orw" data-testid="openrocket-workbench">
      <MenuBar menus={menus} />
      <Tabs
        tabs={[
          { id: 'design', label: 'Rocket design' },
          { id: 'motors', label: 'Motors & Configuration' },
        ]}
        active={tab}
        onChange={setTab}
      />
      {/* Upper half: the tab's own panel */}
      <div style={{ height: topH, flex: 'none', minHeight: 120, display: 'flex', flexDirection: 'column' }}>
        {tab === 'design' && (
          <div style={{ display: 'flex', height: '100%', padding: '6px 2px 0 6px' }}>
            <ComponentTree
              root={doc.rocket}
              selectedId={selectedId}
              onSelect={(id) => {
                setSelectedId(id)
                if (edit && id !== edit.id) openEdit(id)
              }}
              onEdit={(id) => openEdit(id)}
              onRename={onRename}
              onDelete={del}
              style={{ width: 651, flex: '1 1 651px', minWidth: 240 }}
            />
            <div style={{ width: 128, flex: 'none', marginLeft: 6, display: 'flex', flexDirection: 'column', paddingTop: 13 }}>
              <Btn icon="icons/up.png" className="left" disabled={!selectedId || !canMove(doc.rocket, selectedId, -1)} onClick={() => move(-1)}>
                Move up
              </Btn>
              <Btn icon="icons/down.png" className="left" style={{ marginTop: 13 }} disabled={!selectedId || !canMove(doc.rocket, selectedId, 1)} onClick={() => move(1)}>
                Move down
              </Btn>
              <span style={{ flex: 1 }} />
              <Btn icon="icons/edit-edit.png" className="left" disabled={!selectedId} onClick={() => selectedId && openEdit(selectedId)}>
                Edit
              </Btn>
              <Btn icon="icons/edit-duplicate.png" className="left" style={{ marginTop: 26 }} disabled={!selected || selected.type === 'rocket'} onClick={() => selectedId && duplicate(selectedId)}>
                Duplicate
              </Btn>
              <Btn icon="icons/edit-delete.png" className="left" style={{ marginTop: 26, marginBottom: 10 }} disabled={!canDelete(selected)} onClick={() => selectedId && del(selectedId)}>
                Delete
              </Btn>
            </div>
            <div className="orw-vsplit" aria-hidden>
              ⋮
            </div>
            <AddComponentPanel root={doc.rocket} selected={selected} onAdd={onAdd} style={{ width: 634, flex: '0 1 634px', minWidth: 260 }} />
          </div>
        )}
        {tab === 'motors' && (
          <MotorsTab
            api={api}
            doc={doc}
            apply={(fn, label) => d.apply(fn, { label })}
            onParams={onParams}
            analysisInner={innerRadiusOf}
          />
        )}
      </div>
      <div
        className="orw-splitter"
        role="separator"
        aria-orientation="horizontal"
        onMouseDown={(e) => {
          const y0 = e.clientY
          const h0 = topH
          const mv = (m: MouseEvent) => setTopH(Math.max(120, Math.min(window.innerHeight - 260, h0 + m.clientY - y0)))
          const up = () => {
            window.removeEventListener('mousemove', mv)
            window.removeEventListener('mouseup', up)
          }
          window.addEventListener('mousemove', mv)
          window.addEventListener('mouseup', up)
        }}
      >
        •••
      </div>
      <RocketPanel
        doc={doc}
        analysis={analysis}
        selectedId={selectedId}
        onSelect={(id) => {
          setSelectedId(id)
          if (id && edit && id !== edit.id) openEdit(id)
        }}
        onEdit={(id) => openEdit(id)}
        conditions={conditions}
        setConditions={(c) => setCond({ mach: c.mach, aoaDeg: c.aoaDeg, rollRate: c.rollRate, theta: c.theta })}
        onSelectConfig={(id) => d.apply((x) => ({ ...x, selectedConfig: id }), { label: 'Select configuration' })}
        onToggleStage={(n) => doc.selectedConfig && d.apply((x) => (x.selectedConfig ? toggleStage(x, x.selectedConfig, n) : x), { label: 'Toggle stage' })}
        provenance={api.mode === 'mock' ? `${PROVENANCE} — currently the in-browser mock, approximate` : PROVENANCE}
        mockMode={api.mode === 'mock'}
        error={error}
      />

      <input
        ref={fileInput}
        type="file"
        accept=".ork,.json,application/zip"
        style={{ display: 'none' }}
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) openFile(f)
          e.target.value = ''
        }}
      />

      {editComp && edit && (
        <ComponentConfigDialog
          key={editComp.id}
          c={editComp}
          doc={doc}
          analysis={analysis}
          materials={materials}
          resolved={resolved}
          onParams={onParams}
          onRename={onRename}
          onCancel={cancelEdit}
          onClose={closeEdit}
          isNew={edit.isNew}
        />
      )}

      {ask && (
        <Window title="Select component position" onClose={() => setAsk(null)} initial={{ x: 520, y: 200 }} width={430} modal zIndex={70}>
          <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <span>Insert the component after the current component or as the last component?</span>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <Btn
                isDefault
                onClick={() => {
                  const a = ask
                  setAsk(null)
                  insert(a.type, a.parentId, a.index)
                }}
              >
                Insert here
              </Btn>
              <Btn
                onClick={() => {
                  const a = ask
                  setAsk(null)
                  insert(a.type, a.parentId, null)
                }}
              >
                Add to the end
              </Btn>
              <Btn onClick={() => setAsk(null)}>Cancel</Btn>
            </div>
          </div>
        </Window>
      )}

      {dialog === 'prefs' && (
        <Window title="Preferences — Units" onClose={() => setDialog(null)} initial={{ x: 480, y: 160 }} width={420} modal zIndex={70}>
          <div style={{ padding: 14, display: 'grid', gridTemplateColumns: 'max-content auto', gap: '12px 12px', alignItems: 'center' }}>
            <span>Default units:</span>
            <span style={{ display: 'flex', gap: 6 }}>
              <Btn onClick={() => units.setPrefs(METRIC)}>Metric</Btn>
              <Btn onClick={() => units.setPrefs(IMPERIAL)}>Imperial</Btn>
            </span>
            <span>Length:</span>
            <Combo value={units.prefs.length} options={LENGTH_UNITS.map((u) => ({ value: u, label: u }))} onChange={(v) => units.setPrefs({ ...units.prefs, length: v })} style={{ width: 120 }} />
            <span>Mass:</span>
            <Combo value={units.prefs.mass} options={MASS_UNITS.map((u) => ({ value: u, label: u }))} onChange={(v) => units.setPrefs({ ...units.prefs, mass: v })} style={{ width: 120 }} />
            <span />
            <span style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <Btn isDefault onClick={() => setDialog(null)}>
                Close
              </Btn>
            </span>
          </div>
        </Window>
      )}
      {dialog === 'about' && (
        <Window title="About" onClose={() => setDialog(null)} initial={{ x: 480, y: 160 }} width={460} modal zIndex={70}>
          <div style={{ padding: 16, display: 'flex', gap: 14 }}>
            <img src={pix('icon-064.png')} width={64} height={64} alt="" />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <b>openrocket-web</b>
              <span>OpenRocket 24.12's design view in the browser, on a Python port of its physics.</span>
              <span style={{ fontSize: 12, color: '#555' }}>
                GPLv3. Icons and the Inter font are OpenRocket's own. API: {api.mode === 'mock' ? 'in-browser mock (backend not reachable)' : 'live'}.
              </span>
              <span style={{ alignSelf: 'flex-end' }}>
                <Btn isDefault onClick={() => setDialog(null)}>
                  Close
                </Btn>
              </span>
            </div>
          </div>
        </Window>
      )}

      {message && (
        <div style={{ position: 'absolute', left: '50%', top: 60, transform: 'translateX(-50%)', background: '#fff8dc', border: '1px solid #d9c37a', padding: '6px 12px', zIndex: 80, fontSize: 13 }}>
          {message}
        </div>
      )}
    </div>
  )
}

