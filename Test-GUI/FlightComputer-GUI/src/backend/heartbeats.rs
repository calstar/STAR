//! The Live tab in SELF_TEST and IDLE: the board's Idle heartbeats, newest
//! first. The board counts them (gui_map.c "idle_heartbeats"); a row is added
//! each time the count goes up, with what the board reported at that moment.

use std::collections::VecDeque;

use serde::Serialize;

use super::format::{label_tone, Tone};
use super::Shared;

const KEEP: usize = 500;

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct HeartbeatRow {
    pub n: i64,
    pub uptime: String,
    pub battery: String,
    pub battery_state: Option<(String, Tone)>,
    /// "7 of 8 pass"
    pub chips: String,
    /// The previous heartbeat's radio send (the board learns it after sending).
    pub radio: Option<(String, Tone)>,
}

#[derive(Default)]
pub struct Heartbeats {
    rows: VecDeque<HeartbeatRow>,
    last: Option<i64>,
}

impl Heartbeats {
    pub fn clear(&mut self) {
        self.rows.clear();
        self.last = None;
    }

    /// After each full round of the board's rows.
    pub fn on_round(&mut self, sh: &Shared) {
        let Some(n) = sh.value("idle_heartbeats").map(|v| v.number()) else { return };
        if n == 0 || self.last == Some(n) {
            return;
        }
        self.last = Some(n);
        let text = |name| sh.value(name).map_or_else(|| "—".to_string(), |v| v.text());
        let chip = |name| sh.value(name).and_then(|v| v.label().map(|l| (l.to_string(), label_tone(l))));
        let tests: Vec<_> = sh.values.iter().flatten().filter(|v| v.name.starts_with("self_test_")).collect();
        let pass = tests.iter().filter(|v| v.label() == Some("PASS")).count();
        self.rows.push_front(HeartbeatRow {
            n,
            uptime: text("uptime"),
            battery: text("battery"),
            battery_state: chip("battery_state"),
            chips: format!("{pass} of {} pass", tests.len()),
            radio: chip("idle_last_send"),
        });
        self.rows.truncate(KEEP);
    }

    pub fn rows(&self) -> Vec<HeartbeatRow> {
        self.rows.iter().cloned().collect()
    }
}
