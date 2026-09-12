"""The mixture-ratio split: is it exact, and does it blame the right half?

The claim :mod:`feedtwin.engine.balance` makes is unusually strong for a
diagnostic -- not "this correlates with" but "this is identically equal to". So
the tests are correspondingly strict: the identity is checked to machine
precision rather than to a tolerance, and the two terms are checked to be
*independent* in the way the claim requires. A face ratio that moved when the
plumbing changed would make the whole decomposition a lie, and it would be a
comfortable lie -- the numbers would still add up.
"""

from __future__ import annotations

import math

import pytest

from feedtwin.engine.balance import (
    SOFT_STIFFNESS,
    MixtureBalance,
    SideBalance,
    balance_from,
)
from feedtwin.engine.design import DischargeModel, EngineDesign, InjectorSide


def _design(
    *, ox_area: float = 99.245e-6, fuel_area: float = 75.125e-6, mr: float = 1.65
) -> EngineDesign:
    """A two-side engine with nothing in it but the areas that matter here."""
    return EngineDesign(
        name="fixture",
        injector_type="impinging",
        oxidiser=InjectorSide("oxygen", ox_area, 2.2e-3, DischargeModel(), 26),
        fuel=InjectorSide("ethanol", fuel_area, 1.92e-3, DischargeModel(), 26),
        throat_area=1.7e-3,
        design_mixture_ratio=mr,
    )


def _orifice(area: float, cd: float, rho: float, dp: float) -> float:
    return cd * area * math.sqrt(2.0 * rho * dp)


def _balance(
    *,
    dp_ox: float,
    dp_fuel: float,
    cd: float = 0.6,
    pc: float = 2.0e6,
    rho_ox: float = 1140.0,
    rho_fuel: float = 789.0,
    design: EngineDesign | None = None,
) -> MixtureBalance:
    """A balance built from flows that genuinely obey the orifice law."""
    design = design or _design()
    return balance_from(
        design,
        mdot_oxidiser=_orifice(design.oxidiser.area, cd, rho_ox, dp_ox),
        mdot_fuel=_orifice(design.fuel.area, cd, rho_fuel, dp_fuel),
        density_oxidiser=rho_ox,
        density_fuel=rho_fuel,
        injector_dp_oxidiser=dp_ox,
        injector_dp_fuel=dp_fuel,
        chamber_pressure=pc,
    )


# ------------------------------------------------------------- the identity


@pytest.mark.parametrize(
    ("dp_ox", "dp_fuel"),
    [(3.0e5, 3.0e5), (3.6e5, 1.9e5), (1.0e5, 9.0e5), (5.0e4, 5.1e4)],
)
def test_identity_is_exact(dp_ox: float, dp_fuel: float) -> None:
    """``O/F == face_ratio * feed_term``, to floating point and no further.

    This is the whole basis of the decomposition. A tolerance here would hide
    exactly the algebra slip the test exists to catch, so it is checked at
    1e-12 relative -- the residual on real solves comes out at 1e-16.
    """
    balance = _balance(dp_ox=dp_ox, dp_fuel=dp_fuel)
    assert balance.residual < 1e-12
    assert balance.face_ratio * balance.feed_term == pytest.approx(
        balance.mixture_ratio, rel=1e-12
    )


def test_face_ratio_does_not_move_with_the_plumbing() -> None:
    """Change only the pressure split; the face term must not budge.

    The independence claim. If the face ratio drifted with the feed system, the
    split would still sum correctly and would no longer localise the fault --
    which is the only reason to compute it.
    """
    balanced = _balance(dp_ox=3.0e5, dp_fuel=3.0e5)
    lopsided = _balance(dp_ox=6.0e5, dp_fuel=1.0e5)
    assert lopsided.face_ratio == pytest.approx(balanced.face_ratio, rel=1e-12)
    assert lopsided.mixture_ratio > balanced.mixture_ratio


