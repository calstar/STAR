import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import starWordmark from './assets/star-wordmark.png'
import {
  computeFlight,
  computeStability,
  fetchFins,
  fetchManifest,
  fetchMotor,
  fetchOuterSurface,
  glbUrl,
  listModels,
} from './api/client'
import { centreOfMass, formatMass } from './lib/cm'
import { loadViewerConfig, saveViewerConfig } from './lib/persist'
import type { FlightParams, ViewerConfig } from './types/config'
import { ConfigVersions } from './components/versions/ConfigVersions'
import { FlightDynamicsTab } from './components/viewer/FlightDynamicsTab'
import { FlightProfileModal } from './components/viewer/FlightProfileModal'
import { InspectorPanel } from './components/viewer/InspectorPanel'
import { MotorCurvesModal } from './components/viewer/MotorCurvesModal'
import { MaterialWarning } from './components/viewer/MaterialWarning'
import { ModelPicker } from './components/viewer/ModelPicker'
import { PartList } from './components/viewer/PartList'
import { ResizableSidebar } from './components/viewer/ResizableSidebar'
import { Scene } from './components/viewer/Scene'
import type {
  FaceRef,
  FinPlanform,
  Manifest,
  FlightResult,
  FlightDynamicsResult,
  ModelSummary,
  MotorDetail,
  MotorSelection,
  MotorSummary,
  Part,
  PartOverride,
  StabilityResult,
} from './types'
import { MATERIALS_BY_KEY } from './lib/materials'

/** Survives reloads so a new build does not hijack which model is open. */
const LAST_MODEL_KEY = 'star-openrocket:last-model'

