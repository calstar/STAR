/**
 * 3D scene: the assembly, plus a live centre-of-mass marker.
 *
 * Axis handling, which is the easy thing to get subtly wrong here:
 *
 *   The GLB already contains a root node applying the Onshape Z-up -> glTF Y-up
 *   rotation (manifest `upAxisHandling: "glb-root"`). This component must not
 *   apply it a second time to the geometry -- a double swap produces a scene
 *   that looks plausible and a centre of mass that is wrong.
 *
 *   The marker's position comes from `centroidWorld`, which is in the *Onshape*
 *   frame, so it does need that rotation. It gets it from ZUpGroup below, which
 *   mirrors what the GLB does internally. Geometry and marker therefore land in
 *   the same space by construction rather than by coincidence.
 *
 *   Both then sit inside a display group that lays the rocket horizontal. Since
 *   they share that group, they cannot drift apart no matter what it does.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Canvas, useThree } from '@react-three/fiber'
import { Grid, OrbitControls, OrthographicCamera, useGLTF } from '@react-three/drei'

import * as THREE from 'three'

import type { Manifest, Part } from '../../types'
import { STATUS_COLOR, massStatus } from '../../lib/status'
import { CMMarker } from './CMMarker'

/** Mirrors the GLB's internal root rotation, for things given in Onshape coords. */
const Z_UP_TO_Y_UP: [number, number, number] = [-Math.PI / 2, 0, 0]

/** Lays the model's long axis (now glTF +Y) along screen X, so it reads horizontally. */
const LIE_DOWN: [number, number, number] = [0, 0, -Math.PI / 2]

const COLOR_DEFAULT = '#94a3b8'
const COLOR_SELECTED = '#22d3ee'

const EDGE_COLOR = '#0f172a'
const EDGE_COLOR_HOVER = '#22d3ee'
const EDGE_COLOR_SELECTED = '#67e8f9'

/**
 * Minimum dihedral angle for an edge to be drawn, in degrees.
 *
 * Low enough to catch real feature edges, high enough to ignore the seams
 * between adjacent facets of a tessellated cylinder -- otherwise every tube in
 * the model turns into a striped mess.
 */
const EDGE_ANGLE = 30

/** Silhouette width, in CSS pixels, held constant at every zoom level. */
const OUTLINE_PX = 3

/**
 * Draw order for the transparent pass.
 *
 * At any opacity below 1 every part is transparent, which means depth is not
 * written and the image is decided purely by the order things are painted in.
 * three orders the transparent pass back-to-front by each object's view-space
 * depth, taken from its bounding-sphere centre -- and this model is a stack of
 * concentric tubes whose centres all sit on the same axis. Their sort keys are
 * therefore equal to within floating-point noise, and rotating through a
 * symmetric orientation flips the comparison, so the order visibly pops and a
 * buried part jumps to the front.
 *
 * Depth cannot answer "is the inner tube in front of the outer tube" for two
 * concentric shells, so it is not asked. Parts are ordered largest-first
 * instead, which is stable under rotation and reads correctly: an inner part is
 * always painted over the shell that contains it, which is what you want to see
 * through a translucent airframe.
 *
 * Parts take 0..ORDER_PART_MAX; the bands above are absolute so a part can
 * never be sorted into the middle of the overlays.
 */
const ORDER_PART_MAX = 399
const ORDER_EDGES = 500
const ORDER_SELECTED = 900
const ORDER_SELECTED_EDGES = 950

