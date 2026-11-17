"""The extended-Barrowman aerodynamic calculator.

Ported from OpenRocket 24.12 (GPLv3):
info.openrocket.core.aerodynamics.BarrowmanCalculator (with the parts of
AbstractAerodynamicCalculator it uses).

Non-axial forces come from each component's calc, once per instance, moved to
absolute coordinates and merged up the tree. Drag is built rocket-wide:
friction from one skin-friction coefficient (turbulent, or partly laminar for a
"perfect finish" rocket, with compressibility and a per-finish roughness limit)
with a fineness-ratio correction on the body; pressure drag per component plus
stagnation drag where the body steps out; base drag where it steps in; CD
overrides; then the axial CD from the angle of attack.
"""

from __future__ import annotations

import math

from . import _compat as compat
from . import mathutil as mu
from .barrowman import (ComponentAssemblyCalc, FinSetCalc, LaunchLugCalc, RailButtonCalc,
                        SymmetricComponentCalc, TubeFinSetCalc)
from .barrowman.symmetric_component_calc import calculate_stagnation_cd
from .coordinate import Coordinate
from .forces import AerodynamicForces
from .interpolators import PolyInterpolator

pow2 = mu.pow2

STALL_ANGLE = 17.5 * math.pi / 180


def calculate_base_cd(m: float) -> float:
    """BarrowmanCalculator.calculateBaseCD(double)."""
    if m <= 1:
        return 0.12 + 0.13 * m * m
    return 0.25 / m


_axial_drag_poly1 = PolyInterpolator([0, 17 * math.pi / 180], [0, 17 * math.pi / 180]).interpolator(1, 1.3, 0, 0)
_axial_drag_poly2 = PolyInterpolator([17 * math.pi / 180, math.pi / 2], [17 * math.pi / 180, math.pi / 2],
                                     [math.pi / 2]).interpolator(1.3, 0, 0, 0, 0)


def calculate_axial_cd(conditions, cd: float) -> float:
    """BarrowmanCalculator.calculateAxialCD."""
    aoa = mu.clamp(conditions.get_aoa(), 0, math.pi)
    if aoa > math.pi / 2:
        aoa = math.pi - aoa
    if aoa < 17 * math.pi / 180:
        mul = PolyInterpolator.eval(aoa, _axial_drag_poly1)
    else:
        mul = PolyInterpolator.eval(aoa, _axial_drag_poly2)
    if conditions.get_aoa() < math.pi / 2:
        return mul * cd
    return -mul * cd


def make_calc(comp):
    """Reflection.construct(BARROWMAN_PACKAGE, comp, "Calc", comp): the calc of the
    nearest superclass that has one."""
    if compat.is_a(comp, "ComponentAssembly"):
        return ComponentAssemblyCalc(comp)
    if compat.is_a(comp, "TubeFinSet"):
        return TubeFinSetCalc(comp)
    if compat.is_a(comp, "FinSet"):
        return FinSetCalc(comp)
    if compat.is_a(comp, "LaunchLug"):
        return LaunchLugCalc(comp)
    if compat.is_a(comp, "RailButton"):
        return RailButtonCalc(comp)
    if compat.is_a(comp, "SymmetricComponent"):
        return SymmetricComponentCalc(comp)
    raise NotImplementedError(f"No Barrowman calc for {type(comp).__name__} ({compat.name_of(comp)})")