def test_equal_drop_is_the_face_ratio() -> None:
    """With both legs at the same drop, the stand contributes exactly nothing."""
    balance = _balance(dp_ox=4.0e5, dp_fuel=4.0e5)
    assert balance.feed_term == pytest.approx(1.0, rel=1e-12)
    assert balance.mixture_ratio == pytest.approx(balance.face_ratio, rel=1e-12)


def test_face_ratio_matches_its_closed_form() -> None:
    """``Cd A sqrt(rho)`` on each side, computed independently."""
    design = _design()
    balance = _balance(dp_ox=2.5e5, dp_fuel=2.5e5, design=design)
    expected = (
        design.oxidiser.area * math.sqrt(1140.0) / (design.fuel.area * math.sqrt(789.0))
    )
    assert balance.face_ratio == pytest.approx(expected, rel=1e-12)


def test_symmetric_injector_on_one_propellant_is_unity() -> None:
    """Same area, same fluid, same drop -- there is nowhere for a ratio to come
    from, and a decomposition that produced one would be inventing it."""
    design = _design(ox_area=50e-6, fuel_area=50e-6)
    balance = _balance(
        dp_ox=3.0e5, dp_fuel=3.0e5, rho_ox=1000.0, rho_fuel=1000.0, design=design
    )
    assert balance.face_ratio == pytest.approx(1.0, rel=1e-12)
    assert balance.mixture_ratio == pytest.approx(1.0, rel=1e-12)


# --------------------------------------------------------------- stiffness


def test_stiffness_is_the_share_of_chamber_pressure() -> None:
    side = SideBalance("oxygen", 1.0, 1140.0, 1e-4, 0.6, injector_dp=4.0e5)
    assert side.stiffness(2.0e6) == pytest.approx(0.20)
    assert side.stiffness(0.0) == 0.0


def test_feed_loss_never_goes_negative() -> None:
    """A supply below the chamber is a nonsense operating point, not a negative
    loss that would read as the plumbing adding pressure."""
    side = SideBalance(
        "oxygen", 1.0, 1140.0, 1e-4, 0.6, injector_dp=4.0e5, supply_pressure=1.0e6
    )
    assert side.feed_loss(2.0e6) == 0.0
    assert side.feed_loss(1.0e6) == 0.0


def test_soft_leg_is_reported_and_stiff_one_is_not() -> None:
    stiff = _balance(dp_ox=6.0e5, dp_fuel=6.0e5, pc=2.0e6)
    assert all("stiffness" not in note for note in stiff.notes())

    soft = _balance(dp_ox=1.0e5, dp_fuel=1.0e5, pc=2.0e6)
    notes = " ".join(soft.notes())
    assert "stiffness" in notes
    assert f"{SOFT_STIFFNESS * 100:.0f}%" in notes


def test_notes_blame_the_face_when_the_face_is_wrong() -> None:
    """A face drilled off-design at a perfectly balanced stand must not be
    reported as a plumbing problem -- that sends the wrong person to work."""
    design = _design(ox_area=140e-6, fuel_area=75.125e-6)
    balance = _balance(dp_ox=5.0e5, dp_fuel=5.0e5, design=design, pc=2.0e6)
    note = next(n for n in balance.notes() if "O/F is" in n)
    assert "injector face itself" in note


def test_notes_blame_the_stand_when_the_face_is_right() -> None:
    design = _design(mr=1.61)
    balance = _balance(dp_ox=7.2e5, dp_fuel=2.0e5, design=design, pc=2.0e6)
    note = next(n for n in balance.notes() if "O/F is" in n)
    assert "feed system, not the face" in note


# ------------------------------------------------------------------- trim


def test_trim_pressure_lands_on_the_design_ratio() -> None:
    """Apply the recommended fuel-side drop and the O/F must come out right.

    Checked by rebuilding the balance at the trimmed drop rather than by
    re-deriving the formula, so an algebra error in :meth:`trim_pressure`
    cannot be reproduced by the test that is supposed to catch it.
    """
    design = _design(mr=1.65)
    balance = _balance(dp_ox=3.6e5, dp_fuel=1.9e5, design=design)
    trimmed = _balance(
        dp_ox=3.6e5,
        dp_fuel=balance.fuel.injector_dp + balance.trim_pressure(),
        design=design,
    )
    assert trimmed.mixture_ratio == pytest.approx(1.65, rel=1e-9)


