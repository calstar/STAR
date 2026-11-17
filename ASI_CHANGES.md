# ASI ground-station changes — summary

The GOx / GCH4 augmented spark igniter (ASI-1) in the Diablo DAQ ground station, 2026-11-16/17.

**State:** typecheck clean, all 527 frontend tests pass (39 of them new for the ASI), production build succeeds.
Nothing was run against hardware. Brought into the repo on branch `asi-test` (2026-11-17), with the run valve
made pneumatic (see section 7); typecheck, tests and build re-run clean there.

Sources used for every number below:

- **[P&ID]** `ASI V1 (copy of Cash Arjuna Eden).json` (pid-designer export)
- **[DP]** `asi_gox_gch4_17gs_100psia_2026-10-07.yaml` (ASI-1 design point)
- **[operator]** wiring given during the session (2026-11-16)
- **[assume]** not in any source: replace with a measurement

---

## 1. What was added

Two new tabs in the DAQ GUI, both pinned in the top bar.

### ASI tab: `/asi` (system test)

- Live diagram of both lines: regulator → upstream PT → run valve → downstream PT → QD → ASI, with TC-1 on the body.
  Vent solenoids and reliefs are drawn with their tag, connector and state.
- One card per line: two PT readings, regulator deviation, the run valve and both vent solenoids as controls,
  and relief margin bars.
- Valve buttons are the stand's normal actuator cards. They only work when the console is armed and in debug mode.
  The tab itself never sends a command.
- Derived from the downstream PTs: ṁ GOx, ṁ CH4, O/F, "Pc if lit", and pass/fail on the light gate.
- Five test procedures, each logged pass/fail, with CSV export:
  1. Zero / ambient (PTs ≈ 0 psig, TC-1 ≈ room)
  2. Leak decay (psi/min on a locked-up volume; flags a rising pressure)
  3. Valve response: run valves *and* vents, timed to 90 % of the pressure change (±50 ms resolution, because the GUI stream is ~20 pts/s)
  4. Relief crack (mark or peak-hold against set)
  5. Cold-flow O/F
- A sensor and valve mapping panel: auto-detects by name or P&ID tag, with manual override.

### ASI Twin tab: `/asi-twin` (Hotbench Engine + Twin for the ASI)

- **Engine:** operating point from hole pressures (Pc, O/F, Tc, c*, energy margin, choked check);
  sizing of holes and throat for a target, with drill picks; Tc / c* vs O/F chart.
- **Twin · sequence:** runs a light sequence through the twin and reports:
  - light time, the 80 psia / 250 ms gate, steady state and tail-off
  - TC-1 and lower-neck temperatures
  - warnings

  Presets: *Nominal light*, *Failed ignition*, *Vent (safe)*.
- **Twin · live:** the twin driven by the stand's commanded valves and vents and the measured upstream PTs;
  shows predicted vs measured. Read-only.
- **Model:** every hardware number, each with its source note on hover.

All ASI maths runs in the browser. Settings are saved per browser (localStorage key `asi.settings.v3`).

---

## 2. Important labels

### Feed lines (per side: 2 PTs, 1 pneumatic run valve, 2 vent solenoids, 2 reliefs)

| Item | GOx | Methane (CH4) | Source |
|---|---|---|---|
| Regulator (setpoint) | PR-1 (580 psig) | PR-3 (603 psig) | [P&ID][DP]; lockup 645 psig |
| Upstream PT (regulator outlet) | PT-LP-5 | PT-LP-6 | [P&ID] |
| Downstream PT (run-valve outlet / hole P0) | PT-LP-2 | PT-LP-1 | [P&ID][DP] |
| Run valve (pneumatic; PDB drives its pilot) | PDB #3 | PDB #6 | [operator]; NC |
| Vent solenoid, before run valve | SOL-18, PDB #1 | SOL-19, PDB #4 | [operator]; NC |
| Vent solenoid, after run valve | SOL-16, PDB #2 | SOL-17, PDB #5 | [operator]; NC |
| Relief, before run valve | RV-6, 750 psig | RV-5, 750 psig | [P&ID] (DP says 725) |
| Relief, after run valve | RV-8, 725 psig | RV-9, 725 psig | [P&ID] |
| QD | HQD-1 | HQD-2 | [P&ID] |
| Injector hole | #54 drill, Ø1.397 mm | #59 drill, Ø1.041 mm | [DP]; Cd 0.80 [assume] |

### LabJack T7 PT inputs (`config/profiles/default/config.toml`, `[boards.labjack_1]`)

| AIN | Role name | Line |
|---|---|---|
| AIN0 | `PT-LP-5 GOx Upstream` | GOx |
| AIN1 | `PT-LP-2 GOx Downstream` | GOx |
| AIN2 | `PT-LP-6 CH4 Upstream` | Methane |
| AIN3 | `PT-LP-1 CH4 Downstream` | Methane |

