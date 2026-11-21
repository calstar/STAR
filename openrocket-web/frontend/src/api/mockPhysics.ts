/**
 * A stand-in for the backend's /api/analyze while the real port (orweb/) is
 * being written. It exists so the UI can be built and looked at; it is NOT
 * OpenRocket and nothing should be concluded from its numbers.
 *
 * What it does, roughly:
 *  - lays out the tree with the SCHEMA.md position rules and OpenRocket's auto radii;
 *  - draws the side view the backend will send (profiles, fins, internals, motor);
 *  - masses from geometry and material densities (thin shells, annuli, areas);
 *  - CP by Barrowman: nose/transition CNa = 2ΔA/Aref, fins with body interference;
 *  - a coarse drag build-up (turbulent skin friction, base drag 0.12+0.13M²).
 *
 * src/api/mockPhysics.test.ts holds it within a few percent of OpenRocket's own
 * numbers for "A simple model rocket", which is all it is for.
 */
import type {
  Analysis, Component, ComponentAnalysis, ComponentType, Conditions, FigureShape, MotorChoice, RocketDocument,
} from '../types'
import { auto, bool, isAuto, material, motorMount, num, points, pos, str } from '../lib/params'
import { relativePosition } from '../lib/position'
import { BODY, isFinSet } from '../lib/rules'
import { findMotor } from './motorDb'

const DEFAULT_RADIUS = 0.025 // SymmetricComponent.DEFAULT_RADIUS

/** ExternalComponent.Finish roughness heights, m. */
const ROUGHNESS: Record<string, number> = {
  rough: 500e-6, roughunfinished: 250e-6, unfinished: 150e-6, normal: 60e-6,
  smooth: 20e-6, optimum: 5e-6, polished: 2e-6, finishpolished: 2e-6, mirror: 0,
}

interface Node {
  c: Component
  parent: Node | null
  children: Node[]
  /** Absolute front, m from the tip. */
  x: number
  len: number
  /** Body outline radii (body components). */
  foreR: number
  aftR: number
  /** Tube-like radii (internals, lugs). */
  outerR: number
  innerR: number
  /** Vertical offset of this subtree's axis (pods/boosters), m. */
  yOff: number
}

// ---------------------------------------------------------------------------
// Profiles (Transition.Shape.getRadius, OpenRocket 24.12)

function pow2(v: number) {
  return v * v
}
function safeSqrt(v: number) {
  return v <= 0 ? 0 : Math.sqrt(v)
}

export function shapeRadius(shape: string, x: number, radius: number, length: number, k: number): number {
  if (x <= 0) return 0
  if (x >= length) return radius
  switch (shape) {
    case 'conical':
      return (radius * x) / length
    case 'ogive': {
      if (length < radius) {
        x = (x * radius) / length
        length = radius
      }
      if (k < 0.001) return (radius * x) / length
      const R = safeSqrt(((pow2(length) + pow2(radius)) * (pow2((2 - k) * length) + pow2(k * radius))) / (4 * pow2(k * radius)))
      const L = length / k
      const y0 = safeSqrt(R * R - L * L)
      return safeSqrt(R * R - (L - x) * (L - x)) - y0
    }
    case 'ellipsoid': {
      const xs = (x * radius) / length
      return safeSqrt(2 * radius * xs - xs * xs)
    }
    case 'power':
      if (k <= 0.00001) return radius
      return radius * Math.pow(x / length, k)
    case 'parabolic':
      return radius * ((2 * x) / length - k * pow2(x / length)) / (2 - k)
    case 'haack': {
      const th = Math.acos(1 - (2 * x) / length)
      return radius * safeSqrt((th - Math.sin(2 * th) / 2 + k * Math.pow(Math.sin(th), 3)) / Math.PI)
    }
    default:
      return (radius * x) / length
  }
}

/** Radius of a body component at local x. */
function bodyRadius(n: Node, x: number): number {
  const p = n.c.params
  if (n.c.type === 'bodytube') return n.foreR
  const shape = str(p, 'shape', 'conical')
  const k = num(p, 'shapeparameter', shape === 'power' ? 0.5 : shape === 'ogive' || shape === 'parabolic' ? 1 : 0)
  let r1 = n.foreR
  let r2 = n.aftR
  const L = n.len
  if (r1 === r2) return r1
  if (n.c.type === 'nosecone' && bool(p, 'isflipped')) x = L - x
  let flip = false
  if (r1 > r2) {
    ;[r1, r2] = [r2, r1]
    flip = true
  }
  const xx = flip ? L - x : x
  return r1 + shapeRadius(shape, xx, r2 - r1, L, k)
}

