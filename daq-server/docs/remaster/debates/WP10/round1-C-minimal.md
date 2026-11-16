# WP10 round 1 — C (minimal): split less, delete more

Position: the goal is less code, not more files. Split the one god *function* (`daq_bridge main`),
take the one real duplicate (`register_all_tables`), move `sendBatch` to `_udp`, and spend the
saved review budget on deletions. The three classes otherwise stay whole. Lines:
`backend-remastered` @ 4241556b.

## 1. Files and ownership

| pass | file | owns |
|---|---|---|
| move-only | `daq_bridge/BoardMap.{hpp,cpp}` | `daq_bridge_main.cpp:113-305` verbatim, `static` dropped (DESIGN-WP10 §4.3); harness re-point §7.3 in the same commit (D18) |
| move-only | `daq_bridge/BackendLogForwarder.hpp` | `:49-90` header-only |
| move-only | `services/sequencer/ActuatorCommander_udp.cpp` | `ActuatorCommander.cpp:276-390` (`sendUDP`, `sendBatch`; 115 lines) |
| move-only | CMake | `daq_bridge/CMakeLists.txt`; `ACTUATOR_COMMANDER_SOURCES` in the 10 lib targets listing `ActuatorCommander.cpp` (`lib/CMakeLists.txt:156,205,225,241,258,280,303,329,406-424`) and `sequencer_service`; harness §7.2 |
| cleanup | `daq_bridge/TableRegistration.{hpp,cpp}` | `register_all_tables` from `:578-592` and `:759-773`, after §7.4 gap 1 |
| cleanup | `daq_bridge_main.cpp` | `print_board_routing_table`, `publish_self_tests`, `publish_raw_batch` as §4.3 (D43(3)) |
| cleanup | `ControllerService.{hpp,cpp}` | **deletions only** (§3) |
| cleanup | `SequencerService.cpp`, `ActuatorCommander.cpp` | `// Kept:` tags and the `publishState` lock-contract comment |

Threads, mutexes and lock order: exactly §1.2, §2.2, §3.2. The only new cross-TU call
is `emit` (core) → `sendBatch` (`_udp`); `emit` snapshots under `script_positions_mutex_` and
`overrides_mutex_` and releases both before building `by_ip` (`ActuatorCommander.cpp:513-522`);
`sendBatch` takes no lock (`:296-390`). No lock-holding chain crosses a file. C4-1's chain
(`SequencerService.cpp:717 → :727 → :1130`) stays in one file.

Walkthroughs: steps identical to the note's §C (a)/(b)/(c). File column: every SequencerService
and ControllerService row → the unsplit file; (a) 7 and (b) 6 → `_udp.cpp`; (c2) 3 →
`TableRegistration.cpp`; (c1) 3 → `BoardMap.cpp`.

## 2. Why C beats A (B is out on §A's grounds: headers cannot change)

Testability: unchanged in all three (D20 black-box goldens, no ctest rewritten). Abort:
`doTransitionTo` runs §C(b) steps 2-10 on the worker in one file; the only cross-TU hop is step
6's `emit → sendBatch`, lock-free.

**Lines deleted, per option.**

| deletion | A | C |
|---|---|---|
| registration duplicate `:759-773` → one call | −12 net | −12 net |
| `using namespace vtable…` out of core `ControllerService.cpp:35-36` | −2 | 0 (concede) |
| dead `ControllerService` members (§3) | not listed | −27 |
| move-only additions (copied include blocks ×7 TUs, namespace lines, CMake) | ≈ +180 | ≈ +50 |

A moves ≈ 1,730 lines (§1.4 ≈ 674, §2.3 ≈ 321, §3.3 ≈ 524, §4.3 ≈ 209) to delete ≈ 15. C moves ≈
325 and deletes ≈ 40. Every deletion in C is available to A, but A's note does not list it, and a
reviewer verifying 1,730 dimmed lines under `--color-moved` has less attention left for the lines
that actually go.

**Timing tests (D34, D31).** Precisely: the gate builds Release (`gate.sh:39`), no LTO, so moving
`sendBatch` out of the TU changes the inlining context of the republish path
(`startContinuousLoop:616-662 → emit → sendBatch`) in A *and* C. What C gains is narrower and
real: `SequencerService.cpp` and `ControllerService.cpp` are byte-identical, so `hold_rules`,
`script_states`, `sequencer_concurrency`, `abort_ordering` and `t7_integration` see identical
codegen there, and a CI-only red on `actuator_delays`/`script_positions`/`script_runtime` bisects
to one 115-line move instead of seven TUs. If D31's 10× rule triggers, the pre-WP comparison has
one variable.