### ASI PDB actuator roles (staged, **commented out**, `config/profiles/default/config.toml`)

| Connector | Role name | Type |
|---|---|---|
| 1 | `ASI GOx Vent Up` | NC |
| 2 | `ASI GOx Vent Dn` | NC |
| 3 | `ASI GOx Run` | NC (pneumatic run valve pilot) |
| 4 | `ASI CH4 Vent Up` | NC |
| 5 | `ASI CH4 Vent Dn` | NC |
| 6 | `ASI CH4 Run` | NC (pneumatic run valve pilot) |

The board is `[boards.asi_actuator_board]`, the same design as board 12, with placeholder `board_id = 15` and IP `192.168.2.15`.

### Torch and thermal

| Item | Value | Source |
|---|---|---|
| Design flow | 12.5 g/s GOx + 5.0 g/s CH4 = 17.5 g/s, O/F 2.5 | [DP] |
| Chamber pressure | 100.6 psia expected (111.7 ideal), band 80–110 | [DP] |
| Throat | L drill, Ø7.37 mm (fallback N, Ø7.67) | [DP] |
| c* efficiency | 0.90 | [DP][assume] |
| Light gate | Pc > 80 psia within 250 ms, else abort | [DP] |
| Burn cap | 0.85 s from light | [DP] |
| TC-1 | Type K, body TC port, 1 mm from the bore. **It reads copper, not gas.** | [DP] |
| Lower neck limit | 1100 K (C145 copper, never anneal) | [DP] |
| Energy margin | 3.41 ideal, ~2.8 at η 0.90; target 3.0 | [DP] |

### Checks against the design point (these are tests)

| Quantity | This code | Design point |
|---|---|---|
| c* at O/F 2.5 | 1879 m/s | 1878 m/s (CEA) |
| Tc at O/F 2.5 | 3113 K | 3107 K |
| Lossless twin | 100.3 psia, O/F 2.51, 12.5 + 5.0 g/s | 100.6 psia |
| Sizing | #54 / #59 / L | #54 / #59 / L |

---

## 3. Files

**New**

| File | What |
|---|---|
| `daq-server/diablo_server/frontend/app/asi/page.tsx` | ASI tab (system test) |
| `daq-server/diablo_server/frontend/app/asi-twin/page.tsx` | ASI Twin tab (Engine / sequence / live / model) |
| `daq-server/diablo_server/frontend/components/asi/AsiParts.tsx` | Shared widgets; hook that resolves DAQ roles |
| `daq-server/diablo_server/frontend/components/asi/AsiSchematic.tsx` | Feed-line diagram |
| `daq-server/diablo_server/frontend/components/asi/AsiModelEditor.tsx` | Model editor + chart |
| `daq-server/diablo_server/frontend/lib/asi/physics.ts` | Gas flow, combustion lookup, flammability |
| `daq-server/diablo_server/frontend/lib/asi/settings.ts` | Defaults with sources, mapping, auto-detect |
| `daq-server/diablo_server/frontend/lib/asi/engine.ts` | Operating point, sizing, drills, energy margin |
| `daq-server/diablo_server/frontend/lib/asi/twin.ts` | Transient twin and sequences |
| `daq-server/diablo_server/frontend/lib/asi/checks.ts` | Test-procedure pass/fail rules |
| `daq-server/diablo_server/frontend/lib/asi/cea-gox-ch4.ts` | Generated GOx/GCH4 combustion table (do not hand-edit) |
| `daq-server/scripts/asi/gen_cea_gox_ch4.py` | Regenerates that table (needs Cantera) |
| `daq-server/diablo_server/frontend/__tests__/asi.test.ts` | Physics / engine / twin / checks / mapping tests |
| `daq-server/diablo_server/frontend/__tests__/asi-pages.smoke.test.tsx` | Both tabs render |

**Changed**

| File | Change |
|---|---|
| `daq-server/diablo_server/frontend/src/App.tsx` | Routes `/asi`, `/asi-twin` |
| `daq-server/diablo_server/frontend/src/pages.tsx` | Lazy page entries |
| `daq-server/diablo_server/frontend/lib/nav-items.ts` | Nav items `asi`, `asi-twin` |
| `daq-server/config/config_base.toml` | `asi`, `asi-twin` added to `[gui].tabs` |
| `daq-server/config/profiles/default/config.toml` | T7 AIN0–3 = ASI PTs (replaced the two placeholders, incl. the placeholder TC on AIN2); staged ASI board + roles (commented) |
| `daq-server/diablo_server/shared/*.js, *.d.ts` | Regenerated by `npm run build:shared` (build output, not hand edits) |

---

## 4. Open items: do before trusting it on the stand

1. **PT signal type:** AIN0–3 are set to `signal = "0-5V"` as a **placeholder**. Set it from the transducer datasheet.
   A wrong signal gives a wrong pressure.
