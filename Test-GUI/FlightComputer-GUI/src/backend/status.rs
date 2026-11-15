//! Status: the board's value table (firmware `src/app/gui_map.c`), shown as
//! sent. A row added to that table appears here with no change to the app.

use std::collections::VecDeque;

use serde::Serialize;

use super::format::{label_tone, Tone};
use super::Shared;
use crate::protocol as p;

pub const TEXT_LINES: usize = 200;
/// Rows named `self_test_*` go in the self-test list, the rest under Board.
const SELF_TEST_PREFIX: &str = "self_test_";

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Row {
    pub name: String,
    pub value: String,
    /// Shown as a coloured chip instead of plain text.
    pub chip: Option<Tone>,
    /// Hover text.
    pub hint: Option<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Section {
    pub title: String,
    pub rows: Vec<Row>,
}

/// The self-test button: green only when every chip passed.
#[derive(Serialize, Clone, Debug, PartialEq, Default)]
pub struct SelfTestSummary {
    pub ok: bool,
    /// Button text: "Self-test: Barometer, IMU not answering".
    pub label: String,
    /// Hover text: one line per chip that did not pass.
    pub detail: String,
    /// Names (as in `self_test`) of the chips that did not pass.
    pub failed: Vec<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq, Default)]
pub struct StatusView {
    pub sections: Vec<Section>,
    pub self_test: Vec<Row>,
    pub self_test_summary: SelfTestSummary,
    /// TEXT lines from the board (its debug log), newest last.
    pub messages: Vec<String>,
}

fn row(name: &str, value: String) -> Row {
    Row { name: name.into(), value, chip: None, hint: None }
}

/// "gnss_satellites" -> "Gnss satellites".
fn title(name: &str) -> String {
    let s = name.replace('_', " ");
    let mut c = s.chars();
    c.next().map_or_else(String::new, |f| f.to_uppercase().chain(c).collect())
}

fn value_row(v: &p::Value, name: &str) -> Row {
    Row { chip: v.label().map(label_tone), ..row(&title(name), v.text()) }
}

/// "high_g" -> "High-g": the firmware's device names (self_test_devices.h).
fn device_name(key: &str) -> String {
    let squash = |s: &str| s.chars().filter(char::is_ascii_alphanumeric).collect::<String>().to_lowercase();
    p::self_test::DEVICES.iter().find(|d| squash(d) == squash(key)).map_or_else(|| title(key), |d| d.to_string())
}

/// What the self-test button says about the `self_test_*` rows.
pub fn summary(tests: &[&p::Value]) -> SelfTestSummary {
    use p::self_test as st;
    if tests.is_empty() {
        return SelfTestSummary { label: "Self-test".into(), detail: "No results from the board yet".into(), ..Default::default() };
    }
    let name = |v: &p::Value| device_name(&v.name[SELF_TEST_PREFIX.len()..]);
    let bad: Vec<&p::Value> = tests.iter().copied().filter(|v| v.raw != st::PASS as u32).collect();
    let failed: Vec<String> = bad.iter().map(|v| name(v)).collect();
    let detail = bad.iter().map(|v| format!("{}: {}", name(v), st::name(v.raw as u8))).collect::<Vec<_>>().join("\n");
    if bad.is_empty() {
        return SelfTestSummary {
            ok: true,
            label: "Self-test: all pass".into(),
            detail: "Every chip answered. Click to check again.".into(),
            failed,
        };
    }
    if bad.iter().all(|v| v.raw == st::PENDING as u32) {
        return SelfTestSummary { ok: false, label: "Self-test: checking".into(), detail, failed };
    }
    // "not answering": a chip that failed or timed out; "not checked": the
    // firmware has no probe for it, or it is not fitted.
    let silent = |v: &&p::Value| v.raw == st::FAIL as u32 || v.raw == st::TIMEOUT as u32;
    let why = if bad.iter().all(silent) {
        "not answering"
    } else if !bad.iter().any(silent) {
        "not checked"
    } else {
        "not passing"
    };
    let who = if failed.len() <= 3 { failed.join(", ") } else { format!("{} chips", failed.len()) };
    SelfTestSummary { ok: false, label: format!("Self-test: {who} {why}"), detail, failed }
}

pub fn view(sh: &Shared, messages: &VecDeque<String>) -> StatusView {
    let dash = || "—".to_string();
    let info = sh.client.info.as_ref();
    let mut board = vec![
        row("Firmware", info.map_or_else(dash, |i| format!("{}  (protocol v{})", i.fw_git, i.protocol_version))),
        row("Board ID", info.map_or_else(dash, |i| i.uid.iter().map(|b| format!("{b:02X}")).collect::<Vec<_>>().join(" "))),
    ];
    let mut self_test = Vec::new();
    for v in sh.values.iter().flatten() {
        match v.name.strip_prefix(SELF_TEST_PREFIX) {
            Some(device) => self_test.push(Row { name: device_name(device), ..value_row(v, device) }),
            None => board.push(value_row(v, &v.name)),
        }
    }
    let (good, bad) = sh.client.frame_counts();
    let usb = vec![row("Frames good / bad", if sh.client.is_open() { format!("{good} / {bad}") } else { dash() })];
    StatusView {
        sections: vec![Section { title: "Board".into(), rows: board }, Section { title: "USB link".into(), rows: usb }],
        self_test,
        self_test_summary: summary(&sh.values.iter().flatten().filter(|v| v.name.starts_with(SELF_TEST_PREFIX)).collect::<Vec<_>>()),
        messages: messages.iter().cloned().collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use p::self_test as st;

    fn chips(results: &[(&str, u8)]) -> Vec<p::Value> {
        results
            .iter()
            .map(|&(name, r)| p::Value {
                index: 0,
                count: 1,
                ty: p::value_type::U8,
                raw: r as u32,
                name: format!("self_test_{name}"),
                unit: String::new(),
                labels: vec![],
            })
            .collect()
    }

    fn sum(results: &[(&str, u8)]) -> SelfTestSummary {
        let v = chips(results);
        summary(&v.iter().collect::<Vec<_>>())
    }

    #[test]
    fn green_only_when_every_chip_passes() {
        let s = sum(&[("imu", st::PASS), ("high_g", st::PASS), ("emmc", st::PASS)]);
        assert!(s.ok && s.failed.is_empty());
        assert!(!sum(&[]).ok);
        let s = sum(&[("imu", st::PASS), ("nand", st::NOT_IMPLEMENTED)]);
        assert!(!s.ok);
        assert_eq!(s.label, "Self-test: NAND not checked");
    }

    #[test]
    fn names_the_chips_that_did_not_answer() {
        let s = sum(&[("imu", st::TIMEOUT), ("high_g", st::PASS), ("barometer", st::FAIL)]);
        assert!(!s.ok);
        assert_eq!(s.failed, ["IMU", "Barometer"]);
        assert_eq!(s.label, "Self-test: IMU, Barometer not answering");
        assert_eq!(s.detail, "IMU: timeout\nBarometer: fail");
        let s = sum(&[("imu", st::FAIL), ("ethernet", st::NOT_CONFIGURED)]);
        assert_eq!(s.label, "Self-test: IMU, Ethernet not passing");
        let s = sum(&[("imu", st::PENDING), ("emmc", st::PENDING)]);
        assert_eq!(s.label, "Self-test: checking");
    }

    #[test]
    fn device_names_follow_the_firmware() {
        assert_eq!(device_name("high_g"), "High-g");
        assert_eq!(device_name("emmc"), "eMMC");
        assert_eq!(device_name("new_chip"), "New chip");
    }
}
