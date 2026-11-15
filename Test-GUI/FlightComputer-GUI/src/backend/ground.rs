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
use crate::records::{self as rec, REC_BARO, REC_HIGHG, REC_IMU};

const LOG_ROWS: usize = 300;
/// "Last heard" turns red after this. A pad operator should not trust a
/// rocket that has been quiet that long.
const STALE: Duration = Duration::from_secs(15);
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
    /// "read 0x6B, expected 0x6B", or the reading alone when there is no expected byte.
    pub words: String,
    /// "live" (checked for this report) or "boot" (its self-test result).
    pub when: String,
}

#[derive(Serialize, Clone, Debug, PartialEq, Default)]
pub struct GroundView {
    /// The connected board is a receiver.
    pub show: bool,
    pub rocket: Option<(String, Tone)>,
    pub heard: String,
    /// True once the last frame is 15 s old. "nothing yet" is not stale.
    pub heard_stale: bool,
    pub signal: String,
    pub battery: String,
    pub adc: Vec<AdcRow>,
    pub chips: Vec<ChipRow>,
    pub telemetry: String,
    /// "37.87190° N, 122.25850° W", or why there is no position.
    pub place: String,
    /// Distance and height from the first fix after arming.
    pub where_note: String,
    /// East, north metres from that first fix. The window draws them.
    pub track: Vec<[f64; 2]>,
    /// Fix quality, motion, tilt and where the rocket is from the ground station.
    pub gps: GpsView,
    pub log: Vec<LogRow>,
    /// A command in progress, or how the last one ended.
    pub command: String,
    pub busy: bool,
}

/// The GPS card. Direction comes from two places, each with limits:
/// course over ground is the direction of travel worked out from successive
/// fixes (the radio carries position only, ~2 per second); tilt is the angle
/// of gravity off the rocket's long axis, read from the IMU accelerometer and
/// only meaningful while the rocket is not accelerating (on the pad). There is
/// no magnetometer, so which compass direction the nose points is unknown.
#[derive(Serialize, Clone, Debug, PartialEq, Default)]
pub struct GpsView {
    pub has_fix: bool,
    /// "3D fix", "2D fix", "No fix", ...
    pub fix: (String, Tone),
    pub sats: String,
    /// Signed decimal degrees, for copying.
    pub lat: String,
    pub lon: String,
    /// Height above mean sea level.
    pub alt: String,
    /// "last fix 2 s ago".
    pub age: String,
    pub age_stale: bool,
    /// Course over ground, degrees true (0 = north), when it is moving enough to tell.
    pub course_deg: Option<f64>,
    pub course: String,
    pub speed: String,
    pub vspeed: String,
    pub tilt_deg: Option<f64>,
    pub tilt: String,
    pub tilt_note: String,
    pub station_set: bool,
    pub station: String,
    pub station_error: String,
    /// Bearing from the ground station to the rocket, degrees true.
    pub bearing_deg: Option<f64>,
    pub range: String,
    pub elevation: String,
    /// The station in the track's east/north metres (from the pad).
    pub station_en: Option<[f64; 2]>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct Fix {
    at: Instant,
    lat_e7: i32,
    lon_e7: i32,
    hmsl_mm: i32,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Station {
    pub lat_e7: i32,
    pub lon_e7: i32,
    pub alt_m: Option<f64>,
}

/// Fixes kept to work out motion.
const FIX_WINDOW: Duration = Duration::from_secs(10);
/// A position older than this is shown as stale.
const FIX_STALE: Duration = Duration::from_secs(5);
/// Below this horizontal displacement over the baseline, course is noise.
const MIN_MOVE_M: f64 = 3.0;

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
    pad: Option<(i32, i32)>,
    was_armed: bool,
    place: String,
    where_note: String,
    track: Vec<[f64; 2]>,
    fixes: VecDeque<Fix>,
    /// Accelerometer axis (0..2) that carried gravity on the pad: the long axis.
    nose_axis: Option<usize>,
    /// Degrees off vertical, and whether |a| was ~1 g so it can be trusted.
    tilt: Option<(f64, bool)>,
    station: Option<Station>,
    station_error: String,
    log: VecDeque<LogRow>,
    command: Option<Command>,
    outcome: String,
}

impl GroundState {
    /// A new connection starts over, but the ground station's place is kept.
    pub fn clear(&mut self) {
        let station = self.station.take();
        *self = Self { station, ..Self::default() };
    }

