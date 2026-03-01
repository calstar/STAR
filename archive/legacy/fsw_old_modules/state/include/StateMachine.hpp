#ifndef STATE_MACHINE_HPP
#define STATE_MACHINE_HPP

#include <atomic>
#include <chrono>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

/**
 * @brief Engine State Machine
 *
 * Manages engine operational phases and state transitions with safety interlocks
 * and automated sequence control for liquid rocket engine operations
 */
class StateMachine {
public:
    enum class EngineState {
        // System states
        INITIALIZATION,  // System startup and initialization
        STANDBY,         // Ready for operation
        MAINTENANCE,     // Maintenance mode

        // Pre-ignition states
        PRE_IGNITION_CHECKS,  // Pre-flight checks
        PURGE_SEQUENCE,       // Nitrogen purge sequence
        IGNITION_PREP,        // Ignition system preparation

        // Ignition states
        IGNITION_SEQUENCE,  // Main ignition sequence
        IGNITION_CONFIRM,   // Ignition confirmation
        IGNITION_FAILURE,   // Ignition failure handling

        // Engine operation states
        STARTUP,        // Engine startup transient
        STEADY_STATE,   // Nominal steady-state operation
        THROTTLE_UP,    // Throttle increase
        THROTTLE_DOWN,  // Throttle decrease

        // Shutdown states
        SHUTDOWN_SEQUENCE,  // Controlled shutdown
        POST_SHUTDOWN,      // Post-shutdown procedures

        // Safety states
        ABORT,               // Emergency abort
        EMERGENCY_SHUTDOWN,  // Emergency shutdown
        FAULT,               // System fault
        SAFE_MODE            // Safe mode operation
    };

    enum class TransitionTrigger {
        // Manual triggers
        MANUAL_START,
        MANUAL_STOP,
        MANUAL_ABORT,
        MANUAL_THROTTLE_UP,
        MANUAL_THROTTLE_DOWN,

        // Automatic triggers
        PRE_IGNITION_COMPLETE,
        IGNITION_CONFIRMED,
        IGNITION_FAILED,
        STARTUP_COMPLETE,
        SHUTDOWN_COMPLETE,
        ABORT_CONDITION,
        FAULT_DETECTED,
        HEALTH_CHECK_FAILED,

        // Time-based triggers
        TIMEOUT,
        SEQUENCE_TIMEOUT
    };

    struct StateTransition {
        EngineState from_state;
        EngineState to_state;
        TransitionTrigger trigger;
        std::function<bool()> condition_check;  // Additional condition for transition
        std::function<void()> action;           // Action to perform during transition
        std::chrono::milliseconds timeout;      // Transition timeout
        bool critical;                          // Critical transition (cannot be interrupted)
    };

    struct StateConfig {
        std::string name;
        std::string description;
        std::vector<std::function<bool()>> entry_conditions;  // Conditions to enter state
        std::vector<std::function<void()>> entry_actions;     // Actions on state entry
        std::vector<std::function<void()>> state_actions;     // Actions while in state
        std::vector<std::function<void()>> exit_actions;      // Actions on state exit
        std::chrono::milliseconds timeout;                    // State timeout
        bool allows_abort;                                    // Can be aborted
        bool allows_manual_override;                          // Allows manual override
    };

    struct SafetyInterlock {
        std::string name;
        std::function<bool()> check_function;
        bool enabled;
        bool critical;  // Critical interlock (abort if failed)
        std::chrono::milliseconds check_period;
        std::chrono::steady_clock::time_point last_check;
        bool last_result;
    };

    StateMachine();
    ~StateMachine();

    // State machine control
    bool initialize();
    void run();
    void stop();

    // State management
    EngineState getCurrentState() const;
    std::string getCurrentStateName() const;
    std::chrono::steady_clock::time_point getStateEntryTime() const;

    // State transitions
    bool requestTransition(TransitionTrigger trigger);
    bool forceTransition(EngineState target_state);
    bool canTransition(EngineState target_state) const;

    // Configuration
    bool addStateConfig(EngineState state, const StateConfig& config);
    bool addStateTransition(const StateTransition& transition);
    bool addSafetyInterlock(const SafetyInterlock& interlock);

    // Safety systems
    bool checkSafetyInterlocks();
    bool isSystemSafe() const;
    bool requestAbort(const std::string& reason);
    bool requestEmergencyShutdown(const std::string& reason);

