#include "control/SequencerService.hpp"

#include <arpa/inet.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <poll.h>
#include <sys/socket.h>
#include <unistd.h>

#include <array>
#include <cerrno>
#include <chrono>
#include <cstring>
#include <fstream>
#include <iostream>
#include <optional>
#include <sstream>
#include <thread>

#include "comms/CommsMessage.hpp"
#include "config/Config.hpp"
#include "config/LoadActiveBoards.hpp"
#include "elodin/DatabaseConfig.hpp"
#include "net/DaqInterface.hpp"

namespace sequencer {

// ─────────────────────────────────────────────────────────────────────────────
SequencerService::~SequencerService() {
    // Drain order matters. Stop accepting work first, then let the worker finish what it holds,
    // and only then tear down the things a command body touches — otherwise the worker can be
    // mid-transition while fire_manager_ is being destroyed under it.
    cmd_queue_.stop();

    stopElodinRetry();
    actuator_commander_.stopContinuousLoop();
    hold_timer_.stop();
}

// ─────────────────────────────────────────────────────────────────────────────
// Command queue
// ─────────────────────────────────────────────────────────────────────────────
bool SequencerService::enqueueAndWait(CommandQueue::Body fn, std::string* refusal_reason,
                                      bool cancellable) {
    const CommandQueue::Reply r = cmd_queue_.submit(std::move(fn), cancellable);
    // The body wrote its reason into the queue's storage, not the caller's: on kPending it may
    // still be running after this returns (CommandQueue.hpp).
    if (refusal_reason && !r.ok)
        *refusal_reason = r.reason;
    return r.outcome == CommandQueue::Outcome::kDone && r.ok;
}

void SequencerService::enqueueDetached(CommandQueue::Body fn) {
    cmd_queue_.post(std::move(fn));
}

// ─────────────────────────────────────────────────────────────────────────────
bool SequencerService::init(const std::string& config_path) {
    loadConfig(config_path);
    const fsw::config::Config cfg = fsw::config::load_from_string(config_content_);

    if (!applyConfig(cfg))
        return false;

    // Snapshot the actuator board list now, while we are reading config for the first and only
    // time. tryConnectElodin() re-registers VTables on every reconnect and must not go back to
    // disk for this (see the comment there).
    {
        const auto boards_map = fsw::config::load_active_boards(config_path_);
        const auto it_act = boards_map.find(fsw::config::ActiveBoardKind::ACTUATOR);
        actuator_boards_ = (it_act != boards_map.end()) ? it_act->second
                                                        : std::vector<fsw::elodin::BoardChannels>{};
        const auto it_bv = boards_map.find(fsw::config::ActiveBoardKind::BALL_VALVE);
        ball_valve_boards_ =
            (it_bv != boards_map.end()) ? it_bv->second : std::vector<fsw::elodin::BoardChannels>{};
    }

    // Elodin — connection is best-effort; service runs without it
    elodin_host_ = "127.0.0.1";
    elodin_port_ = cfg.database.port;
    if (!tryConnectElodin()) {
        std::cerr << "[SequencerService] Cannot connect to Elodin yet — retrying every "
                  << kElodinRetrySeconds << "s in the background" << std::endl;
    }
    // The connect above used to be one-shot. Losing the startup race with elodin-db (systemd
    // starts the units together) meant the ACT_CMD VTables were never registered and
    // publishCommandedState() early-returned forever, so every valve read "undefined" in the GUI
    // while UDP commands still went out — data flowing, dots grey. Retry until it takes.
    startElodinRetry();

    current_state_ = StateMachine::bootState();
    // Publish initial state so any already-connected backend/GUI knows we started at IDLE.
    publishState();
    // Command IDLE actuators and keep resending so manual debug clicks cannot stick vs CSV.
    // is_transition=true because this IS the entry into the boot state; the loop that follows is
    // only the republisher. See the note in transitionTo — the two must not both claim the entry.
    actuator_commander_.applyForState(current_state_.load(), /*is_transition=*/true);
    actuator_commander_.startContinuousLoop(current_state_.load(), /*allow_delays=*/false);

    // Start the command worker last. Everything above runs on the caller's thread before any
    // command can be accepted, so init() needs no serialization of its own — and starting the
    // worker earlier would let a command run against a half-initialized service.
    cmd_queue_.start(queue_options_);

    std::cout << "[SequencerService] Initialized. Current state: "
              << StateMachine::name(current_state_.load()) << std::endl;
    return true;
}

// ─────────────────────────────────────────────────────────────────────────────
bool SequencerService::isAbortState(State s) {
    // Config-declared (`is_abort`), falling back to the built-in trio when a config omits them.
    // This used to be a hardcoded three-way enum comparison, which meant a stand that renamed or
    // added an abort state got no physical abort broadcast for it.
    return StateMachine::isAbort(s);
}

// ─────────────────────────────────────────────────────────────────────────────
bool SequencerService::transitionTo(const std::string& state_name) {
    return transitionTo(state_name, 0);
}

bool SequencerService::transitionTo(const std::string& state_name, uint32_t requested_hold_ms,
                                    std::string* refusal_reason) {
    // Resolve on the worker; the state the worker resolves is the one that runs. The caller
    // only asks whether the name is an abort, to keep an abort from being cancelled at the
    // deadline (isAbortStateName). The body reports into the queue's reason, never the caller's
    // refusal_reason: on a pending reply the caller has returned while the body may still run.
    return enqueueAndWait(
        [this, state_name, requested_hold_ms](std::string* why) {
            State to = StateMachine::fromName(state_name);
            if (to == State::UNKNOWN) {
                std::cerr << "[SequencerService] Unknown state: " << state_name << std::endl;
                *why = "unknown state";
                return false;
            }
            return doTransitionTo(to, requested_hold_ms, why);
        },
        refusal_reason, !isAbortStateName(state_name));
}

bool SequencerService::transitionTo(const std::string& state_name, uint32_t requested_hold_ms,
                                    const ValvePlan& plan, std::string* refusal_reason) {
    // The plan is captured BY VALUE and the pointer handed on points at that copy, which lives in
    // the queued command as long as the body can run — a copy rather than a reference because a
    // caller is free to let its own plan die the moment this returns (and on a pending reply it
    // returns before the body has finished).
    return enqueueAndWait(
        [this, state_name, requested_hold_ms, plan](std::string* why) {
            State to = StateMachine::fromName(state_name);
            if (to == State::UNKNOWN) {
                std::cerr << "[SequencerService] Unknown state: " << state_name << std::endl;
                *why = "unknown state";
                return false;
            }
            return doTransitionTo(to, requested_hold_ms, why, plan.empty() ? nullptr : &plan);
        },
        refusal_reason, !isAbortStateName(state_name));
}

bool SequencerService::transitionTo(State to) {
    return transitionTo(to, 0);
}

bool SequencerService::transitionTo(State to, uint32_t requested_hold_ms,
                                    std::string* refusal_reason) {
    return enqueueAndWait(
        [this, to, requested_hold_ms](std::string* why) {
            return doTransitionTo(to, requested_hold_ms, why);
        },
        refusal_reason, !isAbortState(to));
}

bool SequencerService::isAbortStateName(const std::string& state_name) const {
    const State s = StateMachine::fromName(state_name);
    return s != State::UNKNOWN && isAbortState(s);
}

/**
 * How long the state is held so that the REFERENCE VALVE is open for the requested duration.
 *
 * A pure function of the three numbers, called from the validation below and again when the hold
 * is armed, because those two must agree: the validation refuses a plan whose valves open after
 * the window ends, and a different arithmetic in the arming would refuse against one window and
 * then run another.
 */
static uint32_t holdWindowMs(uint32_t requested_ms, uint32_t open_delay_ms,
                             uint32_t close_delay_ms) {
    const int64_t want = static_cast<int64_t>(requested_ms) + static_cast<int64_t>(open_delay_ms) -
                         static_cast<int64_t>(close_delay_ms);
    // Clamp rather than wrap: unsigned underflow here would become a ~49-day hold, valves open.
    return want > 0 ? static_cast<uint32_t>(want) : 1;
}

SequencerService::HoldReference SequencerService::holdReferenceFor(State to, const HoldRule& rule,
                                                                   const ValvePlan* plan) const {
    const std::string state_name = StateMachine::name(to);
    const std::string ret_name =
        rule.return_state != State::UNKNOWN ? StateMachine::name(rule.return_state) : std::string();

    // What a valve's entry delay actually is on this run: the plan's if it names it, the CSV's
    // otherwise. Only the ENTRY side can be retimed — the close happens in the return state, which
    // no plan describes, so its stagger always comes from the CSV.
    auto open_ms = [&](const std::string& role) -> uint32_t {
        if (plan) {
            const auto ov = plan->find(role);
            if (ov != plan->end())
                return ov->second.hold_shut ? 0u : ov->second.delay_ms;
        }
        return static_cast<uint32_t>(actuator_commander_.delayForRole(state_name, role) * 1000.0 +
                                     0.5);
    };
    auto close_ms = [&](const std::string& role) -> uint32_t {
        if (ret_name.empty())
            return 0u;
        return static_cast<uint32_t>(actuator_commander_.delayForRole(ret_name, role) * 1000.0 +
                                     0.5);
    };
    auto held_shut = [&](const std::string& role) {
        if (!plan)
            return false;
        const auto ov = plan->find(role);
        return ov != plan->end() && ov->second.hold_shut;
    };

    HoldReference ref;
    if (!rule.gate_actuator.empty() && !held_shut(rule.gate_actuator)) {
        ref.role = rule.gate_actuator;
        ref.open_delay_ms = open_ms(ref.role);
        ref.close_delay_ms = close_ms(ref.role);
        return ref;
    }
    if (rule.gate_actuator.empty())
        return ref;  // no gate configured: the window is the STATE's, as it always was

    // The gate is held shut. Measure on the first valve that does open instead, so the requested
    // duration still means "how long the thing being characterized was open". Ties break on the
    // name only to make the choice deterministic — it is logged, and two valves opening together
    // give the same window either way.
    for (const auto& [role, pos] : actuator_commander_.positionsForState(state_name)) {
        if (pos != 1 || held_shut(role))
            continue;
        const uint32_t d = open_ms(role);
        if (ref.role.empty() || d < ref.open_delay_ms) {
            ref.role = role;
            ref.open_delay_ms = d;
            ref.close_delay_ms = close_ms(role);
        }
    }
    return ref;
}

bool SequencerService::doTransitionTo(State to, uint32_t requested_hold_ms,
                                      std::string* refusal_reason, const ValvePlan* plan) {
    State from = current_state_.load();

    HoldRule rule;
    bool has_rule = false;
    {
        std::lock_guard<std::mutex> lk(config_mutex_);
        const auto it = hold_rules_.find(to);
        if (it != hold_rules_.end()) {
            rule = it->second;
            has_rule = true;
        }
    }

    // Validate a client-supplied hold BEFORE anything moves — before the overrides are cleared,
    // before the resend loop stops, before a single actuator is commanded. A refusal has to leave
    // the rig exactly where it was: the WebSocket client queues commands while its socket is down
    // and replays them on reconnect, so a stale "burn for 60 s" must be a no-op, not a transition
    // that then runs for some other length.
    if (requested_hold_ms != 0) {
        const char* why = nullptr;
        if (!has_rule)
            why = "state is not holdable";
        else if (!rule.gui_settable)
            why = "duration not permitted for this state";
        else if (requested_hold_ms > rule.max_ms)
            why = "duration exceeds max";

        if (why) {
            std::cerr << "[SequencerService] Refused " << requested_hold_ms << " ms hold on "
                      << StateMachine::name(to) << ": " << why << std::endl;
            if (refusal_reason) {
                *refusal_reason = why;
                if (std::string(why) == "duration exceeds max")
                    *refusal_reason += " (" + std::to_string(rule.max_ms) + " ms)";
            }
            // Republish so a client that moved its own display in anticipation is corrected —
            // the same courtesy the ordinary refusal path below extends.
            publishState();
            return false;
        }
    }

    // Validate a per-run valve plan on the same terms, in the same place, and for the same reason
    // as the hold above: before the abort broadcast, before the overrides are cleared, before the
    // resend loop stops, before a single valve moves. A refused plan leaves the rig exactly where
    // it was — never a transition that then runs some other valve timing than the one asked for.
    if (plan && !plan->empty()) {
        std::string why;
        if (!has_rule || !rule.gui_settable) {
            // The same gate the client-settable duration passes. The burn state is never
            // gui_settable, so no frame can retime the valves of a burn.
            why = "valve plan not permitted for this state";
        } else {
            const std::string to_name = StateMachine::name(to);
            const auto positions = actuator_commander_.positionsForState(to_name);
            size_t opening = 0;
            for (const auto& [role, pos] : positions)
                if (pos == 1)
                    ++opening;
            for (const auto& [role, ov] : *plan) {
                const auto it = positions.find(role);
                if (it == positions.end()) {
                    why = "\"" + role + "\" is not an actuator " + to_name + " commands";
                    break;
                }
                if (it->second != 1) {
                    // A plan may only ever move a valve towards shut. Retiming a CLOSE would hold
                    // a valve OPEN inside a state whose column shuts it — a flow path the config
                    // does not have, invented by a client.
                    why = "\"" + role + "\" is not opened by " + to_name +
                          " — a plan can only retime or hold shut a valve the state opens";
                    break;
                }
                if (ov.hold_shut)
                    --opening;
            }
            if (why.empty() && opening == 0)
                why = "the plan holds every valve shut — nothing would flow";
            if (why.empty()) {
                // A valve asked to open at or after the end of the window never opens at all: the
                // expiry transition bumps the schedule generation and its pending stage is
                // abandoned. Nothing is stranded, but the operator would weigh a catch believing
                // both sides flowed, so it is refused rather than logged.
                const HoldReference ref = holdReferenceFor(to, rule, plan);
                const uint32_t hold =
                    holdWindowMs(requested_hold_ms != 0 ? requested_hold_ms : rule.default_ms,
                                 ref.open_delay_ms, ref.close_delay_ms);
                for (const auto& [role, ov] : *plan) {
                    if (ov.hold_shut || ov.delay_ms < hold)
                        continue;
                    why = "\"" + role + "\" would open at " + std::to_string(ov.delay_ms) +
                          " ms, at or after the " + std::to_string(hold) + " ms window ends";
                    break;
                }
            }
        }

        if (!why.empty()) {
            std::cerr << "[SequencerService] Refused valve plan on " << StateMachine::name(to)
                      << ": " << why << std::endl;
            if (refusal_reason)
                *refusal_reason = why;
            publishState();
            return false;
        }
    }

    // A state whose script did not load is not enterable — checked here, beside the other
    // validations, so a refusal leaves the rig exactly where it was: before the abort broadcast,
    // before overrides are cleared, before the resend loop stops, before a single valve moves.
    //
    // Deliberately NOT gated on debug_mode_. Debug mode relaxes which transitions are allowed; it
    // does not conjure a script that failed to parse. There is nothing for the sequencer to run.
    //
    // The reason is copied out under config_mutex_ and the refusal is handled after the lock is
    // released. publishState() takes config_mutex_ itself, and a std::mutex cannot be locked twice
    // by one thread: calling it inside this block wedged the command worker for good, so every
    // later command (aborts included) timed out after 10 s and SIGTERM could not stop the process.
    // Nothing that takes config_mutex_ may be called while this function holds it.
    std::optional<std::string> refused_why;
    {
        std::lock_guard<std::mutex> lk(config_mutex_);
        const auto it = refused_states_.find(to);
        if (it != refused_states_.end())
            refused_why = it->second;
    }
    if (refused_why) {
        std::cerr << "[SequencerService] Refused entry to " << StateMachine::name(to) << ": "
                  << *refused_why << std::endl;
        // The stored reason, not a generic one. The caller's copy is what reaches the
        // operator's notification, and "state script rejected at load" told them nothing
        // they could act on while the specific fault sat here unused.
        if (refusal_reason)
            *refusal_reason = *refused_why;
        publishState();
        return false;
    }

    // A script that reads a sensor is checked for a fresh, calibrated reading BEFORE the
    // transition commits, not when the script first evaluates pressure(). The operator is then
    // told at the moment they press the button — naming the sensor — instead of twenty-five
    // seconds into a press that was never going to work. The interpreter's own check stays as the
    // backstop for a feed that dies while a script is already running.
    //
    // This is the house "refuse up front so the valve never opens" pattern, applied to sensors.
    {
        std::unique_lock<std::mutex> lk(config_mutex_);
        const auto it = dynamic_states_.find(to);
        if (it != dynamic_states_.end()) {
            const std::vector<std::string> roles = it->second.pressure_roles;
            const std::string state_name = it->second.name;
            lk.unlock();
            for (const auto& role : roles) {
                double psi = 0.0;
                const auto status = pressure_feed_.read(role, psi);
                if (status == PressureFeed::Status::Ok)
                    continue;
                std::cerr << "[SequencerService] Refused entry to " << state_name << ": "
                          << PressureFeed::explain(role, status) << std::endl;
                // The same sentence the log gets. This used to flatten all four outcomes —
                // NoReading, Stale, Uncalibrated, NotSubscribed — into one string, so the
                // operator could not tell a sensor that never arrived from one that went stale
                // or was never calibrated, which are three different things to go and fix.
                if (refusal_reason)
                    *refusal_reason = PressureFeed::explain(role, status);
                publishState();
                return false;
            }
        }
    }

    if (!debug_mode_) {
        if (!state_machine_.isAllowed(from, to)) {
            if (refusal_reason)
                *refusal_reason = "transition rejected";
            std::cerr << "[SequencerService] Transition " << StateMachine::name(from) << " → "
                      << StateMachine::name(to) << " is not allowed" << std::endl;
            // Republish the state we are actually in. A refusal used to publish nothing, so a
            // client that had moved its own display in anticipation was never corrected and went
            // on showing a state the rig had refused to enter — the failure was invisible, which
            // is worse than the failure. Publishing on the way out also resyncs any client that
            // drifted for some other reason.
            publishState();
            return false;
        }
    }

    // Physical abort broadcast FIRST — before any of the bookkeeping below.
    //
    // This used to sit after stopContinuousLoop(), fire_manager_.stop() and applyForState(), which
    // meant the boards' abort packet queued behind: a join of the republish thread (up to 100 ms),
    // a TCP round-trip to controller_service (previously unbounded — see notifyControllerFire),
    // and a full actuator batch. Every one of those is the sequencer's own housekeeping, and none
    // of it is a precondition for telling the boards to abort. The boards' independent abort logic
    // is the last line of defence on this rig; it must not wait on the process that is, by
    // definition, in the middle of something going wrong.
    //
    // triggerAbort() sends immediately and schedules ABORT_DONE on its own thread, so this does
    // not block the transition either.
    //
    // Once per abort, here and nowhere else. It used to be called a second time near the end of
    // this function, so every abort sent two ABORT bursts, and the second call joined the first's
    // ABORT_DONE thread, which held the abort state's publish back by up to one 50 ms step.
    //
    // abort -> abort (an escalation such as Engine Abort -> GSE Abort, or a self-transition) sends
    // no second burst and leaves the pending ABORT_DONE alone: the boards are already aborted. The
    // new state's column is still applied below. abort_latched_ clears on entry to any non-abort
    // state, so the next abort after that broadcasts again.
    const bool entering_abort = isAbortState(to);
    if (entering_abort && !abort_latched_) {
        abort_broadcaster_.triggerAbort();
        abort_latched_ = true;
    } else if (!entering_abort) {
        abort_latched_ = false;
    }

    // Then cancel whatever the state being left still had staged. The abort's column goes out with
    // is_transition=false, which does not supersede a pending schedule by itself: without this a
    // stage of the previous state landed after the abort's batch (a valve moving the pre-abort way
    // after the abort), and the abort's batch skipped every role that stage was still holding.
    if (entering_abort)
        actuator_commander_.cancelPendingStages();

    // Silence the strongest writer first.
    //
    // A script is a source of valve commands running on its own thread. If it were still alive
    // when applyForState() below commands the new state's column, its next open_valve would land
    // AFTER those positions and strand a valve open in a state whose CSV says CLOSE. Joining here
    // makes "no script statement can execute past this point" a structural fact rather than a
    // timing hope.
    //
    // After the abort broadcast, though — stop() joins a thread, and the boards' abort packet must
    // not queue behind the sequencer's own housekeeping (test_abort_ordering asserts < 200 ms).
    // And after the two validation gates above, which return early: a REFUSED transition must not
    // kill a script that is running perfectly well.
    script_runner_.stop();

    // New state wins over debug manual actuator overrides, and over the positions a script had
    // taken ownership of. Both are cleared here rather than when the script stops, so a script
    // that ended on its own still has its valves handed back to the incoming state's column.
    actuator_commander_.clearAllManualOverrides();
    actuator_commander_.clearScriptPositions();

    // Stop current continuous loop before applying the new state
    actuator_commander_.stopContinuousLoop();

    // A hold belongs to the state it was armed in, so any move ends it. Unconditional because
    // stop() is a no-op when nothing is running, and because start() below stops first anyway —
    // which is what makes re-entering a held state restart its window rather than stack a second.
    hold_timer_.stop();

    // Apply actuator commands for new state.
    //
    // is_transition=true is what makes this run the delays CSV as a staged schedule instead of
    // dumping every actuator at t=0. It used to be omitted, and the parameter defaults to false —
    // "this is the 1 Hz republish, send settled positions". So this call shipped the whole state
    // at once, and the staged schedule that startContinuousLoop kicked off below then re-commanded
    // valves that were already in position. Every configured delay was inert: parsed, logged as
    // "Sent 1 commands (+1s)", and completely without effect on any state on any profile, the
    // 80 ms fuel lead in default/server's Fire column included. The default argument is why it was
    // invisible — omitting it compiled clean and read exactly like the pre-delay call it once was.
    actuator_commander_.applyForState(to, /*is_transition=*/!isAbortState(to), plan);

    // Arm the hold HERE, immediately after the valves are commanded, rather than at the end of the
    // transition: the window the operator asked for is the one between the open and the close, and
    // everything below (the resend thread spawn, the Elodin publishes) would otherwise be counted
    // inside it.
    if (has_rule && rule.return_state != State::UNKNOWN) {
        // The requested duration is what the REFERENCE valve should be open for, so the state is
        // held for that valve's stagger plus the duration. Without this, a 1 s request on a state
        // whose main opens 1 s late would close everything exactly as the main opened — zero flow.
        //
        // The reference is the configured gate, unless this run's plan retimed it or held it shut
        // (see holdReferenceFor). Resolved here rather than read from the rule because a plan is a
        // property of this entry, not of the config the rule was built from.
        const uint32_t requested = requested_hold_ms != 0 ? requested_hold_ms : rule.default_ms;
        const HoldReference ref = holdReferenceFor(to, rule, plan);
        // Both staggers. The entry delay pushes the valve's opening later, so the state must be
        // held longer; the return state's delay keeps it open past the expiry transition, so the
        // state must be held that much less. Net: hold = requested + open - close.
        const uint32_t hold_ms = holdWindowMs(requested, ref.open_delay_ms, ref.close_delay_ms);
        if (ref.close_delay_ms >= requested + ref.open_delay_ms)
            std::cerr << "[SequencerService] Close delay (" << ref.close_delay_ms
                      << " ms) swallows the requested " << requested
                      << " ms window — holding 1 ms. Fix the delays CSV." << std::endl;
        if (plan && !plan->empty())
            std::cout << "[SequencerService] Valve plan on " << StateMachine::name(to)
                      << ": window measured on \""
                      << (ref.role.empty() ? std::string("(the state)") : ref.role) << "\" (+"
                      << ref.open_delay_ms << " ms / -" << ref.close_delay_ms << " ms), holding "
                      << hold_ms << " ms" << std::endl;
        const State return_state = rule.return_state;
        // The controller is told a burn started only when it owns the valves. When the sequencer
        // owns them there is no notifier at all rather than a suppressed one — nothing to forget
        // to check — and a flow hold never has one regardless.
        const bool notify_controller = (to == fire_state_) && !sequencer_owns_valves_;
        hold_timer_.start(HoldSpec{hold_ms, rule.extended_ms,
                                   [this, return_state]() {
                                       // Timer thread. Resolve to a State rather than a name: the
                                       // old code round-tripped through
                                       // StateMachine::name(State::ARMED) → fromName(), so renaming
                                       // the state made fromName() return UNKNOWN and the
                                       // transition was refused — stranding the system in fire with
                                       // the timer already stopped.
                                       //
                                       // Detached, never enqueueAndWait: this runs on the hold
                                       // timer's own thread, and the worker handling the expiry
                                       // transition calls hold_timer_.stop(), which joins this very
                                       // thread. Waiting here would be a guaranteed deadlock — the
                                       // worker waiting on the join, this thread waiting on the
                                       // worker — and it would strand the rig in the held state
                                       // with the gate valve open.
                                       enqueueDetached([this, return_state](std::string*) {
                                           return doTransitionTo(return_state);
                                       });
                                   },
                                   notify_controller
                                       ? std::function<void(bool)>([this](bool active) {
                                             notifyControllerFire(active);
                                         })
                                       : nullptr,
                                   StateMachine::name(to)});
    }

    // Start continuous re-send loop for new state.
    // allow_delays=false: the entry above already ran the schedule, so this loop is purely the
    // 1 Hz republish. Letting it claim the entry as well would bump the schedule generation and
    // cancel the stages the line above just armed. It still skips a role whose delay is pending,
    // so the board holds its pre-transition position until that role's stage fires.
    // (Abort states got their immediate apply above via isAbortState; an abort must not sit behind
    // a timer. The physical UDP abort broadcast already went out at the top of this function.)
    // defer_first_pass for a dynamic state: its script begins commanding valves a moment from now,
    // and an immediate (redundant) republish pass would race it — losing, because it resolves
    // positions and only then spends milliseconds on retransmits. The column was already applied
    // above, so deferring costs nothing and closes the window.
    bool to_is_dynamic = false;
    {
        std::lock_guard<std::mutex> lk(config_mutex_);
        to_is_dynamic = dynamic_states_.count(to) > 0;
    }
    actuator_commander_.startContinuousLoop(to, /*allow_delays=*/false,
                                            /*defer_first_pass=*/to_is_dynamic);

    // Update current state
    current_state_ = to;

    // The script starts AFTER current_state_ = to, and that ordering is load-bearing. A script
    // whose first statement is transition_to(X) posts that move immediately; doTransitionTo then
    // validates it with isAllowed(from, X), and if current_state_ were still the PREVIOUS state,
    // it would be checking a transition from somewhere the rig is no longer. Starting here also
    // makes elapsed() measure from actual state entry rather than from part-way through one.
    //
    // Copied out and started after config_mutex_ is released: ScriptRunner::start() stops (joins)
    // any run still in flight, and nothing that can block belongs under config_mutex_.
    std::optional<DynamicState> script;
    {
        std::lock_guard<std::mutex> lk(config_mutex_);
        const auto it = dynamic_states_.find(to);
        if (it != dynamic_states_.end())
            script = it->second;
    }
    if (script)
        script_runner_.start(*script, makeScriptEnv(*script));

    // Elodin publishing
    publishStateTransition(from, to);
    publishState();

    std::cout << "[SequencerService] " << StateMachine::name(from) << " → "
              << StateMachine::name(to) << std::endl;
    return true;
}

// ─────────────────────────────────────────────────────────────────────────────
bool SequencerService::setDebugMode(bool enabled, std::string* refusal_reason) {
    return enqueueAndWait(
        [this, enabled](std::string*) {
            return doSetDebugMode(enabled);
        },
        refusal_reason);
}

bool SequencerService::doSetDebugMode(bool enabled) {
    debug_mode_ = enabled;
    if (!enabled)
        actuator_commander_.clearAllManualOverrides();
    std::cout << "[SequencerService] Debug mode: " << (enabled ? "ON" : "OFF") << std::endl;
    publishState();  // push updated debug_mode flag to GUI
    return true;
}

// ─────────────────────────────────────────────────────────────────────────────
bool SequencerService::manualActuator(const std::string& name, int pos,
                                      std::string* refusal_reason) {
    return enqueueAndWait(
        [this, name, pos](std::string* why) {
            return doManualActuator(name, pos, why);
        },
        refusal_reason);
}

bool SequencerService::doManualActuator(const std::string& name, int pos,
                                        std::string* refusal_reason) {
    if (!debug_mode_) {
        std::cerr << "[SequencerService] Manual actuator commands require debug mode" << std::endl;
        if (refusal_reason)
            *refusal_reason = "debug mode required";
        return false;
    }

    // Deliberately NOT blocked in a scripted state. A hand command there fights the script for a
    // valve, and the operator wins (see ActuatorCommander's precedence) — which is the right
    // answer for the person standing at the panel, even though the script has no way to notice.
    actuator_commander_.setManualOverride(name, pos);
    return actuator_commander_.sendSingleActuator(name, pos);
}

// ─────────────────────────────────────────────────────────────────────────────
bool SequencerService::extendFire(std::string* refusal_reason) {
    return enqueueAndWait(
        [this](std::string*) {
            return doExtendFire();
        },
        refusal_reason);
}

bool SequencerService::doExtendFire() {
    if (current_state_ != fire_state_) {
        std::cerr << "[SequencerService] EXTEND_FIRE ignored: not in FIRE state" << std::endl;
        return false;
    }
    return hold_timer_.extend();
}

ScriptEnv SequencerService::makeScriptEnv(const DynamicState& ds) {
    ScriptEnv env;
    env.state_name = ds.name;

    // Pair intent with immediacy, exactly as debug manual control does: the script position is
    // what survives the 1 Hz republish, and the single send is what makes the valve move now
    // rather than up to a second from now.
    env.set_valve = [this](const std::string& role, int pos) {
        actuator_commander_.setScriptPosition(role, pos);
        actuator_commander_.sendSingleActuator(role, pos);
    };

    // enqueueDetached, never enqueueAndWait. The worker that handles this transition calls
    // script_runner_.stop(), which joins the very thread making this call — waiting here would be
    // a guaranteed deadlock, and it would strand the rig in the dynamic state with the script's
    // valves wherever it left them. This is the same trap documented for the fire timer's expiry.
    env.transition = [this](State target) {
        enqueueDetached([this, target](std::string*) {
            return doTransitionTo(target);
        });
    };

    // Refusing is the whole point of the boolean. An uncalibrated PT publishes a smooth, plausible
    // 0.0 PSI, and a script that takes 90% of that for a target computes zero and then does
    // nothing at all — successfully, invisibly, while the operator believes the tank came up.
    env.read_pressure = [this](const std::string& role, double& psi) {
        const auto status = pressure_feed_.read(role, psi);
        if (status == PressureFeed::Status::Ok)
            return true;
        std::cerr << "[SequencerService] " << PressureFeed::explain(role, status) << std::endl;
        return false;
    };

    return env;
}

std::string SequencerService::scriptStatusReport() const {
    // Colons separate the fields, so a state name containing one would split a line. State names
    // come from [[states]] and the config editor; none of the shipped profiles contain a colon.
    // Substituted rather than rejected because a broken report must not be able to hide a refusal.
    auto sanitize = [](std::string s) {
        std::replace(s.begin(), s.end(), ':', ' ');
        std::replace(s.begin(), s.end(), '\n', ' ');
        return s;
    };

    std::string out;
    std::lock_guard<std::mutex> lk(config_mutex_);
    for (const auto& [st, ds] : dynamic_states_) {
        out += "SCRIPT:" + std::to_string(static_cast<int>(st)) + ":" + sanitize(ds.name) +
               ":OK:" + std::to_string(ds.program.stmts.size()) + ":" +
               std::to_string(ds.timeout_ms) + "\n";
    }
    for (const auto& [st, why] : refused_states_) {
        out += "SCRIPT:" + std::to_string(static_cast<int>(st)) + ":" +
               sanitize(StateMachine::name(st)) + ":REFUSED:" + sanitize(why) + "\n";
    }
    // BLOCKED is the other half of the story, and the half an operator meets far more often.
    // REFUSED is fixed at load; this is the live sensor gate, so it can appear and clear while
    // the rig is running and the reason has to be re-read rather than cached.
    for (const auto& [st, ds] : dynamic_states_) {
        for (const auto& role : ds.pressure_roles) {
            double psi = 0.0;
            const auto status = pressure_feed_.read(role, psi);
            if (status == PressureFeed::Status::Ok)
                continue;
            out += "SCRIPT:" + std::to_string(static_cast<int>(st)) + ":" + sanitize(ds.name) +
                   ":BLOCKED:" + sanitize(PressureFeed::explain(role, status)) + "\n";
            break;  // one reason is enough to explain a greyed button
        }
    }
    out += "END\n";
    return out;
}

}  // namespace sequencer
