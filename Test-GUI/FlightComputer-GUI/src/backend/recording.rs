//! Flight data recording: every live sample (USB stream, or the rocket's
//! telemetry on a receiver) from the moment the rocket is armed until STOP is
//! pressed, kept in memory and saved as one CSV file.

use std::fmt::Write as _;
use std::path::Path;
use std::time::Instant;

use serde::Serialize;

use crate::records::{self as rec, Decoded, REC_BARO, REC_GNSS, REC_HIGHG, REC_IMU};

#[derive(Clone, Copy, Debug, PartialEq, Default)]
enum Phase {
    /// Waiting for the rocket to arm.
    #[default]
    Waiting,
    Recording,
    /// STOP pressed: the rows are kept for saving until the next arm.
    Stopped,
}

#[derive(Default)]
pub struct Recorder {
    phase: Phase,
    t0: Option<Instant>,
    rows: Vec<(f64, Decoded)>,
    was_armed: bool,
    saved_to: Option<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq, Default)]
pub struct RecordingView {
    /// "waiting", "recording" or "stopped".
    pub phase: String,
    pub text: String,
    pub can_stop: bool,
    pub can_save: bool,
}

fn kind(d: &Decoded) -> u8 {
    match d {
        Decoded::Imu(_) => REC_IMU,
        Decoded::HighG(_) => REC_HIGHG,
        Decoded::Baro(_) => REC_BARO,
        Decoded::Gnss(_) => REC_GNSS,
    }
}

impl Recorder {
    /// Called with the rocket's armed state: arming starts a new recording.
    pub fn on_armed(&mut self, armed: bool) {
        if armed && !self.was_armed && self.phase != Phase::Recording {
            self.phase = Phase::Recording;
            self.t0 = Some(Instant::now());
            self.rows.clear();
            self.saved_to = None;
        }
        self.was_armed = armed;
    }

    pub fn on_sample(&mut self, d: Decoded) {
        if self.phase != Phase::Recording {
            return;
        }
        let t = self.t0.map_or(0.0, |t0| t0.elapsed().as_secs_f64());
        self.rows.push((t, d));
    }

    pub fn stop(&mut self) {
        if self.phase == Phase::Recording {
            self.phase = Phase::Stopped;
        }
    }

    /// One file: time, sensor, then every sensor's columns (blank where not that sensor).
    pub fn csv(&self) -> String {
        let mut out = String::from("t_s,sensor");
        for t in rec::SENSORS {
            for c in rec::columns(t) {
                let _ = write!(out, ",{}_{c}", rec::name(t));
            }
        }
        out.push('\n');
        for (t, d) in &self.rows {
            let k = kind(d);
            let _ = write!(out, "{t:.6},{}", rec::name(k));
            for s in rec::SENSORS {
                if s == k {
                    for v in d.csv() {
                        let _ = write!(out, ",{v}");
                    }
                } else {
                    out.push_str(&",".repeat(rec::columns(s).len()));
                }
            }
            out.push('\n');
        }
        out
    }

    pub fn save(&mut self, path: &Path) -> Result<(), String> {
        std::fs::write(path, self.csv()).map_err(|e| format!("Could not write {}: {e}", path.display()))?;
        self.saved_to = Some(path.display().to_string());
        Ok(())
    }

    pub fn view(&self) -> RecordingView {
        let n = self.rows.len();
        let secs = self.rows.last().map_or(0.0, |r| r.0);
        let (phase, text) = match self.phase {
            Phase::Waiting => ("waiting", "Recording starts when the rocket is armed".to_string()),
            Phase::Recording => ("recording", format!("Recording: {n} samples, {secs:.1} s")),
            Phase::Stopped => (
                "stopped",
                match &self.saved_to {
                    Some(p) => format!("Saved {n} samples to {p}"),
                    None => format!("Stopped: {n} samples, {secs:.1} s"),
                },
            ),
        };
        RecordingView {
            phase: phase.into(),
            text,
            can_stop: self.phase == Phase::Recording,
            can_save: self.phase == Phase::Stopped && n > 0,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::records::Baro;

    fn baro() -> Decoded {
        Decoded::Baro(Baro { t_us: 0, temp_c: 20.0, pressure_pa: 101325.0, altitude_m: 0.0 })
    }

    #[test]
    fn records_only_from_arm_to_stop() {
        let mut r = Recorder::default();
        r.on_sample(baro());
        assert_eq!(r.view().phase, "waiting");
        r.on_armed(true);
        r.on_sample(baro());
        r.on_sample(baro());
        assert!(r.view().can_stop && !r.view().can_save);
        r.stop();
        r.on_sample(baro());
        let v = r.view();
        assert!(v.can_save && !v.can_stop, "{v:?}");
        let csv = r.csv();
        assert_eq!(csv.lines().count(), 3, "{csv}");
        let width = csv.lines().next().unwrap().split(',').count();
        assert!(csv.lines().all(|l| l.split(',').count() == width), "{csv}");
        // Staying armed does not restart; a new arm does.
        r.on_armed(true);
        assert_eq!(r.view().phase, "stopped");
        r.on_armed(false);
        r.on_armed(true);
        assert_eq!(r.view().phase, "recording");
        assert!(r.rows.is_empty());
    }
}
