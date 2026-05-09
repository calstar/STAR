#include <iostream>
#include <string>
#include <map>
#include <memory>
#include <vector>

// ============================================================================
// DATA STRUCTURES
// ============================================================================

// Sensor readings and system state parameters
struct SystemParameters
{
    // Pressures (psi)
    float PT_HP = 0.0f;
    float PT_LP = 0.0f;
    float PT_F = 0.0f;
    float PT_O = 0.0f;

    float RTD_O1 = 0.0f;
    float RTD_O2 = 0.0f;
    float RTD_O3 = 0.0f;

    float PT_I = 0.0f;
    float TC_I = 0.0f;
    float PT_C1 = 0.0f;
    float TC_C1 = 0.0f;
    float TC_C3 = 0.0f;
    float TC_C2 = 0.0f;
    float PT_C2 = 0.0f;
    float TC_C4 = 0.0f;

    // Solenoid states (true = open/energized, false = closed/de-energized)
    bool SOL_PV = false;
    bool SOL_FUP = false;
    bool SOL_FV = false;
    bool SOL_OUP = false;
    bool SOL_OV = false;
    bool SOL_FDP = false;
    bool MOT_ODP = false;

    bool ROT_MF = false;
    bool ROT_MO = false;

    // Valve states (true = open, false = closed)
};

// ============================================================================
// STATE MACHINE BASE CLASS
// ============================================================================

class EngineState
{
public:
    virtual ~EngineState() = default;
    virtual void on_enter(SystemParameters &params) = 0; // Called when entering the state
    virtual bool update(SystemParameters &params) = 0; // Called repeatedly while in the state// Returns true if state should automatically transition to next state
    virtual void on_exit(SystemParameters &params) = 0; // Called when exiting the state
    virtual std::string get_name() const = 0; // Get human-readable state name
    virtual bool validate_entry(const SystemParameters &params) const = 0; // Define what conditions must be met to enter this state// Each state checks the current SystemParameters and returns whether entry is valid
    virtual std::vector<std::string> get_allowed_transitions() const // Return an empty vector if no manual transitions are allowed // Define which states can be transitioned to FROM this state
    {
        return {};
    }
    virtual std::string get_next_state_name() const
    {
        return "";
    }
    virtual bool is_automatic() const // If true, this state automatically checks transition requirements for get_next_state_name()
    {
        return false;
    }
};

// ============================================================================
// STATE MACHINE MANAGER
// ============================================================================

class EngineFSM
{
public:
    EngineFSM();

    void register_state(const std::string &state_name, std::shared_ptr<EngineState> state);
    bool request_transition(const std::string &target_state, SystemParameters &params); //manual transition
    void update(SystemParameters &params);
    std::string get_current_state() const;
    std::vector<std::string> get_available_transitions(const SystemParameters &params) const; // Get all states that can be transitioned to from the current state// Includes only states whose validation criteria are currently met

private:
    void transition_to_state(const std::string &state_name, SystemParameters &params);
    bool can_enter_state(const std::string &state_name, const SystemParameters &params) const;

    std::map<std::string, std::shared_ptr<EngineState>> states;
    std::string current_state;
};

// ============================================================================
// IMPLEMENTATION
// ============================================================================

EngineFSM::EngineFSM() : current_state("") {}

void EngineFSM::register_state(const std::string &state_name,
                               std::shared_ptr<EngineState> state)
{
    if (states.find(state_name) != states.end())
    {
        std::cerr << "Warning: State '" << state_name << "' already registered\n";
        return;
    }
    states[state_name] = state;

    // Initialize to first registered state
    if (current_state.empty())
    {
        current_state = state_name;
    }
}

void EngineFSM::update(SystemParameters &params)
{
    if (states.find(current_state) == states.end())
    {
        return;
    }

    auto current = states[current_state];

    // Update the current state
    current->update(params);

    // If this is an automatic state, check if we should transition
    if (current->is_automatic())
    {
        std::string next_state_name = current->get_next_state_name();

        if (!next_state_name.empty() && states.find(next_state_name) != states.end())
        {
            // Check if the next state's validation criteria are met
            if (can_enter_state(next_state_name, params))
            {
                transition_to_state(next_state_name, params);
            }
        }
    }
}

bool EngineFSM::request_transition(const std::string &target_state,
                                    SystemParameters &params)
{
    // Check if target state exists
    if (states.find(target_state) == states.end())
    {
        std::cerr << "Error: Target state '" << target_state << "' not registered\n";
        return false;
    }

    // Check if target state's validation criteria are met
    if (!can_enter_state(target_state, params))
    {
        std::cerr << "Error: Cannot enter state '" << target_state
                  << "' - validation criteria not met\n";
        return false;
    }

    transition_to_state(target_state, params);
    return true;
}

void EngineFSM::transition_to_state(const std::string &state_name,
                                    SystemParameters &params)
{
    // Exit current state
    if (states.find(current_state) != states.end())
    {
        states[current_state]->on_exit(params);
        std::cout << "Exiting state: " << states[current_state]->get_name() << "\n";
    }

    // Enter new state
    current_state = state_name;
    states[current_state]->on_enter(params);
    std::cout << "Entering state: " << states[current_state]->get_name() << "\n";
}

