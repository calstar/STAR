//! Config: read, edit, apply and save the board's settings.
//!
//! Apply sends CONFIG_SET (the board validates and runs it from RAM); Save sends
//! CONFIG_SAVE (the board writes it to internal flash and boots with it from
//! then on). After each step the app reads the board's copy back and compares
//! it with what it sent, so "Saved" here means the board reported those exact
//! bytes back from flash.
//!
//! The editor lives here too: the window sends each field's text as typed and
//! gets back the parsed value, the checks and the radio figures. Apply and Save
//! are refused here, not just greyed out there, when the checks fail.

use std::collections::{BTreeMap, HashMap};
use std::path::Path;

use serde::{Deserialize, Serialize};

use super::format::Tone;
use super::{Purpose, Shared};
use crate::config::{self as cfg, Field, Values};
use crate::lora;
use crate::protocol::{self as p, msg, slot, Frame};

/// Frame overhead + heartbeat payload (src/frame.h).
pub const HEARTBEAT_PAYLOAD: i64 = 7 + 7;
const SAVE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);
const FREQ_KEY: &str = "radio_freq_hz";
const MASK_KEY: &str = "gnss_constellations";
const MODULATION: [&str; 3] = ["radio_sf", "radio_bw_hz", "radio_cr"];

#[derive(Serialize, Deserialize)]
struct ConfigFile {
    config_version: u8,
    values: BTreeMap<String, i64>,
}

pub fn export_json(v: &Values) -> String {
    serde_json::to_string_pretty(&ConfigFile { config_version: cfg::CONFIG_VERSION, values: v.to_map() }).expect("serialise config")
}

