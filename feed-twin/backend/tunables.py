"""Every number the twin assumes, named, explained, and dialled from one place.

A simulator earns trust by saying what it assumed. The constants that used to
live at the top of ``session.py`` -- how full a tank loads, what gamma bounds a
charge, how fine the coupling steps, when a note calls a wall "warm" -- are
now fields of :class:`backend.session.Setup`, and this table is what the
Configuration tab renders: one row per knob, with the physics it stands in
for, its unit, its bounds, and whether the running stand picks it up at once
or on the next Reset. The values are still estimates; this is where an
operator with a measurement puts the better number.
"""

from __future__ import annotations

from dataclasses import dataclass, fields, replace
from typing import Any, Mapping

from backend.session import Setup


@dataclass(frozen=True)
class Tunable:
    key: str
    """Name on the wire (what the client sends and the setup echo carries)."""
    field: str
    """Attribute on :class:`Setup`."""
    label: str
    unit: str
    group: str
    explains: str
    """What the number accounts for, and where it came from."""
    kind: str = "number"  # "number" | "flag"
    low: float = 0.0
    high: float = 1.0e9
    step: float = 1.0
    applies: str = "live"  # "live" | "reset"


GROUPS = [
    "Cart and regulators",
    "Loading",
    "Tank thermal",
    "Pressurant",
    "Sequence and notes",
    "Vessel walls",
    "Numerics",
]

