# 0002 — The drawing is a shared document, not a feature of one app

**Status:** Proposed · 2026-09-09
**Affects:** `pid-designer`, `feed-twin`, `daq-server`, `lib/feedtwin`, `lib/feed-canvas`

## Context

`pid-designer` now carries more than geometry. A component holds the numbers
that describe the hardware, in `feedtwin.model.Param`'s shape; fluid is a real
species inherited from the tanks; lines carry length, bore and roughness; a
checks panel reports what a solve could not start from. It is most of the way
to being the input to a feed-system simulation.

Which raises the question this ADR exists to answer, asked plainly: **if the
digital twin is going to do everything the designer does and more, why are
there two apps?**

Three facts shape the answer.

**There are three consumers of the drawing, not two.** Authoring it
(`pid-designer`), solving it (`feed-twin`), and showing live or replayed test
data on it (the DAQ GUI, `daq-server/diablo_server/frontend`). The third is not
hypothetical — ADR-0001 already cites it as the reason the schematic view could
not live inside EngineDesign, and the `feed-twin` README already schedules the
canvas as `lib/feed-canvas` "so the DAQ GUI can import it too".

**The three have incompatible operational requirements.** The DAQ GUI runs
natively on the test-stand machine under systemd, on React 18, and has to be up
when the stand is hot. `pid-designer` is a ~300-line FastAPI with no numerical
dependencies that people use while building hardware. `feed-twin` pulls
CoolProp, SciPy and `ht`, and will change weekly from Phase 05 to Phase 14.
Merging any two of them couples an availability requirement to a release
cadence that has nothing to do with it.

**The monorepo has already run this experiment and it worked.**
`lib/stardesign` and `lib/stardesign-ui` were extracted from three design tools
that had triplicated ~1500 lines of sharing, checkout and dialog code. Those
three tools sit on different Vite majors and different React versions, and the
shared library works because it ships source and each app's own bundler
compiles it.

## Decision

**Three apps, and the drawing is a document they share rather than a feature
one of them owns.** Two things get extracted, in this order:

1. **The schema, as data.** The component vocabulary — what kinds exist, what
   ports each has, what parameters and options each carries — moves out of
   `pid-designer/frontend/src/components/pid/spec.ts` into a data file, in the
   spirit of `feedtwin/model/components.toml`. TypeScript imports it; the
   Phase-11 reader in `feedtwin.io` reads the same file. **One definition of
   what a valve is.**

2. **The canvas**, as `lib/feed-canvas`: the symbols, the renderer and the
   layout, with no authoring machinery and no physics in it.

`pid-designer` keeps what is genuinely its own: checkouts, sharing, version
history and releases — the `lib/stardesign` machinery for a document many
people edit. `feed-twin` keeps the solver and the run reports. The DAQ GUI
keeps the live data path. None of them owns the vocabulary.

**Numbers get exactly one owner, and the others cannot hold a copy.**

| Owner | Holds | Why |
|---|---|---|
| The drawing | Topology, tags, fluid, which port goes where, part number, coarse run geometry | Facts about *this installation* that exist nowhere else |
| The catalogue | Bore, Cv, K, cracking pressure, roughness | Properties of the *part*, identical in every installation |
| The twin | Correlation choice, `turn_K`, discretisation, defaults | Modelling decisions, not facts about hardware |

Where the drawing and a named part both give a value, the reader **reports the
conflict rather than merging it silently**. That is the same discipline
`Part.resolve` already applies to datasheet against measured: the loser is not
overwritten, because the discrepancy is the interesting part.

**Fine geometry belongs to the twin, and supersedes the drawing where it
exists.** A P&ID says a run exists between two components and roughly what it
is. The twin's per-line editor says which four elbows, which reducer, which
exact routing. The twin's answer wins where it has coverage and the drawing's
stands everywhere else — the same override-with-provenance the property layer
uses, applied one level up. This is what lets the drawing be solvable on its
own before anybody opens the twin, without the two disagreeing later.

## Consequences

**Good.**

- One symbol vocabulary and one document format across authoring, simulation
  and live test display. A component added once appears in all three.
- The parity problem raised about `bore` and `turn_K` stops being a
  synchronisation task and becomes a structural impossibility: there is one
  definition of the schema and one owner per value.
- Each app deploys on its own cadence. The drawing tool does not go down
  because the solver's dependencies moved.
- `pid-designer`'s container stays free of CoolProp and SciPy.

**Costs, accepted.**

- Two more path-installed packages to keep in step across `setup.sh`, `dev.sh`,
  the Dockerfiles and CI. This is the tax `lib/stardesign` already pays and the
  tooling exists.
- A schema change touches three consumers. Mitigated by the schema being data:
  most changes are a row, and the reader fails loudly on a vocabulary it does
  not recognise rather than guessing.
- Someone will open `feed-twin`, want to nudge a symbol, and have to go to
  `pid-designer` to do it. Accepted deliberately — see below.

## Alternatives considered

**Merge them: `feed-twin` absorbs `pid-designer`.** The most tempting, and the
question that prompted this ADR. Rejected on four counts. Everyone who draws a
P&ID would depend on the physics stack building and deploying, for a drawing
tool that today needs neither. The drawing — the thing people need *while
building hardware* — would inherit the availability of the solver, the thing
people need while designing it. It does not serve the DAQ GUI at all, which
still needs the canvas on the test stand, on React 18, on its own release
cycle. And it puts checkout, sharing and version history — machinery for a
document a team edits together — inside an app whose job is to run one solve.

**Keep two apps and let each draw its own symbols.** The status quo if nothing
is extracted. Rejected because it is precisely the triplication
`lib/stardesign` was created to remove, and this time the duplicated thing is
the vocabulary itself: two definitions of what a valve is, drifting, with the
solver's copy silently deciding what the drawing meant.

**Put editing in the twin and leave `pid-designer` as a viewer.** Rejected
because it moves the collaborative-document problem — who holds the write
token, what the version history is, who a diagram is shared with — into the app
least equipped for it, and leaves the well-tested `lib/stardesign` machinery
attached to a viewer.

**Extract the canvas first, schema later.** Rejected on ordering. The pixels are
cheap to change and the format is not: a schema that has been written into
saved diagrams for six months is a migration, while a symbol that draws wrong
is an afternoon. The expensive thing goes first.