/**
 * Silhouette outlines, drawn as ordinary geometry.
 *
 * The obvious tool for this is postprocessing's Outline effect, and it was used
 * here first. It does not survive contact with this scene: it can only run
 * inside an EffectComposer, and mounting a composer redirects rendering from the
 * canvas into an offscreen target. three deliberately skips both tone mapping
 * and output colour-space conversion when it renders to a target, and MSAA does
 * not apply there either, so the entire scene changed shade and lost its
 * antialiasing the instant anything was hovered. The outline was also only
 * legible with autoClear off, which meant it was accumulating across frames --
 * the same bug as the silhouette that stayed behind at its old size on zoom.
 *
 * So the outline is drawn in the normal render path instead, in two passes per
 * highlighted part:
 *
 *   1. a mask, which writes the part's screen footprint into the stencil buffer
 *      and no colour at all;
 *   2. a hull, the same geometry pushed outwards along its normals, drawn only
 *      where the stencil was NOT written.
 *
 * Hull minus footprint is exactly the rim, which is what a silhouette is. Both
 * passes have depthTest off and a high renderOrder, so they land on top of
 * everything: what is in front of a highlighted part cannot change how its
 * outline looks, which is the property that started this whole thread.
 *
 * The push happens in clip space rather than world space so the rim keeps a
 * constant pixel width as the camera zooms, instead of scaling with the model.
 */
const HULL_VERTEX_SHADER = /* glsl */ `
  uniform float uThickness;
  uniform float uAspect;

  void main() {
    vec4 clip = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    vec2 projected = (projectionMatrix * vec4(normalize(normalMatrix * normal), 0.0)).xy;

    // A normal pointing straight at the camera projects to nothing; normalizing
    // it would be a divide by zero, and it contributes no silhouette anyway.
    if (length(projected) > 1e-6) {
      vec2 offset = normalize(projected);
      offset.x /= uAspect;
      clip.xy += offset * uThickness * clip.w;
    }

    gl_Position = clip;
  }
`

const HULL_FRAGMENT_SHADER = /* glsl */ `
  uniform vec3 uColor;

  void main() {
    gl_FragColor = vec4(uColor, 1.0);
  }
`

function makeHullMaterial(color: string): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uThickness: { value: 0 },
      uAspect: { value: 1 },
    },
    vertexShader: HULL_VERTEX_SHADER,
    fragmentShader: HULL_FRAGMENT_SHADER,
    side: THREE.DoubleSide,
    // Transparent so it sorts into the pass that runs last. The parts
    // themselves are transparent at any opacity below 1, and the opaque pass
    // runs first, so an opaque outline would be painted over by the model.
    transparent: true,
    depthTest: false,
    depthWrite: false,
    stencilWrite: true,
    stencilFunc: THREE.NotEqualStencilFunc,
    stencilRef: 1,
    stencilFail: THREE.KeepStencilOp,
    stencilZFail: THREE.KeepStencilOp,
    stencilZPass: THREE.KeepStencilOp,
  })
}

const HULL_HOVERED = makeHullMaterial(EDGE_COLOR_HOVER)
const HULL_SELECTED = makeHullMaterial(EDGE_COLOR_SELECTED)

const HULL_MASK = new THREE.MeshBasicMaterial({
  colorWrite: false,
  depthTest: false,
  depthWrite: false,
  transparent: true,
  stencilWrite: true,
  stencilFunc: THREE.AlwaysStencilFunc,
  stencilRef: 1,
  stencilFail: THREE.ReplaceStencilOp,
  stencilZFail: THREE.ReplaceStencilOp,
  stencilZPass: THREE.ReplaceStencilOp,
})

/** Every mask draws before every hull, and both draw after the model. */
const RENDER_ORDER_MASK = 1000
const RENDER_ORDER_HULL = 1001

/**
 * Keeps the hull width at OUTLINE_PX regardless of viewport or zoom.
 *
 * `size` is in CSS pixels while the offset is in NDC, hence the factor of two:
 * NDC spans -1..1 over the height. Using CSS rather than device pixels keeps the
 * rim the same apparent width on a HiDPI display.
 */
function HullUniforms() {
  const size = useThree((state) => state.size)

  useEffect(() => {
    for (const material of [HULL_HOVERED, HULL_SELECTED]) {
      material.uniforms.uAspect.value = size.width / Math.max(size.height, 1)
      material.uniforms.uThickness.value = (2 * OUTLINE_PX) / Math.max(size.height, 1)
    }
  }, [size])

  return null
}