2. **Up/down order:** assumed AIN0/AIN2 = upstream, AIN1/AIN3 = downstream. Swap the role names if wired the other way.
3. **LabJack is still `enabled = false`.** Enable it when it's on the bench.
4. **ASI PDB board:** waiting on its IP. To bring it up:
   - set `ip`, `mac` and `board_id`
   - change `15` to the real ID in the six roles
   - uncomment the board block and the roles
   - reload the config

   Agree with the team whether it should close its valves on an abort; it's `necessary_for_abort = false` now.
5. **TC-1 isn't in the config yet.** Add it where it's wired; the ASI tab finds a TC role named with "ASI" or exactly `TC-1`.
6. **Spark / exciter:** no actuator yet. The tab finds a role named "Spark", "Exciter" or "Plug".
7. **Numbers marked [assume]:** supply CdA, line volumes, relief and vent flow areas, valve and vent stroke times,
   hole Cd, c* efficiency and TC probe lag. Replace them in the Model tab.

### Differences in the source documents

- RV-5 / RV-6: **750 psig in the P&ID**, **725 psig in the DP**. 750 is used.
- In the P&ID the GOx line is wired to the engine's **fuel** port and CH4 to the **ox** port.
- Run valves: the user says pneumatic, the P&ID draws manual valves (MAN-12/13), the DP says direct-acting solenoids (SOL-1/2).
  **Resolved 2026-11-17: pneumatic** (section 7).
- The user once said "RV 5/6/7/8 are the vent solenoids", then withdrew it. The P&ID has RV-5/6/8/9; there is no RV-7.

---

## 5. Pending: connect ASI Engine / Twin to engine-design.starberkeley.org

Not started. Waiting on a decision.

**Problems**

1. EngineDesign's CORS list allows `localhost:3000` and its own site, not `daq-server.starberkeley.org`.
2. Caddy's login gate answers the browser's cookie-less CORS preflight with 401, so non-simple requests are blocked anyway.
   The login cookie itself is shared across `.starberkeley.org` (SameSite=Lax), so the session would carry over.
3. Hotbench Engine and Twin model liquid engines only. They cannot compute a gas-fed GOx/GCH4 igniter.

**Proposal**

- Keep the ASI maths in the DAQ.
- Save and load the ASI design to EngineDesign's shared design store (`/api/engine/documents`: versions, sharing, releases).
- Add buttons that open Hotbench Engine and Hotbench Twin.

Route it through a Caddy rule on the DAQ site (`daq-server.starberkeley.org/engine-api/*` → engine-design API, behind the same login),
so the browser sees one site and problems 1 and 2 don't arise. This is a deploy change to `deploy/caddy/Caddyfile` that someone with server access must apply.

---

## 6. How to run and test

From `daq-server/diablo_server/frontend` (this machine has no Node.js; Bun works):

```bash
bun install
bun --bun x tsc -p ../shared/tsconfig.json      # build shared types
bun --bun x tsc --noEmit                        # typecheck
bun --bun x vitest run                          # all tests
bun --bun x vite --host 127.0.0.1 --port 3000   # UI only → http://127.0.0.1:3000/asi
```

The UI-only server shows the ASI Twin fully. The ASI tab shows "—" and "not mapped" until the DAQ backend runs.
On the stand (`star-rfs`), starting the backend falls under the hardware-safety rules in `daq-server/CLAUDE.md`.

Regenerate the combustion table (needs Cantera; on Windows ARM use an x86-64 Python):

```bash
python daq-server/scripts/asi/gen_cea_gox_ch4.py > daq-server/diablo_server/frontend/lib/asi/cea-gox-ch4.ts
```

---

## 7. 2026-11-17: pneumatic run valve (branch `asi-test`)

Confirmed by the user. Each line has 2 PTs, **1 pneumatic run valve**, 2 vent solenoids and 2 reliefs. TC-1 is on the vehicle, inside the ASI.

- **Run valve is pneumatic.** The ASI PDB connector (#3 GOx, #6 CH4) drives the valve's pilot solenoid. Updated in:
  - `lib/asi/settings.ts`: field docs and model notes
  - `app/asi/page.tsx`: header, valve-response target labels and hint
  - `components/asi/AsiModelEditor.tsx`: field labels
  - `config/profiles/default/config.toml`: comments on the ASI board and roles
- **Run valve stroke (50 ms) is now [assume].** It was the DP's direct-acting solenoid spec. A pneumatic valve adds pilot and actuator fill time.
  Measure it with *3 · Valve response* and set it in the ASI Twin **Model** tab. Do the same for the run-valve Cv: it was sized for the solenoid.
  The default numbers are unchanged, so the twin and the tests behave exactly as before.
- **TC-1 stays unassigned** (user's choice). There's no TC channel in the config; pick it in the ASI tab's mapping panel once wired.