    /// Use the rocket's latest fix as the ground station (e.g. on the pad
    /// before walking back, or with the rocket next to the receiver).
    pub fn station_from_fix(&mut self) {
        match self.fixes.back() {
            Some(f) => {
                self.station = Some(Station { lat_e7: f.lat_e7, lon_e7: f.lon_e7, alt_m: Some(f.hmsl_mm as f64 / 1000.0) });
                self.station_error.clear();
            }
            None => self.station_error = "No GPS fix to use yet".into(),
        }
    }

    /// "lat, lon" or "lat, lon, altitude_m", decimal degrees.
    pub fn station_set(&mut self, text: &str) {
        match parse_station(text) {
            Ok(s) => {
                self.station = Some(s);
                self.station_error.clear();
            }
            Err(e) => self.station_error = e,
        }
    }

    pub fn station_clear(&mut self) {
        self.station = None;
        self.station_error.clear();
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
                    self.note_tilt(sh, &t);
                    self.note_fix(now, &t);
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

    /// The rocket's state as last heard over the radio.
    pub fn rocket_state(&self) -> Option<u8> {
        self.rocket
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
        v.heard_stale = self.heard_at.is_some_and(|t| t.elapsed() >= STALE);
        v.signal = self.signal.map_or_else(|| "—".into(), |(r, s)| format!("RSSI {r:.0} dBm, SNR {s:.1} dB"));
        v.battery = self.battery_mv.map_or_else(|| "—".into(), |mv| format!("{:.2} V", mv as f64 / 1000.0));
        if let Some(s) = &self.status {
            v.adc = adc_rows(s);
            v.chips = chip_rows(s);
        }
        v.place = if self.place.is_empty() { "No GPS fix yet".into() } else { self.place.clone() };
        v.where_note = self.where_note.clone();
        v.track = self.track.clone();
        v.gps = self.gps_view();
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
            Some(c) => format!("try {} of {MAX_TRIES}, waiting for the rocket", c.tries),
            None => self.outcome.clone(),
        };
        v
    }

    fn note_tilt(&mut self, sh: &Shared, t: &Telemetry) {
        if t.state >= state::ARMED && !self.was_armed {
            self.nose_axis = None; // re-learnt on this pad
            self.tilt = None;
        }
        if t.fresh & radio::FRESH_IMU == 0 {
            return;
        }
        let conf = sh.active_config.unwrap_or_else(crate::config::defaults);
        let Some(rec::Decoded::Imu(imu)) = rec::decode(REC_IMU, &t.imu, &conf, rec::P0_PA) else { return };
        if let Some((ax, deg, ok)) = tilt_from_accel(imu.accel_g, self.nose_axis) {
            self.nose_axis = Some(ax);
            self.tilt = Some((deg, ok));
        }
    }