pub fn import_json(text: &str) -> Result<Values, String> {
    let doc: ConfigFile = serde_json::from_str(text).map_err(|e| e.to_string())?;
    if doc.config_version != cfg::CONFIG_VERSION {
        return Err(format!("file is config version {}, this app reads {}", doc.config_version, cfg::CONFIG_VERSION));
    }
    Values::from_map(&doc.values)
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Opt {
    pub value: i64,
    pub label: String,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    /// A drop-down of `options`.
    Select,
    /// A text box holding a number in `unit` (MHz for the frequency).
    Number,
    /// A checkbox per option; `value` is the bitmask.
    Mask,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct FieldView {
    pub key: String,
    pub label: String,
    pub kind: Kind,
    pub value: i64,
    /// What the text box shows: the text as typed, or the value formatted.
    pub text: String,
    pub unit: String,
    pub options: Vec<Opt>,
    /// Hover text: what the setting does and where the allowed values come from.
    pub help: String,
    /// What the board is running, worded; None when not connected.
    pub board: Option<String>,
    pub differs: bool,
    /// Why this field blocks Apply, if it does.
    pub error: Option<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Group {
    pub title: String,
    pub fields: Vec<FieldView>,
}

#[derive(Serialize, Clone, Debug, PartialEq, Default)]
pub struct ConfigView {
    pub groups: Vec<Group>,
    pub banner: String,
    pub banner_tone: Option<Tone>,
    /// Radio figures for the edited values, one line each.
    pub link: Vec<(String, String)>,
    pub issues: Vec<String>,
    pub notes: Vec<String>,
    pub can_read: bool,
    /// Apply and Save: connected, IDLE or SELF_TEST, no issues.
    pub can_write: bool,
    pub can_revert: bool,
}

pub struct ConfigState {
    pub editor: Values,
    /// Text typed into a field, kept so the box shows exactly what was typed
    /// (and so a half-typed number is not overwritten while typing).
    pub texts: HashMap<usize, String>,
    /// Fields whose text is not a number: these block Apply.
    pub unparsed: HashMap<usize, String>,
    pub board_active: Option<Values>,
    pub board_saved: Option<Values>,
    /// Set after a save is confirmed by the flash read-back.
    pub saved_note: bool,
}

/// The value in the unit the text box uses.
fn shown_number(f: &Field, v: i64) -> String {
    if f.key == FREQ_KEY {
        format!("{:.3}", v as f64 / 1e6)
    } else {
        v.to_string()
    }
}

fn parse_number(f: &Field, text: &str) -> Result<i64, String> {
    let t = text.trim();
    if f.key == FREQ_KEY {
        match t.parse::<f64>() {
            Ok(mhz) if mhz.is_finite() => Ok((mhz * 1e6).round() as i64),
            _ => Err(format!("{}: \"{t}\" is not a number of MHz", f.label)),
        }
    } else {
        t.parse::<i64>().map_err(|_| format!("{}: \"{t}\" is not a whole number", f.label))
    }
}

impl ConfigState {
    pub fn new() -> Self {
        Self {
            editor: cfg::defaults(),
            texts: HashMap::new(),
            unparsed: HashMap::new(),
            board_active: None,
            board_saved: None,
            saved_note: false,
        }
    }

    pub fn on_disconnected(&mut self) {
        self.board_active = None;
        self.board_saved = None;
        self.saved_note = false;
    }

    /// Replace every value (read, import, defaults): typed text is dropped.
    pub fn set_editor(&mut self, v: Values) {
        self.editor = v;
        self.texts.clear();
        self.unparsed.clear();
    }

    pub fn edit(&mut self, key: &str, text: &str) {
        let Some(i) = cfg::fields().iter().position(|f| f.key == key) else { return };
        let f = &cfg::fields()[i];
        if f.key == MASK_KEY {
            return; // toggled bit by bit
        }
        self.texts.insert(i, text.to_string());
        match parse_number(f, text) {
            Ok(v) => {
                self.editor.0[i] = v;
                self.unparsed.remove(&i);
            }
            Err(e) => {
                self.unparsed.insert(i, e);
            }
        }
    }

    pub fn toggle(&mut self, key: &str, bit: i64) {
        if key == MASK_KEY && cfg::GNSS_NAMES.iter().any(|(b, _)| *b == bit) {
            self.editor[MASK_KEY] ^= bit;
        }
    }

    /// Problems that block Apply/Save, and notes that do not.
    pub fn checks(&self) -> (Vec<String>, Vec<String>) {
        let v = &self.editor;
        let mut unparsed: Vec<_> = self.unparsed.iter().collect();
        unparsed.sort();
        let mut issues: Vec<String> = unparsed.into_iter().map(|(_, e)| e.clone()).collect();
        let problems = cfg::problems(v);
        issues.extend(problems.iter().filter(|(f, _)| !self.unparsed.contains_key(&cfg::index(f.key))).map(|(_, m)| m.clone()));
        if problems.iter().all(|(f, _)| !MODULATION.contains(&f.key)) {
            let toa = lora::time_on_air_ms(v["radio_sf"], v["radio_bw_hz"], v["radio_cr"], v["radio_preamble"], HEARTBEAT_PAYLOAD);
            for key in ["hb_self_test_ms", "hb_idle_ms", "hb_flight_ms"] {
                if toa >= v[key] as f64 {
                    issues.push(format!(
                        "{}: a heartbeat takes {toa:.0} ms on air, longer than the {} ms interval",
                        cfg::by_key(key).label,
                        v[key]
                    ));
                }
            }
        }
        let mut notes = Vec::new();
        if v["radio_bw_hz"] < 62_500 {
            notes.push("Bandwidth below 62.5 kHz: the radio's crystal drift becomes significant.".into());
        }
        (issues, notes)
    }

    fn writable(sh: &Shared) -> Result<(), String> {
        if !sh.client.is_ready() {
            Err("Not connected to a board.".into())
        } else if !sh.configurable() {
            Err("The board is armed or flying: its settings cannot be changed until it is back in IDLE.".into())
        } else {
            Ok(())
        }
    }

    pub fn can_write(&self, sh: &Shared) -> bool {
        Self::writable(sh).is_ok() && self.checks().0.is_empty()
    }

    // ---- board I/O
    pub fn read_board(&mut self, sh: &mut Shared, then_editor: bool) {
        sh.client.request(msg::CONFIG_GET, &[slot::ACTIVE], Purpose::ConfigRead { then_editor });
    }

    pub fn apply(&mut self, sh: &mut Shared, save: bool) {
        let title = if save { "Save" } else { "Apply" };
        if let Err(e) = Self::writable(sh) {
            return sh.warn(title, e);
        }
        let (issues, _) = self.checks();
        if !issues.is_empty() {
            return sh.warn(title, format!("Not sent; fix these first:\n{}", issues.join("\n")));
        }
        let vals = self.editor;
        match cfg::pack(&vals) {
            Ok(blob) => sh.client.request(msg::CONFIG_SET, &blob, Purpose::ConfigSet { vals, save }),
            Err(e) => sh.warn(title, e),
        }
    }

    pub fn revert(&mut self, sh: &mut Shared) {
        if let Err(e) = Self::writable(sh) {
            return sh.warn("Revert", e);
        }
        sh.client.request(msg::CONFIG_REVERT, &[], Purpose::ConfigRevert);
    }

    pub fn on_reply(&mut self, sh: &mut Shared, purpose: Purpose, res: Result<Frame, String>) {
        match purpose {
            Purpose::ConfigRead { then_editor } => match config_from(res) {
                Err(e) => sh.warn("Read config", format!("Could not read the board's config: {e}")),
                Ok(v) => {
                    self.board_active = Some(v);
                    sh.active_config = Some(v);
                    if then_editor {
                        self.set_editor(v);
                    }
                }
            },
            Purpose::ConfigSet { vals, save } => match ack_of(res) {
                Err(e) => sh.warn("Apply", format!("The board refused the settings: {e}")),
                Ok(()) => sh.client.request(msg::CONFIG_GET, &[slot::ACTIVE], Purpose::ConfigReadback { vals, save }),
            },
            Purpose::ConfigReadback { vals, save } => match config_from(res) {
                Err(e) => sh.warn("Apply", format!("Applied, but the read-back failed: {e}")),
                Ok(back) => {
                    self.board_active = Some(back);
                    sh.active_config = Some(back);
                    if back != vals {
                        let bad: Vec<_> = cfg::diff(&vals, &back).iter().map(|f| f.label).collect();
                        sh.warn("Apply", format!("The board is running something other than what was sent: {}", bad.join(", ")));
                    } else if save {
                        sh.client.request_with_timeout(msg::CONFIG_SAVE, &[], Purpose::ConfigSave { vals }, SAVE_TIMEOUT);
                    }
                }
            },
            Purpose::ConfigSave { vals } => match ack_of(res) {
                Err(e) => sh.warn("Save", format!("The board did not save: {e}")),
                Ok(()) => sh.client.request(msg::CONFIG_GET, &[slot::SAVED], Purpose::ConfigSavedReadback { vals }),
            },
            Purpose::ConfigSavedReadback { vals } => match config_from(res) {
                Ok(saved) if saved == vals => {
                    self.board_saved = Some(saved);
                    self.saved_note = true;
                }
                Ok(_) => sh.warn("Save", "Flash read-back does not match what was sent (different values)."),
                Err(e) => sh.warn("Save", format!("Flash read-back does not match what was sent ({e}).")),
            },
            Purpose::ConfigRevert => match ack_of(res) {
                Err(e) => sh.warn("Revert", format!("The board did not revert: {e}")),
                Ok(()) => self.read_board(sh, true),
            },
            _ => unreachable!("not a config purpose"),
        }
    }

    // ---- files
    pub fn export(&self, sh: &mut Shared, path: &Path) {
        if let Err(e) = std::fs::write(path, export_json(&self.editor)) {
            sh.warn("Export config", format!("Could not write {}: {e}", path.display()));
        }
    }

    pub fn import(&mut self, sh: &mut Shared, path: &Path) {
        match std::fs::read_to_string(path).map_err(|e| e.to_string()).and_then(|t| import_json(&t)) {
            Ok(v) => self.set_editor(v),
            Err(e) => sh.warn("Import config", format!("Could not import {}: {e}", path.display())),
        }
    }

    // ---- the view
    fn banner(&self, sh: &Shared) -> (String, Option<Tone>) {
        let Some(flags) = sh.flags() else {
            return ("Not connected. You can still edit, import and export.".into(), None);
        };
        if !sh.configurable() {
            ("The board is armed or flying: its settings cannot be changed until it is back in IDLE.".into(), Some(Tone::Bad))
        } else if self.saved_note && flags & p::FLAG_CONFIG_UNSAVED == 0 {
            ("Saved. The board will boot with these settings.".into(), Some(Tone::Good))
        } else if flags & p::FLAG_CONFIG_DEFAULTS != 0 {
            (
                "The board found no valid config in flash and is running its built-in defaults. Save to make them stick.".into(),
                Some(Tone::Warn),
            )
        } else if flags & p::FLAG_CONFIG_UNSAVED != 0 {
            (
                "The board is running settings that are not saved. A reboot or power cycle goes back to the saved ones.".into(),
                Some(Tone::Warn),
            )
        } else {
            ("The board is running its saved settings.".into(), None)
        }
    }

    fn link_lines(&self) -> Vec<(String, String)> {
        let v = &self.editor;
        if cfg::problems(v).iter().any(|(f, _)| MODULATION.contains(&f.key)) {
            return vec![("".into(), "The modulation settings are not valid.".into())];
        }
        let fig = lora::figures(v["radio_sf"], v["radio_bw_hz"], v["radio_cr"], v["radio_preamble"], HEARTBEAT_PAYLOAD);
        let mut lines = vec![
            ("Symbol time".into(), format!("{:.2} ms", fig.symbol_ms)),
            ("Low-data-rate optimisation".into(), if fig.ldro { "on (required)".into() } else { "off".into() }),
            (format!("Heartbeat on air ({HEARTBEAT_PAYLOAD} B)"), format!("{:.1} ms", fig.time_on_air_ms)),
            ("Raw bit rate".into(), format!("{:.0} bit/s", fig.bitrate_bps)),
            ("Sensitivity (estimate)".into(), format!("{:.1} dBm", fig.sensitivity_dbm)),
        ];
        for (key, name) in [("hb_self_test_ms", "self-test"), ("hb_idle_ms", "idle"), ("hb_flight_ms", "flight")] {
            let duty = 100.0 * fig.time_on_air_ms / v[key].max(1) as f64;
            lines.push((format!("TX duty, {name}"), format!("{duty:.1} %")));
        }
        lines
    }

    fn field_view(&self, i: usize, f: &Field, problems: &[(&'static Field, String)]) -> FieldView {
        let v = self.editor.0[i];
        let (kind, options, unit) = if f.key == MASK_KEY {
            (Kind::Mask, cfg::GNSS_NAMES.iter().map(|(b, n)| Opt { value: *b, label: n.to_string() }).collect(), String::new())
        } else if let Some(choices) = f.choices {
            let mut o: Vec<Opt> = choices.iter().map(|&c| Opt { value: c, label: f.show(c) }).collect();
            if !choices.contains(&v) {
                o.insert(0, Opt { value: v, label: format!("{v} (not allowed)") });
            }
            (Kind::Select, o, String::new())
        } else if f.key == FREQ_KEY {
            (Kind::Number, Vec::new(), "MHz".into())
        } else {
            (Kind::Number, Vec::new(), f.unit.to_string())
        };
        // A brief explanation only. The datasheet section behind each limit
        // (`f.source`) is provenance for whoever changes the limits, in the code.
        let help = f.help.to_string();
        let error = self.unparsed.get(&i).cloned().or_else(|| problems.iter().find(|(pf, _)| pf.key == f.key).map(|(_, m)| m.clone()));
        FieldView {
            key: f.key.into(),
            label: f.label.into(),
            kind,
            value: v,
            text: self.texts.get(&i).cloned().unwrap_or_else(|| shown_number(f, v)),
            unit,
            options,
            help,
            board: self.board_active.map(|b| board_text(f, b.0[i])),
            differs: self.board_active.is_some_and(|b| b.0[i] != v),
            error,
        }
    }

    pub fn view(&self, sh: &Shared) -> ConfigView {
        let problems = cfg::problems(&self.editor);
        let groups = cfg::GROUPS
            .iter()
            .map(|g| Group {
                title: g.to_string(),
                fields: cfg::fields()
                    .iter()
                    .enumerate()
                    .filter(|(_, f)| f.group == *g)
                    .map(|(i, f)| self.field_view(i, f, &problems))
                    .collect(),
            })
            .collect();
        let (issues, notes) = self.checks();
        let (banner, banner_tone) = self.banner(sh);
        let writable = Self::writable(sh).is_ok();
        ConfigView {
            groups,
            banner,
            banner_tone,
            link: self.link_lines(),
            can_write: writable && issues.is_empty(),
            issues,
            notes,
            can_read: sh.client.is_ready(),
            can_revert: writable,
        }
    }
}

impl Default for ConfigState {
    fn default() -> Self {
        Self::new()
    }
}

fn board_text(f: &Field, v: i64) -> String {
    match f.key {
        MASK_KEY => cfg::gnss_mask_text(v),
        FREQ_KEY => format!("{:.3} MHz", v as f64 / 1e6),
        _ => f.show(v),
    }
}

fn ack_of(res: Result<Frame, String>) -> Result<(), String> {
    let fr = res?;
    if fr.ty != msg::ACK {
        return Err(format!("unexpected reply 0x{:02X}", fr.ty));
    }
    let a = p::Ack::unpack(&fr.payload)?;
    if a.ok() {
        Ok(())
    } else {
        Err(a.describe())
    }
}

fn config_from(res: Result<Frame, String>) -> Result<Values, String> {
    let fr = res?;
    match fr.ty {
        msg::ACK => Err(p::Ack::unpack(&fr.payload)?.describe()),
        msg::CONFIG if !fr.payload.is_empty() => cfg::unpack(&fr.payload[1..]),
        t => Err(format!("unexpected reply 0x{t:02X}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_round_trip_and_rejections() {
        let v = cfg::defaults().with("radio_sf", 10);
        assert_eq!(import_json(&export_json(&v)).unwrap(), v);
        let wrong = export_json(&v).replace("\"config_version\": 1", "\"config_version\": 2");
        assert!(import_json(&wrong).unwrap_err().contains("version"));
        let unknown = export_json(&v).replace("\"radio_sf\"", "\"radio_spreading\"");
        assert!(import_json(&unknown).is_err());
    }

    #[test]
    fn heartbeat_longer_than_interval_blocks_writing() {
        let mut t = ConfigState::new();
        assert!(t.checks().0.is_empty());
        t.set_editor(cfg::defaults().with("radio_sf", 12).with("hb_flight_ms", 500));
        // An SF12 heartbeat is ~1.2 s on air: longer than the 1 s self-test and
        // 500 ms flight intervals, shorter than the 10 s idle one.
        let (issues, _) = t.checks();
        assert_eq!(issues.len(), 2, "{issues:?}");
        assert!(issues.iter().all(|i| i.contains("longer than")));
        assert!(issues.iter().any(|i| i.starts_with("Heartbeat in self-test")));
        assert!(issues.iter().any(|i| i.starts_with("Heartbeat armed")));
    }

    #[test]
    fn typed_text_parses_here() {
        let mut t = ConfigState::new();
        t.edit("radio_freq_hz", "903.125");
        assert_eq!(t.editor["radio_freq_hz"], 903_125_000);
        t.edit("hb_idle_ms", "12x");
        let (issues, _) = t.checks();
        assert!(issues.iter().any(|i| i.contains("not a whole number")), "{issues:?}");
        let fv = t.field_view(cfg::index("hb_idle_ms"), cfg::by_key("hb_idle_ms"), &[]);
        assert_eq!(fv.text, "12x", "the box keeps what was typed");
        assert!(fv.error.is_some());
        t.edit("hb_idle_ms", "12000");
        assert!(t.checks().0.is_empty());
        t.toggle("gnss_constellations", cfg::GNSS_GALILEO);
        assert_eq!(
            t.editor["gnss_constellations"] & cfg::GNSS_GALILEO,
            cfg::defaults()["gnss_constellations"] & cfg::GNSS_GALILEO ^ cfg::GNSS_GALILEO
        );
    }
}
