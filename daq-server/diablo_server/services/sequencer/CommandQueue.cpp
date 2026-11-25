#include "control/CommandQueue.hpp"

#include <exception>
#include <iostream>

namespace sequencer {

namespace {
/** The supervisor's check period. A wedge is reported within this much of the threshold. */
constexpr auto kSupervisorTick = std::chrono::milliseconds(100);
}  // namespace

int64_t CommandQueue::nowNs() {
    return std::chrono::duration_cast<std::chrono::nanoseconds>(
               std::chrono::steady_clock::now().time_since_epoch())
        .count();
}

CommandQueue::~CommandQueue() {
    stop();
}

void CommandQueue::start(const Options& opts) {
    opts_ = opts;
    {
        std::lock_guard<std::mutex> lk(mtx_);
        stop_ = false;
        started_ = true;
    }
    supervisor_stop_ = false;
    worker_ = std::thread([this]() {
        workerLoop();
    });
    supervisor_ = std::thread([this]() {
        supervisorLoop();
    });
}

void CommandQueue::stop() {
    {
        std::lock_guard<std::mutex> lk(mtx_);
        stop_ = true;
    }
    cv_.notify_all();
    if (worker_.joinable())
        worker_.join();
    supervisor_stop_ = true;
    if (supervisor_.joinable())
        supervisor_.join();
}

void CommandQueue::workerLoop() {
    for (;;) {
        std::shared_ptr<Entry> e;
        {
            std::unique_lock<std::mutex> lk(mtx_);
            cv_.wait(lk, [this] {
                return stop_ || !queue_.empty();
            });
            // Drain before exiting, as the inline queue this replaced did: a stop returns only
            // once what was accepted has run (or been cancelled by its waiter).
            if (stop_ && queue_.empty())
                return;
            if (queue_.empty())
                continue;
            e = std::move(queue_.front());
            queue_.pop_front();
        }

        // The claim. If the waiter got there first the command was reported as not executed, and
        // it must stay that way.
        uint8_t expected = kQueued;
        if (!e->state.compare_exchange_strong(expected, kRunning)) {
            std::cerr << "[SequencerService] skipping a command its caller cancelled at the "
                      << opts_.deadline.count() << " ms deadline — not executed" << std::endl;
            continue;
        }

        started_ns_.store(nowNs());
        bool ok = false;
        std::string reason;
        try {
            ok = e->body(&reason);
        } catch (const std::exception& ex) {
            std::cerr << "[SequencerService] command threw: " << ex.what() << std::endl;
        } catch (...) {
            std::cerr << "[SequencerService] command threw an unknown exception" << std::endl;
        }
        finished_ns_.store(nowNs());

        // Fulfilled on every path, including a throw, or a waiter sits out its whole bound on
        // what was an immediate failure.
        {
            std::lock_guard<std::mutex> lk(e->m);
            e->ok = ok;
            e->reason = std::move(reason);
            e->done = true;
        }
        e->cv.notify_all();
    }
}

CommandQueue::Reply CommandQueue::submit(Body body, bool cancellable) {
    auto e = std::make_shared<Entry>();
    e->body = std::move(body);
    e->queued_at = std::chrono::steady_clock::now();
    {
        std::lock_guard<std::mutex> lk(mtx_);
        if (stop_ || !started_)
            return Reply{Outcome::kStopped, false, "sequencer shutting down"};
        queue_.push_back(e);
    }
    cv_.notify_one();

    auto finished = [&](std::unique_lock<std::mutex>& lk, std::chrono::steady_clock::time_point t) {
        return e->cv.wait_until(lk, t, [&] {
            return e->done;
        });
    };

    std::unique_lock<std::mutex> lk(e->m);
    if (finished(lk, e->queued_at + opts_.deadline))
        return Reply{Outcome::kDone, e->ok, e->reason};

    if (cancellable) {
        uint8_t expected = kQueued;
        if (e->state.compare_exchange_strong(expected, kCancelled)) {
            std::cerr << "[SequencerService] command still queued after " << opts_.deadline.count()
                      << " ms (worker busy) — cancelled, it will not run" << std::endl;
            return Reply{Outcome::kCancelled, false,
                         "not executed: still queued after " +
                             std::to_string(opts_.deadline.count()) + " ms (sequencer busy)"};
        }
    }

    // The worker has claimed it (or it is an abort, which is never cancelled): its result is the
    // only true answer. Wait for it, but not forever — past the wedge threshold the supervisor is
    // already reporting the worker, and the caller is told the outcome is not known yet.
    if (finished(lk, std::chrono::steady_clock::now() + opts_.wedge_threshold))
        return Reply{Outcome::kDone, e->ok, e->reason};
    const bool still_queued = e->state.load() == kQueued;
    std::cerr << "[SequencerService] command " << (still_queued ? "still queued" : "still running")
              << " after its deadline plus " << opts_.wedge_threshold.count()
              << " ms — replying pending, outcome unknown" << std::endl;
    return Reply{Outcome::kPending, false,
                 still_queued ? "pending: still queued behind a busy worker; it will run"
                              : "pending: still running; outcome unknown"};
}

void CommandQueue::post(Body body) {
    auto e = std::make_shared<Entry>();
    e->body = std::move(body);
    e->queued_at = std::chrono::steady_clock::now();
    {
        std::lock_guard<std::mutex> lk(mtx_);
        if (stop_ || !started_)
            return;
        queue_.push_back(std::move(e));
    }
    cv_.notify_one();
}

CommandQueue::Health CommandQueue::health() const {
    Health h;
    h.wedged = wedged_.load();
    const int64_t s = started_ns_.load();
    const int64_t f = finished_ns_.load();
    if (s > f)
        h.busy_ms = static_cast<uint64_t>((nowNs() - s) / 1000000);
    return h;
}

void CommandQueue::supervisorLoop() {
    const int64_t threshold_ns =
        std::chrono::duration_cast<std::chrono::nanoseconds>(opts_.wedge_threshold).count();
    while (!supervisor_stop_) {
        std::this_thread::sleep_for(kSupervisorTick);
        const int64_t s = started_ns_.load();
        const int64_t f = finished_ns_.load();
        const bool busy = s > f;
        const int64_t inside_ns = busy ? nowNs() - s : 0;
        const bool wedged = busy && inside_ns > threshold_ns;
        if (wedged && !wedged_.load()) {
            wedged_ = true;
            std::cerr << "[SequencerService] WATCHDOG: command worker wedged — inside one command "
                         "for "
                      << inside_ns / 1000000 << " ms (threshold " << opts_.wedge_threshold.count()
                      << " ms). Detect only: no valve is moved." << std::endl;
        } else if (!wedged && wedged_.load()) {
            wedged_ = false;
            std::cerr << "[SequencerService] WATCHDOG: command worker recovered" << std::endl;
        }
    }
}

}  // namespace sequencer
