# 0006 — The drawing wires the twin

**Status:** Accepted · 2026-10-07
**Affects:** `lib/feedtwin`, `feed-twin`, `EngineDesign` (Layer X), `pid-designer`

## Context

LE4 (6) was the first drawing with its ground support drawn: a Rocket page and a GSE page,
joined at quick-disconnects paired across the pages. Run in the cockpit, almost everything
off the vehicle page was read wrong, and the operator had to wire the rest by hand on the
Hookup tab, then still hit the problems below. A deep dive (2026-10-07) found:

* **No notion of vehicle and cart.** Every TANK was a flight tank. The fuel transfer tank
  took the tanker load with the flight tank, so Fuel Fill poured 13 kg into a tank that is
  the *source* of the load. A DEWAR was a pressurant bottle: GN2 High Press "charged" the
  LOX dewar to 4,500 psig and crashed. Every bottle started empty, the cart's 6K bank
  included, so nothing could charge the COPV even after the built-in charge stood aside.
* **Hand valves were holes.** A MAN valve had no position, which a valve reads as wide
  open. Every hand vent, bleed and dump on the GSE page vented for good. The flight fuel
  tank vented through its cart's hand vent (FV-MAN) across the mated disconnect.
* **Motorised valves didn't exist.** MOV wasn't an inline type, so OV-MOT and
  OF-MOT-Dump were built as junctions: always open, never commanded.
* **Dome lines were feed.** A line drawn on a regulator's `dome` handle landed on its
  inlet or outlet. The dome-control line (GSE regulator → solenoid → mated QD → solenoid →
  dome port) was plumbed into the tank press manifold. Loaders were found only when drawn
  directly onto the dome regulator.
* **Only one knob.** `suggest()` made the dome knob and nothing else. A regulator with no
  setting on the drawing (PR-1, DR-REG-G, LP-PR: every GSE regulator) silently held the
  500 psia fallback. The COPV fill knob was the built-in charge's, even with PR-1 drawn.
* **Names couldn't bind the cart.** "GSE High Press Control" never met "HPC_SOL", or
  "Fuel Vent" "FV-SOL". Hand valves were offered to actuators.
* **A drawn load couldn't flow.** A tank took no liquid in at its outlet, and an empty
  tank's outlet branches were cut by the dry-tank isolation, fill line included.
* **The checkout gated nothing.** Configuration, knobs, hookup and the engine and drawing
  picks all changed without Take. Save took the checkout silently, overwriting the
  holder's last save. A stand's hookup and the drawing's hookup fought on restart.

## Decision

The drawing says what the stand is; the twin works the rest out once, in the library,
and the cockpit and Layer X read the same answer. Wiring by hand is the exception, kept
for what the drawing does not settle.

1. **Vehicle and ground support** (`feedtwin.pid.roles`). The vehicle is everything joined
   to the ENGINE by drawn lines; a paired disconnect is not a line, so it is where the
   vehicle ends. A drawing that is one piece is all vehicle, and reads exactly as before.
2. **Vessels by role.**
   * A cart TANK is a supply. It starts loaded (Setup full fraction of its volume, said
     in the assumptions). It never takes the tanker load. `BuiltNetwork.supplies` records
     the flight tanks it reaches, and their built-in load stands aside.
   * A cart K-bottle arrives full. Only the vehicle's bottle is charged on the pad.
   * The built-in charge and vent never touch a cart vessel.
3. **Liquid moves through the drawing.** Both ends of a transfer line take liquid in at
   their outlet (mixed at its arriving temperature, squeezing the ullage). The line stays
   open to a dry tank. The stand's mass balance closes through a full load.
4. **Built-ins stand in only for what is not drawn**, and say so. The transfer tank's
   press line isn't on LE4 (6), so while "Fuel Fill Press" is open and bound to nothing,
   the tank is held at its drawn pressure (`Setup.supply_press_s`, assumed).
   The crew's hand on the transfer valve is modelled:
   * shut until the flight tank's fill state;
   * opened for the load;
   * shut at the full fraction.

   The twin only acts when that changes, so a hand on the P&ID in between is kept.
5. **Every valve has a resting position.**
   * Actuated (SOL, ROT, MOV): the drawing's `failState`.
   * Hand (MAN): **shut**, every one, until a person opens it (the team's rule,
     2026-10-07). The exception is a valve the drawing marks `normalPosition: open`.

   Hand valves are turned on the P&ID and never offered to the table. The crew's
   transfer valve on a drawn load (4) is a hand valve the twin opens for the load.
6. **Dome lines are loading, not feed.** Lines on a `dome` handle are not plumbing. The
   loader is the one regulator the dome line reaches through junctions, valves and paired
   disconnects. A loader with no setting is set by the dome knob.
6a. **Dome-line valves gate the dome.** When the dome line has valves on it
    (`BuiltNetwork.dome_lines`), the session walks it each tick from the dome port:
    * through valves that are open, the dome follows its loader;
    * past an open vent, the dome drains to atmosphere and the regulator holds its
      spring bias;
    * otherwise the dome keeps what was shut in.

    An inline valve no actuator drives passes; a vent no actuator drives rests shut.
    The cart's valve on the line is the table's "GSE Med Press Control". The line's
    transducers read the dome, and T-0 starts with it loaded. On LE4 (6):
    * GN2 Low Press opens DR-CTRL-G and loads DPR_HP's dome from DR-REG-G;
    * Ready shuts it and the dome holds 500 psig;
    * before that, the tanks lock up at the 50 psi bias alone.
