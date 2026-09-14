#include "control/ScriptRunner.hpp"

#include <cmath>
#include <iostream>
#include <map>
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
    /** Set when something went wrong; names it for the log. */
    std::string error;

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
                    if (c == 0.0)
                        return Flow::Continue;
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
              << " ms)" << std::endl;

    const Flow f = in.execBlock(ds.program.top_begin, ds.program.top_end);

    if (stop_.load()) {
        // Cancelled by a transition or an abort. It is not this script's business where the rig
        // goes next, and firing a landing transition here would fight the one already underway.
        std::cout << "[ScriptRunner] " << env.state_name << ": stopped" << std::endl;
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
        std::cerr << "[ScriptRunner] " << env.state_name << ": " << in.error << " — going to "
                  << StateMachine::name(ds.timeout_target) << std::endl;
        if (env.transition)
            env.transition(ds.timeout_target);
        active_ = false;
        return;
    }

    // Ran off the end without transitioning. The landing state is mandatory in config for exactly
    // this path, even when every branch ends in a transition_to — it is the backstop for the path
    // the author did not think about.
    std::cout << "[ScriptRunner] " << env.state_name << ": script complete — going to "
              << StateMachine::name(ds.return_target) << std::endl;
    if (env.transition)
        env.transition(ds.return_target);
    active_ = false;
}

}  // namespace sequencer
