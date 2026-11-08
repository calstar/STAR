//! Display text and tones, computed here so the frontend only renders.

use serde::Serialize;

use crate::protocol::{battery, pyro, self_test as st, state};

/// How a value should look. The frontend maps each to a colour; nothing else.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Tone {
    Neutral,
    Good,
    Warn,
    Bad,
    Info,
}

pub fn state_tone(s: u8) -> Tone {
    match s {
        state::SELF_TEST => Tone::Warn,
        state::IDLE => Tone::Good,
        state::ARMED | state::LAUNCHED => Tone::Bad,
        state::RECOVERY => Tone::Info,
        _ => Tone::Neutral,
    }
}

pub fn result_tone(r: u8) -> Tone {
    match r {
        st::PASS => Tone::Good,
        st::FAIL | st::TIMEOUT => Tone::Bad,
        st::PENDING => Tone::Warn,
        _ => Tone::Neutral,
    }
}

pub fn battery_tone(s: u8) -> Tone {
    match s {
        battery::OK => Tone::Good,
        battery::LOW => Tone::Warn,
        battery::CRITICAL => Tone::Bad,
        _ => Tone::Neutral,
    }
}

pub fn pyro_tone(s: u8) -> Tone {
    match s {
        pyro::CONTINUITY => Tone::Good,
        pyro::OPEN => Tone::Warn,
        pyro::SHORT => Tone::Bad,
        _ => Tone::Neutral,
    }
}

pub fn state_name(s: u8) -> String {
    state::name(s).replace('_', " ")
}

pub fn fix_name(fix: u8) -> String {
    match fix {
        0 => "no fix".into(),
        1 => "dead reckoning".into(),
        2 => "2D".into(),
        3 => "3D".into(),
        4 => "GNSS + DR".into(),
        5 => "time only".into(),
        n => n.to_string(),
    }
}

pub fn fmt_bytes(n: u64) -> String {
    let mut x = n as f64;
    for unit in ["B", "KB", "MB", "GB"] {
        if x < 1024.0 || unit == "GB" {
            return if unit == "B" { format!("{x:.0} B") } else { format!("{x:.1} {unit}") };
        }
        x /= 1024.0;
    }
    unreachable!()
}

pub fn fmt_duration(ms: u32) -> String {
    let s = ms / 1000;
    let (h, m, s) = (s / 3600, s / 60 % 60, s % 60);
    if h > 0 {
        format!("{h}:{m:02}:{s:02}")
    } else {
        format!("{m}:{s:02}")
    }
}

/// Unix seconds -> (year, month, day, hour, minute, second), UTC.
/// Howard Hinnant's civil_from_days.
pub fn utc(t: u64) -> (i64, u32, u32, u32, u32, u32) {
    let days = (t / 86_400) as i64;
    let rem = t % 86_400;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    (y, m, d, (rem / 3600) as u32, (rem / 60 % 60) as u32, (rem % 60) as u32)
}

pub fn utc_text(t: u64) -> String {
    let (y, mo, d, h, mi, s) = utc(t);
    format!("{y:04}-{mo:02}-{d:02} {h:02}:{mi:02}:{s:02}")
}

pub fn now_utc_iso() -> String {
    let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let (y, mo, d, h, mi, s) = utc(t);
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{mi:02}:{s:02}+00:00")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utc_conversion() {
        assert_eq!(utc_text(0), "1970-01-01 00:00:00");
        assert_eq!(utc_text(1_793_548_800), "2026-11-01 16:00:00");
        assert_eq!(utc_text(951_782_400), "2000-02-29 00:00:00"); // leap day
    }

    #[test]
    fn formatting() {
        assert_eq!(fmt_bytes(512), "512 B");
        assert_eq!(fmt_bytes(1536), "1.5 KB");
        assert_eq!(fmt_duration(65_000), "1:05");
        assert_eq!(fmt_duration(3_725_000), "1:02:05");
    }
}
