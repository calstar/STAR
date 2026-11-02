/**
 * The chips the propellant / injector selector shows after a switch (POST /api/config/switch).
 *
 * ``design_warning`` is the chamber's staleness only -- solved for another injector or propellant,
 * a seed, "needs re-optimization". ``fluid_warning`` is the fluid properties off their propellant
 * preset: the chamber is still the right one, the properties want refreshing. A clean swap to the
 * pintle (whose canonical config carries the old LOX block) used to read "needs re-optimization".
 */
export interface SwitchChip {
  label: string;
  title: string;
}

export function switchChips(res: { design_warning?: string | null; fluid_warning?: string | null }): SwitchChip[] {
  const chips: SwitchChip[] = [];
  if (res.design_warning) chips.push({ label: 'needs re-optimization', title: res.design_warning });
  if (res.fluid_warning) chips.push({ label: 'fluids differ from preset', title: res.fluid_warning });
  return chips;
}
