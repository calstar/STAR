import { useCallback, useEffect, useMemo, useState } from 'react'

import { fetchManifest, glbUrl, listModels } from './api/client'
import { centreOfMass, formatMass, formatMetres } from './lib/cm'
import { MaterialWarning } from './components/viewer/MaterialWarning'
import { PartList } from './components/viewer/PartList'
import { PropertiesPanel } from './components/viewer/PropertiesPanel'
import { Row } from './components/viewer/Row'
import { Scene } from './components/viewer/Scene'
import type { Manifest, ModelSummary, Part } from './types'

export default function App() {
  const [models, setModels] = useState<ModelSummary[]>([])
  const [modelId, setModelId] = useState<string | null>(null)
  const [manifest, setManifest] = useState<Manifest | null>(null)
  const [error, setError] = useState<string | null>(null)

  const [visibleKeys, setVisibleKeys] = useState<Set<string>>(new Set())
  // Ordered, so the last entry can stand in as the primary selection wherever
  // only one part makes sense -- the 3D highlight, the detail panel.
  const [selectedKeys, setSelectedKeys] = useState<string[]>([])
  // Lifted out of the viewer so the parts list can drive the same highlight.
  const [hoveredKeys, setHoveredKeys] = useState<string[]>([])
  const [density, setDensity] = useState(1750)
  const [opacity, setOpacity] = useState(0.55)
  const [showAssemblyCentroid, setShowAssemblyCentroid] = useState(true)

  useEffect(() => {
    listModels()
      .then((found) => {
        setModels(found)
        if (found.length > 0) setModelId(found[0].id)
        else setError('No built models found. Run: python -m backend.onshape.build <onshape-url>')
      })
      .catch((exc) => setError(String(exc)))
  }, [])

  useEffect(() => {
    if (!modelId) return
    fetchManifest(modelId)
      .then((loaded) => {
        setManifest(loaded)
        setDensity(loaded.defaultDensity)
        setVisibleKeys(new Set(loaded.parts.map((part) => part.key)))
        setSelectedKeys([])
        setError(null)
      })
      .catch((exc) => setError(String(exc)))
  }, [modelId])

  // Re-derive estimated masses whenever the assumed density changes. Volume is
  // exact even for parts Onshape gave no mass for, so this needs no rebuild.
  const parts = useMemo<Part[]>(() => {
    if (!manifest) return []
    if (density === manifest.defaultDensity) return manifest.parts
    return manifest.parts.map((part) =>
      part.materialDefaulted ? { ...part, mass: part.volume * density } : part,
    )
  }, [manifest, density])

  const activeParts = useMemo(
    () => parts.filter((part) => visibleKeys.has(part.key)),
    [parts, visibleKeys],
  )

  const cm = useMemo(() => centreOfMass(activeParts), [activeParts])
  const measuredOnly = useMemo(
    () => centreOfMass(activeParts.filter((part) => !part.materialDefaulted)),
    [activeParts],
  )

  const handleToggle = useCallback((keys: string[], visible: boolean) => {
    setVisibleKeys((current) => {
      const next = new Set(current)
      for (const key of keys) {
        if (visible) next.add(key)
        else next.delete(key)
      }
      return next
    })
  }, [])

  // The scene highlights one part, so it gets the most recent of the selection.
  const selectedKey = selectedKeys.length > 0 ? selectedKeys[selectedKeys.length - 1] : null
  const selectedSet = useMemo(() => new Set(selectedKeys), [selectedKeys])

  // A click in the 3D view replaces the selection rather than adding to it;
  // multi-select is a parts-list gesture.
  const handleSceneSelect = useCallback((key: string | null) => {
    setSelectedKeys(key ? [key] : [])
  }, [])

  const selectedParts = useMemo(
    () => parts.filter((part) => selectedSet.has(part.key)),
    [parts, selectedSet],
  )

  if (error && !manifest) {
    return (
      <div className="flex h-screen items-center justify-center bg-slate-950 p-8 text-slate-300">
        <div className="max-w-xl rounded border border-slate-700 bg-slate-900 p-6">
          <h1 className="mb-2 text-lg font-semibold text-slate-100">Nothing to show</h1>
          <p className="text-sm whitespace-pre-wrap">{error}</p>
        </div>
      </div>
    )
  }

  if (!manifest || !modelId) {
    return (
      <div className="flex h-screen items-center justify-center bg-slate-950 text-slate-400">
        Loading…
      </div>
    )
  }

  const totals = manifest.totals

  return (
    <div className="flex h-screen flex-col bg-slate-950 text-slate-100">
      <header className="flex flex-wrap items-center gap-3 border-b border-slate-700 px-4 py-2">
        <h1 className="text-base font-semibold">
          {manifest.source.documentName}
          <span className="ml-2 text-sm font-normal text-slate-400">
            {manifest.source.assemblyName}
          </span>
        </h1>

        {models.length > 1 && (
          <select
            value={modelId}
            onChange={(event) => setModelId(event.target.value)}
            className="rounded border border-slate-600 bg-slate-900 px-2 py-1 text-sm"
          >
            {models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.documentName ?? model.id}
              </option>
            ))}
          </select>
        )}

        <label className="ml-auto flex items-center gap-2 text-sm text-slate-300">
          Opacity
          <input
            type="range"
            min={0.15}
            max={1}
            step={0.05}
            value={opacity}
            onChange={(event) => setOpacity(Number(event.target.value))}
            className="accent-cyan-400"
          />
        </label>

        <label className="flex items-center gap-2 text-sm text-slate-300">
          <input
            type="checkbox"
            checked={showAssemblyCentroid}
            onChange={(event) => setShowAssemblyCentroid(event.target.checked)}
            className="accent-emerald-400"
          />
          Onshape CM
        </label>
      </header>

      <MaterialWarning
        manifest={manifest}
        density={density}
        onDensityChange={setDensity}
        estimatedMass={cm.massDefaulted}
        measuredMass={cm.mass - cm.massDefaulted}
      />

      <div className="flex min-h-0 flex-1">
        <aside className="w-72 shrink-0 border-r border-slate-700 bg-slate-900/60">
          <PartList
            parts={parts}
            visibleKeys={visibleKeys}
            selectedKeys={selectedSet}
            onToggle={handleToggle}
            onSelect={setSelectedKeys}
            onHover={setHoveredKeys}
          />
        </aside>

        <main className="relative min-w-0 flex-1">
          <Scene
            modelUrl={glbUrl(modelId)}
            manifest={manifest}
            visibleKeys={visibleKeys}
            selectedKey={selectedKey}
            hoveredKeys={hoveredKeys}
            onSelect={handleSceneSelect}
            onHover={setHoveredKeys}
            centroid={cm.centroid}
            showAssemblyCentroid={showAssemblyCentroid}
            opacity={opacity}
          />

          <div className="pointer-events-none absolute left-4 top-4 w-80 space-y-3">
            <section className="pointer-events-auto rounded border border-slate-700 bg-slate-900/90 p-3 text-sm backdrop-blur">
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
                Centre of mass — {cm.partCount} of {parts.length} parts
              </h2>
              <Row label="Total mass" value={formatMass(cm.mass)} />
              <Row label="CM x" value={formatMetres(cm.centroid[0])} />
              <Row label="CM y" value={formatMetres(cm.centroid[1])} />
              <Row label="CM z" value={formatMetres(cm.centroid[2])} highlight />

              {cm.massDefaulted > 0 && (
                <div className="mt-2 border-t border-slate-700 pt-2 text-xs">
                  <p className="mb-1 text-amber-300">
                    Excluding estimated parts ({formatMass(cm.massDefaulted)} assumed):
                  </p>
                  <Row label="Measured mass" value={formatMass(measuredOnly.mass)} small />
                  <Row label="Measured CM z" value={formatMetres(measuredOnly.centroid[2])} small />
                </div>
              )}
            </section>

          </div>

          <div className="pointer-events-none absolute bottom-3 right-4 text-right text-xs text-slate-500">
            <div>
              Onshape total {formatMass(totals.assemblyMass)} · CM z{' '}
              {totals.assemblyCentroid[2].toFixed(4)} m
            </div>
            <div>
              {totals.reconciled ? 'reconciled' : 'NOT reconciled'} · built{' '}
              {manifest.source.builtAt} · {manifest.source.resolvedFrom}
            </div>
          </div>
        </main>

        <aside className="w-80 shrink-0 border-l border-slate-700 bg-slate-900/60">
          <PropertiesPanel selected={selectedParts} visibleKeys={visibleKeys} density={density} />
        </aside>
      </div>
    </div>
  )
}
