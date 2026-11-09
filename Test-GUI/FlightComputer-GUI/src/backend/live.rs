//! Live: the board's slow debug stream.
//!
//! The board sends the latest sample of each sensor at the chosen rate (it does
//! not stream full-rate data; that is what the eMMC log is for). Samples are
//! decoded here with the config the board reported as ACTIVE, so changing a
//! range on the Config tab rescales the plot correctly once applied. The window
//! gets them in batches (`live` events) and only draws them.

use std::collections::BTreeMap;
use std::time::{Duration, Instant};

use serde::Serialize;

use super::format::fix_name;
use super::{Purpose, Shared};
use crate::protocol::{self as p, msg, Frame};
use crate::records::{self as rec, Decoded, P0_PA};

pub const RATES: [u16; 8] = [0, 1, 2, 5, 10, 25, 50, 100];
pub const DEFAULT_RATE: u16 = 10;
/// Seconds of history the window keeps on screen.
pub const WINDOW_S: f64 = 30.0;

/// One chart: title, unit, a legend name per line.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct PlotSpec {
    pub title: String,
    pub unit: String,
    pub series: Vec<String>,
}

fn plots() -> Vec<PlotSpec> {
    let spec =
        |t: &str, u: &str, s: &[&str]| PlotSpec { title: t.into(), unit: u.into(), series: s.iter().map(|x| x.to_string()).collect() };
    vec![
        spec("Accel (IMU)", "g", &["x", "y", "z"]),
        spec("Gyro", "dps", &["x", "y", "z"]),
        spec("High-g accel", "g", &["x", "y", "z"]),
        spec("Baro altitude (ISA)", "m", &["baro"]),
        spec("GNSS altitude MSL", "m", &["gnss"]),
    ]
}

pub const PLOT_ACCEL: usize = 0;
pub const PLOT_GYRO: usize = 1;
pub const PLOT_HIGHG: usize = 2;
pub const PLOT_BARO: usize = 3;
pub const PLOT_GNSS: usize = 4;

/// One sample for one chart: `y` has one value per line of that chart. A point
/// whose values are all `None` is a break: the chart leaves a gap there instead
/// of drawing a line across a stretch the board was not sending.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Point {
    pub plot: usize,
    /// Seconds since the link came up.
    pub t: f64,
    pub y: Vec<Option<f64>>,
}

const PLOTS: usize = 5;

/// The charts a stream-mask bit feeds.
fn plots_of(bit: u8) -> &'static [usize] {
    match bit {
        p::STREAM_IMU => &[PLOT_ACCEL, PLOT_GYRO],
        p::STREAM_HIGHG => &[PLOT_HIGHG],
        p::STREAM_BARO => &[PLOT_BARO],
        p::STREAM_GNSS => &[PLOT_GNSS],
        _ => &[],
    }
}

/// One box of current values at the top of the Live tab.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Reading {
    pub label: String,
    /// (name, value): one entry for a single value, x/y/z for a vector.
    pub values: Vec<(String, String)>,
    pub unit: String,
    /// The sensor is not being streamed now: the values are the last ones seen
    /// (or dashes), and the box is drawn faded.
    pub stale: bool,
}

/// What the `live` event carries.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Batch {
    /// Which link session these belong to. A new one (a reconnect) restarts
    /// `t` at 0, so the window drops what it holds from the old one.
    pub session: u32,
    pub points: Vec<Point>,
    /// The latest value of everything, in boxes.
    pub readings: Vec<Reading>,
}

#[derive(Serialize, Clone, Debug, PartialEq, Default)]
pub struct Choice {
    pub value: u16,
    pub label: String,
}

#[derive(Serialize, Clone, Debug, PartialEq, Default)]
pub struct LiveView {
    pub rate: u16,
    pub rates: Vec<Choice>,
    pub mask: u8,
    /// (bit, name) for each sensor checkbox.
    pub sensors: Vec<(u8, String)>,
    pub error: Option<String>,
    pub plots: Vec<PlotSpec>,
    pub window_s: f64,
    /// SELF_TEST and IDLE: the Idle heartbeats, newest first.
    pub heartbeats: Option<Vec<super::heartbeats::HeartbeatRow>>,
    pub show_graphs: bool,
}