def test_trim_is_zero_when_already_on_design() -> None:
    design = _design(mr=1.65)
    balance = _balance(dp_ox=3.6e5, dp_fuel=1.9e5, design=design)
    on_design = _balance(
        dp_ox=3.6e5,
        dp_fuel=balance.fuel.injector_dp + balance.trim_pressure(),
        design=design,
    )
    assert on_design.trim_pressure() == pytest.approx(0.0, abs=1.0)


# ---------------------------------------------------------------- degenerate


def test_a_dead_leg_does_not_raise() -> None:
    """Zero fuel flow is a real state during an ox lead. It must report zero
    rather than divide, because the start transient is sampled through it."""
    design = _design()
    balance = balance_from(
        design,
        mdot_oxidiser=1.0,
        mdot_fuel=0.0,
        density_oxidiser=1140.0,
        density_fuel=789.0,
        injector_dp_oxidiser=4.0e5,
        injector_dp_fuel=0.0,
        chamber_pressure=1.0e6,
    )
    assert balance.mixture_ratio == 0.0
    assert balance.feed_term == 0.0
    assert balance.residual == 0.0


# ------------------------------------------------ the engine's own band


def _banded(ox: tuple[float, float], fuel: tuple[float, float]) -> EngineDesign:
    base = _design()
    from dataclasses import replace

    return replace(
        base,
        oxidiser=replace(base.oxidiser, stiffness_band=ox),
        fuel=replace(base.fuel, stiffness_band=fuel),
    )


def test_the_configs_band_is_used_over_the_rule_of_thumb() -> None:
    """EngineDesign states injector_dp_ratio_{O,F}_min in its own config. That
    is what the optimiser was constrained by; the 20% rule is only the fallback
    for a config that says nothing."""
    design = _banded((0.25, 0.35), (0.25, 0.35))
    # 22% -- fine under the rule of thumb, short of what this engine wanted.
    balance = _balance(dp_ox=4.4e5, dp_fuel=4.4e5, pc=2.0e6, design=design)
    assert balance.oxidiser.stiffness(2.0e6) == pytest.approx(0.22)
    note = next(n for n in balance.notes() if "oxidiser leg is soft" in n)
    assert "25-35% this engine was designed to" in note


def test_the_rule_of_thumb_is_named_as_such_when_there_is_no_band() -> None:
    balance = _balance(dp_ox=1.0e5, dp_fuel=1.0e5, pc=2.0e6)
    note = next(n for n in balance.notes() if "leg is soft" in n or "metering" in n)
    assert "rule of thumb" in note


def test_a_leg_inside_its_band_draws_no_comment() -> None:
    design = _banded((0.20, 0.30), (0.20, 0.30))
    balance = _balance(dp_ox=5.0e5, dp_fuel=5.0e5, pc=2.0e6, design=design)
    assert not any("stiffness" in n for n in balance.notes())


def test_too_stiff_is_reported_too() -> None:
    """The band has an upper bound and the rule of thumb does not. Past it the
    injector is spending tank pressure the design did not mean to spend."""
    design = _banded((0.20, 0.30), (0.20, 0.30))
    balance = _balance(dp_ox=8.0e5, dp_fuel=8.0e5, pc=2.0e6, design=design)
    note = next(n for n in balance.notes() if "oxidiser" in n)
    assert "stiffer than designed" in note


def test_a_band_is_read_off_the_real_config() -> None:
    """The end-to-end claim: this number comes out of EngineDesign's own file."""
    from pathlib import Path

    from feedtwin.engine.importer import load_engine

    config = (
        Path(__file__).resolve().parents[3]
        / "EngineDesign"
        / "configs"
        / "ethalox_doublet_7000N.yaml"
    )
    if not config.exists():
        pytest.skip("the ethalox config is not present")
    design = load_engine(config)
    assert design.oxidiser.stiffness_band == (0.2, 0.3)
    assert design.fuel.stiffness_band == (0.2, 0.3)
