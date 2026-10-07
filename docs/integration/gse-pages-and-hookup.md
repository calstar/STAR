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

**The page.** On the Hookup tab:
* **Valves:** each actuator has a drop-down of the drawing's valves (with page and
  plumbed role). "Automatic" shows what the twin matched and how; "never
  commanded" flags an actuator nothing drives.
* **Knobs:** named dials with start, low and high values, each with the regulators
  it turns.

The GSE Controls tab then draws one knob per hookup knob that sets something.