pub struct LiveState {
    pub rate: u16,
    pub mask: u8,
    pub error: Option<String>,
    pub latest: BTreeMap<u8, Decoded>,
    t0: Instant,
    batch: Vec<Point>,
    /// Time of each chart's last point, if it has one.
    last_t: [Option<f64>; PLOTS],
    /// The chart's data stopped (sensor turned off, stream off, GNSS fix lost):
    /// its next point is preceded by a break.
    broken: [bool; PLOTS],
    /// The readings changed without a new sample (stream settings): send them.
    readings_dirty: bool,
    session: u32,
    last_sample: Option<Instant>,
}

impl LiveState {
    pub fn new() -> Self {
        Self {
            rate: DEFAULT_RATE,
            mask: p::STREAM_ALL,
            error: None,
            latest: BTreeMap::new(),
            t0: Instant::now(),
            batch: Vec::new(),
            last_t: [None; PLOTS],
            broken: [false; PLOTS],
            readings_dirty: true,
            session: 0,
            last_sample: None,
        }
    }

    pub fn restart(&mut self) {
        self.t0 = Instant::now();
        self.latest.clear();
        self.batch.clear();
        self.last_t = [None; PLOTS];
        self.broken = [false; PLOTS];
        self.readings_dirty = true;
        self.session += 1;
        self.last_sample = None;
    }

    pub fn set_stream(&mut self, sh: &mut Shared, rate: u16, mask: u8) {
        if !RATES.contains(&rate) {
            return sh.warn("Live", format!("{rate} Hz is not a stream rate this app offers"));
        }
        let mask = mask & p::STREAM_ALL;
        // A sensor coming back (its bit set again, or the stream turned back
        // on) resumes after a gap: mark its charts so the first new point is
        // not joined to the last old one.
        let was = if self.rate == 0 { 0 } else { self.mask };
        let now = if rate == 0 { 0 } else { mask };
        for bit in [p::STREAM_IMU, p::STREAM_HIGHG, p::STREAM_BARO, p::STREAM_GNSS] {
            if now & bit != 0 && was & bit == 0 {
                for &plot in plots_of(bit) {
                    self.broken[plot] = true;
                }
            }
        }
        self.rate = rate;
        self.mask = mask;
        self.readings_dirty = true;
        self.push_stream(sh);
    }

    pub fn push_stream(&mut self, sh: &mut Shared) {
        if !sh.client.is_open() {
            return;
        }
        let mut pl = self.rate.to_le_bytes().to_vec();
        pl.push(self.mask);
        sh.client.request(msg::SET_STREAM, &pl, Purpose::Stream);
    }

    pub fn on_stream_reply(&mut self, res: Result<Frame, String>) {
        self.error = match res {
            Err(e) => Some(e),
            Ok(fr) => match p::Ack::unpack(&fr.payload) {
                Ok(a) if a.ok() => None,
                Ok(a) => Some(a.describe()),
                Err(e) => Some(e),
            },
        }
        .map(|e| format!("Stream request refused: {e}"));
    }

    pub fn on_sample(&mut self, sh: &Shared, t: u8, data: &[u8]) {
        // A board that cannot report its config runs the firmware defaults (PROTOCOL.md §5).
        let conf = sh.active_config.unwrap_or_else(crate::config::defaults);
        let Some(d) = rec::decode(t, data, &conf, P0_PA) else { return };
        self.latest.insert(t, d);
        self.last_sample = Some(Instant::now());
        let now = self.t0.elapsed().as_secs_f64();
        let (batch, last_t, broken) = (&mut self.batch, &mut self.last_t, &mut self.broken);
        let mut put = |plot: usize, y: Vec<f64>| {
            if std::mem::take(&mut broken[plot]) {
                if let Some(last) = last_t[plot] {
                    batch.push(Point { plot, t: (last + now) / 2.0, y: vec![None; y.len()] });
                }
            }
            last_t[plot] = Some(now);
            batch.push(Point { plot, t: now, y: y.into_iter().map(Some).collect() });
        };
        match d {
            Decoded::Imu(d) => {
                put(PLOT_ACCEL, d.accel_g.to_vec());
                put(PLOT_GYRO, d.gyro_dps.to_vec());
            }
            Decoded::HighG(d) => put(PLOT_HIGHG, d.accel_g.to_vec()),
            Decoded::Baro(d) => put(PLOT_BARO, vec![d.altitude_m]),
            Decoded::Gnss(d) if d.fix_type >= 3 => put(PLOT_GNSS, vec![d.hmsl_m]),
            Decoded::Gnss(_) => broken[PLOT_GNSS] = true,
        }
    }

