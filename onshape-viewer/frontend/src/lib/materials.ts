/**
 * User-selectable materials for the properties panel.
 *
 * Onshape is the source of truth for a part's material, but a part can reach the
 * viewer with none assigned (see MaterialWarning), and sometimes Onshape's guess
 * is simply the wrong alloy. This is the short list a user can pick from instead:
 * choosing one applies its density to the part's exact volume to get a mass, so
 * the centre of mass includes the part without anyone typing a number.
 *
 * Densities are standard handbook values in kg/m^3 at room temperature. They are
 * kept here, close to the UI, rather than fetched -- the list is small and its
 * numbers do not change.
 */

import type { Material } from '../types'

export interface CatalogMaterial extends Material {
  /** Stable id stored in the override; never shown. */
  key: string
}

export const MATERIAL_CATALOG: CatalogMaterial[] = [
  { key: '6061', name: '6061 Aluminum', density: 2700 },
  { key: '5052', name: '5052 Aluminum', density: 2680 },
]

export const MATERIALS_BY_KEY: Record<string, CatalogMaterial> = Object.fromEntries(
  MATERIAL_CATALOG.map((material) => [material.key, material]),
)