TUNABLES: tuple[Tunable, ...] = (
    # --- cart and regulators (the GSE tab's knobs, repeated here) ---------
    Tunable(
        "ignore_gse",
        "ignore_gse",
        "Ignore the drawn GSE",
        "",
        GROUPS[0],
        "On: the cart drawn on the GSE page is not simulated, except its vent lines, "
        "which stay plugged into the rocket until the last moment before launch: a "
        "tank still vents through the cart's vent valve. The stand is built from the "
        "rocket and those vents, its other disconnects capped, and the fills are the simple "
        "built-in ones at the GSE Controls settings: GN2 High Press charges the COPV "
        "to the COPV fill knob over the COPV charge time, Fuel Fill pours the fuel "
        "load, Ox Fill loads LOX from the LOX dewar pressure, and the dome knob sets "
        "the tank regulator's dome directly. Off (the default) simulates the GSE as "
        "drawn. Changing it opens a fresh stand. A drawing with no GSE page is the "
        "same either way.",
        kind="flag",
        applies="reset",
    ),
    Tunable(
        "dome",
        "dome_psi",
        "Dome control regulator",
        "psig",
        GROUPS[0],
        "What the hand-loaded dome regulator is set to. The 1092-50 tank regulator "
        "locks up at this + its 50 psi bias - its supply effect x the COPV: 500 here "
        "with 4,500 psig behind it at 17 psi per 1000 is 473.5 psig in the tanks, "
        "climbing as the bottle falls.",
        low=0.0,
        high=6000.0,
        step=5.0,
    ),
    Tunable(
        "copv_target",
        "copv_target_psi",
        "GSE high press regulator",
        "psig",
        GROUPS[0],
        "What the cart charges the COPV to during GN2 High Press.",
        low=100.0,
        high=10000.0,
        step=50.0,
    ),
    Tunable(
        "copv_fill_s",
        "copv_fill_s",
        "COPV charge time",
        "s",
        GROUPS[0],
        "Seconds from empty to the high-press setting while the fill valve is open. "
        "9.7 s is fitted to the 12 Sep pulse fill (daq_20260912_204917, 183 psi RMS; "
        "the operator's 25 s was 1,489 psi RMS). The cart is not on the drawing, so "
        "this is a rate rather than a solved flow, and it holds only with the GSE "
        "bank well above the bottle.",
        low=1.0,
        high=3600.0,
        step=5.0,
    ),
    Tunable(
        "regulator_compressible_seat",
        "regulator_compressible_seat",
        "Regulator seat: compressible",
        "",
        GROUPS[0],
        "On: a wide-open dome regulator passes gas the way IEC 60534-2-1 says a "
        "valve of its Cv does -- with the expansion factor Y = 1 - x/(3 F_gamma xT) "
        "and choking once the drop passes F_gamma xT of the inlet. On by default. "
        "Off: the seat is the incompressible Cv law at the inlet density (what "
        "the benchmark study is stated at), which overstates a GN2 regulator's "
        "wide-open capacity by ~25 % near burnout (0.398 vs 0.319 kg/s) and by up "
        "to 1.5x choked. Only a saturated regulator is affected; on helium at the "
        "hot-fire flows it regulates and nothing changes.",
        kind="flag",
    ),
    Tunable(
        "regulator_xT",
        "regulator_xT",
        "Regulator seat xT",
        "",
        GROUPS[0],
        "Pressure-differential ratio factor of the regulator seat at choked flow "
        "(IEC 60534-2-1): the gas chokes at x = (gamma/1.40) xT. 0.70 is the "
        "standard's typical value, assumed -- the 1092's is not published. Read "
        "only with the compressible seat on; an xT on the drawing wins.",
        low=0.1,
        high=1.0,
        step=0.01,
    ),
    Tunable(
        "bottle_delivered",
        "bottle_delivered",
        "Bottle arrives full",
        "",
        GROUPS[0],
        "On: the COPV starts at its drawing pressure, cold, like a supplier's "
        "cylinder filled hours ago. Off: it starts empty and GN2 High Press charges "
        "it from the cart.",
        kind="flag",
        applies="reset",
    ),
    # --- loading ----------------------------------------------------------
    Tunable(
        "fuel_fill_s",
        "fuel_fill_s",
        "Fuel load time",
        "s",
        GROUPS[1],
        "Seconds to pour the fuel tank to its full fraction. About 15 s on the stand "
        "(operator); nothing to chill, so nothing slows it.",
        low=1.0,
        high=3600.0,
        step=5.0,
    ),
    Tunable(
        "load_chill_s",
        "load_chill_s",
        "LOX chilldown time",
        "s",
        GROUPS[1],
        "Seconds the LOX load spends chilling a room-temperature tank before any "
        "liquid stays in it. What is poured flashes on the warm wall and vents; on "
        "the stand that is about ten minutes of pouring (operator), compressed here "
        "so it can be watched. 0: liquid collects from the start and the wall chills "
        "as it goes. Only with the dewar pressure at 0; a dewar chills in real time.",
        low=0.0,
        high=3600.0,
        step=5.0,
    ),
    Tunable(
        "tank_fill_s",
        "tank_fill_s",
        "LOX load time",
        "s",
        GROUPS[1],
        "Seconds for the dewar transfer to reach the full fraction once the tank is "
        "chilled. The wall is near saturation by then; what heat it still has boils "
        "LOX, which the vent has to carry. Only with the dewar pressure at 0; with a "
        "dewar, the load takes as long as its line delivers.",
        low=1.0,
        high=3600.0,
        step=10.0,
    ),
    Tunable(
        "dewar_psi",
        "dewar_psi",
        "LOX dewar pressure",
        "psig",
        GROUPS[1],
        "What pushes the LOX load in: ~100 psig on the stand (operator). The load "
        "is the dewar less the tank, through the fill line. While the wall is warm "
        "everything that arrives boils into the ullage, so the tank climbs until the "
        "vent carries what the dewar sends, more the faster it pours; once the wall "
        "is at saturation the liquid collects. 0: the fixed-rate load and chill "
        "time above.",
        low=0.0,
        high=500.0,
        step=5.0,
    ),
    Tunable(
        "dewar_fill_cv",
        "dewar_fill_cv",
        "Dewar valve Cv",
        "Cv",
        GROUPS[1],
        "Everything on the fill line that is not tube: the dewar's liquid valve, the "
        "LOX Fill valve, the disconnect -- in practice how far the dewar valve is "
        "open. The stand tops out near 30 psig during the chill and takes ~10 min "
        "(operator). LE4 (6) as drawn: 0.019 peaks at 57 psig and chills in 5.3 "
        "min; 0.013 at 38 psig and 6.9 min. 'skip' on the tank card skips the "
        "chill. A clean 3/8 in line pours ~0.7 kg/s, all of which boils on a warm "
        "wall, and the tank rides up to the dewar.",
        low=0.0,
        high=10.0,
        step=0.001,
    ),
    Tunable(
        "dewar_line_bore_mm",
        "dewar_line_bore_mm",
        "Dewar line bore",
        "mm",
        GROUPS[1],
        "3/8 in tube, 0.035 in wall (operator: 3/8 in lines for now).",
        low=1.0,
        high=50.0,
        step=0.05,
    ),
    Tunable(
        "dewar_line_length_m",
        "dewar_line_length_m",
        "Dewar line length",
        "m",
        GROUPS[1],
        "Hose from the dewar to the tank's fill disconnect. Estimated; measure it.",
        low=0.0,
        high=100.0,
        step=0.5,
    ),
    Tunable(
        "gse_vent_cv",
        "gse_vent_cv",
        "Cart vent valve Cv",
        "Cv",
        GROUPS[1],
        "The cart's vent valve, ~0.5 (operator). Sizes a tank vent the drawing leaves "
        "to the GSE (a capped disconnect on the tank top, LE4's QD_OVA and QD_FVA) "
        "when the disconnect carries no Cv or Cd of its own. Sets how high a LOX load "
        "pushes the tank.",
        low=0.01,
        high=20.0,
        step=0.05,
    ),
    Tunable(
        "full_fraction",
        "full_fraction",
        "Full fraction",
        "",
        GROUPS[1],
        "Liquid volume fraction a load stops at; the rest is ullage. 0.95 is the 5 % "
        "ullage the fuel tank was sized with (6.5 kg of ethanol + 5 %).",
        low=0.5,
        high=0.99,
        step=0.01,
    ),
    # --- tank thermal -----------------------------------------------------
    Tunable(
        "ambient_leak",
        "ambient_leak",
        "Air film on the tank skin",
        "W/(m²·K)",
        GROUPS[2],
        "Natural convection from still air onto a cold surface, in series with the "
        "insulation the drawing declares (an inch of fiberglass on the LOX tank). "
        "8 is still air; the RTD on the tank and the vent's hiss say what it really is. "
        "Sets the heat leak that boils LOX with the vent shut.",
        low=0.0,
        high=1000.0,
        step=1.0,
    ),
    Tunable(
        "ambient_T",
        "ambient_T",
        "Ambient temperature",
        "K",
        GROUPS[2],
        "The air around the stand: what the leak flows down from and what an "
        "empty tank's wall starts at.",
        low=200.0,
        high=330.0,
        step=1.0,
    ),
    Tunable(
        "chilldown",
        "chilldown",
        "Wall to liquid, film boiling",
        "W/(m²·K)",
        GROUPS[2],
        "Liquid-to-wall conductance while the wall is far above saturation and a "
        "vapour film insulates it (film boiling). 50-200 for a cryogen on bare metal. "
        "This is what chills a warm tank at the start of a load. Zero disables chilldown.",
        low=0.0,
        high=5000.0,
        step=10.0,
    ),
    Tunable(
        "chilldown_nucleate",
        "chilldown_nucleate",
        "Wall to liquid, nucleate boiling",
        "W/(m²·K)",
        GROUPS[2],
        "Conductance once the wall superheat has fallen below the Leidenfrost point "
        "and the liquid wets the metal: bubbles, not a film. Thousands, against ~100 "
        "in film boiling. This is why the last of a chilldown is fast, and why a tank "
        "loaded over two minutes is cold when the vent shuts. Zero: one regime only.",
        low=0.0,
        high=50000.0,
        step=100.0,
    ),
    Tunable(
        "leidenfrost_K",
        "leidenfrost_K",
        "Leidenfrost superheat",
        "K",
        GROUPS[2],
        "Wall temperature above saturation at which boiling changes from a vapour "
        "film to wetted nucleate boiling. ~30-50 K for LN2 and LOX on metal "
        "(estimated from cryogen boiling curves).",
        low=1.0,
        high=200.0,
        step=1.0,
    ),
    Tunable(
        "boiling_onset_K",
        "boiling_onset_K",
        "Boiling onset superheat",
        "K",
        GROUPS[2],
        "Wall superheat above saturation before the wetted wall boils the liquid it "
        "touches instead of warming it. A chilled wall under a 75 W leak sits a "
        "fraction of a kelvin above saturation: below this it does not boil, and the "
        "heat rides up the wall to the surface layer. A few kelvin is nucleate-boiling "
        "incipience for a cryogen on smooth metal (estimated).",
        low=0.0,
        high=50.0,
        step=0.5,
    ),
    Tunable(
        "stratification",
        "stratification",
        "Surface layer (stratification)",
        "",
        GROUPS[2],
        "Track the liquid surface apart from the bulk. A quiescent cryogen "
        "stratifies: leak heat rides up the wall in a boundary layer and pools at "
        "the top, so the vapour pressure follows the warm surface while the bulk "
        "stays cold. This is what makes a shut LOX tank climb at tens of psi a "
        "minute rather than boiling the whole leak (~100 psi/min) or warming all "
        "of it (~0.3 psi/min).",
        kind="flag",
    ),
    Tunable(
        "surface_layer_m",
        "surface_layer_m",
        "Surface layer thickness",
        "m",
        GROUPS[2],
        "How deep the warm layer at the top is. Sets its heat capacity and therefore "
        "the climb rate of a shut tank: 1 cm on a 6 in bore is ~0.2 kg of LOX, ~15 "
        "psi/min under a 75 W leak; 2 cm halves that. A thermal boundary layer of "
        "order sqrt(alpha t) -- millimetres to centimetres (estimated; the tank's own "
        "pressure trace with the vent shut calibrates it).",
        low=0.001,
        high=0.2,
        step=0.001,
    ),
    Tunable(
        "surface_mixing",
        "surface_mixing",
        "Layer-to-bulk mixing",
        "W/(m²·K)",
        GROUPS[2],
        "Conductance from the surface layer down into the bulk: conduction plus "
        "whatever the liquid is doing. Small for a still tank (LOX conducts at 0.15 "
        "W/m·K); sloshing or a running main mixes far harder.",
        low=0.0,
        high=1000.0,
        step=1.0,
    ),
    Tunable(
        "ullage_collapse",
        "ullage_collapse",
        "Ullage collapse",
        "",
        GROUPS[2],
        "Heat from warm pressurant into the liquid surface. Real; it is why a "
        "pressed tank droops on a long hold.",
        kind="flag",
    ),
    Tunable(
        "ullage_vapour",
        "ullage_vapour",
        "Propellant vapour",
        "",
        GROUPS[2],
        "Boil-off and condensation of the propellant in the ullage. Without it a LOX "
        "tank cannot climb with its vent shut.",
        kind="flag",
    ),
    Tunable(
        "wall_boiling",
        "wall_boiling",
        "Boiling at the wall",
        "",
        GROUPS[2],
        "A wetted wall above saturation at the tank's total pressure boils the "
        "liquid it touches straight into the ullage rather than warming the bulk. "
        "Needs propellant vapour on.",
        kind="flag",
    ),
    Tunable(
        "cryogen_ullage_wall_T0_K",
        "cryogen_ullage_wall_T0_K",
        "LOX tank upper wall at T-0",
        "K",
        GROUPS[2],
        "Temperature of a cryogen tank's upper (ullage) wall for a stand primed "
        "straight to T-0, the state EngineDesign's Layer X burns from. 0 (the "
        "default) leaves it at the pressurant's 293 K, as freshly pressed. A LOX "
        "tank that has held its load has a cold upper shell: at 150 K the wall "
        "takes heat from the warm pressurant, the tank sags ~13 psi in the "
        "lead-in and the helium burn draws ~225 psi more bottle (estimated, "
        "EngineDesign/docs/layerx/AUDIT.md D1). Unmeasured: an RTD on the upper "
        "shell would settle it. This console loads and presses through the "
        "sequence, so its walls follow what it did and this changes nothing here; "
        "the Study tab burns at its benchmark settings and does not read it.",
        low=0.0,
        high=330.0,
        step=1.0,
        applies="reset",
    ),
    Tunable(
        "line_walls",
        "line_walls",
        "Line walls",
        "",
        GROUPS[2],
        "The press lines' own metal warms the pressurant on its way to the tanks; "
        "worth ~50 psi of tank pressure late in a nitrogen burn. Needs wall_thickness "
        "or fitting_mass on the drawing's lines.",
        kind="flag",
    ),
    # --- pressurant -------------------------------------------------------
    Tunable(
        "fill_supply_T",
        "fill_supply_T",
        "Cart gas temperature",
        "K",
        GROUPS[3],
        "Temperature of the GN2 arriving from the cart's bank during a charge. The "
        "bottle heats by adiabatic compression from here.",
        low=200.0,
        high=330.0,
        step=1.0,
    ),
    Tunable(
        "fill_stirring",
        "fill_stirring",
        "Charge stirring",
        "× still hA",
        GROUPS[3],
        "Multiplier on gas-to-wall conductance while a vessel is being charged: the "
        "jet stirs it and forced convection runs several times natural. 1 is a still "
        "vessel and the full adiabatic-charge heating; 20 lands a 25 s COPV fill at "
        "336 K over a 316 K wall. To be calibrated from the bottle RTD.",
        low=1.0,
        high=100.0,
        step=1.0,
    ),
    Tunable(
        "charge_gamma",
        "charge_gamma",
        "Charge heating gamma",
        "",
        GROUPS[3],
        "Ratio of specific heats used to bound how hot arriving gas leaves an ullage "
        "on the step that crosses lockup, so a small ullage lands on its supply "
        "instead of past it. 1.67 (monatomic) is the conservative bound for GN2 or He.",
        low=1.0,
        high=1.7,
        step=0.01,
    ),
    Tunable(
        "supply_band",
        "supply_band",
        "Supply clamp band",
        "fraction",
        GROUPS[3],
        "How far above its supply pressure a tank may sit before it refuses gas. "
        "0.005 is the same half percent the regulator uses to decide it has shut.",
        low=0.0,
        high=0.1,
        step=0.001,
    ),
    Tunable(
        "stir_band",
        "stir_band",
        "Charge-jet threshold",
        "fraction",
        GROUPS[3],
        "A tank counts as being charged (and its ullage as stirred) only while the "
        "supply is this fraction above it. Below that the manifold is just trading "
        "grams between tanks at lockup.",
        low=0.0,
        high=0.5,
        step=0.01,
    ),
    # --- sequence and notes -----------------------------------------------
    Tunable(
        "auto_vent",
        "auto_vent",
        "Vent at burnout",
        "",
        GROUPS[4],
        "When a tank runs dry during Fire the sequence goes to Vent on its own, as the "
        "stand's fire timer does, so the tanks and the regulated manifold dump rather "
        "than sitting at lockup. Off: Fire holds until the operator moves.",
        kind="flag",
    ),
    Tunable(
        "valve_travel_s",
        "valve_travel_s",
        "Valve travel time",
        "s",
        GROUPS[4],
        "Shut-to-open time for an actuator the drawing gives none for. Positions slew "
        "rather than step, so a main valve is not a step input into half a litre of "
        "ullage.",
        low=0.001,
        high=5.0,
        step=0.01,
        applies="reset",
    ),
    Tunable(
        "low_tank",
        "low_tank",
        "Low-tank note",
        "fraction",
        GROUPS[4],
        "Fill fraction below which the notes say a tank is running low.",
        low=0.0,
        high=1.0,
        step=0.01,
    ),
    Tunable(
        "warm_wall_K",
        "warm_wall_K",
        "Warm-wall note",
        "K",
        GROUPS[4],
        "Wetted wall this far above its liquid is still chilling and will boil the "
        "tank hard if shut; the notes and the pad guide wait for it.",
        low=1.0,
        high=200.0,
        step=1.0,
    ),
    Tunable(
        "hot_bottle_K",
        "hot_bottle_K",
        "Hot-bottle note",
        "K",
        GROUPS[4],
        "Gas this much hotter than the bottle's wall is still settling from the "
        "charge and will sag as it cools; the note says so before someone hunts a leak.",
        low=1.0,
        high=200.0,
        step=1.0,
    ),
    # --- vessel walls (built once) ----------------------------------------
    Tunable(
        "tank_wall_kg_per_L",
        "tank_wall_kg_per_L",
        "Tank wall mass per litre",
        "kg/L",
        GROUPS[5],
        "Wall mass of a tank that does not declare wall_mass on the drawing: "
        "8 kg at 17.5 L for an aluminium tank, scaled by volume. Sets how much heat "
        "the wall holds when LOX arrives, hence how much boils to chill it.",
        low=0.05,
        high=5.0,
        step=0.05,
        applies="reset",
    ),
    Tunable(
        "tank_wall_capacity",
        "tank_wall_capacity",
        "Tank wall specific heat",
        "J/(kg·K)",
        GROUPS[5],
        "900 is aluminium; 500 is steel.",
        low=100.0,
        high=2000.0,
        step=10.0,
        applies="reset",
    ),
    Tunable(
        "tank_wall_hA",
        "tank_wall_hA",
        "Tank ullage-to-wall hA",
        "W/K at 17.5 L",
        GROUPS[5],
        "Still-gas conductance between the ullage and its wall for a tank that declares "
        "none; scaled as V^(2/3). What fights the ullage cooling during a blowdown.",
        low=0.1,
        high=500.0,
        step=1.0,
        applies="reset",
    ),
    Tunable(
        "wall_hA_from_gas",
        "wall_hA_from_gas",
        "Wall hA from the gas",
        "",
        GROUPS[5],
        "Estimate a vessel's gas-to-wall conductance from its ullage gas and its "
        "size (Churchill–Chu natural convection) when the drawing leaves it blank, "
        "instead of the per-litre default. A value on the drawing always wins.",
        kind="flag",
        applies="reset",
    ),
    Tunable(
        "ullage_wall_by_level",
        "ullage_wall_by_level",
        "Ullage meets the dry wall only",
        "",
        GROUPS[5],
        "Scale a tank's ullage-to-wall conductance by the share of the wall above "
        "the liquid. Off, a 95 % full LOX tank's ullage cooled against the whole "
        "cold tank and a fresh press sagged 548 to 260 psig in six seconds of Ready.",
        kind="flag",
        applies="live",
    ),
    Tunable(
        "wall_hA_dT",
        "wall_hA_dT",
        "Film ΔT for the estimate",
        "K",
        GROUPS[5],
        "Gas-to-wall difference the still-gas film is evaluated at. Natural "
        "convection stiffens roughly as ΔT^(1/4); ten kelvin is a blowdown in progress.",
        low=1.0,
        high=100.0,
        step=1.0,
        applies="reset",
    ),
    Tunable(
        "burst_safety_factor",
        "burst_safety_factor",
        "Burst safety factor",
        "×",
        GROUPS[5],
        "A vessel trips the stand at its drawn burst pressure divided by this. Two "
        "is the factor the team designs to. A drawing still carrying an MAWP trips "
        "at that instead.",
        low=1.0,
        high=10.0,
        step=0.1,
        applies="reset",
    ),
    Tunable(
        "bottle_wall_kg_per_L",
        "bottle_wall_kg_per_L",
        "Bottle wall mass per litre",
        "kg/L",
        GROUPS[5],
        "Wall mass of a bottle that declares none: 60 kg at 44 L for a steel K-bottle. "
        "The shipped COPV declares its own 3.5 kg, so this only matters for a drawing "
        "that does not.",
        low=0.05,
        high=5.0,
        step=0.05,
        applies="reset",
    ),
    Tunable(
        "bottle_wall_hA",
        "bottle_wall_hA",
        "Bottle gas-to-wall hA",
        "W/K at 4.687 L",
        GROUPS[5],
        "Still-gas conductance in a bottle that declares none; scaled as V^(2/3).",
        low=0.1,
        high=500.0,
        step=1.0,
        applies="reset",
    ),
    Tunable(
        "bottle_volume_L",
        "bottle_volume_L",
        "Bottle volume",
        "L",
        GROUPS[5],
        "Water volume of a bottle the drawing gives none: the stand's 45 scf SCBA "
        "COPV -- 52.8 mol of free air, Z 1.1145 at 4500 psi, 4.64 L plus 3 in^3 of "
        "fittings. A volume on the drawing wins.",
        low=0.5,
        high=60.0,
        step=0.01,
        applies="reset",
    ),
    # --- numerics ---------------------------------------------------------
    Tunable(
        "live_step",
        "live_step",
        "Outer step",
        "s",
        GROUPS[6],
        "A panel tick is integrated as ceil(tick / this) steps, so the console runs on "
        "the Study's grid. Smaller is slower and no more accurate below the coupling "
        "rules; larger lets a fast press alias.",
        low=0.002,
        high=0.25,
        step=0.005,
    ),
    Tunable(
        "max_iterations",
        "max_iterations",
        "Newton iterations",
        "",
        GROUPS[6],
        "Cap on network-solve iterations per step. 120 is the Study's; a solve that "
        "has not closed hands back the last good state (a 'failed tick').",
        low=5,
        high=500,
        step=5,
    ),
    Tunable(
        "max_coupled_change",
        "max_coupled_change",
        "Coupling: pressure rule",
        "fraction",
        GROUPS[6],
        "No coupling step may move a vessel pressure by more than this fraction, "
        "sized from the previous tick's motion.",
        low=0.005,
        high=0.5,
        step=0.005,
    ),
    Tunable(
        "coupling_safety",
        "coupling_safety",
        "Coupling: RC safety",
        "× C·R",
        GROUPS[6],
        "Coupling step as a multiple of the regulator-ullage time constant C·R. Swept: "
        "flat to 2, visibly rough by 4. 1 is one tau per step.",
        low=0.1,
        high=4.0,
        step=0.1,
    ),
    Tunable(
        "body_acceleration",
        "body_acceleration",
        "Liquid-column acceleration",
        "m/s²",
        GROUPS[1],
        "What every liquid column (tank heads, line climbs) is multiplied by: rho * a * dz. "
        "Standard gravity on the stand. In flight it is thrust less drag over mass, which "
        "EngineDesign's Layer X sets each step from its flight solve (~10 g at burnout on LE4).",
        low=0.0,
        high=200.0,
        step=0.1,
    ),
    Tunable(
        "chamber_tolerance_psi",
        "chamber_tolerance_psi",
        "Chamber closure tolerance",
        "psi",
        GROUPS[6],
        "How closely the chamber pressure is solved against the flows each coupling "
        "step. 0.5 psi is the benchmarked setting; EngineDesign's Layer X runs 0.02 so "
        "the closure is finer than its engine card.",
        low=0.001,
        high=5.0,
        step=0.01,
    ),
    Tunable(
        "network_tolerance",
        "network_tolerance",
        "Network solve tolerance",
        "",
        GROUPS[6],
        "Scaled residual the network solve must reach each step. Branches are judged "
        "against the bottle pressure, so 1e-4 (the console's and the Study's) is ~3 kPa "
        "on a full COPV and leaves an injector drop a few tenths of a percent off.",
        low=1.0e-8,
        high=1.0e-3,
        step=1.0e-6,
    ),
    Tunable(
        "ground_rests",
        "ground_rests",
        "Simplified GSE",
        "",
        GROUPS[6],
        "On (the default): a cart vessel is integrated only while something flows in or "
        "out of it, and while the engine burns, the cart the vehicle has no open path to "
        "is left out of the solve -- the burn is the vehicle-only drawing's, number for "
        "number, at a fraction of the cost. Off integrates every cart vessel's wall, "
        "vapour and leak every step. Only a drawing with its GSE drawn has a cart.",
        kind="flag",
    ),
    Tunable(
        "max_mass_step",
        "max_mass_step",
        "Coupling: mass rule",
        "fraction",
        GROUPS[6],
        "No coupling step may move more than this fraction of an ullage's mass, from "
        "the last solve's flows. The RC rule uses the regulator's droop slope, which is "
        "its stiffness near lockup; wide open it passes ten times its rated flow into "
        "a 0.43 L ullage.",
        low=0.01,
        high=1.0,
        step=0.01,
    ),
)