/**
 * Model bounds, tagged with the model they belong to.
 *
 * The tag is the whole point. Bounds arrive from an effect one or more frames
 * after the model URL changes, so for a moment the newest bounds in state still
 * describe the *previous* model -- and React runs child effects before parent
 * ones, so a child cannot rely on the parent having cleared them first. Anyone
 * consuming these compares the url instead of trusting the timing.
 */
interface Bounds {
  url: string
  box: THREE.Box3
}

interface ModelProps {
  url: string
  parts: Map<string, Part>
  visibleKeys: Set<string>
  /** Every selected part, not just the most recent one. */
  selectedKeys: Set<string>
  /** Parts whose mass the user has taken over; see lib/status. */
  overriddenKeys: Set<string>
  hoveredKeys: Set<string>
  onSelect: (key: string | null) => void
  onHover: (keys: string[]) => void
  opacity: number
  onBounds: (bounds: Bounds) => void
}

function Model({
  url,
  parts,
  visibleKeys,
  selectedKeys,
  overriddenKeys,
  hoveredKeys,
  onSelect,
  onHover,
  opacity,
  onBounds,
}: ModelProps) {
  const { scene } = useGLTF(url)

  // useGLTF caches by URL, so mutating the shared scene would leak state across
  // remounts. Clone once, give every mesh its own material to colour, and hang
  // a feature-edge overlay off each one.
  const model = useMemo(() => {
    const clone = scene.clone(true)

    // Occurrences share geometry, so edges and hulls are derived once per
    // distinct geometry rather than once per placement.
    const edgeCache = new Map<string, THREE.EdgesGeometry>()
    const hullCache = new Map<string, THREE.BufferGeometry>()

    // Collected before anything is added. The overlays below are themselves
    // Meshes, and traverse walks children as they appear -- decorating during
    // the walk means decorating the decorations, forever.
    const meshes: THREE.Mesh[] = []
    clone.traverse((object) => {
      if (object instanceof THREE.Mesh) meshes.push(object)
    })

    // Stable painter's order, assigned once. Largest radius first, with the
    // part key breaking ties so two parts of identical size cannot swap between
    // loads. Array.sort is stable, so equal keys keep traversal order.
    const radius = (mesh: THREE.Mesh) => {
      if (!mesh.geometry.boundingSphere) mesh.geometry.computeBoundingSphere()
      return mesh.geometry.boundingSphere?.radius ?? 0
    }
    ;[...meshes]
      .sort((a, b) => {
        const delta = radius(b) - radius(a)
        if (delta !== 0) return delta
        return String(a.userData?.key ?? '').localeCompare(String(b.userData?.key ?? ''))
      })
      .forEach((mesh, index) => {
        mesh.userData.drawOrder = Math.min(index, ORDER_PART_MAX)
      })

    for (const object of meshes) {
      object.material = new THREE.MeshStandardMaterial({
        color: COLOR_DEFAULT,
        metalness: 0.1,
        roughness: 0.6,
      })

      let edges = edgeCache.get(object.geometry.uuid)
      if (!edges) {
        edges = new THREE.EdgesGeometry(object.geometry, EDGE_ANGLE)
        edgeCache.set(object.geometry.uuid, edges)
      }

      // A child, so it inherits the occurrence transform and the parent's
      // visibility for free.
      const outline = new THREE.LineSegments(
        edges,
        new THREE.LineBasicMaterial({ color: EDGE_COLOR }),
      )
      outline.userData.isEdges = true
      // Edges must not intercept picking: a hit on one carries no part key and
      // would read as a click on empty space, clearing the selection.
      outline.raycast = () => {}
      object.userData.edges = outline
      object.add(outline)

      // Normals are recomputed rather than taken from the GLB. Onshape gives
      // normals per face, so a welded vertex keeps whichever face wrote it
      // last; pushing along those would tear the hull open at every seam.
      // Averaging across the faces that share a vertex is what closes it.
      let hullGeometry = hullCache.get(object.geometry.uuid)
      if (hullGeometry === undefined) {
        const derived: THREE.BufferGeometry = object.geometry.clone()
        derived.deleteAttribute('normal')
        derived.computeVertexNormals()
        hullCache.set(object.geometry.uuid, derived)
        hullGeometry = derived
      }

      // Children again, so they inherit the occurrence transform and vanish
      // with the part when it is hidden. Both start off and are switched on by
      // the highlight effect below.
      const mask = new THREE.Mesh(object.geometry, HULL_MASK)
      mask.renderOrder = RENDER_ORDER_MASK
      mask.visible = false
      mask.raycast = () => {}

      const hull = new THREE.Mesh(hullGeometry, HULL_HOVERED)
      hull.renderOrder = RENDER_ORDER_HULL
      hull.visible = false
      hull.raycast = () => {}

      object.userData.mask = mask
      object.userData.hull = hull
      object.add(mask, hull)
    }

    return clone
  }, [scene])

  useEffect(() => {
    // Force world matrices before measuring: setFromObject reads matrixWorld,
    // and on the first frame the parent groups have not composed theirs yet, so
    // the box would come back in the wrong space.
    model.updateWorldMatrix(true, true)
    const box = new THREE.Box3().setFromObject(model)
    // Stamped with the URL they were measured from, so a consumer can tell
    // whether they describe the model it is currently looking at.
    if (!box.isEmpty()) onBounds({ url, box })
  }, [model, url, onBounds])

  // Visibility, colour and opacity all derive from props, so this runs on every
  // toggle. It is a traversal of a few hundred nodes -- cheap enough to keep
  // simple rather than caching a key->mesh index.
  useEffect(() => {
    model.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return
      const key = object.userData?.key as string | undefined
      if (!key) return

      object.visible = visibleKeys.has(key)

      const part = parts.get(key)
      const isSelected = selectedKeys.has(key)
      // Hover marks the edges only; the surface stays as it is until a click,
      // matching how Onshape previews a pick.
      const isHovered = hoveredKeys.has(key) && !isSelected
      const material = object.material as THREE.MeshStandardMaterial

      // Same three-state encoding as the parts tree: red for a part nobody has
      // given a mass, green once one has been supplied, yellow where Onshape's
      // own figure was overridden.
      material.color.set(
        isSelected
          ? COLOR_SELECTED
          : part
            ? STATUS_COLOR[massStatus(part, overriddenKeys.has(key))]
            : COLOR_DEFAULT,
      )

      // Depth is left alone for every part, including the selected one. An
      // earlier version drew the selection with depthTest off so that parts in
      // front could not alter its appearance, but that both flattened it into
      // an opaque slab and broke the outline pass, which derives its mask from
      // depth. The silhouette outline solves the same problem properly.
      const surfaceOpacity = isSelected ? Math.min(1, opacity + 0.25) : opacity
      material.transparent = surfaceOpacity < 1
      material.opacity = surfaceOpacity
      material.depthTest = true
      material.depthWrite = surfaceOpacity >= 1

      // The selected part is lifted above the whole stack rather than left in
      // it. Otherwise a smaller part nested in front of it paints over it, and
      // how the selection looks depends on which parts happen to be drawn after
      // it -- which is the same thing as its appearance depending on what is on
      // top of it.
      const drawOrder = (object.userData.drawOrder as number | undefined) ?? 0
      object.renderOrder = isSelected ? ORDER_SELECTED : drawOrder
      material.needsUpdate = true

      const lit = isSelected || isHovered

      const outline = object.userData.edges as THREE.LineSegments | undefined
      if (outline) {
        const line = outline.material as THREE.LineBasicMaterial

        line.color.set(
          isSelected ? EDGE_COLOR_SELECTED : isHovered ? EDGE_COLOR_HOVER : EDGE_COLOR,
        )
        // Depth stays on here too. Seeing a highlighted part through whatever
        // occludes it is the silhouette's job.
        line.depthTest = true
        line.transparent = true
        line.opacity = lit ? 1 : Math.min(1, opacity + 0.35)
        // Above every surface, so edges are never washed out by a translucent
        // part painted after them, and in the same stable order as the parts.
        outline.renderOrder = isSelected ? ORDER_SELECTED_EDGES : ORDER_EDGES + drawOrder
        line.needsUpdate = true
      }

      // Feature edges alone leave a smooth cylinder outlined at its two ends
      // and nowhere down its length. The silhouette is what closes that gap,
      // and unlike a feature edge it depends on where the camera is.
      const mask = object.userData.mask as THREE.Mesh | undefined
      const hull = object.userData.hull as THREE.Mesh | undefined
      if (mask && hull) {
        mask.visible = lit
        hull.visible = lit
        hull.material = isSelected ? HULL_SELECTED : HULL_HOVERED
      }
    })
  }, [model, parts, visibleKeys, selectedKeys, overriddenKeys, hoveredKeys, opacity])

  return (
    <primitive
      object={model}
      // onClick, not onPointerDown: r3f suppresses click after a drag, so
      // orbiting the camera does not re-select whatever the drag started over.
      onClick={(event: any) => {
        event.stopPropagation()
        const key = event.object?.userData?.key as string | undefined
        onSelect(key ?? null)
      }}
      // onPointerMove rather than onPointerOver: the whole model is one
      // primitive, so moving between two meshes does not always fire an
      // over/out pair, and the hover would stick to the first part touched.
      onPointerMove={(event: any) => {
        event.stopPropagation()
        const key = event.object?.userData?.key as string | undefined
        onHover(key ? [key] : [])
      }}
      onPointerOut={() => onHover([])}
    />
  )
}