std::string EngineFSM::get_current_state() const
{
    return current_state;
}

bool EngineFSM::can_enter_state(const std::string &state_name,
                                const SystemParameters &params) const
{
    if (states.find(state_name) == states.end())
    {
        return false;
    }
    auto allowed = states.at(current_state)->get_allowed_transitions();
    if (std::find(allowed.begin(), allowed.end(), state_name) == allowed.end())
    {
        return false; // Not an allowed transition from current state
    }
    return states.at(state_name)->validate_entry(params);
}

std::vector<std::string> EngineFSM::get_available_transitions(
    const SystemParameters &params) const
{
    std::vector<std::string> available;

    // Get the list of allowed transitions from the current state
    if (states.find(current_state) == states.end())
    {
        return available;
    }

    auto allowed = states.at(current_state)->get_allowed_transitions();

    // Filter to only those whose validation criteria are met
    for (const auto &target_state : allowed)
    {
        if (can_enter_state(target_state, params))
        {
            available.push_back(target_state);
        }
    }

    return available;
}

// ============================================================================
// EXAMPLE USAGE (SKELETON - ADD YOUR STATES HERE)
// ============================================================================

/*
// Example: Manual state (requires user command to transition)
class IdleState : public EngineState {
public:
    void on_enter(const SystemParameters& params) override {
        std::cout << "  Idle: All systems standing by\n";
    }

    bool update(const SystemParameters& params) override {
        return false;  // No automatic behavior
    }

    void on_exit(const SystemParameters& params) override {
        std::cout << "  Idle: Leaving idle state\n";
    }

    std::string get_name() const override {
        return "Idle";
    }

    bool validate_entry(const SystemParameters& params) const override {
        // Idle can always be entered (e.g., abort state)
        return true;
    }

    std::vector<std::string> get_allowed_transitions() const override {
        return {"Pressurize", "Abort"};
    }
};

// Example: Automatic state (transitions automatically when next state's conditions are met)
class PressurizeState : public EngineState {
private:
    // Track state duration or progress
    int iteration_count = 0;

public:
    void on_enter(const SystemParameters& params) override {
        std::cout << "  Pressurize: Starting pressurization sequence\n";
        iteration_count = 0;
        // In real code: open GN2 solenoid, monitor pressures, etc.
    }

    bool update(const SystemParameters& params) override {
        iteration_count++;
        // Simulate pressure building
        if (iteration_count % 10 == 0) {
            std::cout << "  Pressurize: Pressurizing tanks...\n";
        }
        return false;  // Don't return true; let is_automatic() handle transitions
    }

    void on_exit(const SystemParameters& params) override {
        std::cout << "  Pressurize: Pressurization complete\n";
    }

    std::string get_name() const override {
        return "Pressurize";
    }

    bool validate_entry(const SystemParameters& params) const override {
        // Can only enter if initial state is acceptable
        return true;  // Define real conditions based on your system
    }

    std::vector<std::string> get_allowed_transitions() const override {
        return {"Idle", "Abort"};
    }

    bool is_automatic() const override {
        return true;
    }

    std::string get_next_state_name() const override {
        return "ReadyToFire";
    }
};

// Example: Target state for automatic transition
class ReadyToFireState : public EngineState {
public:
    void on_enter(const SystemParameters& params) override {
        std::cout << "  ReadyToFire: All systems pressurized and ready\n";
    }

    bool update(const SystemParameters& params) override {
        return false;
    }

    void on_exit(const SystemParameters& params) override {
        std::cout << "  ReadyToFire: Leaving ready state\n";
    }

    std::string get_name() const override {
        return "ReadyToFire";
    }

    bool validate_entry(const SystemParameters& params) const override {
        // Define conditions that must be met to enter ready state
        // For example: all pressures in acceptable range
        return params.fuel_pressure > 100.0f &&
               params.ox_pressure > 100.0f &&
               params.gn2_pressure > 50.0f;
    }

    std::vector<std::string> get_allowed_transitions() const override {
        return {"Fire", "Abort"};
    }
};

// In main():
EngineFSM fsm;
fsm.register_state("Idle", std::make_shared<IdleState>());
fsm.register_state("Pressurize", std::make_shared<PressurizeState>());
fsm.register_state("ReadyToFire", std::make_shared<ReadyToFireState>());
// Register more states...

SystemParameters params;

// Main loop
while (true) {
    // Read sensor data into params...
    // params.fuel_pressure = read_fuel_pressure();
    // params.ox_pressure = read_ox_pressure();
    // etc.

    // Display available transitions to user
    auto available = fsm.get_available_transitions(params);
    std::cout << "Available transitions from " << fsm.get_current_state() << ":\n";
    for (const auto& state : available) {
        std::cout << "  - " << state << "\n";
    }

    // Update state machine (handles automatic transitions)
    fsm.update(params);

    // User can request manual transitions
    // if (user_wants_pressurize) {
    //     fsm.request_transition("Pressurize", params);
    // }
}
*/