class BarrowmanCalculator:
    def __init__(self):
        self.calc_map: dict | None = None
        self.cache_diameter = -1.0
        self.cache_length = -1.0
        self.stall_margin = math.nan

    def get_stall_margin(self) -> float:
        return self.stall_margin

    # ------------------------------------------------------------ public
    def get_cp(self, configuration, conditions, warnings=None) -> Coordinate:
        forces = self.calculate_non_axial_forces(configuration, conditions, warnings)
        return forces.get_cp()

    def get_force_analysis(self, configuration, conditions, warnings=None) -> dict:
        """{component: AerodynamicForces} for every active aerodynamic component and
        every active assembly (the rocket's entry carries the totals)."""
        if warnings is None:
            warnings = []
        if self.calc_map is None:
            self.build_calc_map(configuration)

        inst_map = compat.active_instances(configuration)
        each_map: dict = {}
        assembly_map: dict = {}

        rocket = compat.get_rocket(configuration)
        self.calculate_force_analysis(configuration, conditions, rocket, inst_map, each_map, assembly_map, warnings)

        rocket_forces = assembly_map[rocket]
        rocket_forces.set_friction_cd(self.calculate_friction_cd(configuration, conditions, each_map, warnings,
                                                                 inst_map))
        rocket_forces.set_pressure_cd(self.calculate_pressure_cd(configuration, conditions, each_map, warnings,
                                                                 inst_map))
        rocket_forces.set_base_cd(self.calculate_base_cd(configuration, conditions, each_map, warnings, inst_map))
        rocket_forces.set_override_cd(self.calculate_override_cd(configuration, conditions, each_map, assembly_map,
                                                                 warnings, inst_map))

        final_map: dict = {}
        for comp in inst_map:
            if compat.is_a(comp, "ComponentAssembly"):
                f = assembly_map[comp]
            elif compat.is_aerodynamic(comp):
                f = each_map[comp]
            else:
                continue

            if f.get_cp().is_nan():
                f.set_cp(Coordinate.ZERO)  # type: ignore[attr-defined]
            if math.isnan(f.get_base_cd()):
                f.set_base_cd(0.0)
            if math.isnan(f.get_pressure_cd()):
                f.set_pressure_cd(0.0)
            if math.isnan(f.get_friction_cd()):
                f.set_friction_cd(0.0)
            if math.isnan(f.get_override_cd()):
                f.set_override_cd(0.0)

            f.set_cd(f.get_base_cd() + f.get_pressure_cd() + f.get_friction_cd() + f.get_override_cd())
            f.set_cd_axial(calculate_axial_cd(conditions, f.get_cd()))
            final_map[comp] = f
        return final_map

    def get_aerodynamic_forces(self, configuration, conditions, warnings=None) -> AerodynamicForces:
        """Rocket totals including pitch/yaw damping (as the simulation uses them)."""
        if warnings is None:
            warnings = []
        inst_map = compat.active_instances(configuration)
        total = self.calculate_non_axial_forces(configuration, conditions, warnings, inst_map)
        total.set_friction_cd(self.calculate_friction_cd(configuration, conditions, None, warnings, inst_map))
        total.set_pressure_cd(self.calculate_pressure_cd(configuration, conditions, None, warnings, inst_map))
        total.set_base_cd(self.calculate_base_cd(configuration, conditions, None, warnings, inst_map))
        total.set_override_cd(self.calculate_override_cd(configuration, conditions, None, None, warnings, inst_map))
        total.set_cd(total.get_friction_cd() + total.get_pressure_cd() + total.get_base_cd()
                     + total.get_override_cd())
        total.set_cd_axial(calculate_axial_cd(conditions, total.get_cd()))
        self.calculate_damping_moments(configuration, conditions, total)
        total.set_cm(total.get_cm() - total.get_pitch_damping_moment())
        total.set_cyaw(total.get_cyaw() - total.get_yaw_damping_moment())
        self.stall_margin = STALL_ANGLE - conditions.get_aoa()
        return total

    # ------------------------------------------------------- non-axial
    def calculate_force_analysis(self, configuration, conds, comp, instances, each_forces, assembly_forces,
                                 warnings) -> AerodynamicForces:
        aggregate = AerodynamicForces().zero()
        aggregate.set_component(comp)

        if compat.is_aerodynamic(comp) or compat.is_a(comp, "ComponentAssembly"):
            calc_obj = self.calc_map.get(comp)
            if calc_obj is None:
                raise RuntimeError(f"Could not find a CalculationObject for aerodynamic Component!: "
                                   f"{compat.name_of(comp)}")
            context_list = instances.get(comp)
            if context_list is None:  # Java: NullPointerException on an inactive component
                raise RuntimeError(f"{compat.name_of(comp)} is not active in this configuration")
            comp_forces = self.calculate_component_non_axial_forces(conds, comp, calc_obj, context_list, warnings)
            each_forces[comp] = comp_forces
            aggregate.merge(comp_forces)

        for child in compat.get_children(comp):
            if compat.is_a(child, "AxialStage") and not compat.is_stage_active(
                    configuration, compat.get_stage_number(child)):
                for child_stage in compat.get_top_level_child_stages(child):
                    if compat.is_stage_active(configuration, compat.get_stage_number(child_stage)):
                        child_forces = self.calculate_force_analysis(configuration, conds, child_stage, instances,
                                                                     each_forces, assembly_forces, warnings)
                        if child_forces is not None:
                            aggregate.merge(child_forces)
                continue
            child_forces = self.calculate_force_analysis(configuration, conds, child, instances, each_forces,
                                                         assembly_forces, warnings)
            if child_forces is not None:
                aggregate.merge(child_forces)

        assembly_forces[comp] = aggregate
        return aggregate

    @staticmethod
    def calculate_component_non_axial_forces(conditions, comp, calc_obj, context_list, warnings):
        component_forces = AerodynamicForces().zero()
        for context in context_list:
            instance_forces = AerodynamicForces().zero()
            calc_obj.calculate_nonaxial_forces(conditions, context.transform, instance_forces, warnings)
            cp_inst = instance_forces.get_cp()
            cp_abs = context.transform.transform(cp_inst)
            cp_abs = cp_abs.set_y(0.0).set_z(0.0)
            instance_forces.set_cp(cp_abs)
            cn_instanced = instance_forces.get_cn()
            instance_forces.set_cm(cn_instanced * instance_forces.get_cp().x / conditions.get_ref_length())
            component_forces.merge(instance_forces)
        component_forces.set_component(comp)
        return component_forces

    def calculate_non_axial_forces(self, configuration, conditions, warnings=None, imap=None):
        if warnings is None:
            warnings = []
        if self.calc_map is None:
            self.build_calc_map(configuration)
        if imap is None:
            imap = compat.active_instances(configuration)
        assembly_forces = AerodynamicForces().zero()
        for comp, context_list in imap.items():
            calc_obj = self.calc_map.get(comp)
            if calc_obj is not None:
                assembly_forces.merge(self.calculate_component_non_axial_forces(
                    conditions, comp, calc_obj, context_list, warnings))
        return assembly_forces

    # ------------------------------------------------------------- drag
    def calculate_friction_cd(self, configuration, conditions, force_map, warnings, imap=None) -> float:
        mach = conditions.get_mach()
        re = self.calculate_reynolds_number(configuration, conditions)
        cf = self.calculate_friction_coefficient(configuration, mach, re)
        roughness_correction = self.calculate_roughness_correction(mach)
        if self.calc_map is None:
            self.build_calc_map(configuration)
        if imap is None:
            imap = compat.active_instances(configuration)

        other_friction_cd = 0.0
        body_friction_cd = 0.0
        max_r, min_x, max_x = 0.0, 1.7976931348623157e308, 0.0
        roughness_limited: dict[str, float] = {}
        length_aero = configuration.get_length_aerodynamic()
        perfect = compat.is_perfect_finish(compat.get_rocket(configuration))

        for c, contexts in imap.items():
            if not compat.is_aerodynamic(c):
                continue
            if compat.is_cd_overridden(c) or compat.is_cd_overridden_by_ancestor(c):
                continue

            # roughness-limited friction coefficient, once per finish
            key = compat.finish_key(c)
            if key not in roughness_limited:
                roughness_limited[key] = 0.032 * mu.jpow(compat.finish_roughness(c) / length_aero, 0.2) \
                    * roughness_correction
            rl = roughness_limited[key]

            # actual Cf is the larger of Cf and the roughness limit; perfect finish needs Re > 1e6 too
            if perfect:
                component_cf = rl if (re > 1.0e6 and rl > cf) else cf
            else:
                component_cf = _jmax(cf, rl)

            component_friction_cd = self.calc_map[c].calculate_friction_cd(conditions, component_cf, warnings)
            instance_count = len(contexts)

            if compat.is_a(c, "SymmetricComponent"):
                body_friction_cd += instance_count * component_friction_cd
                component_min_x = compat.axial_offset_absolute(c)
                min_x = min(min_x, component_min_x)
                component_max_x = component_min_x + c.get_length()
                max_x = max(max_x, component_max_x)
                component_max_r = max(c.get_fore_radius(), c.get_aft_radius())
                max_r = max(max_r, component_max_r)
            else:
                other_friction_cd += instance_count * component_friction_cd

            if force_map is not None:
                force_map[c].set_friction_cd(component_friction_cd)

        # fB may be +inf, which is fine
        f_b = mu.jdiv(max_x - min_x + 0.0001, max_r)
        correction = 1 + mu.jdiv(1.0, 2 * f_b)

        if force_map is not None:
            for comp, f in force_map.items():
                if compat.is_a(comp, "SymmetricComponent"):
                    f.set_friction_cd(f.get_friction_cd() * correction)

        return other_friction_cd + correction * body_friction_cd

    @staticmethod
    def calculate_reynolds_number(configuration, conditions) -> float:
        return conditions.get_velocity() * configuration.get_length_aerodynamic() / \
            conditions.get_atmospheric_conditions().get_kinematic_viscosity()

    @staticmethod
    def calculate_friction_coefficient(configuration, mach: float, re: float) -> float:
        c1 = 1.0
        c2 = 1.0
        if compat.is_perfect_finish(compat.get_rocket(configuration)):
            # partial laminar layer; roughness limit is checked later
            if re < 1.0e4:
                cf = 1.33e-2
            elif re < 5.39e5:
                cf = 1.328 / mu.safe_sqrt(re)
            else:
                cf = 1.0 / pow2(1.50 * math.log(re) - 5.6) - 1700 / re
            # compressibility correction
            if mach < 1.1:
                if re > 1.0e6:
                    if re < 3.0e6:
                        c1 = 1 - 0.1 * pow2(mach) * (re - 1.0e6) / 2.0e6
                    else:
                        c1 = 1 - 0.1 * pow2(mach)
            if mach > 0.9:
                if re > 1.0e6:
                    if re < 3.0e6:
                        c2 = 1 + (1.0 / math.pow(1 + 0.045 * pow2(mach), 0.25) - 1) * (re - 1.0e6) / 2.0e6
                    else:
                        c2 = 1.0 / math.pow(1 + 0.045 * pow2(mach), 0.25)
            if mach < 0.9:
                cf *= c1
            elif mach < 1.1:
                cf *= (c2 * (mach - 0.9) / 0.2 + c1 * (1.1 - mach) / 0.2)
            else:
                cf *= c2
        else:
            # fully turbulent; roughness limit is checked later
            if re < 1.0e4:
                cf = 1.48e-2
            else:
                cf = 1.0 / pow2(1.50 * math.log(re) - 5.6)
            if mach < 1.1:
                c1 = 1 - 0.1 * pow2(mach)
            if mach > 0.9:
                c2 = 1 / math.pow(1 + 0.15 * pow2(mach), 0.58)
            if mach < 0.9:
                cf *= c1
            elif mach < 1.1:
                cf *= c2 * (mach - 0.9) / 0.2 + c1 * (1.1 - mach) / 0.2
            else:
                cf *= c2
        return cf

    @staticmethod
    def calculate_roughness_correction(mach: float) -> float:
        if mach < 0.9:
            return 1 - 0.1 * pow2(mach)
        if mach > 1.1:
            return 1 / (1 + 0.18 * pow2(mach))
        c1 = 1 - 0.1 * pow2(0.9)
        c2 = 1.0 / (1 + 0.18 * pow2(1.1))
        return c2 * (mach - 0.9) / 0.2 + c1 * (1.1 - mach) / 0.2

    def calculate_pressure_cd(self, configuration, conditions, force_map, warnings, imap=None) -> float:
        if self.calc_map is None:
            self.build_calc_map(configuration)
        if imap is None:
            imap = compat.active_instances(configuration)
        stagnation = calculate_stagnation_cd(conditions.get_mach())
        base = calculate_base_cd(conditions.get_mach())

        total = 0.0
        for c, contexts in imap.items():
            if not compat.is_aerodynamic(c):
                continue
            if compat.is_cd_overridden(c) or compat.is_cd_overridden_by_ancestor(c):
                continue
            instance_count = len(contexts)

            cd = self.calc_map[c].calculate_pressure_cd(conditions, stagnation, base, warnings)
            if force_map is not None:
                force_map[c].set_pressure_cd(cd)
            total += cd * instance_count

            # stagnation drag where the radius steps out from the previous component
            if compat.is_a(c, "SymmetricComponent"):
                fore_radius = c.get_fore_radius()
                aft_radius = c.get_aft_radius()
                if c.get_length() == 0:
                    fore_radius = max(fore_radius, aft_radius)
                radius = 0.0
                prev = compat.previous_symmetric(c)
                if prev is not None and compat.is_component_active(configuration, prev):
                    radius = prev.get_aft_radius()
                if radius < fore_radius:
                    area = math.pi * (pow2(fore_radius) - pow2(radius))
                    cd = stagnation * area / conditions.get_ref_area()
                    total += instance_count * cd
                    if force_map is not None:
                        force_map[c].set_pressure_cd(force_map[c].get_pressure_cd() + cd)
        return total

    def calculate_base_cd(self, configuration, conditions, force_map, warnings, imap=None) -> float:
        if self.calc_map is None:
            self.build_calc_map(configuration)
        if imap is None:
            imap = compat.active_instances(configuration)
        base = calculate_base_cd(conditions.get_mach())
        total = 0.0
        for c, contexts in imap.items():
            if not compat.is_a(c, "SymmetricComponent"):
                continue
            if compat.is_cd_overridden(c) or compat.is_cd_overridden_by_ancestor(c):
                continue
            fore_radius = c.get_fore_radius()
            aft_radius = c.get_aft_radius()
            if c.get_length() == 0:
                fore_radius = aft_radius = max(fore_radius, aft_radius)
            instance_count = len(contexts)

            nxt = compat.next_symmetric(c)
            if nxt is not None and compat.is_component_active(configuration, nxt):
                next_radius = nxt.get_fore_radius()
            else:
                next_radius = 0.0

            if next_radius < aft_radius:
                area = math.pi * (pow2(aft_radius) - pow2(next_radius))
                cd = base * area / conditions.get_ref_area()
                total += instance_count * cd
                if force_map is not None:
                    force_map[c].set_base_cd(cd)
        return total

    def calculate_override_cd(self, configuration, conditions, each_map, assembly_map, warnings,
                              imap=None) -> float:
        if self.calc_map is None:
            self.build_calc_map(configuration)
        if imap is None:
            imap = compat.active_instances(configuration)
        total = 0.0
        for c, contexts in imap.items():
            instance_count = len(contexts)
            if not compat.is_aerodynamic(c) and not compat.is_a(c, "ComponentAssembly"):
                continue
            if compat.is_cd_overridden(c) and not compat.is_cd_overridden_by_ancestor(c):
                cd = instance_count * compat.get_override_cd(c)
                force_map = assembly_map if compat.is_a(c, "ComponentAssembly") else each_map
                if force_map is not None:
                    force_map[c].set_override_cd(cd)
                total += cd
        return total

    # ---------------------------------------------------------- damping
    def calculate_damping_moments(self, configuration, conditions, total) -> None:
        mul = self.get_damping_multiplier(configuration, conditions, conditions.get_pitch_center().x)
        pitch_rate = conditions.get_pitch_rate()
        yaw_rate = conditions.get_yaw_rate()
        velocity = conditions.get_velocity()
        mul *= 3  # OpenRocket: "Higher damping yields much more realistic apogee turn"
        pitch_mag = mu.min_(mul * pow2(mu.jdiv(pitch_rate, velocity)), total.get_cm())
        yaw_mag = mu.min_(mul * pow2(mu.jdiv(yaw_rate, velocity)), total.get_cyaw())
        total.set_pitch_damping_moment(mu.sign(pitch_rate) * pitch_mag)
        total.set_yaw_damping_moment(mu.sign(yaw_rate) * yaw_mag)

    def get_damping_multiplier(self, configuration, conditions, cgx: float) -> float:
        if self.cache_diameter < 0:
            area = 0.0
            self.cache_length = 0.0
            self.cache_diameter = 0.0
            for c in compat.active_components(configuration):
                if compat.is_a(c, "SymmetricComponent"):
                    area += c.get_component_planform_area()
                    self.cache_length += c.get_length()
            if self.cache_length > 0:
                self.cache_diameter = area / self.cache_length

        mul = 0.275 * self.cache_diameter / (conditions.get_ref_area() * conditions.get_ref_length())
        mul *= mu.pow4(cgx) + mu.pow4(self.cache_length - cgx)

        for c in compat.active_components(configuration):
            if compat.is_a(c, "FinSet") and not compat.is_a(c, "TubeFinSet"):
                calc = self.calc_map[c]
                midchord_x = compat.to_absolute_x(c, Coordinate(calc.get_midchord_pos()))
                mul += 0.6 * min(int(c.get_fin_count()), 4) * c.get_planform_area() * \
                    mu.pow3(abs(midchord_x - cgx)) / (conditions.get_ref_area() * conditions.get_ref_length())
        return mul

    # ------------------------------------------------------------ calcs
    def build_calc_map(self, configuration) -> None:
        self.calc_map = {}
        for comp in compat.all_components(configuration):
            if not compat.is_aerodynamic(comp) and not compat.is_a(comp, "ComponentAssembly"):
                continue
            self.calc_map[comp] = make_calc(comp)


def _jmax(a: float, b: float) -> float:
    """Math.max: NaN if either is NaN."""
    if math.isnan(a) or math.isnan(b):
        return math.nan
    return a if a >= b else b