    /// What arrived since the last call, or None.
    pub fn take_batch(&mut self) -> Option<Batch> {
        if self.batch.is_empty() && !self.readings_dirty {
            return None;
        }
        self.readings_dirty = false;
        Some(Batch { session: self.session, points: std::mem::take(&mut self.batch), readings: self.readings() })
    }

    fn streaming(&self, bit: u8) -> bool {
        self.rate != 0 && self.mask & bit != 0
    }

    /// The current values, a box each. Every box is always there (dashes until a
    /// sample arrives), so the row does not jump around as sensors come and go.
    pub fn readings(&self) -> Vec<Reading> {
        let dash = || "—".to_string();
        let xyz = |v: Option<[f64; 3]>, prec: usize| -> Vec<(String, String)> {
            ["x", "y", "z"]
                .iter()
                .enumerate()
                .map(|(i, n)| (n.to_string(), v.map_or_else(dash, |v| format!("{:+.*}", prec, v[i]))))
                .collect()
        };
        let one = |v: Option<String>| vec![(String::new(), v.unwrap_or_else(dash))];
        let r = |label: &str, values: Vec<(String, String)>, unit: &str, bit: u8| Reading {
            label: label.into(),
            values,
            unit: unit.into(),
            stale: !self.streaming(bit),
        };
        let imu = match self.latest.get(&rec::REC_IMU) {
            Some(Decoded::Imu(d)) => Some(d),
            _ => None,
        };
        let highg = match self.latest.get(&rec::REC_HIGHG) {
            Some(Decoded::HighG(d)) => Some(d),
            _ => None,
        };
        let baro = match self.latest.get(&rec::REC_BARO) {
            Some(Decoded::Baro(d)) => Some(d),
            _ => None,
        };
        let gnss = match self.latest.get(&rec::REC_GNSS) {
            Some(Decoded::Gnss(d)) => Some(d),
            _ => None,
        };
        let fixed = gnss.filter(|g| g.fix_type >= 3);
        vec![
            r("Accel (IMU)", xyz(imu.map(|d| d.accel_g), 3), "g", p::STREAM_IMU),
            r("Gyro", xyz(imu.map(|d| d.gyro_dps), 2), "dps", p::STREAM_IMU),
            r("High-g accel", xyz(highg.map(|d| d.accel_g), 2), "g", p::STREAM_HIGHG),
            r("IMU temperature", one(imu.map(|d| format!("{:.1}", d.temp_c))), "°C", p::STREAM_IMU),
            r("Pressure", one(baro.map(|d| format!("{:.2}", d.pressure_pa / 100.0))), "hPa", p::STREAM_BARO),
            r("Baro altitude (ISA)", one(baro.map(|d| format!("{:.1}", d.altitude_m))), "m", p::STREAM_BARO),
            r("Baro temperature", one(baro.map(|d| format!("{:.1}", d.temp_c))), "°C", p::STREAM_BARO),
            r("GNSS fix", one(gnss.map(|g| format!("{}, {} satellites", fix_name(g.fix_type), g.num_sv))), "", p::STREAM_GNSS),
            r(
                "GNSS position",
                vec![
                    ("lat".into(), fixed.map_or_else(dash, |g| format!("{:.6}", g.lat_deg))),
                    ("lon".into(), fixed.map_or_else(dash, |g| format!("{:.6}", g.lon_deg))),
                ],
                "°",
                p::STREAM_GNSS,
            ),
            r("GNSS altitude MSL", one(fixed.map(|g| format!("{:.1}", g.hmsl_m))), "m", p::STREAM_GNSS),
        ]
    }

    /// Samples arrived in the last few seconds.
    pub fn receiving(&self) -> bool {
        self.last_sample.is_some_and(|t| t.elapsed() < Duration::from_secs(3))
    }

    pub fn view(&self) -> LiveView {
        LiveView {
            rate: self.rate,
            rates: RATES.iter().map(|&r| Choice { value: r, label: if r == 0 { "Off".into() } else { format!("{r} Hz") } }).collect(),
            mask: self.mask,
            sensors: [(p::STREAM_IMU, "IMU"), (p::STREAM_HIGHG, "High-g"), (p::STREAM_BARO, "Baro"), (p::STREAM_GNSS, "GNSS")]
                .iter()
                .map(|(b, n)| (*b, n.to_string()))
                .collect(),
            error: self.error.clone(),
            plots: plots(),
            window_s: WINDOW_S,
            heartbeats: None,
            show_graphs: true,
        }
    }
}

impl Default for LiveState {
    fn default() -> Self {
        Self::new()
    }
}
