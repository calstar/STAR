# Glossary

The words the twin uses, and what they mean here. Where the team has its own
word, the twin uses it: **O/F**, not "mixture ratio" or MR.

| Word | Means |
|---|---|
| **Stand** | The whole test set-up as one shared, versioned document: drawing, engine, fluid set, state machine, every setting, hookup, knob positions. Kept in the same store as pid-designer's drawings. |
| **Session** | One stand running live in the cockpit: vessels, valves, a clock. Lives on the server, not in the document. Reset starts a new one. |
| **Run** | One burn, recorded when it ends, with everything it depended on (inputs, code, stand version) and what it did (outcome, solver summary, traces). Never edited. |
| **Release** | A named, frozen version of a stand ("TRR rev B"). |
| **Checkout** | Who may save a stand right now. One person at a time; it lapses if they go quiet. |
| **Hookup** | Which actuator opens which valve, and which knob loads which regulator, on a given drawing. |
| **T-0** | The stand at the last sample before ignition: each tank's pressure, load and temperature, each bottle's pressure. A replay starts here. |
| **Lockup** | The pressure a regulator holds its outlet at with no flow. The tanks sit at lockup before Fire. |
| **Droop** | How far a regulator's outlet falls below lockup as flow rises. |
| **Dome** | The loading pressure on a dome-loaded regulator; the dome knob sets it. |
| **psig / psia** | Gauge (vented reads 0) / absolute. Everything a person reads or sets is psig. A chamber pressure is psia. See ADR 0004. |
| **MAWP / burst** | The pressure a vessel is rated to / fails at. The stand trips above MAWP, or above burst over the safety factor. |
| **Tunable** | An assumed number with a row on the Configuration tab: what it accounts for, its default, its bounds. |
| **Provenance** | Where a hardware number came from (manufacturer, measured, estimated). Every one carries it. |
| **Engine card** | EngineDesign's engine as tables (c\*, flow, thrust against chamber state), built once and fired by the cockpit. "Simplified" is the twin's own fallback engine. |
| **Residual** | How far a solve stopped from balanced. Each network solve stops under the tolerance. |
| **Continuity** | Mass in minus mass out at each network node. Zero for a converged solve. |
| **Chamber closure** | How far the chamber pressure the engine needs is from the one the feed delivers. Solved to a tolerance each tick. |
| **Mass balance** | What the vessels lost against what crossed the stand's boundary (engine, vents, fills). The difference, per million of what moved, is on the Solver tab and on every run. |
| **Guards** | Floors and clamps a vessel applies (a vent cannot pull below atmosphere). Booked, so the balance can tell a guard from a leak. |
| **Attribution / Explain** | Which input moved a run's answer: both runs replayed from T-0, then one input group swapped at a time. |
| **Interaction** | The part of a change the single swaps do not add up to: two inputs that matter together. |
| **Study** | The COPV sizing study: scripted burns at the scheme the physics benchmark is stated at. |
| **Layer X** | EngineDesign's forward mode over a burn: the same feed physics plus the engine analyses. See ADR 0005. |
| **Validated** | Compared against the stand's own data and found to agree. Until then the chip says *Not validated against test data*. |
