#include "control/ScriptRunner.hpp"

#include <cmath>
#include <iomanip>
#include <iostream>
#include <map>
#include <sstream>
#include <string>

namespace sequencer {

using fsw::script::Expr;
using fsw::script::ExprKind;
using fsw::script::Op;
using fsw::script::ScriptProgram;
using fsw::script::Stmt;
using fsw::script::StmtKind;

namespace {

/** Total loop iterations across the whole script. The wall deadline is the real bound; this
 *  catches a tight loop that would otherwise spend the whole budget spinning. */
constexpr uint64_t kMaxIterations = 1000000;

/** Shortest delay actually honoured. A script cannot express delay(0) — the parser refuses it —
 *  but an expression can still evaluate to something tiny, and a sub-millisecond wait in a loop is
 *  a spin with extra steps. */
/**
 * How long the script waits before its first statement, so the state's own actuator column has
 * landed on the boards first.
 *
 * Both go out as UDP to the same board, but the boards poll one datagram per loop() and
 * hotfire_config.h sets LOOP_DELAY_MS = 10 — so the column's three retransmits alone take ~30 ms
 * to drain, and the script's first command queues behind them. Without this the valve a script
 * opens on its first line could be commanded up to ~40 ms late, or land while the column's own
 * CLOSE for that valve was still being consumed, which read on the stand as "the valve did not
 * open for as long as I asked for".
 *
 * Spent on the SCRIPT'S thread, deliberately, not in doTransitionTo: that runs on the command
 * worker, and sleeping there would delay every queued command behind it — an abort included,
 * against a budget test_abort_ordering pins at 200 ms. Here it costs the worker nothing, and
 * stop() still preempts it in well under a millisecond because sleep() waits on the condition
 * variable with the stop flag as its predicate.
 *
 * Comes out of the script's own timeout budget rather than extending it, the same way the rest of
 * the transition's overhead does — script_timeout_ms stays the wall-clock ceiling on the state.
 */
constexpr double kStartLeadInSeconds = 0.100;

constexpr double kMinDelaySeconds = 0.010;

/** How a statement ended. */
enum class Flow {
    Continue,
    /** transition_to ran, or something failed. Unwind everything; the thread is done. */
    Terminated,
};

}  // namespace

ScriptRunner::~ScriptRunner() {
    stop();
}

double ScriptRunner::elapsedSeconds() const {
    if (!active_.load())
        return 0.0;
    std::lock_guard<std::mutex> lk(mtx_);
    return std::chrono::duration<double>(Clock::now() - started_at_).count();
}

void ScriptRunner::start(const DynamicState& ds, ScriptEnv env) {
    // Re-entering a scripted state discards a run in flight and restarts from line 1 — including
    // its valve commands. On 2026-09-16 the backend sent TRANSITION:Dynamic Test twelve times in
    // 216 ms and each one re-entered, so the valve was commanded open twelve times in a fifth of
    // a second. That is worth a line in the journal: the discarded run leaves no other trace.
    if (active_.load()) {
        double ran_for = 0.0;
        {
            std::lock_guard<std::mutex> lk(mtx_);
            ran_for = std::chrono::duration<double>(Clock::now() - started_at_).count();
        }
        std::cerr << "[ScriptRunner] " << ds.name << ": re-entered while still running — "
                  << "discarding a run " << std::fixed << std::setprecision(2) << ran_for
                  << " s in and restarting from the top" << std::endl;
    }

    stop();  // supersede anything still running; also reaps its thread

    {
        std::lock_guard<std::mutex> lk(mtx_);
        started_at_ = Clock::now();
    }
    stop_ = false;
    active_ = true;
    // By value: the program cannot be mutated out from under a run, and there is no stored copy
    // for a later config load to leave stale.
    thread_ = std::thread(&ScriptRunner::run, this, ds, std::move(env));
}

void ScriptRunner::stop() {
    {
        std::lock_guard<std::mutex> lk(mtx_);
        stop_ = true;
    }
    cv_.notify_all();

    if (thread_.joinable()) {
        // Self-join guard, copied from HoldTimer for the same reason. It should be unreachable —
        // transition_to posts its work and unwinds rather than calling back in — but a future path
        // that stopped the runner from inside its own thread would otherwise be a std::terminate,
        // and that is the failure that used to kill the sequencer outright.
        if (thread_.get_id() == std::this_thread::get_id())
            thread_.detach();
        else
            thread_.join();
    }
    active_ = false;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The interpreter
// ─────────────────────────────────────────────────────────────────────────────────────────────
namespace {

/** Everything one run needs, so the recursive walk can be free functions over one struct. */
struct Interp {
    const ScriptProgram& prog;
    const DynamicState& ds;
    const ScriptEnv& env;
    std::atomic<bool>& stop;
    std::mutex& mtx;
    std::condition_variable& cv;
    ScriptRunner::Clock::time_point started_at;
    ScriptRunner::Clock::time_point deadline;

    std::map<std::string, double> vars;
    uint64_t iterations = 0;
    /** Completed passes of the outermost loop, and the last condition rendered — both exist so
     *  the end-of-run line can say how far it got and what the deciding numbers were. Without
     *  them a timeout and a loop that never ran are the same single word in the journal. */
    uint64_t loop_passes = 0;
    std::string last_condition;
    /** Set when something went wrong; names it for the log. */
    std::string error;

    /** Comparison operators, for the condition text in the log. Non-comparisons return null. */
    static const char* opText(Op op) {
        switch (op) {
            case Op::Lt:
                return "<";
            case Op::Le:
                return "<=";
            case Op::Gt:
                return ">";
            case Op::Ge:
                return ">=";
            case Op::Eq:
                return "==";
            case Op::Ne:
                return "!=";
            default:
                return nullptr;
        }
    }

    bool stopped() const {
        return stop.load();
    }

    double elapsed() const {
        return std::chrono::duration<double>(ScriptRunner::Clock::now() - started_at).count();
    }

    bool pastDeadline() const {
        return ScriptRunner::Clock::now() >= deadline;
    }

    /** Wait `seconds`, or until stopped / the deadline, whichever comes first.
     *  @return false if the run should end. */
    bool sleep(double seconds) {
        if (seconds < kMinDelaySeconds)
            seconds = kMinDelaySeconds;
        auto until = ScriptRunner::Clock::now() +
                     std::chrono::microseconds(static_cast<long long>(seconds * 1e6));
        if (until > deadline)
            until = deadline;
        std::unique_lock<std::mutex> lk(mtx);
        cv.wait_until(lk, until, [this] {
            return stop.load();
        });
        return !stop.load() && !pastDeadline();
    }

    /**
     * The condition's operands as text, e.g. "117.7 < 82.1".
     *
     * A probe, not part of evaluation: it re-evaluates the two sides and RESTORES `error`, so a
     * failing read here can never invent a run-ending error that the real evaluation did not
     * hit. Safe to repeat because expressions in this language have no side effects — pressure()
     * is a guarded map read of the latest sample, and there is no assignment inside an
     * expression. Returns empty for anything that is not a comparison, and the caller then
     * simply omits the parenthetical.
     */
    std::string describeCondition(int32_t idx) {
        if (idx < 0)
            return {};
        const Expr& e = prog.exprs[static_cast<size_t>(idx)];
        if (e.kind != ExprKind::Binary)
            return {};
        const char* op = opText(e.op);
        if (op == nullptr)
            return {};
        const std::string saved = error;
        double a = 0.0;
        double b = 0.0;
        const bool ok = eval(e.lhs, a) && eval(e.rhs, b);
        error = saved;
        if (!ok)
            return {};
        std::ostringstream os;
        os << std::fixed << std::setprecision(1) << a << ' ' << op << ' ' << b;
        return os.str();
    }

    // ── Expressions ──────────────────────────────────────────────────────────────────────────
    bool eval(int32_t idx, double& out) {
        if (idx < 0) {
            error = "malformed expression";
            return false;
        }
        const Expr& e = prog.exprs[static_cast<size_t>(idx)];
        switch (e.kind) {
            case ExprKind::Number:
                out = e.number;
                return true;

            case ExprKind::Var: {
                const std::string& name = prog.variables[static_cast<size_t>(e.var)];
                auto it = vars.find(name);
                if (it == vars.end()) {
                    // The parser refuses a read-before-assign on every path it can see, so this is
                    // a belt-and-braces case rather than a reachable one.
                    error = "variable '" + name + "' was read before it was assigned";
                    return false;
                }
                out = it->second;
                return true;
            }

            case ExprKind::Elapsed:
                out = elapsed();
                return true;

            case ExprKind::Pressure: {
                const std::string& role = ds.slug_names[static_cast<size_t>(e.slug)];
                if (!env.read_pressure) {
                    error = "pressure(" + role + ") is not available in this build";
                    return false;
                }
                double psi = 0.0;
                if (!env.read_pressure(role, psi)) {
                    // Deliberately fatal to the run. Continuing on a stale or uncalibrated reading
                    // is how a press loop ends up cycling a valve against a number that stopped
                    // moving, or computing a target of zero from a plausible-looking 0.0 PSI.
                    error = "no fresh calibrated reading for \"" + role + "\"";
                    return false;
                }
                out = psi;
                return true;
            }

            case ExprKind::Unary: {
                double v = 0.0;
                if (!eval(e.lhs, v))
                    return false;
                out = (e.op == Op::Neg) ? -v : (v != 0.0 ? 0.0 : 1.0);
                return true;
            }

            case ExprKind::Binary: {
                double a = 0.0;
                if (!eval(e.lhs, a))
                    return false;
                // Short-circuit, so `x != 0 and pressure(P) > x` does not read a sensor it does
                // not need — and so a guarded pressure read is actually guarded.
                if (e.op == Op::And && a == 0.0) {
                    out = 0.0;
                    return true;
                }
                if (e.op == Op::Or && a != 0.0) {
                    out = 1.0;
                    return true;
                }
                double b = 0.0;
                if (!eval(e.rhs, b))
                    return false;
                switch (e.op) {
                    case Op::Add:
                        out = a + b;
                        break;
                    case Op::Sub:
                        out = a - b;
                        break;
                    case Op::Mul:
                        out = a * b;
                        break;
                    case Op::Div:
                        if (b == 0.0) {
                            error = "division by zero";
                            return false;
                        }
                        out = a / b;
                        break;
                    case Op::Lt:
                        out = (a < b) ? 1.0 : 0.0;
                        break;
                    case Op::Le:
                        out = (a <= b) ? 1.0 : 0.0;
                        break;
                    case Op::Gt:
                        out = (a > b) ? 1.0 : 0.0;
                        break;
                    case Op::Ge:
                        out = (a >= b) ? 1.0 : 0.0;
                        break;
                    case Op::Eq:
                        out = (a == b) ? 1.0 : 0.0;
                        break;
                    case Op::Ne:
                        out = (a != b) ? 1.0 : 0.0;
                        break;
                    case Op::And:
                        out = (b != 0.0) ? 1.0 : 0.0;
                        break;
                    case Op::Or:
                        out = (b != 0.0) ? 1.0 : 0.0;
                        break;
                    default:
                        error = "unsupported operator";
                        return false;
                }
                if (!std::isfinite(out)) {
                    // A NaN reaching a comparison decides which branch opens a valve, by coin
                    // flip. Stop instead.
                    error = "arithmetic produced a non-finite value";
                    return false;
                }
                return true;
            }
        }
        error = "unsupported expression";
        return false;
    }

    // ── Statements ───────────────────────────────────────────────────────────────────────────
    Flow execBlock(int32_t begin, int32_t end) {
        for (int32_t k = begin; k < end; k++) {
            if (stopped())
                return Flow::Terminated;
            if (pastDeadline()) {
                error = "timeout";
                return Flow::Terminated;
            }
            const Flow f = exec(prog.block_items[static_cast<size_t>(k)]);
            if (f == Flow::Terminated)
                return f;
        }
        return Flow::Continue;
    }

    Flow exec(int32_t idx) {
        const Stmt& s = prog.stmts[static_cast<size_t>(idx)];
        switch (s.kind) {
            case StmtKind::Assign: {
                double v = 0.0;
                if (!eval(s.expr, v))
                    return Flow::Terminated;
                vars[prog.variables[static_cast<size_t>(s.var)]] = v;
                return Flow::Continue;
            }

            case StmtKind::OpenValve:
            case StmtKind::CloseValve: {
                const std::string& role = ds.slug_names[static_cast<size_t>(s.slug)];
                if (env.set_valve)
                    env.set_valve(role, s.kind == StmtKind::OpenValve ? 1 : 0);
                return Flow::Continue;
            }

            case StmtKind::Delay: {
                double seconds = 0.0;
                if (!eval(s.expr, seconds))
                    return Flow::Terminated;
                if (!(seconds > 0.0)) {
                    error = "delay(" + std::to_string(seconds) + ") is not a positive duration";
                    return Flow::Terminated;
                }
                if (!sleep(seconds)) {
                    if (!stopped())
                        error = "timeout";
                    return Flow::Terminated;
                }
                return Flow::Continue;
            }

            case StmtKind::TransitionTo: {
                const State target = ds.slug_states[static_cast<size_t>(s.slug)];
                if (target == State::UNKNOWN) {
                    error = "transition target did not resolve";
                    return Flow::Terminated;
                }
                std::cout << "[ScriptRunner] " << env.state_name << ": transition_to "
                          << StateMachine::name(target) << std::endl;
                if (env.transition)
                    env.transition(target);
                return Flow::Terminated;  // terminal by construction — unwind everything
            }

            case StmtKind::If: {
                double c = 0.0;
                if (!eval(s.expr, c))
                    return Flow::Terminated;
                if (c != 0.0)
                    return execBlock(s.body_begin, s.body_end);
                if (s.else_begin >= 0)
                    return execBlock(s.else_begin, s.else_end);
                return Flow::Continue;
            }

            case StmtKind::While: {
                bool announced = false;
                for (;;) {
                    if (stopped())
                        return Flow::Terminated;
                    if (pastDeadline()) {
                        error = "timeout";
                        return Flow::Terminated;
                    }
                    if (++iterations > kMaxIterations) {
                        error = "loop iteration budget exhausted";
                        return Flow::Terminated;
                    }
                    double c = 0.0;
                    if (!eval(s.expr, c))
                        return Flow::Terminated;

                    last_condition = describeCondition(s.expr);
                    const std::string paren =
                        last_condition.empty() ? std::string{} : " (" + last_condition + ")";

                    // Announce the entry decision once. A loop whose body never runs is otherwise
                    // indistinguishable in the journal from one that ran and finished, and the two
                    // mean opposite things: the first says the condition was already satisfied (or
                    // could never be), the second that the script did its work.
                    if (!announced) {
                        announced = true;
                        std::cout << "[ScriptRunner] " << env.state_name << ": while "
                                  << (c != 0.0 ? "true" : "false") << " at entry" << paren
                                  << (c != 0.0 ? " — entering loop"
                                               : " — body never runs, 0 iterations")
                                  << std::endl;
                    }
                    if (c == 0.0)
                        return Flow::Continue;

                    ++loop_passes;
                    // One line per pass. Loops are delay-bounded (a body with no delay() is
                    // refused at parse), so this cannot flood the journal.
                    std::cout << "[ScriptRunner] " << env.state_name << ": iteration "
                              << loop_passes << paren << std::endl;

                    const Flow f = execBlock(s.body_begin, s.body_end);
                    if (f == Flow::Terminated)
                        return f;
                }
            }
        }
        error = "unsupported statement";
        return Flow::Terminated;
    }
};

}  // namespace

void ScriptRunner::run(DynamicState ds, ScriptEnv env) {
    const auto t0 = Clock::now();
    Interp in{ds.program, ds,  env, stop_,
              mtx_,       cv_, t0,  t0 + std::chrono::milliseconds(ds.timeout_ms)};

    std::cout << "[ScriptRunner] " << env.state_name << ": start (timeout " << ds.timeout_ms
              << " ms, " << static_cast<int>(kStartLeadInSeconds * 1000) << " ms lead-in)"
              << std::endl;

    // Let the state's actuator column reach the boards before the first script statement.
    in.sleep(kStartLeadInSeconds);

    const Flow f = in.execBlock(ds.program.top_begin, ds.program.top_end);

    // Every ending below carries the same two facts: how far the script got, and what the
    // condition was doing when it ended. Without them "stopped" and "timeout" are bare words and
    // a run has to be reconstructed by correlating ActuatorCommander lines against the clock.
    const std::string progress =
        " after " + std::to_string(in.loop_passes) + " iteration(s)" +
        (in.last_condition.empty() ? std::string{} : ", condition " + in.last_condition);

    if (stop_.load()) {
        // Cancelled by a transition or an abort. It is not this script's business where the rig
        // goes next, and firing a landing transition here would fight the one already underway.
        std::cout << "[ScriptRunner] " << env.state_name << ": stopped by transition" << progress
                  << std::endl;
        active_ = false;
        return;
    }

    if (f == Flow::Terminated && in.error.empty()) {
        active_ = false;  // transition_to already posted its own move
        return;
    }

    if (!in.error.empty()) {
        // Every abnormal end lands on the timeout target, not the return target. The two are
        // separate fields precisely so a runaway can be sent somewhere more conservative than a
        // clean finish, and an error is the runaway case.
        std::cerr << "[ScriptRunner] " << env.state_name << ": " << in.error << progress
                  << " — going to " << StateMachine::name(ds.timeout_target) << std::endl;
        if (env.transition)
            env.transition(ds.timeout_target);
        active_ = false;
        return;
    }

    // Ran off the end without transitioning. The landing state is mandatory in config for exactly
    // this path, even when every branch ends in a transition_to — it is the backstop for the path
    // the author did not think about.
    std::cout << "[ScriptRunner] " << env.state_name << ": script complete" << progress
              << " — going to " << StateMachine::name(ds.return_target) << std::endl;
    if (env.transition)
        env.transition(ds.return_target);
    active_ = false;
}

}  // namespace sequencer
