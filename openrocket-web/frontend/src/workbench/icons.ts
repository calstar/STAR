/**
 * OpenRocket's own icons (public/pix/, copied from
 * swing/src/main/resources/pix/ at release-24.12; GPLv3 / Nuvola, see
 * public/pix/README.md). Paths resolve against Vite's base so the app still
 * finds them when mounted under another app's base URL.
 */
import type { ComponentType, Params } from '../types'

export function pix(path: string): string {
  const base = (import.meta.env?.BASE_URL as string | undefined) ?? '/'
  return `${base}pix/${path}`
}

const COMPONENT_ICON: Partial<Record<ComponentType, string>> = {
  stage: 'stage',
  parallelstage: 'boosters',
  podset: 'pods',
  nosecone: 'nosecone',
  bodytube: 'bodytube',
  transition: 'transition',
  trapezoidfinset: 'trapezoidfin',
  ellipticalfinset: 'ellipticalfin',
  freeformfinset: 'freeformfin',
  tubefinset: 'tubefin',
  launchlug: 'launchlug',
  railbutton: 'railbutton',
  innertube: 'innertube',
  tubecoupler: 'tubecoupler',
  centeringring: 'centeringring',
  bulkhead: 'bulkhead',
  engineblock: 'engineblock',
  masscomponent: 'mass',
  shockcord: 'shockcord',
  parachute: 'parachute',
  streamer: 'streamer',
}

/** MassComponent's per-type small icons (ComponentIcons.java). */
const MASS_TYPE_ICON: Record<string, string> = {
  altimeter: 'altimeter',
  flightcomputer: 'flight-comp',
  deploymentcharge: 'deployment-charge',
  tracker: 'tracker',
  payload: 'payload',
  recoveryhardware: 'recovery-hardware',
  battery: 'battery',
}

export function componentIcon(type: ComponentType, size: 'small' | 'large', params?: Params): string | null {
  if (type === 'masscomponent' && size === 'small' && params) {
    const t = typeof params.masscomponenttype === 'string' ? params.masscomponenttype : ''
    if (MASS_TYPE_ICON[t]) return pix(`componenticons/${MASS_TYPE_ICON[t]}-small.png`)
  }
  const n = COMPONENT_ICON[type]
  return n ? pix(`componenticons/${n}-${size}.png`) : null
}