_SETUP_FIELDS = {f.name for f in fields(Setup)}
for _t in TUNABLES:
    assert _t.field in _SETUP_FIELDS, _t.field


def parse_setup(settings: Mapping[str, Any], base: Setup | None = None) -> Setup:
    """The dials, from whatever the client sent. Anything unsent is kept.

    ``replace`` on the base, never a fresh ``Setup``: building it field by
    field silently reset every dial the client did not send.
    """
    current = base or Setup()
    changes: dict[str, Any] = {}
    for t in TUNABLES:
        raw = settings.get(t.key)
        if raw is None:
            continue
        if t.kind == "flag":
            changes[t.field] = bool(raw)
            continue
        try:
            value = float(raw)
        except (TypeError, ValueError):
            continue
        value = min(max(value, t.low), t.high)
        if t.field == "max_iterations":
            changes[t.field] = int(round(value))
        else:
            changes[t.field] = value
    return replace(current, **changes) if changes else current


def wire_setup(setup: Setup) -> dict[str, Any]:
    """The setup as the client sees it, keyed as :data:`TUNABLES` names it."""
    return {t.key: getattr(setup, t.field) for t in TUNABLES}


def describe() -> list[dict[str, Any]]:
    """The table the Configuration tab renders, with each knob's default."""
    defaults = Setup()
    return [
        {
            "key": t.key,
            "label": t.label,
            "unit": t.unit,
            "group": t.group,
            "explains": t.explains,
            "kind": t.kind,
            "low": t.low,
            "high": t.high,
            "step": t.step,
            "applies": t.applies,
            "default": getattr(defaults, t.field),
        }
        for t in TUNABLES
    ]