    fn note_fix(&mut self, now: Instant, t: &Telemetry) {
        let armed = t.state >= state::ARMED;
        if armed && !self.was_armed {
            self.pad = None;
            self.track.clear();
            self.fixes.clear();
        }
        if t.fix_type >= 2 && t.fresh & radio::FRESH_GNSS != 0 {
            self.fixes.push_back(Fix { at: now, lat_e7: t.lat_e7, lon_e7: t.lon_e7, hmsl_mm: t.hmsl_mm });
            while self.fixes.front().is_some_and(|f| now.duration_since(f.at) > FIX_WINDOW) {
                self.fixes.pop_front();
            }
        }
        self.was_armed = armed;
        if t.fix_type < 2 {
            self.place = format!("No fix, {} satellites", t.num_sv);
            self.where_note = "A position shows once the GPS has a 2D or 3D fix.".into();
            return;
        }
        self.place = format_deg(t.lat_e7, t.lon_e7);
        let here = (t.lat_e7, t.lon_e7);
        if self.pad.is_none() {
            self.pad = Some(here);
        }
        let (lat0, lon0) = self.pad.unwrap();
        let (east, north) = en_meters(lat0, lon0, here.0, here.1);
        self.track.push([east, north]);
        if self.track.len() > 60 {
            self.track.remove(0);
        }
        let dist = (east * east + north * north).sqrt();
        let height = t.hmsl_mm as f64 / 1000.0;
        self.where_note = if dist < 3.0 {
            format!("{height:.0} m above the sea, still where this fix started")
        } else {
            format!("{dist:.0} m {} of where it armed, {height:.0} m above the sea", bearing_name(east, north))
        };
    }
}

impl GroundState {
    fn gps_view(&self) -> GpsView {
        let mut g = GpsView::default();
        let t = self.telemetry.as_ref();
        let fix_type = t.map_or(0, |t| t.fix_type);
        g.fix = match t {
            None => ("No data".into(), Tone::Neutral),
            Some(_) => fix_name(fix_type),
        };
        g.sats = t.map_or_else(|| "—".into(), |t| t.num_sv.to_string());
        let last = self.fixes.back().copied();
        g.has_fix = last.is_some();
        let dash = || "—".to_string();
        if let Some(f) = last {
            g.lat = format!("{:.7}", f.lat_e7 as f64 / 1e7);
            g.lon = format!("{:.7}", f.lon_e7 as f64 / 1e7);
            g.alt = format!("{:.1} m MSL", f.hmsl_mm as f64 / 1000.0);
            let age = f.at.elapsed();
            g.age = format!("last fix {:.0} s ago", age.as_secs_f64());
            g.age_stale = age >= FIX_STALE;
        } else {
            g.age = "no fix yet".into();
        }
        match motion(&self.fixes) {
            Some(m) => {
                g.speed = format!("{:.1} m/s", m.speed);
                g.vspeed = format!("{:+.1} m/s", m.vspeed);
                g.course_deg = m.course;
                g.course = m.course.map_or_else(|| "not moving".into(), |c| format!("{c:03.0}° {}", compass16(c)));
            }
            None => (g.speed, g.vspeed, g.course) = (dash(), dash(), dash()),
        }
        match self.tilt {
            Some((deg, ok)) => {
                g.tilt_deg = Some(deg);
                g.tilt = format!("{deg:.1}° from vertical");
                g.tilt_note = if ok {
                    "From the accelerometer's gravity vector; good while still on the pad".into()
                } else {
                    "Accelerating, so this is not true tilt".into()
                };
            }
            None => (g.tilt, g.tilt_note) = (dash(), "Shows once armed (needs IMU in telemetry)".into()),
        }
        g.station_error = self.station_error.clone();
        if let Some(s) = self.station {
            g.station_set = true;
            g.station = format!(
                "{:.6}, {:.6}{}",
                s.lat_e7 as f64 / 1e7,
                s.lon_e7 as f64 / 1e7,
                s.alt_m.map_or_else(String::new, |a| format!(", {a:.0} m"))
            );
            if let Some((lat0, lon0)) = self.pad {
                let (e, n) = en_meters(lat0, lon0, s.lat_e7, s.lon_e7);
                g.station_en = Some([e, n]);
            }
            if let Some(f) = last {
                let (e, n) = en_meters(s.lat_e7, s.lon_e7, f.lat_e7, f.lon_e7);
                let dist = (e * e + n * n).sqrt();
                g.range = format_dist(dist);
                if dist >= 1.0 {
                    let b = bearing_deg(e, n);
                    g.bearing_deg = Some(b);
                }
                g.elevation = match s.alt_m {
                    Some(a) => {
                        let dh = f.hmsl_mm as f64 / 1000.0 - a;
                        format!("{:.1}° ({:+.0} m)", dh.atan2(dist.max(0.1)).to_degrees(), dh)
                    }
                    None => "needs station altitude".into(),
                };
            }
        }
        g
    }
}

struct Motion {
    speed: f64,
    vspeed: f64,
    course: Option<f64>,
}

/// Speed and course from the newest fix and one about 2 s earlier.
fn motion(fixes: &VecDeque<Fix>) -> Option<Motion> {
    let b = fixes.back()?;
    let a = fixes.iter().rev().find(|f| b.at.duration_since(f.at) >= Duration::from_millis(1800)).or_else(|| fixes.front())?;
    let dt = b.at.duration_since(a.at).as_secs_f64();
    if dt < 0.4 {
        return None;
    }
    let (e, n) = en_meters(a.lat_e7, a.lon_e7, b.lat_e7, b.lon_e7);
    let d = (e * e + n * n).sqrt();
    Some(Motion {
        speed: d / dt,
        vspeed: (b.hmsl_mm - a.hmsl_mm) as f64 / 1000.0 / dt,
        course: (d >= MIN_MOVE_M).then(|| bearing_deg(e, n)),
    })
}

/// (long axis, degrees off vertical, trustworthy). The long axis is the one
/// carrying most of gravity the first time the rocket is seen at ~1 g.
fn tilt_from_accel(a: [f64; 3], nose: Option<usize>) -> Option<(usize, f64, bool)> {
    let mag = (a[0] * a[0] + a[1] * a[1] + a[2] * a[2]).sqrt();
    if mag.is_nan() || mag <= 0.05 {
        return None;
    }
    let still = (0.9..=1.1).contains(&mag);
    let ax = match nose {
        Some(ax) => ax,
        None if still => (0..3).max_by(|&i, &j| a[i].abs().total_cmp(&a[j].abs()))?,
        None => return None,
    };
    let deg = (a[ax].abs() / mag).clamp(0.0, 1.0).acos().to_degrees();
    Some((ax, deg, still))
}

fn fix_name(fix_type: u8) -> (String, Tone) {
    match fix_type {
        0 => ("No fix".into(), Tone::Bad),
        1 => ("Dead reckoning".into(), Tone::Warn),
        2 => ("2D fix".into(), Tone::Warn),
        3 => ("3D fix".into(), Tone::Good),
        4 => ("GNSS + DR".into(), Tone::Good),
        5 => ("Time only".into(), Tone::Warn),
        n => (format!("fix type {n}"), Tone::Neutral),
    }
}

fn parse_station(text: &str) -> Result<Station, String> {
    let parts: Vec<&str> = text.split([',', ' ']).filter(|s| !s.is_empty()).collect();
    if !(2..=3).contains(&parts.len()) {
        return Err("Enter \"lat, lon\" or \"lat, lon, altitude m\" in decimal degrees".into());
    }
    let num = |s: &str| s.parse::<f64>().map_err(|_| format!("\"{s}\" is not a number"));
    let (lat, lon) = (num(parts[0])?, num(parts[1])?);
    if !(-90.0..=90.0).contains(&lat) || !(-180.0..=180.0).contains(&lon) {
        return Err("Latitude must be within ±90 and longitude within ±180".into());
    }
    let alt_m = parts.get(2).map(|s| num(s)).transpose()?;
    Ok(Station { lat_e7: (lat * 1e7).round() as i32, lon_e7: (lon * 1e7).round() as i32, alt_m })
}

fn bearing_deg(east: f64, north: f64) -> f64 {
    east.atan2(north).to_degrees().rem_euclid(360.0)
}

fn compass16(deg: f64) -> &'static str {
    const N: [&str; 16] = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
    N[((deg / 22.5).round() as usize) % 16]
}