6b. **A dewar holding liquid is a supply tank.** A DEWAR whose drawn temperature is
    below its fluid's critical point is read as a TANK on the ground side:
    * it starts loaded, at its drawn pressure, its metal at the liquid's temperature;
    * it has no skin leak, being vacuum-jacketed;
    * its pressure-building circuit holds its drawn pressure;
    * the flight tank it reaches is loaded through the drawing.

    A dewar used as a gas source, warm or above critical, stays the gas bottle it was.
7. **Every hand-loaded regulator has a knob.**
   * `DOME` (Setup dome) on the dome's loader.
   * `CHARGE` (Setup `copv_target_psi`) on the regulator whose outlet reaches the
     vehicle's bottle, so the COPV fill is one setting whether the cart is drawn or
     not. (The supply effect has no datum: it is measured from zero inlet,
     PHYSICS-BENCHMARK 4.11.)
   * A knob of its own for every other regulator the drawing gives no setting.
8. **Binding: names, then the plumbing, and the plumbing can overrule a name.**
   * The team's line prefixes expand (FV, FF, OV, OF, HP/HPC, LP).
   * A valve on the ground side answers to "GSE".
   * The closest name wins.
   * A name match loses to the one valve that does the actuator's job when it doesn't.
   * GSE roles include fill press, fill vent, fill and dump.
   * `open_session` uses the same binding as the cockpit, and takes a hookup.
9. **The checkout gates configuration, never operation.** On a stand not taken, the
   Configuration tab, GSE knobs and cart numbers, the hookup, and the drawing and engine
   picks are read only. States, valves, T-0 and Fire are operating the stand and stay free.
   Save and releases need the checkout. On a stand, the hookup is the stand's own,
   saved with it.

## Consequences

* LE4 (6) runs its pad through the drawing:
  * GN2 High Press charges the COPV through PR-1 at the COPV fill knob.
  * Fuel Fill presses the transfer tank to 150 psig and loads 6.18 kg across QD-FF to the
    95% fill, then shuts FF-MAN-Output. The tank loses exactly what the flight tank gains,
    less a few grams of evaporation.
  * Ten actuators bind with no hookup saved.
  * GN2 Low Press loads the dome through DR-CTRL-G, which then holds it.
  * With its LOX fill line drawn, Ox Fill loads the flight LOX tank from the dewar
    (8.45 kg in ~10 s through Cv-4 fallback valves). Your drawing's line still dead-ends,
    so it keeps the built-in dewar load until it's finished.
* Layer X reads the vehicle through `feedtwin.pid.roles` (`engine/layerx/vehicle.py`
  delegates), and passes its dome hookup through `open_session`.
* Shipped and one-page drawings are unchanged: none has a hand valve, a motorised valve,
  a second page or a dome-handle line. `physics_benchmark.py`, the Layer X parity test and
  both suites pass unchanged.
* `lib/feedtwin/tests/test_rocket_and_gse.py` holds it, against the team's drawing as a
  fixture, with each check red-checked.
* **The cart is simplified on purpose** (the team, 2026-10-07: "we only care about the
  rocket"). A cart vessel nothing flows through is not integrated, and while the engine
  burns the cart with no open path to the vehicle is out of the solve
  (`Setup.ground_rests`). Fire on LE4 (6) went from 2.3x to 4.1x real time with the burn
  unchanged to the bit (PHYSICS-BENCHMARK 3.10b).

## Not yet

* **The drawing should name each valve's DAQ actuator** (`options.actuator` in
  pid-designer), so the binding is the drawing's and inference fills only the gaps.
  Deferred by the team; names, prefixes and the plumbing do it until then.
* **A "normally open" choice on hand valves in pid-designer.** The twin reads
  `options.normalPosition` already; the symbol's dialog does not offer it yet.

## LE4 (6): what the drawing is missing

These are the drawing's to fix in pid-designer, not the twin's to guess:

1. **LOX fill path is broken.** OF-MAN-Fill ends at a junction going nowhere. OF-QDA
   (mated to the vehicle's OF-QDB) has no lines. The OF-Manifold and its two dump valves
   float.
2. **LOX vent disconnects aren't paired.** QD-OV-B (vehicle) and OV-QD-A (GSE) both have
   an empty `pairedWith`, so the twin vents the LOX tank through its top QD as if the
   cart weren't drawn.
3. **The transfer tank has no press line and no volume.** FF-QD-Pressure has no lines, and
   the FF-Manifold port (Jc_79) dangles. Its volume defaults to 17.5 L.
4. **GSE regulators carry no settings** (PR-1, DR-REG-G, LP-PR). That's fine: they get
   knobs. Give them their datasheet Cv and droop.
5. **GSE reliefs have no set pressure** (HP-Up-RV, HP-Down-RV, LP-RV, LOX-DW-RV, FF-RV,
   DR-RV), so they are read as shut.
6. **The LOX dewar's label says 350 psi; its pressure param says 50.**
7. **Smaller gaps:** HP-QD-B → HP-QD-A is paired one way only (harmless, they're drawn
   with a line). LP-MAN-Vent dangles. Eth-Tank and LOX-Tank have no diameter.
   DPR_HP has a supply coefficient and no inlet reference (the twin takes the COPV charge;
   see PHYSICS-BENCHMARK 4.11).
