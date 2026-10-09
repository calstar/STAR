"""Layer-1 geometry DOFs: configurable theta, hard geometric constraints, priced diameter.

Each test breaks the thing it guards and asserts the guard fires.
"""
import math
import numpy as np
import pytest

from engine.optimizer.layers.layer1_static_optimization import (
    _layer1_contraction_theta,
    _layer1_geometry_infeasibility,
    _layer1_chamber_mass_kg,
    DEFAULT_CONTRACTION_HALF_ANGLE_DEG,
)
from engine.core.chamber_geometry import (
    chamber_length_calc, contraction_length_horizontal_calc,
)

A_T = 0.0018729167346808366
PC = 2.9648e6


class TestContractionAngle:
    def test_defaults_to_45_when_unset(self):
        for req in ({}, None, {"layer1_contraction_half_angle_deg": None}):
            assert math.degrees(_layer1_contraction_theta(req)) == pytest.approx(
                DEFAULT_CONTRACTION_HALF_ANGLE_DEG)

    def test_config_value_is_honoured(self):
        for deg in (25.0, 30.0, 37.5, 45.0):
            got = math.degrees(_layer1_contraction_theta(
                {"layer1_contraction_half_angle_deg": deg}))
            assert got == pytest.approx(deg)

    def test_garbage_falls_back_rather_than_raising(self):
        for bad in ("banana", float("nan"), float("inf")):
            got = math.degrees(_layer1_contraction_theta(
                {"layer1_contraction_half_angle_deg": bad}))
            assert got == pytest.approx(DEFAULT_CONTRACTION_HALF_ANGLE_DEG)

    def test_angle_actually_changes_the_geometry(self):
        """Not just plumbing -- a different angle must move the chamber."""
        A_c = math.pi / 4 * 0.127 ** 2
        R_t = math.sqrt(A_T / math.pi)
        out = {}
        for deg in (25.0, 45.0):
            th = _layer1_contraction_theta({"layer1_contraction_half_angle_deg": deg})
            out[deg] = (chamber_length_calc(1.0 * A_T, A_T, A_c / A_T, th),
                        contraction_length_horizontal_calc(A_c, R_t, th))
        assert out[25.0] != out[45.0]
        # shallower cone is longer and takes more of the volume
        assert out[25.0][1] > out[45.0][1]
        assert out[25.0][0] < out[45.0][0]


class TestGeometryInfeasibility:
    A_C = math.pi / 4 * 0.127 ** 2

    def test_noop_when_unconfigured(self):
        assert _layer1_geometry_infeasibility(
            {}, L_cylindrical=0.09, D_chamber_inner=0.127,
            A_chamber=self.A_C, n_elements=26) == 0.0

    def test_min_lcyl_over_d_fires_only_when_violated(self):
        ok = _layer1_geometry_infeasibility(
            {"layer1_min_Lcyl_over_D": 0.6}, L_cylindrical=0.09,
            D_chamber_inner=0.127, A_chamber=self.A_C, n_elements=26)
        bad = _layer1_geometry_infeasibility(
            {"layer1_min_Lcyl_over_D": 0.9}, L_cylindrical=0.09,
            D_chamber_inner=0.127, A_chamber=self.A_C, n_elements=26)
        assert ok == 0.0
        assert bad > 0.0

    def test_element_pitch_fires_only_when_violated(self):
        ok = _layer1_geometry_infeasibility(
            {"layer1_max_element_pitch_m": 0.030}, L_cylindrical=0.09,
            D_chamber_inner=0.127, A_chamber=self.A_C, n_elements=26)
        bad = _layer1_geometry_infeasibility(
            {"layer1_max_element_pitch_m": 0.018}, L_cylindrical=0.09,
            D_chamber_inner=0.127, A_chamber=self.A_C, n_elements=26)
        assert ok == 0.0
        assert bad > 0.0

    def test_pitch_worsens_monotonically_with_face_area(self):
        """Spreading a fixed element count over a bigger face must cost more."""
        prev = -1.0
        for D in (0.127, 0.1397, 0.1524, 0.1651):
            v = _layer1_geometry_infeasibility(
                {"layer1_max_element_pitch_m": 0.020}, L_cylindrical=0.09,
                D_chamber_inner=D, A_chamber=math.pi / 4 * D ** 2, n_elements=26)
            assert v > prev
            prev = v