fn format_dist(m: f64) -> String {
    if m >= 1000.0 {
        format!("{:.2} km", m / 1000.0)
    } else {
        format!("{m:.0} m")
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
                words: match expected {
                    Some(e) => format!("read 0x{value:02X}, expected 0x{e:02X}"),
                    None if what.is_empty() => format!("read 0x{value:02X}"),
                    None => format!("read 0x{value:02X} ({what})"),
                },
                when: if s.live_mask >> i & 1 != 0 { "live".into() } else { "boot".into() },
            }
        })
        .collect()
}

/// 1e-7 degrees, the unit on the radio, as a person reads a map.
fn format_deg(lat_e7: i32, lon_e7: i32) -> String {
    fn hem(v: i32, pos: &str, neg: &str) -> String {
        format!("{:.5}° {}", (v as f64 / 1e7).abs(), if v < 0 { neg } else { pos })
    }
    format!("{}, {}", hem(lat_e7, "N", "S"), hem(lon_e7, "E", "W"))
}

/// East and north metres. Fine for a few kilometres; the Earth is taken as flat.
fn en_meters(lat0: i32, lon0: i32, lat1: i32, lon1: i32) -> (f64, f64) {
    let lat = lat0 as f64 / 1e7;
    let north = (lat1 - lat0) as f64 / 1e7 * 111_320.0;
    let east = (lon1 - lon0) as f64 / 1e7 * 111_320.0 * lat.to_radians().cos();
    (east, north)
}

