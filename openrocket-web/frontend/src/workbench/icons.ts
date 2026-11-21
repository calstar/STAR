/**
 * OpenRocket's own icons (src/assets/pix/, copied from
 * swing/src/main/resources/pix/ at release-24.12; GPLv3 / Nuvola, see
 * src/assets/pix/README.md). Imported through Vite rather than served from
 * public/, so whichever app compiles the workbench -- this one, or
 * star-openrocket hosting it as a tab -- bundles them and gets working URLs.
 */
import type { ComponentType, Params } from '../types'

const PIX = import.meta.glob('../assets/pix/**/*.png', { eager: true, query: '?url', import: 'default' }) as Record<
  string,
  string
>

/** The bundled URL of `pix/<path>`, e.g. `icons/edit-undo.png`; '' when there is no such icon. */
export function pix(path: string): string {
  return PIX[`../assets/pix/${path}`] ?? ''
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