// ---------------------------------------------------------------------------
// Lengths and layout

function finPolygon(c: Component): [number, number][] {
  const p = c.params
  switch (c.type) {
    case 'trapezoidfinset': {
      const cr = num(p, 'rootchord', 0.05)
      const ct = num(p, 'tipchord', 0.05)
      const sw = num(p, 'sweeplength', 0.025)
      const h = num(p, 'height', 0.03)
      return [[0, 0], [sw, h], [sw + ct, h], [cr, 0]]
    }
    case 'ellipticalfinset': {
      const cr = num(p, 'rootchord', 0.05)
      const h = num(p, 'height', 0.05)
      const pts: [number, number][] = []
      const N = 24
      for (let i = 0; i <= N; i++) {
        const t = Math.PI - (Math.PI * i) / N
        pts.push([cr / 2 + (cr / 2) * Math.cos(t), h * Math.sin(t)])
      }
      return pts
    }
    case 'freeformfinset': {
      const pts = points(p)
      return pts.length >= 3 ? pts : [[0, 0], [0.025, 0.05], [0.075, 0.05], [0.05, 0]]
    }
    default:
      return []
  }
}

function ownLength(c: Component): number {
  const p = c.params
  switch (c.type) {
    case 'trapezoidfinset':
    case 'ellipticalfinset':
      return num(p, 'rootchord', 0.05)
    case 'freeformfinset': {
      const pts = finPolygon(c)
      return pts[pts.length - 1][0]
    }
    case 'railbutton':
      return num(p, 'outerdiameter', 0.0097)
    case 'masscomponent':
    case 'parachute':
    case 'streamer':
    case 'shockcord':
      return num(p, 'packedlength', 0.025)
    default:
      return num(p, 'length', 0)
  }
}

function defaultMethod(t: ComponentType) {
  if (BODY.has(t)) return 'after' as const
  if (isFinSet(t) || t === 'podset' || t === 'parallelstage') return 'bottom' as const
  if (t === 'launchlug' || t === 'railbutton') return 'middle' as const
  return 'top' as const
}

function mkNode(c: Component, parent: Node | null): Node {
  return { c, parent, children: [], x: 0, len: 0, foreR: 0, aftR: 0, outerR: 0, innerR: 0, yOff: parent?.yOff ?? 0 }
}

/** Lays out an assembly's body children end to end; returns the span. */
function layoutAssembly(n: Node): void {
  const kids = n.c.children.map((ch) => mkNode(ch, n))
  n.children = kids
  const bodyLens = kids.map((k) => ownLength(k.c))
  const total = bodyLens.reduce((a, b) => a + b, 0)
  let prevEnd = 0
  kids.forEach((k, i) => {
    k.len = bodyLens[i]
    const rel = relativePosition(pos(k.c.params, 'axialoffset', 'after'), {
      length: k.len, parentLength: total, parentX: n.x, prevEnd,
    })
    k.x = n.x + rel
    prevEnd = rel + k.len
  })
  n.len = Math.max(0, ...kids.map((k) => k.x + k.len - n.x))
}

function layoutChildren(n: Node): void {
  // Assemblies under a body tube (pods, boosters) are positioned like any child.
  const kids = n.c.children.map((ch) => mkNode(ch, n))
  n.children = kids
  let prevEnd = 0
  for (const k of kids) {
    const isAsm = k.c.type === 'podset' || k.c.type === 'parallelstage'
    if (isAsm) {
      // Measure first, place after.
      const probe = mkNode(k.c, n)
      layoutAssembly(probe)
      k.len = probe.len
    } else {
      k.len = ownLength(k.c)
    }
    const rel = relativePosition(pos(k.c.params, 'axialoffset', defaultMethod(k.c.type)), {
      length: k.len, parentLength: n.len, parentX: n.x, prevEnd,
    })
    k.x = n.x + rel
    prevEnd = rel + k.len
    if (isAsm) {
      layoutAssembly(k)
      k.yOff = n.yOff + n.outerR + num(k.c.params, 'radiusoffset', 0)
    }
  }
}