fn bearing_name(east: f64, north: f64) -> &'static str {
    let deg = east.atan2(north).to_degrees();
    let oct = ((deg + 180.0) / 45.0).round() as i32 % 8;
    ["south", "southwest", "west", "northwest", "north", "northeast", "east", "southeast"][oct.rem_euclid(8) as usize]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_berkeley_fix_reads_north_and_west() {
        // Campanile: 37.87215 N, 122.25795 W.
        assert_eq!(format_deg(378_721_500, -1_222_579_500), "37.87215° N, 122.25795° W");
    }

    #[test]
    fn tilt_learns_the_long_axis_on_the_pad() {
        let (ax, deg, ok) = tilt_from_accel([0.0, 0.0, -1.0], None).unwrap();
        assert_eq!((ax, ok), (2, true));
        assert!(deg.abs() < 1e-9);
        let (_, deg, _) = tilt_from_accel([0.0, 0.5, 0.866], Some(2)).unwrap();
        assert!((deg - 30.0).abs() < 0.1, "{deg}");
        assert!(tilt_from_accel([0.0, 0.0, 5.0], None).is_none());
    }

    #[test]
    fn course_from_two_fixes() {
        let t0 = Instant::now();
        let mut f = VecDeque::new();
        f.push_back(Fix { at: t0, lat_e7: 378_721_500, lon_e7: -1_222_579_500, hmsl_mm: 0 });
        f.push_back(Fix { at: t0 + Duration::from_secs(2), lat_e7: 378_721_500, lon_e7: -1_222_570_000, hmsl_mm: 10_000 });
        let m = motion(&f).unwrap();
        assert!((m.course.unwrap() - 90.0).abs() < 0.5);
        assert!((m.vspeed - 5.0).abs() < 1e-9);
        assert_eq!(compass16(m.course.unwrap()), "E");
    }

    #[test]
    fn station_text() {
        let s = parse_station("37.87215, -122.25795, 120").unwrap();
        assert_eq!((s.lat_e7, s.lon_e7, s.alt_m), (378_721_500, -1_222_579_500, Some(120.0)));
        assert!(parse_station("91, 0").is_err());
        assert!(parse_station("abc").is_err());
    }

    #[test]
    fn a_hundred_metres_due_north() {
        let (east, north) = en_meters(378_721_500, -1_222_579_500, 378_730_500, -1_222_579_500);
        assert!(east.abs() < 1.0, "{east}");
        assert!((north - 100.2).abs() < 1.0, "{north}");
        assert_eq!(bearing_name(east, north), "north");
    }
}
