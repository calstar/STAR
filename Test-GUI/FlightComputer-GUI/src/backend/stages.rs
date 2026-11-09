//! The flight stages (Flight_computer.drawio; firmware flight_state.c): where
//! the board is and where it can go next. Shown only; the app never moves it.

use serde::Serialize;

use crate::protocol::state;

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Stage {
    pub name: &'static str,
    pub does: &'static str,
    /// "done", "current", "next" or "later".
    pub status: &'static str,
    /// For a "next" stage: the event that moves the board there.
    pub how: Option<&'static str>,
}

const STAGES: [(u8, &str, &str); 5] = [
    (state::SELF_TEST, "Self test", "Checks every sensor, the battery and pyro continuity, then reports"),
    (state::IDLE, "Idle", "Radio heartbeat with the battery; sensors and GPS off"),
    (state::ARMED, "Armed", "Altimeter powered; full-rate data and GPS"),
    (state::LAUNCHED, "Launched", "In flight"),
    (state::RECOVERY, "Recovery", "Pyros fire at programmed times and altitudes"),
];

/// The event from `from` to `to`, if the diagram draws one.
fn event(from: u8, to: u8) -> Option<&'static str> {
    use state::*;
    match (from, to) {
        (SELF_TEST, IDLE) => Some("self test done"),
        (IDLE, ARMED) => Some("Arm command (radio)"),
        (ARMED, IDLE) => Some("Un-arm command (radio)"),
        (ARMED, LAUNCHED) => Some("launch detected (not in the firmware yet)"),
        (LAUNCHED, RECOVERY) => Some("apogee detected (not in the firmware yet)"),
        _ => None,
    }
}

pub fn stages(current: Option<u8>) -> Vec<Stage> {
    STAGES
        .iter()
        .map(|&(s, name, does)| {
            let how = current.and_then(|c| event(c, s));
            let status = match current {
                Some(c) if c == s => "current",
                Some(_) if how.is_some() => "next",
                Some(c) if s < c => "done",
                _ => "later",
            };
            Stage { name, does, status, how }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn armed_can_go_back_to_idle_or_on_to_launched() {
        let st: Vec<_> = stages(Some(state::ARMED)).iter().map(|s| (s.name, s.status)).collect();
        assert_eq!(st, [("Self test", "done"), ("Idle", "next"), ("Armed", "current"), ("Launched", "next"), ("Recovery", "later")]);
        assert_eq!(stages(Some(state::IDLE))[2].how, Some("Arm command (radio)"));
        assert!(stages(None).iter().all(|s| s.status == "later"), "not connected: nothing is current");
    }
}
