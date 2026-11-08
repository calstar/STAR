//! Status: what the board says about itself, from its 1 Hz STATUS heartbeat.

use std::collections::VecDeque;

use serde::Serialize;

use super::format::{battery_tone, fix_name, fmt_bytes, pyro_tone, result_tone, state_name, state_tone, Tone};
use super::Shared;
use crate::protocol::{self as p, battery, disk, pyro, self_test};

pub const TEXT_LINES: usize = 200;

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

#[derive(Serialize, Clone, Debug, PartialEq, Default)]
pub struct StatusView {
    pub sections: Vec<Section>,
    pub self_test: Vec<Row>,
    /// TEXT lines from the board (its debug log), newest last.
    pub messages: Vec<String>,
}

fn row(name: &str, value: String) -> Row {
    Row { name: name.into(), value, chip: None, hint: None }
}

/// One pyro channel's continuity, as the board judged it.
fn pyro_row(s: Option<&p::Status>, ch: usize) -> Row {
    let name = format!("Pyro {} continuity", ch + 1);
    let Some(s) = s else { return row(&name, "—".into()) };
    let st = s.pyro_state[ch];
    if st == pyro::NOT_MEASURED {
        return row(&name, "not measured".into());
    }
    let mohm = s.pyro_mohm[ch];
    let value = if mohm == pyro::OVER_RANGE { pyro::name(st) } else { format!("{}, {:.2} Ω", pyro::name(st), mohm as f64 / 1000.0) };
    Row { chip: Some(pyro_tone(st)), ..row(&name, value) }
}

pub fn view(sh: &Shared, messages: &VecDeque<String>) -> StatusView {
    let s = sh.status.as_ref();
    let dash = || "—".to_string();
    let info = sh.client.info.as_ref();
    let board = vec![
        match s {
            Some(s) => Row { chip: Some(state_tone(s.state)), ..row("Flight state", state_name(s.state)) },
            None => row("Flight state", dash()),
        },
        row(
            "Uptime",
            s.map_or_else(dash, |s| {
                let t = s.uptime_ms / 1000;
                format!("{}:{:02}:{:02}", t / 3600, t / 60 % 60, t % 60)
            }),
        ),
        row(
            "Firmware",
            info.map_or_else(dash, |i| format!("{}  (protocol v{}, config v{})", i.fw_git, i.protocol_version, i.config_version)),
        ),
        row("Board ID", info.map_or_else(dash, |i| i.uid.iter().map(|b| format!("{b:02X}")).collect::<Vec<_>>().join(" "))),
        row("Power source", s.map_or_else(dash, |s| if s.flags & p::FLAG_ON_USB_POWER != 0 { "USB".into() } else { "battery".into() })),
        // The board converts and judges (PROTOCOL.md §3); this only words it.
        match s {
            Some(s) if s.battery_state != battery::NOT_MEASURED => Row {
                chip: Some(battery_tone(s.battery_state)),
                ..row("Battery", format!("{:.2} V, {}", s.battery_mv as f64 / 1000.0, battery::name(s.battery_state)))
            },
            Some(_) => row("Battery", "not measured".into()),
            None => row("Battery", dash()),
        },
        row(
            "Config",
            s.map_or_else(dash, |s| {
                if s.flags & p::FLAG_CONFIG_DEFAULTS != 0 {
                    "running firmware defaults: flash holds no valid config".into()
                } else if s.flags & p::FLAG_CONFIG_UNSAVED != 0 {
                    "running settings that are NOT saved; a reboot loses them".into()
                } else {
                    "running the saved config".into()
                }
            }),
        ),
    ];
    let sensors = vec![
        row("GNSS", s.map_or_else(dash, |s| format!("{}, {} satellites", fix_name(s.gnss_fix), s.gnss_sv))),
        row(
            "eMMC log",
            s.map_or_else(dash, |s| {
                if s.disk == disk::UNMOUNTED {
                    "not mounted yet (it mounts on Arm, or when the Flights tab reads it)".into()
                } else {
                    let used = s.log_blocks_used as u64 * 512;
                    let total = s.log_blocks_total as u64 * 512;
                    let pct = if total > 0 { 100.0 * used as f64 / total as f64 } else { 0.0 };
                    format!(
                        "{}; {} of {} used ({pct:.2} %); {} records dropped",
                        disk::name(s.disk),
                        fmt_bytes(used),
                        fmt_bytes(total),
                        s.log_dropped
                    )
                }
            }),
        ),
        pyro_row(s, 0),
        pyro_row(s, 1),
        row("Sensor read errors", s.map_or_else(dash, |s| s.sensor_errors.to_string())),
    ];
    let (good, bad) = sh.client.frame_counts();
    let usb = vec![
        row("Frames good / bad", if sh.client.is_open() { format!("{good} / {bad}") } else { dash() }),
        row(
            "Streaming",
            s.map_or_else(dash, |s| if s.flags & p::FLAG_STREAMING != 0 { format!("{} Hz", s.stream_rate_hz) } else { "off".into() }),
        ),
    ];
    let self_test = self_test::DEVICES
        .iter()
        .enumerate()
        .map(|(i, name)| match s {
            Some(s) => Row { chip: Some(result_tone(s.self_test[i])), ..row(name, self_test::name(s.self_test[i])) },
            None => row(name, dash()),
        })
        .collect();
    StatusView {
        sections: vec![
            Section { title: "Board".into(), rows: board },
            Section { title: "Sensors and storage".into(), rows: sensors },
            Section { title: "USB link".into(), rows: usb },
        ],
        self_test,
        messages: messages.iter().cloned().collect(),
    }
}
