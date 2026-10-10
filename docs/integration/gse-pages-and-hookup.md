# GSE pages and the hookup

How a pid-designer drawing with a rocket page and a GSE page becomes one stand in
feed-twin, and how a person links the stand's controls to whatever that drawing
contains. Written 2026-10-06.

## Pages

pid-designer has no page container: each node carries `data.page` (empty means
"Main"). There is also no off-page connector. A line from the vehicle to the cart
is drawn as a quick-disconnect on each page, the two paired through
`options.pairedWith`. That is the same coupling the stand has: a half on the
vehicle and a half on the cart.

feed-twin reads every page into one network (`lib/feedtwin/feedtwin/pid/network.py`):

* **A paired disconnect is mated** (`_mate_disconnects`). Each half's free side is
  found (the side no drawn line landed on), and the two free sides become one
  place, like any direct connection. The halves' own losses stay in series.
  * The pairing may be written on one half only; pid-designer saves only the half
    that was edited.
  * Two halves naming different partners are left unmated, and the report says so.
  * A drawing that pairs nothing builds exactly as before.
* **A cart drawn on the GSE page fills the vehicle itself.** A bottle reached from
  a bottle or dewar on *another page*, or a tank reached from a dewar there, is
  filled by the network through the drawn valves. The session's built-in fills
  (the COPV charge, the tanker load) stand aside for it, and the report says which
  vessels. Gas the drawing delivers into a bottle is credited at the enthalpy it
  arrives with.
  * The other-page rule is deliberate: two flight bottles manifolded on the
    vehicle page are not one filling the other.

Not yet built:
* demating, a disconnect that comes apart, e.g. the umbilical at T-0;
* a "pages" view in the P&ID tab.

## The hookup

The DAQ's state machine commands names ("LOX Press", "GSE High Press Control").
The drawing has tags ("OU_SOL_R", "PR-CART"). The GSE page has as many hand-loaded
regulators as the cart has. A **hookup** (`lib/feedtwin/feedtwin/session/hookup.py`)
is the link between them, kept per drawing:

* `valves`: actuator → drawing valve, **only for what a person pinned**. Everything
  else is matched automatically on every open (names, then what each valve is
  plumbed to do), so a drawing that grows a valve picks it up.
  * `""` means "this actuator has no valve here".
  * A pin naming a valve the drawing lost is ignored, and that actuator is matched
    automatically again.
* `knobs`: each is a dial on the GSE page, with the regulators it sets. What the
  knob sets depends on the regulator:
  * a control regulator (dome loader): its setpoint, with the dome following
    through it;
  * a dome-loaded regulator with no loader drawn: its dome;
  * a plain regulator: its setpoint.

  A regulator on no knob holds its drawn setting. A regulator can be on one knob
  only. The knob with id `dome` is `Setup.dome_psi`, which the Configuration tab
  and Layer X's lockup solve drive.

**Suggested, then edited.** With nothing saved, feed-twin uses `suggest()`. That is
exactly what it always did: the name/role binding, plus one `dome` knob on every
dome loader (or, with none drawn, on the first dome-loaded regulator). A session
given the suggestion emits the same signals, bit for bit, as one given none
(`lib/feedtwin/tests/test_hookup.py`).

**Where it lives.** feed-twin keeps it in its library under the drawing's
*lineage*, not its content hash, so saving the drawing again keeps it:
* a pid-designer document for a pulled drawing;
* the shipped file;
* the upload name, with a browser's " (2)" stripped.

The API:
* `GET /api/hookup?diagram=…` returns:
  * what is saved, or the suggestion;
  * the suggestion itself;
  * everything there is to link: actuators, valves, regulators;
  * the binding it produces;
  * the pages and mated pairs.
* `PUT` saves a hookup.
* `DELETE` goes back to the suggestion.
* A session reports its knobs (`knobs` on every tick) and takes
  `{"knob": {"id", "value"}}` on `/command`.

**The DAQ box (2026-10-10).** The real stand declares its wiring in the DAQ's
config: `[actuator_roles]` puts each actuator name on a board and channel,
`sensor_roles_<board>` names each transducer channel, and the state table opens
*names*. A hookup now says the same three things:

* `channels`: one entry per connector with a cable on it: `board` (`sol12`,
  `sol24`, `pt_low`, `pt_high`, `rtd`, `tc`), `slot` (from 1), the `symbol` it goes
  to, and its `name`. The name is what the console calls the symbol and, on a
  solenoid board, the state table's row. Names are unique ignoring case.
* A hookup with `channels` is **wired**. A row then drives the valve on the
  connector of its name (matched ignoring case) and nothing else. A row with no
  connector drives nothing, and so does a connector to something that is not a
  valve. Nothing is matched behind the person's back. `channels: []` is a box
  with nothing plugged in.
* Without `channels` (`None`) the hookup is the old kind (pins, then names and
  roles), written and bound exactly as before. `GET /api/hookup` still shows it
  as a box: `backend/daqbox.wiring` puts each row the matching binds on the
  DAQ's own connector for that name (`statemachines/diablo_channels.json`, from
  the DAQ's `[actuator_roles]`; board 12 is shown as 12 V and 14 as 24 V, a
  guess) and every PT, RTD and TC on its board. Saving that box changes no
  binding.