/**
 * Frames the camera on the model, once per model.
 *
 * The fit is latched so that orbiting and zooming are not undone on every
 * re-render. The latch records *which* model was framed rather than a bare
 * boolean, and the fit only runs against bounds tagged with the model now being
 * displayed. Both halves matter: a boolean latch cleared on model change still
 * re-latches immediately against the outgoing model's bounds, because those are
 * what is in state at that moment. The result is an OrbitControls target left
 * on the old model's centre -- and since that target is the point zoom and
 * orbit pivot around, the new model appears to swing about an arbitrary spot
 * somewhere off to one side of itself.
 */
function FitCamera({
  bounds,
  controls,
  modelUrl,
}: {
  bounds: Bounds | null
  controls: React.RefObject<any>
  modelUrl: string
}) {
  const { camera, size } = useThree()
  const fittedFor = useRef<string | null>(null)

  useEffect(() => {
    if (!bounds || bounds.url !== modelUrl) return
    if (fittedFor.current === modelUrl) return
    if (!(camera instanceof THREE.OrthographicCamera)) return
    const box = bounds.box

    // `box` is already in world space, so the display group's rotation is
    // baked in and must not be applied again here.
    const centre = box.getCenter(new THREE.Vector3())
    const extent = box.getSize(new THREE.Vector3())

    const margin = 1.15
    camera.zoom = Math.min(
      size.width / (Math.max(extent.x, 1e-3) * margin),
      size.height / (Math.max(extent.y, 1e-3) * margin),
    )

    const target = centre.clone()
    camera.position.set(target.x, target.y, target.z + 10)
    camera.updateProjectionMatrix()

    // Only latch once the target actually landed. If the controls ref is not
    // attached yet, latching here would leave the pivot at the world origin
    // permanently -- which is the same failure by a different route.
    if (controls.current) {
      controls.current.target.copy(target)
      controls.current.update()
      fittedFor.current = modelUrl
    }
  }, [bounds, modelUrl, camera, size, controls])

  return null
}