**Harness exposure — correcting §A's table.** It credits C with "only §7.3". With `_udp`, C needs
§7.2 too: `char_config_dump` lists `ActuatorCommander.cpp` by path
(`test/characterization/config/CMakeLists.txt:15-21`). So C = §7.2 (one TU) + §7.3; A = §7.2 (two
TUs) + §7.3. `_udp` is the piece I would trade first: it is what makes C formally subject to D-PF
("reproduce before WP10 moves sequencer code") and costs the 10 `lib/CMakeLists.txt` edits; the
position stands without it.

**S33's own clause.** "A cohesive file over the line stays whole." `SequencerService.cpp` is one
class whose `config_mutex_` threads through all four "concerns": `applyConfig` writes the fifteen
unguarded fields `doTransitionTo` and `notifyControllerFireOnce` read (§1.5), `publishState`
takes the mutex `doTransitionTo` holds (`:717`, `:1130`), `init:570-623` calls all of them in a
frozen order. Splitting by concern separates functions from the fields they own; the object and
its lock map stay the same size. §1.5 is the cost: a section on cross-TU lock-holding chains that
do not exist today.

**Abort cohesion (D42 binding 1).** A satisfies the binding; I do not claim otherwise. The narrower
point: A moves `publishState` to `_elodin.cpp`, so the C4-1 chain becomes cross-file, and research
structural choice 4 (the lock-contract comment) exists to compensate. In C the comment is still
worth writing, but nothing depends on it. Conceded: `:717` and `:1130` are 400 lines apart either
way.

**`register_all_tables` stays** in C: `subscription-robustness.md:88` names it as the site a later
D-SLOT injectivity check lands in, and it is the only genuine duplicate in the four files.

## 3. Real deletions (cleanup pass, each with its proof)

`git grep` over all of `daq-server/`: zero references outside `ControllerService.{hpp,cpp}`; only
DESIGN-WP10 §3.2 mentions them.

| what | lines | observable? |
|---|---|---|
| `getLastActuation`, `getLastDiagnostics` | hpp:138-140, cpp:373-382 | no caller anywhere; `fsw_daq_lib` exports two fewer symbols |
| `setNavState` | hpp:92, cpp:245-248 | no caller; `current_nav_` stays (read `:322`, `:558`) |
| `output_mutex_`, `last_actuation_`, `last_diagnostics_` and the store block | hpp:221-223, cpp:703-708 | write-only once the getters go; removes one uncontended lock/unlock per 10 Hz tick — unobservable, listed separately so a reviewer can take the getters without this |

§3.3 says `ControllerService.hpp` is unchanged, but gives no harness reason (unlike AC §7.2 and
Seq §1.4's destruction order); removing a mutex and two PODs changes no order anything observes.
Proof: `nm -C fsw_daq_lib` before/after differs in exactly three symbols; `service_pwm.txt` and
`controller__*` green.

Not a deletion, deliberately: daq_bridge's three config parses (`:169`, `:377`, `:558`).
`fsw::config::load` prints `[Config] ERROR` for slot > 8 on every parse (`Config.cpp:49-53`);
board 60 is slot 10 and H2 greps that line. Collapsing changes stderr. Parked.

## 4. Later fixes

Research "Structural choices" 1-5 hold by not moving anything: C4-1's 5-line hoist (Idea 1), the
single `triggerAbort` (Idea 4), `cancelPendingStages` (Idea 3) and `enqueueUrgent` (Idea 2a) are
each a one-file diff against one golden. Idea 5 edits the header in both options.
`register_all_tables` is where D-SLOT's check lands (D42 binding 3).

## 5. Concessions

`SequencerService_controller_notify.cpp` (`:995-1114`: a TCP client on the hold-timer thread,
touching no sequencer mutex) and `ControllerService_elodin.cpp` (`:754-1107`, no control-path
double) are the two splits with genuine merit: no lock crosses them, D22 untouched. If the judge
takes A, those two carry it; `_config` and `_pwm` do not. A's `using namespace` removal is a
deletion C cannot make.

## 6. Objections

1. **"BLOAT-MAP's DoD says no `.cpp` > 700; C leaves 1295, 1160 and ≈714."** D39 already waived
   WP9's `main < 400`; S33 says targets, not gates, and names the cohesive exception. Record the
   waiver with its reason rather than meet a number by moving code.
2. **"Four concerns, four threads, four reviewers."** The thread map is `SequencerService.hpp:167-283`
   and §1.2, not file boundaries; a reviewer of `notifyControllerFire` reads 120 lines either way.
   Partial concession: `_controller_notify` is where boundary and thread coincide.
3. **"C is D45(3)'s fallback; choosing it pre-empts CI."** CI judges three timing tests only after
   the fact. Choose on merits now (review budget, bisectability, deletions) and keep A's two good
   TUs (§5) as a later, separately gated item.