export default function App() {
  // The persisted working config, read once so a reload restores the inputs below.
  const [initialConfig] = useState(loadViewerConfig)

  const [models, setModels] = useState<ModelSummary[]>([])
  const [modelId, setModelId] = useState<string | null>(initialConfig.modelId)
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
  const [overrides, setOverrides] = useState<Map<string, PartOverride>>(
    () => new Map(Object.entries(initialConfig.overrides)),
  )
  const [opacity, setOpacity] = useState(0.55)
  const [showAssemblyCentroid, setShowAssemblyCentroid] = useState(true)
  // Backend-computed stability (CG, CP, static margin). Null until the user
  // asks for it; cleared when the model changes so a stale margin never lingers.
  const [stability, setStability] = useState<StabilityResult | null>(null)
  const [stabilityBusy, setStabilityBusy] = useState(false)
  const [stabilityError, setStabilityError] = useState<string | null>(null)
  // Outer-surface selection: which faces are the airframe. Empty means "let the
  // backend auto-detect on compute". Editing lets the user correct the guess.
  const [outerFaces, setOuterFaces] = useState<FaceRef[]>(initialConfig.outerFaces)
  const [finFaces, setFinFaces] = useState<FaceRef[]>(initialConfig.finFaces)
  const [finCount, setFinCount] = useState(initialConfig.finCount)
  // The exposed fin planform surfaces to draw; from auto-detect or compute.
  const [finPlanforms, setFinPlanforms] = useState<FinPlanform[]>([])
  const [faceEditMode, setFaceEditMode] = useState(false)
  const [editTarget, setEditTarget] = useState<'body' | 'fin' | 'motor'>('body')
  const [autoBusy, setAutoBusy] = useState(false)
  const [isolateOuterFaces, setIsolateOuterFaces] = useState(false)
  // Selected motor, folded into the CG / static margin by the backend. Null = none.
  // motorSummary keeps the picker's metadata for labelling before a compute round-trips.
  const [motorSel, setMotorSel] = useState<MotorSelection | null>(initialConfig.motor)
  const [motorSummary, setMotorSummary] = useState<MotorSummary | null>(null)
  // Flight-profile popup: fetched on open from the current surfaces + motor.
  const [flightOpen, setFlightOpen] = useState(false)
  const [flightResult, setFlightResult] = useState<FlightResult | null>(null)
  // Flight Dynamics tab result, lifted here so it survives CAD/Flight tab switches.
  const [flightDynResult, setFlightDynResult] = useState<FlightDynamicsResult | null>(null)
  const [flightBusy, setFlightBusy] = useState(false)
  const [flightError, setFlightError] = useState<string | null>(null)
  // Guided rail length (m) — travel to full departure (rear lug clears), for off-rail velocity.
  const [railLength, setRailLength] = useState(initialConfig.railLength)

  // Flight Dynamics launch params, lifted here so they are versioned in the config.
  const [flight, setFlightState] = useState<FlightParams>(initialConfig.flight)
  const setFlight = useCallback(
    (patch: Partial<FlightParams>) => setFlightState((f) => ({ ...f, ...patch })),
    [],
  )
  // Motor-curves popup: the selected motor's raw thrust/weight/CG datafile.
  const [curvesOpen, setCurvesOpen] = useState(false)
  const [curvesDetail, setCurvesDetail] = useState<MotorDetail | null>(null)
  const [curvesBusy, setCurvesBusy] = useState(false)
  const [curvesError, setCurvesError] = useState<string | null>(null)
  // True once a stability result exists, so changing the motor recomputes live
  // rather than silently waiting for the next manual Compute.
  const computedOnce = useRef(false)
  // Bumped when a build finishes, so rebuilding the model already on screen
  // refetches it. Without this the manifest effect keys only on the id, which
  // has not changed, and the viewer would keep showing the previous build.
  const [reloadNonce, setReloadNonce] = useState(0)

  // Top-level tab: the CAD viewer (all existing UI) vs the 6-DOF flight dynamics.
  const [activeTab, setActiveTab] = useState<'cad' | 'flight'>('cad')

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
        computedOnce.current = false
        setOuterFaces([])
        setFinFaces([])
        setFinCount(0)
        setFinPlanforms([])
        setFaceEditMode(false)
        setEditTarget('body')
        setIsolateOuterFaces(false)
        setMotorSel(null)
        setMotorSummary(null)
        setFlightOpen(false)
        setFlightResult(null)
        setFlightError(null)
        setCurvesOpen(false)
        setCurvesDetail(null)
        setCurvesError(null)
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

  // The "CM" marker in the 3D view folds in the selected motor at its wet/dry mass,
  // so it sits where the *loaded* rocket balances -- the same CG the static margin
  // uses -- and moves when the wet/dry toggle changes. Parts stay visibility-filtered
  // as before; with no motor this is just the parts CM.
  const markerCentroid = useMemo<[number, number, number]>(() => {
    const motor = stability?.motor
    if (!motor?.cgWorld) return cm.centroid
    const motorMass = motor.state === 'burnout' ? motor.dryMass : motor.wetMass
    const total = cm.mass + motorMass
    if (!(total > 0)) return cm.centroid
    const cg = motor.cgWorld
    return [0, 1, 2].map((i) => (cm.centroid[i] * cm.mass + cg[i] * motorMass) / total) as [
      number,
      number,
      number,
    ]
  }, [cm, stability])

  // Static margin is (CP − CG)/d. CP is fixed by geometry (only a surface change moves it),
  // so a mass edit is pure algebra on the CG — recompute it here instead of round-tripping to
  // the backend. Uses ALL parts (override-adjusted), not the visibility-filtered marker: the
  // margin is the whole rocket's. Folds in the motor exactly as the backend does.
  const liveStability = useMemo(() => {
    if (!stability) return null
    const axis = stability.axisDirection
    const full = centreOfMass(parts)
    let cg = full.centroid
    let mass = full.mass
    const motor = stability.motor
    if (motor?.cgWorld && mass >= 0) {
      const mMotor = motor.state === 'burnout' ? motor.dryMass : motor.wetMass
      const total = mass + mMotor
      if (total > 0) {
        cg = [0, 1, 2].map((i) => (full.centroid[i] * mass + motor.cgWorld![i] * mMotor) / total) as [
          number,
          number,
          number,
        ]
        mass = total
      }
    }
    if (!(mass > 0)) return null
    const cpw = stability.cp.world
    // Nose point on the axis, then project the live CG onto the nose→tail axis.
    const nose = [0, 1, 2].map((i) => cpw[i] - stability.cp.fromNose * axis[i])
    const cgFromNose = [0, 1, 2].reduce((s, i) => s + (cg[i] - nose[i]) * axis[i], 0)
    const margin = stability.refDiameter > 0 ? (stability.cp.fromNose - cgFromNose) / stability.refDiameter : null
    return { cgFromNose, margin }
  }, [stability, parts])

  // CM along the rocket axis (from the nose) plus its off-axis (radial) offset. A
  // non-trivial radial offset means the visible mass is laterally unbalanced — a
  // symmetry problem the CM section flags. Needs the detected axis (from stability).
  const cmAnalysis = useMemo(() => {
    if (!stability) return null
    const axis = stability.axisDirection
    const cpw = stability.cp.world
    const nose = [0, 1, 2].map((i) => cpw[i] - stability.cp.fromNose * axis[i])
    const d = [0, 1, 2].map((i) => cm.centroid[i] - nose[i])
    const along = d[0] * axis[0] + d[1] * axis[1] + d[2] * axis[2]
    const radial = Math.hypot(...[0, 1, 2].map((i) => d[i] - along * axis[i]))
    // Off-axis if the lateral offset exceeds ~1% of the airframe diameter.
    const offAxis = radial > 0.01 * stability.refDiameter
    return { fromNose: along, radial, offAxis }
  }, [stability, cm])

  // -- Versioning: gather the user inputs into one ViewerConfig, persist it, and
  // apply a restored one. localStorage is the reload cache; ConfigVersions drives
  // the durable server-side timeline (named designs, history, releases).
  const config = useMemo<ViewerConfig>(
    () => ({
      version: 1,
      modelId,
      overrides: Object.fromEntries(overrides),
      outerFaces,
      finFaces,
      finCount,
      motor: motorSel,
      railLength,
      flight,
    }),
    [modelId, overrides, outerFaces, finFaces, finCount, motorSel, railLength, flight],
  )

  // Debounced: `config` changes on every keystroke and this serialises it all.
  useEffect(() => {
    const id = setTimeout(() => saveViewerConfig(config), 400)
    return () => clearTimeout(id)
  }, [config])

  // Stable, so ConfigVersions' mount/restore effects don't re-run every render.
  const handleRestore = useCallback((c: ViewerConfig) => {
    setModelId(c.modelId)
    setOverrides(new Map(Object.entries(c.overrides)))
    setOuterFaces(c.outerFaces)
    setFinFaces(c.finFaces)
    setFinCount(c.finCount)
    setMotorSel(c.motor)
    setRailLength(c.railLength)
    setFlightState(c.flight)
    saveViewerConfig(c)
  }, [])

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
        motor: motorSel,
      })
      setStability(result)
      setFinCount(result.fins.count)
      setFinPlanforms(result.fins.planforms)
      computedOnce.current = true
    } catch (exc) {
      setStabilityError(String(exc))
    } finally {
      setStabilityBusy(false)
    }
  }, [modelId, massOverrides, outerFaces, finFaces, motorSel])

  // Recompute when the motor selection changes. Selecting a motor computes even
  // without a prior manual Compute -- handleComputeStability auto-detects the body
  // and fins when none are chosen, so the motor's effect on CG/margin shows up at
  // once. A ref holds the latest callback so this effect keys on motorSel alone
  // (not on face edits, which must not trigger a recompute).
  const computeRef = useRef(handleComputeStability)
  computeRef.current = handleComputeStability
  useEffect(() => {
    if (motorSel || computedOnce.current) void computeRef.current()
  }, [motorSel])

  const handleSelectMotor = useCallback((motor: MotorSummary, simfileId: string) => {
    setMotorSummary(motor)
    // Keep any reference face the user already picked when swapping the motor.
    setMotorSel((current) => ({
      motorId: motor.motorId,
      simfileId,
      aftOffset: current?.aftOffset ?? 0,
      refFace: current?.refFace ?? null,
      state: current?.state ?? 'launch',
    }))
  }, [])

  const handleClearMotor = useCallback(() => {
    setMotorSel(null)
    setMotorSummary(null)
    // Drop motor-face editing if it was on.
    setFaceEditMode((on) => (editTarget === 'motor' ? false : on))
  }, [editTarget])

  const handleSetMotorState = useCallback((state: 'launch' | 'burnout') => {
    setMotorSel((current) => (current ? { ...current, state } : current))
  }, [])

  const handleSetMotorOffset = useCallback((aftOffset: number) => {
    setMotorSel((current) => (current ? { ...current, aftOffset } : current))
  }, [])

  const handleSetMotorRefFace = useCallback((refFace: FaceRef | null) => {
    setMotorSel((current) => (current ? { ...current, refFace } : current))
  }, [])

  // Open the flight-profile popup and simulate, reusing the surfaces/overrides/motor that
  // fed the current stability result.
  const handleViewFlight = useCallback(async () => {
    if (!modelId || !motorSel) return
    setFlightOpen(true)
    setFlightBusy(true)
    setFlightError(null)
    setFlightResult(null)
    try {
      const result = await computeFlight(modelId, {
        outerFaces,
        finFaces,
        overrides: massOverrides,
        motor: motorSel,
        railLength,
      })
      setFlightResult(result)
    } catch (exc) {
      setFlightError(String(exc))
    } finally {
      setFlightBusy(false)
    }
  }, [modelId, motorSel, outerFaces, finFaces, massOverrides, railLength])

  // Open the motor-curves popup and fetch the selected motor's raw datafile.
  const handleViewMotorCurves = useCallback(async () => {
    if (!motorSel) return
    setCurvesOpen(true)
    setCurvesBusy(true)
    setCurvesError(null)
    setCurvesDetail(null)
    try {
      setCurvesDetail(await fetchMotor(motorSel.motorId))
    } catch (exc) {
      setCurvesError(String(exc))
    } finally {
      setCurvesBusy(false)
    }
  }, [motorSel])

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
    (target: 'body' | 'fin' | 'motor') => {
      setEditTarget(target)
      setFaceEditMode((on) => {
        // Toggle off only if re-clicking the active target; switching target
        // stays in edit mode. Seed the body/fin sets from auto-detect the first
        // time in; the motor reference face needs no seed.
        if (target !== 'motor' && outerFaces.length === 0 && finFaces.length === 0)
          void handleAutoDetect()
        return !(on && editTarget === target)
      })
    },
    [outerFaces.length, finFaces.length, editTarget, handleAutoDetect],
  )

  const handleFaceToggle = useCallback(
    (target: 'body' | 'fin' | 'motor', occurrenceKey: string, faceId: string) => {
      // The motor reference is a single face: clicking sets it, clicking the same
      // one again clears it. (The backend rejects a face not normal to the axis.)
      if (target === 'motor') {
        setMotorSel((current) => {
          if (!current) return current
          const same = current.refFace?.key === occurrenceKey && current.refFace?.faceId === faceId
          return { ...current, refFace: same ? null : { key: occurrenceKey, faceId } }
        })
        return
      }
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

  // Only take over the screen while a *selected* model's manifest is loading. With
  // no model (e.g. a fresh/blank design) we still render the header + design bar so
  // the user can pick a model or switch designs -- the body shows a prompt instead.
  if (modelId && !manifest) {
    return (
      <div className="flex h-screen items-center justify-center bg-slate-950 text-slate-400">
        Loading…
      </div>
    )
  }

  return (
    <div className="flex h-screen flex-col bg-slate-950 text-slate-100">
      <header className="flex flex-col border-b border-slate-700">
        <div className="flex flex-wrap items-center gap-3 px-4 py-4">
        {/* STAR wordmark, then a divider, then the app title -- mirrors the
            recovery calculator's header. */}
        <img src={starWordmark} alt="STAR" className="h-14 w-auto" />
        <div className="h-9 w-px bg-slate-700" />
        {/* Fixed title. What is loaded is the picker's job to say, and it
            already does -- naming it twice just made the header noisy. */}
        <h1 className="text-xl font-bold">STAR OpenRocket</h1>

        <nav className="flex items-center gap-1 rounded-lg border border-slate-700 bg-slate-900/60 p-1 text-sm">
          {(['cad', 'flight'] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`rounded px-3 py-1 font-medium ${activeTab === tab ? 'bg-cyan-600 text-white' : 'text-slate-300 hover:bg-slate-800'}`}
            >
              {tab === 'cad' ? 'CAD & Stability' : 'Flight Dynamics'}
            </button>
          ))}
        </nav>

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
        </div>

        {/* Versioned designs, as a full-width strip at the bottom of the header. */}
        <div className="border-t border-slate-800 px-4 py-1.5">
          <ConfigVersions config={config} onRestore={handleRestore} inline />
        </div>
      </header>

      {activeTab === 'flight' ? (
        <FlightDynamicsTab
          modelId={modelId}
          motorSel={motorSel}
          outerFaces={outerFaces}
          finFaces={finFaces}
          nFins={finCount}
          railLength={railLength}
          overrides={massOverrides}
          flight={flight}
          onFlightChange={setFlight}
          result={flightDynResult}
          onResult={setFlightDynResult}
        />
      ) : !manifest || !modelId ? (
        <div className="flex flex-1 items-center justify-center p-8 text-center text-slate-400">
          Select or build a model in the header to begin — this design has no model yet.
        </div>
      ) : (
        <>
      <MaterialWarning parts={parts} />

      <div className="flex min-h-0 flex-1">
        <ResizableSidebar side="left" defaultWidth={340} storageKey="star-openrocket:left-width">
          <PartList
            parts={parts}
            visibleKeys={visibleKeys}
            selectedKeys={selectedSet}
            overriddenKeys={overriddenKeys}
            onToggle={handleToggle}
            onSelect={setSelectedKeys}
            onHover={setHoveredKeys}
          />
        </ResizableSidebar>

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
            centroid={markerCentroid}
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
            motor={stability?.motor ?? null}
            motorRefFace={motorSel?.refFace ?? null}
          />

          <div className="pointer-events-none absolute bottom-3 right-4 text-right text-xs text-slate-500">
            <div>
              Onshape total {formatMass(manifest.totals.assemblyMass)} · CM z{' '}
              {manifest.totals.assemblyCentroid[2].toFixed(4)} m
            </div>
            <div>
              {manifest.totals.reconciled ? 'reconciled' : 'NOT reconciled'} · built{' '}
              {manifest.source.builtAt} · {manifest.source.resolvedFrom}
            </div>
          </div>
        </main>

        <ResizableSidebar side="right" defaultWidth={440} storageKey="star-openrocket:right-width">
          <InspectorPanel
            // Properties tab
            selected={selectedParts}
            visibleKeys={visibleKeys}
            overrides={overrides}
            onOverrideChange={handleOverrideChange}
            // Auto-switch to Properties on a new part selection (unless pinned).
            primarySelectedKey={selectedKeys.at(-1) ?? null}
            // Analysis tab: centre of mass + stability
            cm={cm}
            partCount={parts.length}
            cmAnalysis={cmAnalysis}
            result={stability}
            liveMargin={liveStability?.margin ?? null}
            liveCgFromNose={liveStability?.cgFromNose ?? null}
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
            motorSel={motorSel}
            motorSummary={motorSummary}
            onSelectMotor={handleSelectMotor}
            onClearMotor={handleClearMotor}
            onSetMotorState={handleSetMotorState}
            onSetMotorOffset={handleSetMotorOffset}
            onSetMotorRefFace={handleSetMotorRefFace}
            motorFaceEdit={faceEditMode && editTarget === 'motor'}
            onToggleMotorFaceEdit={() => handleToggleFaceEdit('motor')}
            onViewFlight={handleViewFlight}
            railLength={railLength}
            onSetRailLength={setRailLength}
            onViewMotorCurves={handleViewMotorCurves}
          />
        </ResizableSidebar>
      </div>
        </>
      )}

      {flightOpen && (
        <FlightProfileModal
          result={flightResult}
          busy={flightBusy}
          error={flightError}
          onClose={() => setFlightOpen(false)}
        />
      )}

      {curvesOpen && (
        <MotorCurvesModal
          detail={curvesDetail}
          simfileId={motorSel?.simfileId ?? null}
          busy={curvesBusy}
          error={curvesError}
          onClose={() => setCurvesOpen(false)}
        />
      )}
    </div>
  )
}