interface SceneProps {
  modelUrl: string
  manifest: Manifest
  visibleKeys: Set<string>
  /** Every selected part, not just the most recent one. */
  selectedKeys: Set<string>
  /** Parts whose mass the user has taken over; see lib/status. */
  overriddenKeys: Set<string>
  hoveredKeys: string[]
  onSelect: (key: string | null) => void
  onHover: (keys: string[]) => void
  centroid: [number, number, number]
  showAssemblyCentroid: boolean
  opacity: number
}

export function Scene({
  modelUrl,
  manifest,
  visibleKeys,
  selectedKeys,
  overriddenKeys,
  hoveredKeys,
  onSelect,
  onHover,
  centroid,
  showAssemblyCentroid,
  opacity,
}: SceneProps) {
  const controls = useRef<any>(null)
  const [bounds, setBounds] = useState<Bounds | null>(null)
  // Only for things that merely need a rough scale, and are happy to use the
  // outgoing model's for the frame or two before the new one is measured.
  const box = bounds?.box ?? null
  // Stable identity: Model calls this from an effect keyed on it.
  const handleBounds = useCallback((next: Bounds) => setBounds(next), [])

  const hoveredSet = useMemo(() => new Set(hoveredKeys), [hoveredKeys])

  const parts = useMemo(
    () => new Map(manifest.parts.map((part) => [part.key, part])),
    [manifest.parts],
  )

  // Marker size is a fraction of the model, so it reads the same on a 30 cm
  // bracket and a 3 m airframe.
  const modelSpan = box ? box.getSize(new THREE.Vector3()).length() : 1
  const markerScale = modelSpan * 0.008
  const armLength = modelSpan * 0.06

  return (
    <Canvas
      dpr={[1, 2]}
      // stencil is off by default in current three, and the silhouette outline
      // is stencil-masked, so without this the rim fills the whole part.
      gl={{ antialias: true, alpha: false, stencil: true }}
      onPointerMissed={() => onSelect(null)}
      style={{ cursor: hoveredKeys.length > 0 ? 'pointer' : 'default' }}
    >
      <color attach="background" args={['#0b1120']} />

      <OrthographicCamera makeDefault position={[0, 0, 10]} near={-100} far={1000} />
      <OrbitControls ref={controls} makeDefault enableDamping dampingFactor={0.15} />

      <ambientLight intensity={0.7} />
      <directionalLight position={[5, 10, 7]} intensity={1.4} />
      <directionalLight position={[-6, -4, -6]} intensity={0.5} />

      <group rotation={LIE_DOWN}>
        <Model
          url={modelUrl}
          parts={parts}
          visibleKeys={visibleKeys}
          selectedKeys={selectedKeys}
          overriddenKeys={overriddenKeys}
          hoveredKeys={hoveredSet}
          onSelect={onSelect}
          onHover={onHover}
          opacity={opacity}
          onBounds={handleBounds}
        />

        {/* Onshape-frame quantities live in here, matching the GLB's own root. */}
        <group rotation={Z_UP_TO_Y_UP}>
          <CMMarker
            position={centroid}
            scale={markerScale}
            armLength={armLength}
            color="#f43f5e"
            label="CM"
          />
          {showAssemblyCentroid && (
            <CMMarker
              position={manifest.totals.assemblyCentroid}
              scale={markerScale * 0.7}
              armLength={armLength * 0.7}
              color="#34d399"
              label="Onshape"
            />
          )}
        </group>
      </group>

      <Grid
        args={[10, 10]}
        cellSize={0.1}
        cellColor="#1e293b"
        sectionSize={0.5}
        sectionColor="#334155"
        fadeDistance={12}
        infiniteGrid
        // Sit just under the model, using the world-space floor of its bounds.
        position={[0, box ? box.min.y - 0.05 : -0.2, 0]}
      />

      <FitCamera bounds={bounds} controls={controls} modelUrl={modelUrl} />
      <HullUniforms />
    </Canvas>
  )
}
