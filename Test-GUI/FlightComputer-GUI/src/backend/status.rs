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

/// "gnss_satellites" -> "Gnss satellites".
fn title(name: &str) -> String {
    let s = name.replace('_', " ");
    let mut c = s.chars();
    c.next().map_or_else(String::new, |f| f.to_uppercase().chain(c).collect())
}

fn value_row(v: &p::Value, name: &str) -> Row {
    Row { chip: v.label().map(label_tone), ..row(&title(name), v.text()) }
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
            Some(device) => self_test.push(value_row(v, device)),
            None => board.push(value_row(v, &v.name)),
        }
    }
    let (good, bad) = sh.client.frame_counts();
    let usb = vec![row("Frames good / bad", if sh.client.is_open() { format!("{good} / {bad}") } else { dash() })];
    StatusView {
        sections: vec![Section { title: "Board".into(), rows: board }, Section { title: "USB link".into(), rows: usb }],
        self_test,
        messages: messages.iter().cloned().collect(),
    }
}
