import { useCallback, useEffect, useMemo, useState } from 'react'

import {
  computeStability,
  fetchFins,
  fetchManifest,
  fetchOuterSurface,
  glbUrl,
  listModels,
} from './api/client'
import { centreOfMass, formatMass, formatMetres } from './lib/cm'
import { MaterialWarning } from './components/viewer/MaterialWarning'
import { ModelPicker } from './components/viewer/ModelPicker'
import { PartList } from './components/viewer/PartList'
import { PropertiesPanel } from './components/viewer/PropertiesPanel'
import { Row } from './components/viewer/Row'
import { Scene } from './components/viewer/Scene'
import { StabilityPanel } from './components/viewer/StabilityPanel'
import type {
  FaceRef,
  FinPlanform,
  Manifest,
  ModelSummary,
  Part,
  PartOverride,
  StabilityResult,
} from './types'
import { MATERIALS_BY_KEY } from './lib/materials'

/** Survives reloads so a new build does not hijack which model is open. */
const LAST_MODEL_KEY = 'onshape-viewer:last-model'

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
  // Session-only edits, keyed by part. Nothing is written back to Onshape and
  // nothing survives a reload; see PropertiesPanel for what they can change.
  const [overrides, setOverrides] = useState<Map<string, PartOverride>>(new Map())
  const [opacity, setOpacity] = useState(0.55)
  const [showAssemblyCentroid, setShowAssemblyCentroid] = useState(true)
  // Backend-computed stability (CG, CoP, static margin). Null until the user
  // asks for it; cleared when the model changes so a stale margin never lingers.
  const [stability, setStability] = useState<StabilityResult | null>(null)
  const [stabilityBusy, setStabilityBusy] = useState(false)
  const [stabilityError, setStabilityError] = useState<string | null>(null)
  // Outer-surface selection: which faces are the airframe. Empty means "let the
  // backend auto-detect on compute". Editing lets the user correct the guess.
  const [outerFaces, setOuterFaces] = useState<FaceRef[]>([])
  const [finFaces, setFinFaces] = useState<FaceRef[]>([])
  const [finCount, setFinCount] = useState(0)
  // The exposed fin planform surfaces to draw; from auto-detect or compute.
  const [finPlanforms, setFinPlanforms] = useState<FinPlanform[]>([])
  const [faceEditMode, setFaceEditMode] = useState(false)
  const [editTarget, setEditTarget] = useState<'body' | 'fin'>('body')
  const [autoBusy, setAutoBusy] = useState(false)
  const [isolateOuterFaces, setIsolateOuterFaces] = useState(false)
  // Bumped when a build finishes, so rebuilding the model already on screen
  // refetches it. Without this the manifest effect keys only on the id, which
  // has not changed, and the viewer would keep showing the previous build.
  const [reloadNonce, setReloadNonce] = useState(0)

  useEffect(() => {
    listModels()
      .then((found) => {
        setModels(found)
        if (found.length === 0) {
          setError('No models built yet. Use the picker in the header to build one.')
          return
        }
        // Whatever was open last, if it is still built. Falling back to
        // found[0] alone means the newest *build* wins, so building a second
        // assembly silently moves everyone onto it at the next reload -- which
        // reads as being dumped into some sub-assembly for no reason.
        const remembered = window.localStorage.getItem(LAST_MODEL_KEY)
        const restored = found.find((model) => model.id === remembered)
        setModelId((restored ?? found[0]).id)
      })
      .catch((exc) => setError(String(exc)))
  }, [])

  useEffect(() => {
    if (modelId) window.localStorage.setItem(LAST_MODEL_KEY, modelId)
  }, [modelId])

  const handleBuilt = useCallback((builtId: string) => {
    listModels().then(setModels).catch(() => undefined)
    setModelId(builtId)
    setReloadNonce((value) => value + 1)
  }, [])

  useEffect(() => {
    if (!modelId) return
    fetchManifest(modelId)
      .then((loaded) => {
        setManifest(loaded)
        setOverrides(new Map())
        setVisibleKeys(new Set(loaded.parts.map((part) => part.key)))
        setSelectedKeys([])
        setStability(null)
        setStabilityError(null)
        setOuterFaces([])
        setFinFaces([])
        setFinCount(0)
        setFinPlanforms([])
        setFaceEditMode(false)
        setEditTarget('body')
        setIsolateOuterFaces(false)
        setError(null)
      })
      .catch((exc) => setError(String(exc)))
  }, [modelId, reloadNonce])

  // The manifest as edited: a user-assigned mass replaces Onshape's, and every
  // downstream number -- the centre of mass, the totals, the parts list -- is
  // computed from this rather than from the raw manifest.
  const parts = useMemo<Part[]>(() => {
    if (!manifest) return []
    if (overrides.size === 0) return manifest.parts
    return manifest.parts.map((part) => {
      const override = overrides.get(part.key)
      if (!override) return part
      // A typed-in mass wins over everything, including a chosen material.
      if (override.massOverridden) return { ...part, mass: override.mass ?? 0 }
      // Otherwise a catalog material sets the mass from its density and the
      // part's exact volume. Onshape's own material is left untouched.
      if (override.material) {
        const material = MATERIALS_BY_KEY[override.material]
        if (material) return { ...part, mass: part.volume * material.density }
      }
      return part
    })
  }, [manifest, overrides])

  // Which parts carry a user override at all -- a typed-in mass or a chosen
  // material. Colour depends on it and the effective mass alone cannot say: an
  // override equal to Onshape's own figure is still an override.
  const overriddenKeys = useMemo(
    () =>
      new Set(
        [...overrides]
          .filter(([, override]) => override.massOverridden || override.material != null)
          .map(([key]) => key),
      ),
    [overrides],
  )

  const activeParts = useMemo(
    () => parts.filter((part) => visibleKeys.has(part.key)),
    [parts, visibleKeys],
  )

  const cm = useMemo(() => centreOfMass(activeParts), [activeParts])

  // Effective mass per occurrence, sent to the backend so its CG matches exactly
  // what is on screen (material and typed-in overrides included). The backend is
  // the source of truth for the stability CG; this just feeds it the same edits.
  const massOverrides = useMemo(
    () => Object.fromEntries(parts.map((part) => [part.key, part.mass])),
    [parts],
  )

  const handleComputeStability = useCallback(async () => {
    if (!modelId) return
    setStabilityBusy(true)
    setStabilityError(null)
    setFaceEditMode(false) // leave edit mode so raw fin faces stop showing
    try {
      // Use the user's picked faces. If none yet, auto-detect body + fins and
      // keep them in state so what fed the result is highlighted too.
      let body = outerFaces
      let fins = finFaces
      if (body.length === 0) {
        body = (await fetchOuterSurface(modelId)).faces
        setOuterFaces(body)
      }
      if (fins.length === 0) {
        const guess = await fetchFins(modelId)
        fins = guess.faces
        setFinFaces(fins)
        setFinCount(guess.count)
        setFinPlanforms(guess.planforms)
      }
      const result = await computeStability(modelId, {
        outerFaces: body,
        finFaces: fins,
        overrides: massOverrides,
      })
      setStability(result)
      setFinCount(result.fins.count)
      setFinPlanforms(result.fins.planforms)
    } catch (exc) {
      setStabilityError(String(exc))
    } finally {
      setStabilityBusy(false)
    }
  }, [modelId, massOverrides, outerFaces, finFaces])

  const handleAutoDetect = useCallback(async () => {
    if (!modelId) return
    setAutoBusy(true)
    setStabilityError(null)
    setFaceEditMode(false)
    try {
      const [surface, fins] = await Promise.all([fetchOuterSurface(modelId), fetchFins(modelId)])
      setOuterFaces(surface.faces)
      setFinFaces(fins.faces)
      setFinCount(fins.count)
      setFinPlanforms(fins.planforms)
    } catch (exc) {
      setStabilityError(String(exc))
    } finally {
      setAutoBusy(false)
    }
  }, [modelId])

  const handleToggleFaceEdit = useCallback(
    (target: 'body' | 'fin') => {
      setEditTarget(target)
      setFaceEditMode((on) => {
        // Toggle off only if re-clicking the active target; switching target
        // stays in edit mode. Seed from auto-detect the first time in.
        if (outerFaces.length === 0 && finFaces.length === 0) void handleAutoDetect()
        return !(on && editTarget === target)
      })
    },
    [outerFaces.length, finFaces.length, editTarget, handleAutoDetect],
  )

  const handleFaceToggle = useCallback(
    (target: 'body' | 'fin', occurrenceKey: string, faceId: string) => {
      const setter = target === 'fin' ? setFinFaces : setOuterFaces
      setter((current) => {
        const idx = current.findIndex((f) => f.key === occurrenceKey && f.faceId === faceId)
        if (idx >= 0) return current.filter((_, i) => i !== idx)
        return [...current, { key: occurrenceKey, faceId }]
      })
    },
    [],
  )

  const handleOverrideChange = useCallback((key: string, override: PartOverride | null) => {
    setOverrides((current) => {
      const next = new Map(current)
      if (override) next.set(key, override)
      else next.delete(key)
      return next
    })
  }, [])

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
          {/* The picker lives in the header, which does not exist yet on a
              fresh install -- so it is repeated here, otherwise there would be
              no way to build a first model without going back to the CLI. */}
          <div className="mt-4">
            <ModelPicker
              models={models}
              modelId={modelId}
              onSelectModel={setModelId}
              onBuilt={handleBuilt}
            />
          </div>
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
        {/* Fixed title. What is loaded is the picker's job to say, and it
            already does -- naming it twice just made the header noisy. */}
        <h1 className="text-base font-semibold">Onshape Viewer</h1>

        <ModelPicker
          models={models}
          modelId={modelId}
          onSelectModel={setModelId}
          onBuilt={handleBuilt}
        />

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

      <MaterialWarning parts={parts} />

      <div className="flex min-h-0 flex-1">
        <aside className="w-72 shrink-0 border-r border-slate-700 bg-slate-900/60">
          <PartList
            parts={parts}
            visibleKeys={visibleKeys}
            selectedKeys={selectedSet}
            overriddenKeys={overriddenKeys}
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
            selectedKeys={selectedSet}
            overriddenKeys={overriddenKeys}
            hoveredKeys={hoveredKeys}
            onSelect={handleSceneSelect}
            onHover={setHoveredKeys}
            centroid={cm.centroid}
            showAssemblyCentroid={showAssemblyCentroid}
            opacity={opacity}
            copPosition={stability?.cp.world ?? null}
            finPlanforms={faceEditMode && editTarget === 'fin' ? [] : finPlanforms}
            faceEditMode={faceEditMode}
            editTarget={editTarget}
            outerFaces={outerFaces}
            finFaces={finFaces}
            onFaceToggle={handleFaceToggle}
            isolateOuterFaces={isolateOuterFaces}
          />

          <div className="pointer-events-none absolute left-4 top-4 w-80 space-y-3">
            <section className="pointer-events-auto rounded border border-slate-700 bg-slate-900/90 p-3 text-sm backdrop-blur">
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
                Centre of mass — {cm.partCount - cm.masslessCount} of {parts.length} parts
              </h2>
              <Row label="Total mass" value={formatMass(cm.mass)} />
              <Row label="CM x" value={formatMetres(cm.centroid[0])} />
              <Row label="CM y" value={formatMetres(cm.centroid[1])} />
              <Row label="CM z" value={formatMetres(cm.centroid[2])} highlight />

              {cm.masslessCount > 0 && (
                <p className="mt-2 border-t border-slate-700 pt-2 text-xs text-amber-300">
                  {cm.masslessCount} visible {cm.masslessCount === 1 ? 'part has' : 'parts have'} no
                  mass and {cm.masslessCount === 1 ? 'is' : 'are'} not in this figure.
                </p>
              )}
            </section>

            <StabilityPanel
              result={stability}
              busy={stabilityBusy}
              error={stabilityError}
              onCompute={handleComputeStability}
              faceEditMode={faceEditMode}
              editTarget={editTarget}
              onToggleEditMode={handleToggleFaceEdit}
              onAutoDetect={handleAutoDetect}
              outerFaceCount={outerFaces.length}
              finFaceCount={finFaces.length}
              finCount={finCount}
              autoBusy={autoBusy}
              isolate={isolateOuterFaces}
              onToggleIsolate={() => setIsolateOuterFaces((on) => !on)}
            />
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
          <PropertiesPanel
            selected={selectedParts}
            visibleKeys={visibleKeys}
            overrides={overrides}
            onOverrideChange={handleOverrideChange}
          />
        </aside>
      </div>
    </div>
  )
}