    // Monitoring
    std::vector<std::string> getActiveInterlocks() const;
    std::vector<std::string> getFailedInterlocks() const;
    std::vector<EngineState> getPossibleTransitions() const;

    // Event logging
    void logStateTransition(EngineState from, EngineState to, TransitionTrigger trigger);
    void logSafetyEvent(const std::string& event, bool critical);

private:
    void stateMachineLoop();
    void executeStateActions();
    void checkStateTimeout();
    void checkTransitionConditions();
    void processTransitionQueue();

    bool validateTransition(EngineState from, EngineState to, TransitionTrigger trigger) const;
    void executeTransition(const StateTransition& transition);

    // Safety monitoring
    void safetyMonitorLoop();
    void checkInterlocks();
    void handleSafetyViolation(const SafetyInterlock& interlock);

    // State variables
    std::atomic<bool> running_;
    std::atomic<EngineState> current_state_;
    std::atomic<EngineState> previous_state_;
    std::chrono::steady_clock::time_point state_entry_time_;
    std::chrono::steady_clock::time_point last_transition_time_;

    // Configuration
    std::map<EngineState, StateConfig> state_configs_;
    std::vector<StateTransition> state_transitions_;
    std::vector<SafetyInterlock> safety_interlocks_;

    // State machine logic
    std::vector<TransitionTrigger> transition_queue_;
    std::atomic<bool> transition_in_progress_;
    std::atomic<bool> abort_requested_;
    std::atomic<bool> emergency_shutdown_requested_;

    // Threading
    std::thread state_machine_thread_;
    std::thread safety_monitor_thread_;
    std::mutex state_mutex_;
    std::mutex transition_mutex_;
    std::mutex interlock_mutex_;

    // Timing
    std::chrono::milliseconds state_machine_period_{50};  // 20 Hz state machine
    std::chrono::milliseconds safety_check_period_{100};  // 10 Hz safety checks

    // Event logging
    std::vector<std::string> event_log_;
    std::mutex log_mutex_;
};

/**
 * @brief Engine Sequence Controller
 *
 * Manages automated sequences within engine states (e.g., ignition sequence, shutdown sequence)
 */
class SequenceController {
public:
    enum class SequenceType {
        IGNITION_SEQUENCE,
        SHUTDOWN_SEQUENCE,
        PURGE_SEQUENCE,
        HEALTH_CHECK_SEQUENCE,
        CALIBRATION_SEQUENCE,
        SELF_TEST_SEQUENCE
    };

    struct SequenceStep {
        std::string name;
        std::function<bool()> condition;        // Condition to proceed to next step
        std::function<void()> action;           // Action to perform
        std::chrono::milliseconds timeout;      // Step timeout
        bool critical;                          // Critical step (sequence fails if this fails)
        std::vector<std::string> dependencies;  // Steps that must complete before this step
    };

    SequenceController();
    ~SequenceController();

    bool startSequence(SequenceType sequence_type);
    bool stopSequence();
    bool pauseSequence();
    bool resumeSequence();

    bool isSequenceRunning() const;
    SequenceType getCurrentSequence() const;
    std::string getCurrentStep() const;
    double getSequenceProgress() const;

    bool addSequenceStep(SequenceType sequence_type, const SequenceStep& step);
    bool removeSequenceStep(SequenceType sequence_type, const std::string& step_name);

    std::vector<std::string> getCompletedSteps() const;
    std::vector<std::string> getFailedSteps() const;
    std::vector<std::string> getRemainingSteps() const;

private:
    void sequenceLoop();
    void executeCurrentStep();
    void checkStepTimeout();
    void advanceToNextStep();

    bool validateStepDependencies(const SequenceStep& step) const;
    void logSequenceEvent(const std::string& event);

    // State variables
    std::atomic<bool> sequence_running_;
    std::atomic<bool> sequence_paused_;
    std::atomic<SequenceType> current_sequence_;
    std::atomic<size_t> current_step_index_;

    // Configuration
    std::map<SequenceType, std::vector<SequenceStep>> sequences_;
    std::vector<std::string> completed_steps_;
    std::vector<std::string> failed_steps_;

    // Threading
    std::thread sequence_thread_;
    std::mutex sequence_mutex_;

    // Timing
    std::chrono::milliseconds sequence_period_{100};  // 10 Hz sequence execution
    std::chrono::steady_clock::time_point step_start_time_;
};

#endif  // STATE_MACHINE_HPP
