//! The Ground tab: connected to a receiver board, the rocket as the receiver
//! hears it (PROTOCOL.md §8), and Arm / Un-arm.
//!
//! There is no radio ACK, so a command is sent again until the rocket's own
//! frames show the new state: ARMED in its Telemetry, IDLE in a Heartbeat (it
//! sends one on entering Idle). A sniffing rocket misses a preamble now and
//! then, and an armed one is deaf while it sends Telemetry (bench: 1-3 tries).

use std::collections::VecDeque;
use std::time::{Duration, Instant};

use serde::Serialize;

use super::format::{label_tone, Tone};
use super::{live, Purpose, Shared};
use crate::protocol::{self as p, msg, state, Frame};
use crate::radio::{self, frame_type as ft, Heartbeat, RadioRx, Status, Telemetry};
use crate::records::{REC_BARO, REC_HIGHG, REC_IMU};

const LOG_ROWS: usize = 300;
/// After a command is sent, how long the rocket has to show the new state.
const CONFIRM: Duration = Duration::from_secs(3);
pub const MAX_TRIES: u32 = 6;
const SEND_TIMEOUT: Duration = Duration::from_secs(10); // two ~1.2 s frames

const CHIPS: [(&str, Option<u8>, &str); 8] = [
    ("IMU", Some(0x6B), "WHO_AM_I"),
    ("High-g", Some(0x32), "WHO_AM_I"),
    ("Barometer", None, "PROM CRC"),
    ("Ethernet", None, ""),
    ("Radio", Some(0), "start-up step"),
    ("GNSS", None, ""),
    ("SD NAND", None, ""),
    ("eMMC", Some(4), "card state"),
];

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct LogRow {
    pub t: String,
    pub kind: String,
    pub seq: u16,
    pub rssi: String,
    pub summary: String,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct AdcRow {
    pub name: String,
    pub counts: u16,
    /// At the STM32 pin (3.32 V reference, 16 bit).
    pub pin_v: String,
    /// In what it measures, where the board's conversion is known.
    pub value: String,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct ChipRow {
    pub name: String,
    pub result: (String, Tone),
    pub value: String,
    pub expected: String,
    /// "live" (checked for this report) or "boot" (its self-test result).
    pub when: String,
}

#[derive(Serialize, Clone, Debug, PartialEq, Default)]
pub struct GroundView {
    /// The connected board is a receiver.
    pub show: bool,
    pub rocket: Option<(String, Tone)>,
    pub heard: String,
    pub signal: String,
    pub battery: String,
    pub adc: Vec<AdcRow>,
    pub chips: Vec<ChipRow>,
    pub telemetry: String,
    pub log: Vec<LogRow>,
    /// A command in progress, or how the last one ended.
    pub command: String,
    pub busy: bool,
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Want {
    Armed,
    Idle,
}

struct Command {
    want: Want,
    tries: u32,
    /// The receiver ACKed the send at this time; None while sending.
    sent_at: Option<Instant>,
}

#[derive(Default)]
pub struct GroundState {
    t0: Option<Instant>,
    heard_at: Option<Instant>,
    signal: Option<(f64, f64)>,
    rocket: Option<u8>,
    battery_mv: Option<u16>,
    status: Option<Status>,
    telemetry: Option<Telemetry>,
    log: VecDeque<LogRow>,
    command: Option<Command>,
    outcome: String,
}

impl GroundState {
    pub fn clear(&mut self) {
        *self = Self::default();
    }

    pub fn on_radio(&mut self, sh: &Shared, live: &mut live::LiveState, rx: RadioRx) {
        let now = Instant::now();
        let t0 = *self.t0.get_or_insert(now);
        self.heard_at = Some(now);
        self.signal = Some((rx.rssi_dbm, rx.snr_db));
        let (kind, summary) = match rx.ty {
            ft::HEARTBEAT => match Heartbeat::unpack(&rx.payload) {
                Ok(h) => {
                    self.rocket = Some(h.state);
                    format_hb(&h)
                }
                Err(e) => ("Heartbeat".into(), e),
            },
            ft::STATUS => match Status::unpack(&rx.payload) {
                Ok(s) => {
                    let text = format!("heartbeat #{}, {} of 8 chips pass", s.heartbeat, s.chips.iter().filter(|c| c.0 == 1).count());
                    self.rocket = Some(s.state);
                    self.battery_mv = Some(s.battery_mv);
                    self.status = Some(s);
                    ("Status".into(), text)
                }
                Err(e) => ("Status".into(), e),
            },
            ft::TELEMETRY => match Telemetry::unpack(&rx.payload) {
                Ok(t) => {
                    self.rocket = Some(t.state);
                    // The rocket's records, as-is: the Live tab graphs them.
                    for (bit, rec, data) in [
                        (radio::FRESH_IMU, REC_IMU, &t.imu),
                        (radio::FRESH_HIGHG, REC_HIGHG, &t.highg),
                        (radio::FRESH_BARO, REC_BARO, &t.baro),
                    ] {
                        if t.fresh & bit != 0 {
                            live.on_sample(sh, rec, data);
                        }
                    }
                    let text = format!("{}, GPS fix {} with {} sats", state::name(t.state), t.fix_type, t.num_sv);
                    self.telemetry = Some(t);
                    ("Telemetry".into(), text)
                }
                Err(e) => ("Telemetry".into(), e),
            },
            ft::ARM | ft::UNARM => ("(another ground)".into(), "Arm/Un-arm heard".into()),
            other => (format!("type 0x{other:02X}"), format!("{} B", rx.payload.len())),
        };
        self.log.push_front(LogRow {
            t: format!("{:.1} s", now.duration_since(t0).as_secs_f64()),
            kind,
            seq: rx.seq,
            rssi: format!("{:.0} dBm / {:.1} dB", rx.rssi_dbm, rx.snr_db),
            summary,
        });
        self.log.truncate(LOG_ROWS);
    }

    /// Arm (true) or Un-arm: send, then again until the rocket shows it.
    pub fn command(&mut self, sh: &mut Shared, arm: bool) {
        if self.command.is_some() {
            return;
        }
        self.command = Some(Command { want: if arm { Want::Armed } else { Want::Idle }, tries: 0, sent_at: None });
        self.send(sh);
    }

    fn send(&mut self, sh: &mut Shared) {
        let Some(c) = &mut self.command else { return };
        c.tries += 1;
        c.sent_at = None;
        let ty = if c.want == Want::Armed { msg::RADIO_ARM } else { msg::RADIO_UNARM };
        sh.client.request_with_timeout(ty, &[], Purpose::Ground, SEND_TIMEOUT);
    }

    pub fn on_reply(&mut self, sh: &mut Shared, res: Result<Frame, String>) {
        let Some(c) = &mut self.command else { return };
        let ok = res.as_ref().is_ok_and(|fr| fr.ty == msg::ACK && p::Ack::unpack(&fr.payload).is_ok_and(|a| a.result == 0));
        if ok {
            c.sent_at = Some(Instant::now());
        } else if c.tries < MAX_TRIES {
            self.send(sh); // the receiver could not send: again
        } else {
            self.finish(format!("The receiver could not send: {}", res.map(|_| "radio error".to_string()).unwrap_or_else(|e| e)));
        }
    }

    /// Each tick: done once the rocket shows it; send again after CONFIRM.
    pub fn tick(&mut self, sh: &mut Shared) {
        let Some(c) = &self.command else { return };
        let (want, tries) = (c.want, c.tries);
        let done = match want {
            Want::Armed => self.rocket.is_some_and(|s| s >= state::ARMED),
            Want::Idle => self.rocket == Some(state::IDLE),
        };
        let what = if want == Want::Armed { "Armed" } else { "Un-armed" };
        if done {
            return self.finish(format!("{what} (the rocket confirmed it) after {tries} {}", if tries == 1 { "try" } else { "tries" }));
        }
        if c.sent_at.is_some_and(|t| t.elapsed() >= CONFIRM) {
            if tries >= MAX_TRIES {
                return self.finish(format!("Not {}: the rocket did not show it after {tries} tries", what.to_lowercase()));
            }
            self.send(sh);
        }
    }

    fn finish(&mut self, outcome: String) {
        self.command = None;
        self.outcome = outcome;
    }

    pub fn view(&self, receiver: bool) -> GroundView {
        let mut v = GroundView { show: receiver, ..Default::default() };
        if !receiver {
            return v;
        }
        v.rocket = self.rocket.map(|s| {
            let n = state::name(s);
            let tone = label_tone(&n);
            (n.replace('_', " "), tone)
        });
        v.heard = self.heard_at.map_or_else(|| "nothing yet".into(), |t| format!("{:.0} s ago", t.elapsed().as_secs_f64()));
        v.signal = self.signal.map_or_else(|| "—".into(), |(r, s)| format!("RSSI {r:.0} dBm, SNR {s:.1} dB"));
        v.battery = self.battery_mv.map_or_else(|| "—".into(), |mv| format!("{:.2} V", mv as f64 / 1000.0));
        if let Some(s) = &self.status {
            v.adc = adc_rows(s);
            v.chips = chip_rows(s);
        }
        v.telemetry = self.telemetry.as_ref().map_or_else(String::new, |t| {
            format!(
                "{}: {:.1} s up, GPS fix {} with {} satellites",
                state::name(t.state),
                t.uptime_ms as f64 / 1000.0,
                t.fix_type,
                t.num_sv
            )
        });
        v.log = self.log.iter().cloned().collect();
        v.busy = self.command.is_some();
        v.command = match &self.command {
            Some(c) => format!(
                "{} — try {} of {MAX_TRIES}{}",
                if c.want == Want::Armed { "Arming" } else { "Un-arming" },
                c.tries,
                if c.sent_at.is_some() { ", waiting for the rocket to show it" } else { ", sending (~3 s)" }
            ),
            None => self.outcome.clone(),
        };
        v
    }
}

fn format_hb(h: &Heartbeat) -> (String, String) {
    let battery = if h.battery_mv == 0 { "on USB".to_string() } else { format!("{:.2} V", h.battery_mv as f64 / 1000.0) };
    ("Heartbeat".into(), format!("{}, battery {battery}, up {} s", state::name(h.state), h.uptime_s))
}

fn adc_rows(s: &Status) -> Vec<AdcRow> {
    radio::ADC_NAMES
        .iter()
        .zip(s.adc)
        .map(|(name, c)| {
            let pin = c as f64 * 3.32 / 65535.0;
            // Conversions the firmware states: VBAT through 22k/10k
            // (battery.h, x3.2), CURR at 1 V/A; the rest have none yet.
            let value = match *name {
                "VBAT" => format!("{:.2} V supply", pin * 3.2),
                "CURR" => format!("{:.0} mA", pin * 1000.0),
                _ => String::new(),
            };
            AdcRow { name: name.to_string(), counts: c, pin_v: format!("{pin:.3} V"), value }
        })
        .collect()
}

fn chip_rows(s: &Status) -> Vec<ChipRow> {
    CHIPS
        .iter()
        .zip(s.chips)
        .enumerate()
        .map(|(i, ((name, expected, what), (result, value)))| {
            let label = p::self_test::name(result).to_uppercase();
            ChipRow {
                name: name.to_string(),
                result: (label.clone(), label_tone(&label)),
                value: if what.is_empty() { "—".into() } else { format!("0x{value:02X} ({what})") },
                expected: expected.map_or_else(String::new, |e| format!("0x{e:02X}")),
                when: if s.live_mask >> i & 1 != 0 { "live".into() } else { "boot".into() },
            }
        })
        .collect()
}