* Rocket only, `on_vehicle` keeps the rocket's connectors. A row whose cable
  went to the cart is matched on the rocket as before (`auto`), so its vent row
  finds the tank-top disconnect; a row with no connector still drives such a
  stand-in (a disconnect whose mate was cut, `Model.meta["capped"]`), which the
  box cannot take.
* A connector whose symbol the drawing no longer has (redrawn, new id) is matched
  by name again if it is a valve's (its name is a row); a sensor's is not shown
  until rewired. The stand says which in its notes, and also names any connector
  of a stand's own box that a save would refuse (wrong board, not a DAQ symbol).
* Some rows the twin reads by name with no valve wired (`core.builtin_rows`: the
  built-in COPV charge and dump, the transfer tank's press), listed only where the
  stand acts on them: the charge and dump while a vehicle bottle's fill is not
  drawn (on the cut drawing when rocket only), the press while a cart transfer
  tank of that side has a drawn pressure. The State machine tab shows them as
  built-in, not "wired to nothing".
* The console shows what is wired: a valve or transducer the box can take is on
  it only with a connector, as on the real DAQ's dashboard. Gauges, tanks and the
  engine's channels are the twin's and show as before (`SessionOut.wired`).

**The state table.** `machine` is the stand's own table when somebody edited it
(`StateMachine.to_dict` / `machine_from_dict`: states with their panel row/col and
abort flag, rows, which rows each state opens *as written*, and the legal moves).
`None` is the shipped DAQ table. An edited table is read like the CSVs: Idle held
shut, mains outside Fire and Fire bypasses warned, a missing Idle, Ready,
Fire, Vent or Engine Abort warned with its reason (the twin keys on them), and a
table in which no state loads the LOX or the fuel tank warned (a fill state's name
says fill and its side). It rides with the hookup, so a stand carries its own. A
run records it as `machine_table`, which the Explain ladder swaps with the hookup
(the "drawing & hookup" rung), and a replay runs it.
`POST /api/statemachine/check` warns about a table being edited.
`GET /api/session/{id}/statemachine` is the table a running stand commands,
including a stand's own hookup.

**The pages.**
* **P&ID → Symbols** (method A): each valve and transducer shows its board and
  connector, its name, and for a valve the states that open it.
* **P&ID → DAQ box** (method B): the boards as GX12 connectors. Drag an empty
  connector onto a symbol, or click it and then the symbol.
* **State machine**: the DAQ's State tab: states, what each opens, the allowed
  transitions, and the DAQ's CSVs to download or upload.
* **Knobs** (the nav's name for the old Hookup page; its path is still
  `/hookup`): the knobs, as named dials with start, low and high values, each
  with the regulators it turns.

The four edit one draft and save together.

The GSE Controls tab then draws one knob per hookup knob that sets something.

## Ignoring the drawn GSE

`Setup.ignore_gse` ("Ignore the drawn GSE", on the GSE Controls and Configuration
tabs; off by default) is for when the twin's reading of a complicated cart gets in
the way and only the rocket matters (the operator, 2026-10-08). On, the stand is
built from the vehicle alone (`feedtwin.pid.roles.vehicle_only`,
`assemble_model(vehicle_only=True)`): every symbol off the vehicle and every line
touching one is cut, and each vehicle disconnect whose mate was cut is a capped
half. The stand then fills like a drawing of the rocket alone:

* GN2 High Press charges the COPV to the COPV fill knob (`copv_target_psi`) over
  `copv_fill_s`;
* Fuel Fill pours the load over `fuel_fill_s`; Ox Fill loads from a dewar at
  `dewar_psi`;
* the dome knob sets the dome-loaded tank regulator directly, and the vehicle's
  dome transducer reads it.

The drawing's saved hookup keeps its vehicle pins; its knobs are the cut drawing's
(`hookup.on_vehicle`). It is how the stand is built, so changing it opens a fresh
stand, and a running session reports the value its model was built with. Run
records carry it in their setup, so a replay rebuilds the same stand. On a drawing
with no GSE page it changes nothing.

## Knobs start at the drawing (2026-10-08)

Every regulator a hand sets gets a knob: every regulator on the ground support,
whatever the sheet says it was set to, and any other the drawing gives no setting.
Every knob starts at the drawing's setting (`hookup.drawn_settings`,
`knob_starts`): a loader's or plain regulator's `setpoint`, a dome-loaded one's
`dome_pressure`. A fresh stand's dome (`Setup.dome_psi`) and COPV fill
(`copv_target_psi`) are read the same way. The cockpit sends them only when the
operator has turned them on this drawing, or a stand document carries them.
Before this, a cart regulator drawn with a setting got no knob, and the dome and
COPV fill opened at 500 and 4,500 whatever was drawn: LE4 drawn with PR-1 at 3,750,
DR-REG-G at 535 and LP-PR at 150 showed one knob, at 500.