// ---------------------------------------------------------------------------

interface Built {
  root: Node
  nodes: Node[]
  byId: Map<string, Node>
}

function build(doc: RocketDocument): Built {
  const root = mkNode(doc.rocket, null)
  const nodes: Node[] = [root]
  // Stages, end to end.
  root.children = doc.rocket.children.map((s) => mkNode(s, root))
  let x = 0
  for (const s of root.children) {
    s.x = x
    layoutAssembly(s)
    x = s.x + s.len
  }
  root.len = x

  // Body radii per assembly, with OpenRocket's auto rules (previous/next).
  const resolveBodies = (asm: Node) => {
    const bodies = asm.children.filter((k) => BODY.has(k.c.type))
    const fore: number[] = []
    const aft: number[] = []
    const autoFore: boolean[] = []
    const autoAft: boolean[] = []
    for (const b of bodies) {
      const p = b.c.params
      if (b.c.type === 'nosecone') {
        const a = auto(p, 'aftradius', DEFAULT_RADIUS)
        fore.push(0); autoFore.push(false)
        aft.push(a.value); autoAft.push(a.auto)
      } else if (b.c.type === 'bodytube') {
        const r = auto(p, 'radius', DEFAULT_RADIUS)
        fore.push(r.value); aft.push(r.value)
        autoFore.push(r.auto); autoAft.push(r.auto)
      } else {
        const f = auto(p, 'foreradius', DEFAULT_RADIUS)
        const a = auto(p, 'aftradius', DEFAULT_RADIUS)
        fore.push(f.value); aft.push(a.value)
        autoFore.push(f.auto); autoAft.push(a.auto)
      }
    }
    // Pull autos from neighbours: fore from the previous aft, aft from the next fore.
    for (let pass = 0; pass < 3; pass++) {
      bodies.forEach((b, i) => {
        const isTube = b.c.type === 'bodytube'
        if (autoFore[i] && b.c.type !== 'nosecone') {
          const v = i > 0 ? aft[i - 1] : i + 1 < bodies.length ? fore[i + 1] : fore[i]
          fore[i] = v
          if (isTube) aft[i] = v
        }
        if (autoAft[i] && !isTube) {
          aft[i] = i + 1 < bodies.length ? fore[i + 1] : i > 0 ? aft[i - 1] : aft[i]
        }
      })
    }
    bodies.forEach((b, i) => {
      b.foreR = fore[i]
      b.aftR = aft[i]
      b.outerR = Math.max(fore[i], aft[i])
      const t = num(b.c.params, 'thickness', 0.002)
      const filled = bool(b.c.params, 'filled')
      b.innerR = filled ? 0 : Math.max(0, Math.min(fore[i], aft[i]) - t)
    })
  }

  const visit = (n: Node) => {
    nodes.push(n)
    const t = n.c.type
    if (t === 'stage' || t === 'podset' || t === 'parallelstage') {
      resolveBodies(n)
      for (const k of n.children) visit(k)
      return
    }
    if (n.c.children.length) layoutChildren(n)
    // Radii of the children now that the parent's are known.
    const parentInner = n.innerR
    for (const k of n.children) {
      const p = k.c.params
      switch (k.c.type) {
        case 'innertube':
        case 'tubecoupler': {
          const o = auto(p, 'outerradius', parentInner)
          k.outerR = o.auto ? parentInner : o.value
          k.innerR = Math.max(0, k.outerR - num(p, 'thickness', 0.0005))
          break
        }
        case 'engineblock': {
          const o = auto(p, 'outerradius', parentInner)
          k.outerR = o.auto ? parentInner : o.value
          k.innerR = Math.max(0, k.outerR - num(p, 'thickness', 0.005))
          break
        }
        case 'centeringring':
        case 'bulkhead': {
          const o = auto(p, 'outerradius', parentInner)
          k.outerR = o.auto ? parentInner : o.value
          if (k.c.type === 'bulkhead') {
            k.innerR = 0
          } else {
            const ir = auto(p, 'innerradius', 0)
            if (ir.auto) {
              // CenteringRing.getInnerRadius: the largest overlapping sibling inner tube.
              let best = 0
              for (const s of n.c.children) {
                if (s.type !== 'innertube') continue
                best = Math.max(best, num(s.params, 'outerradius', 0))
              }
              k.innerR = best
            } else k.innerR = ir.value
          }
          break
        }
        case 'launchlug':
          k.outerR = num(p, 'radius', 0.005)
          k.innerR = Math.max(0, k.outerR - num(p, 'thickness', 0.001))
          break
        case 'tubefinset': {
          const o = auto(p, 'outerradius', 0.025)
          k.outerR = o.value
          k.innerR = Math.max(0, k.outerR - num(p, 'thickness', 0.002))
          break
        }
        case 'masscomponent':
        case 'parachute':
        case 'streamer':
        case 'shockcord': {
          const r = auto(p, 'packedradius', parentInner)
          k.outerR = r.auto ? parentInner : r.value
          break
        }
        case 'railbutton':
          k.outerR = num(p, 'outerdiameter', 0.0097) / 2
          break
        default:
          break
      }
    }
    for (const k of n.children) visit(k)
  }
  for (const s of root.children) visit(s)

  const byId = new Map<string, Node>()
  for (const n of nodes) byId.set(n.c.id, n)
  return { root, nodes, byId }
}