class TestClosureMass:
    def test_closure_is_opt_in(self):
        A_c = math.pi / 4 * 0.127 ** 2
        assert (_layer1_chamber_mass_kg(A_c, 0.15, 0.0381, 2000.0)
                == pytest.approx(_layer1_chamber_mass_kg(A_c, 0.15, 0.0381, 2000.0, Pc_pa=0.0)))

    def test_closure_prices_diameter_at_fixed_lstar(self):
        """Barrel-only keeps rewarding a fatter chamber; the closure must turn it over.

        This is the documented reason a mass penalty was abandoned in Layer 1:
        mass/volume ~ 4t/D, so charging barrel mass alone buys a short fat chamber.
        """
        th = math.radians(45.0)
        R_t = math.sqrt(A_T / math.pi)
        bores = (0.1143, 0.127, 0.1397, 0.1524, 0.1651)
        barrel, full = [], []
        for D in bores:
            A_c = math.pi / 4 * D ** 2
            L = (chamber_length_calc(1.0 * A_T, A_T, A_c / A_T, th)
                 + contraction_length_horizontal_calc(A_c, R_t, th))
            barrel.append(_layer1_chamber_mass_kg(A_c, L, 0.0381, 2000.0))
            full.append(_layer1_chamber_mass_kg(A_c, L, 0.0381, 2000.0, Pc_pa=PC))
        # barrel-only is still falling at the fattest bore -> unbounded preference
        assert barrel[-1] == min(barrel)
        # with the closure the optimum is interior
        assert full.index(min(full)) < len(bores) - 1


class TestConstantsDictPlumbing:
    """constants_dict is curated -- a key absent from it never reaches the worker objective.

    This is how the first wiring attempt failed silently: theta was honoured by
    _layer1_apply_chamber_geometry_to_config (which reads the config) but defaulted to
    45 deg inside the objective, so the optimiser scored a different chamber than it built,
    and layer1_min_Lcyl_over_D was never enforced at all -- Layer 1 returned a design at
    L_cyl/D = 0.337 against a configured floor of 0.55 and called it valid.
    """

    KEYS = ("layer1_contraction_half_angle_deg",
            "layer1_min_Lcyl_over_D",
            "layer1_max_element_pitch_m")

    def test_geometry_keys_are_forwarded_to_constants_dict(self):
        import inspect
        from engine.optimizer.layers import layer1_static_optimization as L1
        src = inspect.getsource(L1)
        start = src.index("constants_dict = {")
        end = src.index("}", src.index("'target_thrust'", start))
        block = src[start:end]
        for k in self.KEYS:
            assert f"'{k}'" in block, (
                f"{k} is missing from constants_dict: the worker objective will "
                f"silently use its default while the applied geometry uses the config value")

    def test_helpers_read_through_a_plain_dict(self):
        """constants_dict is a plain dict; the config object is a pydantic model.

        Both must work -- a bare .get() broke the model path, a bare getattr breaks the dict.
        """
        from engine.optimizer.layers.layer1_static_optimization import (
            _layer1_contraction_theta, _layer1_geometry_infeasibility)
        import math

        class _Model:            # stands in for DesignRequirementsConfig
            layer1_contraction_half_angle_deg = 30.0
            layer1_min_Lcyl_over_D = 0.55
            layer1_max_element_pitch_m = 0.024

        as_dict = {"layer1_contraction_half_angle_deg": 30.0,
                   "layer1_min_Lcyl_over_D": 0.55,
                   "layer1_max_element_pitch_m": 0.024}
        A_c = math.pi / 4 * 0.127 ** 2
        for src in (as_dict, _Model()):
            assert math.degrees(_layer1_contraction_theta(src)) == pytest.approx(30.0)
            # L_cyl/D = 0.337, below the 0.55 floor -> must score infeasible from BOTH shapes
            assert _layer1_geometry_infeasibility(
                src, L_cylindrical=0.0428, D_chamber_inner=0.127,
                A_chamber=A_c, n_elements=27) > 0.0