// ---------------------------------------------------------------------------

interface Mass {
  m: number
  /** Absolute CG x. */
  cg: number
}

function rect(x0: number, x1: number, y0: number, y1: number): [number, number][] {
  return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
}

function polygonArea(pts: [number, number][]): { a: number; cx: number } {
  let a = 0
  let cx = 0
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i]
    const [x1, y1] = pts[(i + 1) % pts.length]
    const cross = x0 * y1 - x1 * y0
    a += cross
    cx += (x0 + x1) * cross
  }
  a /= 2
  if (Math.abs(a) < 1e-15) return { a: 0, cx: 0 }
  return { a: Math.abs(a), cx: cx / (6 * a) }
}

function density(c: Component, key = 'material', fallback = 680): number {
  return material(c.params, key)?.density ?? fallback
}

export interface MockResolved {
  /** Proposed contract extension: the value each auto param resolved to. */
  resolved: Record<string, Record<string, number>>
}

export function mockAnalyze(doc: RocketDocument, cond: Conditions): Analysis & MockResolved {
  const { root, nodes, byId } = build(doc)
  const configId = cond.configId ?? doc.selectedConfig
  const config = doc.motorConfigs.find((m) => m.id === configId) ?? null
  const shapes: FigureShape[] = []
  const comps: ComponentAnalysis[] = []
  const warnings: string[] = []
  const resolved: Record<string, Record<string, number>> = {}
  const M = Math.max(0, cond.mach)
  const alpha = (cond.aoaDeg * Math.PI) / 180

  // Reference: the largest body diameter (referencetype "maximum").
  let maxR = 0
  for (const n of nodes) if (BODY.has(n.c.type)) maxR = Math.max(maxR, n.foreR, n.aftR)
  if (maxR <= 0) maxR = DEFAULT_RADIUS
  const refLen = 2 * maxR
  const refArea = Math.PI * maxR * maxR

  let xmax = 0
  let ymax = maxR
  const masses: Mass[] = []
  let cnaSum = 0
  let cnaX = 0
  let friction = 0
  let pressure = 0
  let base = 0

  const V = M * 340.29
  const nu = 1.46e-5

  // Skin friction: OpenRocket's turbulent fit on the whole rocket's Reynolds
  // number, floored by the finish's roughness limit.
  const Re = Math.max(1e4, (V * Math.max(root.len, 0.01)) / nu)
  const CfTurb = 1 / Math.pow(1.5 * Math.log(Re) - 5.6, 2)
  const skinFriction = (c: Component) => {
    const h = ROUGHNESS[str(c.params, 'finish', 'normal')] ?? 60e-6
    return Math.max(CfTurb, 0.032 * Math.pow(h / Math.max(root.len, 0.01), 0.2))
  }

  // The aft-most body, for base drag.
  let aftBody: Node | null = null

  for (const n of nodes) {
    const c = n.c
    const p = c.params
    const t = c.type
    let mass = 0
    let cgx = n.x + n.len / 2
    let cpx = 0
    let cna = 0
    let cd = 0
    const y0 = n.yOff
    const ownResolved: Record<string, number> = {}

    if (BODY.has(t)) {
      // Outline
      const N = t === 'bodytube' ? 1 : 40
      const top: [number, number][] = []
      for (let i = 0; i <= N; i++) {
        const lx = (n.len * i) / N
        top.push([n.x + lx, y0 + bodyRadius(n, lx)])
      }
      const bottom = top.map(([x, y]) => [x, 2 * y0 - y] as [number, number]).reverse()
      shapes.push({ id: c.id, kind: 'body', points: [...top, ...bottom], closed: true })
      xmax = Math.max(xmax, n.x + n.len)
      ymax = Math.max(ymax, Math.abs(y0) + n.outerR)
      if (!aftBody || n.x + n.len >= aftBody.x + aftBody.len) aftBody = n

      // Mass: thin shell, wall measured normal to the surface.
      const thick = num(p, 'thickness', 0.002)
      const filled = bool(p, 'filled')
      const rho = density(c)
      const S = 60
      let vol = 0
      let mom = 0
      let solid = 0
      let wet = 0
      for (let i = 0; i < S; i++) {
        const xa = (n.len * i) / S
        const xb = (n.len * (i + 1)) / S
        const ra = bodyRadius(n, xa)
        const rb = bodyRadius(n, xb)
        const dx = xb - xa
        const rm = (ra + rb) / 2
        const slope = (rb - ra) / dx
        const tn = thick * Math.sqrt(1 + slope * slope)
        const ri = filled ? 0 : Math.max(0, rm - tn)
        const dv = Math.PI * (rm * rm - ri * ri) * dx
        vol += dv
        mom += dv * (n.x + (xa + xb) / 2)
        solid += (Math.PI / 3) * dx * (ra * ra + ra * rb + rb * rb)
        wet += Math.PI * (ra + rb) * Math.sqrt(dx * dx + (rb - ra) * (rb - ra))
      }
      if (t === 'nosecone' || t === 'transition') {
        // Aft shoulder (+ cap), and the transition's fore shoulder.
        for (const end of t === 'nosecone' ? ['aft'] : ['fore', 'aft']) {
          const sl = num(p, `${end}shoulderlength`, 0)
          if (sl <= 0) continue
          const sr = num(p, `${end}shoulderradius`, 0)
          const st = num(p, `${end}shoulderthickness`, 0.002)
          const sri = Math.max(0, sr - st)
          const sx = end === 'aft' ? n.x + n.len : n.x - sl
          const dv = Math.PI * (sr * sr - sri * sri) * sl
          vol += dv
          mom += dv * (sx + sl / 2)
          if (bool(p, `${end}shouldercapped`)) {
            const cv = Math.PI * sri * sri * st
            vol += cv
            mom += cv * (end === 'aft' ? sx + sl - st / 2 : sx + st / 2)
          }
          shapes.push({ id: c.id, kind: 'internal', points: rect(sx, sx + sl, y0 - sr, y0 + sr), closed: true })
        }
      }
      mass = vol * rho
      cgx = vol > 0 ? mom / vol : cgx

      // Barrowman: CNa = 2 (A_aft - A_fore)/Aref, Xcp = (L A_aft - V)/(A_aft - A_fore)
      const Af = Math.PI * n.foreR * n.foreR
      const Aa = Math.PI * n.aftR * n.aftR
      if (Math.abs(Aa - Af) > 1e-12) {
        cna = (2 * (Aa - Af)) / refArea
        cpx = n.x + (n.len * Aa - solid) / (Aa - Af)
      }
      // Body lift at angle of attack (Galejs), K = 1.1.
      if (alpha !== 0) {
        let plan = 0
        let planX = 0
        for (let i = 0; i < S; i++) {
          const xa = (n.len * (i + 0.5)) / S
          const da = (2 * bodyRadius(n, xa) * n.len) / S
          plan += da
          planX += da * (n.x + xa)
        }
        const lift = ((1.1 * plan) / refArea) * Math.abs(Math.sin(alpha))
        if (lift > 0) {
          const x0 = cna !== 0 ? cpx : planX / plan
          cpx = (cna * x0 + lift * (planX / plan)) / (cna + lift)
          cna += lift
        }
      }
      // Skin friction (OpenRocket's turbulent fit), body fineness correction.
      const Cf = skinFriction(c)
      const fb = root.len / refLen
      cd = (Cf * (1 + 1 / (2 * fb)) * wet) / refArea
      friction += cd
      if (t === 'nosecone' && str(p, 'shape') === 'conical') {
        const pd = 0.8 * Math.pow(Math.sin(Math.atan(n.aftR / n.len)), 2) * (Aa / refArea)
        pressure += pd
        cd += pd
      }
      if (t === 'transition' && n.aftR < n.foreR) {
        const pd = 0.1 * ((Af - Aa) / refArea)
        pressure += pd
        cd += pd
      }
      ownResolved.length = n.len
      if (t === 'bodytube') ownResolved.radius = n.foreR
      else {
        ownResolved.aftradius = n.aftR
        if (t === 'transition') ownResolved.foreradius = n.foreR
      }
    } else if (t === 'trapezoidfinset' || t === 'ellipticalfinset' || t === 'freeformfinset') {
      const poly = finPolygon(c)
      const parent = n.parent
      const r = parent ? bodyRadius(parent, n.x - parent.x + n.len / 2) : maxR
      const count = Math.max(1, Math.round(num(p, 'fincount', 3)))
      const th0 = num(p, 'angleoffset', 0) + num(p, 'rotation', 0) + cond.theta
      for (let i = 0; i < count; i++) {
        const th = th0 + (2 * Math.PI * i) / count
        const ct = Math.cos(th)
        if (Math.abs(ct) < 1e-3) continue
        shapes.push({
          id: c.id, kind: 'fin', closed: true,
          points: poly.map(([px, py]) => [n.x + px, y0 + (r + py) * ct] as [number, number]),
        })
      }
      const span = Math.max(...poly.map((q) => q[1]))
      xmax = Math.max(xmax, n.x + Math.max(...poly.map((q) => q[0])))
      ymax = Math.max(ymax, Math.abs(y0) + r + span)
      const { a: area, cx } = polygonArea(poly)
      const thick = num(p, 'thickness', 0.003)
      mass = area * thick * density(c) * count
      cgx = n.x + cx

      // Equivalent trapezoid for Barrowman.
      const rootPts = poly.filter((q) => q[1] < 1e-9)
      const cr = rootPts.length ? Math.max(...rootPts.map((q) => q[0])) - Math.min(...rootPts.map((q) => q[0])) : n.len
      const tipPts = poly.filter((q) => q[1] > span - Math.max(1e-9, span * 1e-3))
      const ctip = tipPts.length > 1 ? Math.max(...tipPts.map((q) => q[0])) - Math.min(...tipPts.map((q) => q[0])) : 0
      const sweep = tipPts.length ? Math.min(...tipPts.map((q) => q[0])) : cr / 2
      if (span > 0 && cr > 0) {
        const lf = Math.sqrt(span * span + Math.pow(sweep + ctip / 2 - cr / 2, 2))
        const d = 2 * r
        const Kfb = 1 + r / (span + r)
        const nEff = count <= 4 ? count : count * (count <= 8 ? 0.9 : 0.8)
        const cnaF = (Kfb * 4 * nEff * Math.pow(span / d, 2)) / (1 + Math.sqrt(1 + Math.pow((2 * lf) / (cr + ctip), 2)))
        cna = cnaF * (d * d / (refLen * refLen)) * (1 + 0.104 * M * M)
        const xf = (sweep * (cr + 2 * ctip)) / (3 * (cr + ctip)) + (cr + ctip - (cr * ctip) / (cr + ctip)) / 6
        cpx = n.x + xf
      }
      const Cf = skinFriction(c)
      const fc = (Cf * (1 + (2 * thick) / Math.max(cr, 1e-3)) * 2 * area * count) / refArea
      const cs = str(p, 'crosssection', 'square')
      const le = ((count * span * thick) / refArea) * (cs === 'square' ? 0.85 : cs === 'rounded' ? 0.09 : 0.02) * (1 + M * M)
      friction += fc
      pressure += le
      cd = fc + le
    } else if (t === 'tubefinset' || t === 'launchlug' || t === 'railbutton') {
      const parent = n.parent
      const r = parent ? bodyRadius(parent, n.x - parent.x + n.len / 2) : maxR
      const count = Math.max(1, Math.round(num(p, t === 'tubefinset' ? 'fincount' : 'instancecount', t === 'tubefinset' ? 6 : 1)))
      const th0 = num(p, 'angleoffset', 0) + cond.theta
      const ro = n.outerR
      const height = t === 'railbutton' ? num(p, 'totalheight', 0.0097) : 2 * ro
      const sep = num(p, 'instanceseparation', 0)
      const ninst = t === 'tubefinset' ? count : 1
      for (let i = 0; i < ninst; i++) {
        const th = th0 + (2 * Math.PI * i) / ninst
        const ct = Math.cos(th)
        const yc = y0 + (r + height / 2) * ct
        if (t === 'tubefinset' && Math.abs(ct) < 0.2) continue
        const reps = t === 'tubefinset' ? 1 : count
        for (let j = 0; j < reps; j++) {
          const xs = n.x + j * sep
          shapes.push({
            id: c.id, kind: t === 'tubefinset' ? 'fin' : 'body', closed: true,
            points: rect(xs, xs + n.len, yc - (height / 2) * Math.abs(ct || 1), yc + (height / 2) * Math.abs(ct || 1)),
          })
        }
        ymax = Math.max(ymax, Math.abs(y0) + r + height)
      }
      xmax = Math.max(xmax, n.x + n.len)
      const rho = density(c, 'material', t === 'railbutton' ? 1400 : 680)
      if (t === 'railbutton') mass = Math.PI * ro * ro * height * 0.5 * rho * count
      else mass = Math.PI * (ro * ro - n.innerR * n.innerR) * n.len * rho * count
      const frontal = t === 'railbutton' ? 2 * ro * height : Math.PI * (ro * ro - n.innerR * n.innerR)
      cd = ((t === 'tubefinset' ? count : count) * frontal * 1.0) / refArea
      pressure += cd
      if (t === 'tubefinset') {
        cna = ((count / 2) * 2 * (2 * ro * n.len)) / refArea * 0.6
        cpx = n.x + n.len / 4
      }
    } else if (t === 'innertube' || t === 'tubecoupler' || t === 'centeringring' || t === 'bulkhead' || t === 'engineblock') {
      shapes.push({ id: c.id, kind: 'internal', points: rect(n.x, n.x + n.len, y0 - n.outerR, y0 + n.outerR), closed: true })
      if ((t === 'engineblock' || t === 'centeringring') && n.innerR > 0) {
        // OpenRocket draws a ring's bore as two lines across it.
        for (const sgn of [1, -1]) {
          shapes.push({ id: c.id, kind: 'internal', points: [[n.x, y0 + sgn * n.innerR], [n.x + n.len, y0 + sgn * n.innerR]], closed: false })
        }
      }
      const count = Math.max(1, num(p, 'instancecount', 1))
      mass = Math.PI * (n.outerR * n.outerR - n.innerR * n.innerR) * n.len * density(c) * count
      if (isAuto(p.outerradius)) ownResolved.outerradius = n.outerR
      if (isAuto(p.innerradius)) ownResolved.innerradius = n.innerR
    } else if (t === 'masscomponent' || t === 'shockcord' || t === 'parachute' || t === 'streamer') {
      const kind = t === 'parachute' || t === 'streamer' ? 'recovery' : 'internal'
      const ro = n.outerR
      // Rounded-rectangle outline, like OpenRocket's MassObject shapes.
      const rr = Math.min(ro, n.len / 2) * 0.6
      const pts: [number, number][] = []
      const corners: [number, number, number][] = [
        [n.x + n.len - rr, y0 + ro - rr, 0], [n.x + rr, y0 + ro - rr, Math.PI / 2],
        [n.x + rr, y0 - ro + rr, Math.PI], [n.x + n.len - rr, y0 - ro + rr, (3 * Math.PI) / 2],
      ]
      for (const [cx, cy, a0] of corners) {
        for (let i = 0; i <= 4; i++) {
          const a = a0 + (Math.PI / 2) * (i / 4)
          pts.push([cx + rr * Math.cos(a), cy + rr * Math.sin(a)])
        }
      }
      shapes.push({ id: c.id, kind, points: pts, closed: true })
      if (t === 'masscomponent') mass = num(p, 'mass', 0)
      else if (t === 'shockcord') mass = num(p, 'cordlength', 0.4) * density(c, 'material', 0.0018)
      else if (t === 'parachute') {
        const d = num(p, 'diameter', 0.3)
        mass = Math.PI * (d / 2) ** 2 * density(c, 'material', 0.067)
          + num(p, 'linecount', 6) * num(p, 'linelength', 0.3) * density(c, 'linematerial', 0.0018)
        if (isAuto(p.cd)) ownResolved.cd = 0.8
      } else {
        mass = num(p, 'striplength', 0.5) * num(p, 'stripwidth', 0.05) * density(c, 'material', 0.067)
      }
      if (isAuto(p.packedradius)) ownResolved.packedradius = ro
    }

    // Overrides (RocketComponent override*): replace this component's own values.
    if (typeof p.overridemass === 'number') mass = p.overridemass
    if (typeof p.overridecg === 'number') cgx = n.x + p.overridecg
    if (typeof p.overridecd === 'number' && cd !== 0) cd = p.overridecd

    if (Object.keys(ownResolved).length) resolved[c.id] = ownResolved

    if (t !== 'rocket') {
      comps.push({ id: c.id, name: c.name, type: t, x: n.x, length: n.len, mass, cgx, cpx: cna ? cpx : 0, cna, cd })
    }
    if (mass > 0) masses.push({ m: mass, cg: cgx })
    if (cna !== 0) {
      cnaSum += cna
      cnaX += cna * cpx
    }
  }

  // Body diameter discontinuities (OpenRocket warns about these).
  for (const asm of nodes.filter((n) => n.c.type === 'stage')) {
    const bodies = asm.children.filter((k) => BODY.has(k.c.type))
    for (let i = 1; i < bodies.length; i++) {
      if (Math.abs(bodies[i - 1].aftR - bodies[i].foreR) > 1e-5) {
        warnings.push(`Discontinuity in rocket body diameter (${bodies[i - 1].c.name} → ${bodies[i].c.name})`)
      }
    }
  }

  // Motors of the selected configuration.
  const empty = sumMass(masses)
  const all = [...masses]
  if (config) {
    for (const [mountId, choice] of Object.entries(config.motors)) {
      const mount = byId.get(mountId)
      if (!mount) continue
      const mm = motorMount(mount.c.params)
      if (!mm) continue
      const m = motorFor(choice)
      const end = mount.x + mount.len + (mm.overhang ?? 0)
      const x0 = end - m.length
      const r = m.diameter / 2
      shapes.push({ id: mountId, kind: 'motor', points: rect(x0, end, mount.yOff - r, mount.yOff + r), closed: true })
      all.push({ m: m.mass, cg: x0 + m.length / 2 })
    }
  }
  const loaded = sumMass(all)

  if (aftBody) {
    const Ab = Math.PI * aftBody.aftR * aftBody.aftR
    base = (M < 1 ? 0.12 + 0.13 * M * M : 0.25 / M) * (Ab / refArea)
    const row = comps.find((r) => r.id === aftBody!.c.id)
    if (row) row.cd += base
  }

  const cpX = cnaSum > 0 ? cnaX / cnaSum : 0
  const length = xmax
  const calibers = cnaSum > 0 ? (cpX - loaded.cg) / refLen : NaN
  const pad = Math.max(0.01, ymax * 0.15)
  return {
    conditions: { ...cond, configId: config?.id ?? null },
    reference: { length: refLen, area: refArea },
    length,
    maxDiameter: 2 * maxR,
    cg: { x: loaded.cg, mass: loaded.m },
    cgEmpty: { x: empty.cg, mass: empty.m },
    cp: { x: cpX, cna: cnaSum },
    stability: { calibers, percent: cnaSum > 0 && length > 0 ? (100 * (cpX - loaded.cg)) / length : NaN },
    cd: { total: friction + pressure + base, friction, pressure, base },
    components: comps,
    figure: { bounds: { xmin: 0, xmax: Math.max(length, root.len), ymin: -ymax - pad, ymax: ymax + pad }, shapes },
    warnings,
    resolved,
  }
}

function sumMass(ms: Mass[]): Mass {
  const m = ms.reduce((a, b) => a + b.m, 0)
  const cg = m > 0 ? ms.reduce((a, b) => a + b.m * b.cg, 0) / m : 0
  return { m, cg }
}

function motorFor(choice: MotorChoice): { length: number; diameter: number; mass: number } {
  const m = findMotor(choice.designation, choice.manufacturer)
  if (m) return { length: m.length, diameter: m.diameter, mass: m.launchMass }
  return { length: 0.07, diameter: 0.018, mass: 0.02 }
}
