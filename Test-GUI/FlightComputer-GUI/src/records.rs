//! Sensor records (firmware app/records.h), raw and in physical units.
//!
//! The same structs arrive two ways: live, in SAMPLE frames over USB, and inside
//! eMMC log blocks. Both go through `decode` here, so a plot of a live stream
//! and a plot of a downloaded flight use one decoder.
//!
//! Raw counts become units with the scale of the config the board was running:
//! accel and gyro LSB sizes depend on the configured range. A record decoded
//! with the wrong config is wrong by a factor of 2^n, silently, so callers
//! always say which config they used (see `emmc::Session::config_source`).

use crate::config::{self as cfg, Values};
use crate::protocol::Rd;

pub const REC_IMU: u8 = 0x10;
pub const REC_HIGHG: u8 = 0x11;
pub const REC_BARO: u8 = 0x12;
pub const REC_GNSS: u8 = 0x13;
pub const REC_HEALTH: u8 = 0x14;
pub const REC_EVENT: u8 = 0x15;
/// Proposed (PROTOCOL.md): the config blob, first record of every session.
pub const REC_CONFIG: u8 = 0x16;

// Log-owned record types (Core/Inc/emmc_log.h).
pub const REC_SESSION_START: u8 = 0x01;
pub const REC_STATE: u8 = 0x02;
pub const REC_SESSION_END: u8 = 0x03;
pub const REC_DROPPED: u8 = 0x04;

pub const IMU_SIZE: usize = 18;
pub const HIGHG_SIZE: usize = 7;
pub const BARO_SIZE: usize = 12;
pub const GNSS_SIZE: usize = 49;

/// The sensor records that get a CSV, in export order.
pub const SENSORS: [u8; 4] = [REC_IMU, REC_HIGHG, REC_BARO, REC_GNSS];

pub fn name(t: u8) -> String {
    match t {
        REC_IMU => "imu",
        REC_HIGHG => "highg",
        REC_BARO => "baro",
        REC_GNSS => "gnss",
        REC_HEALTH => "health",
        REC_EVENT => "event",
        REC_CONFIG => "config",
        REC_SESSION_START => "session_start",
        REC_STATE => "state",
        REC_SESSION_END => "session_end",
        REC_DROPPED => "dropped",
        _ => return format!("type_0x{t:02x}"),
    }
    .into()
}

/// CSV column names per record type (after t_ms).
pub fn columns(t: u8) -> &'static [&'static str] {
    match t {
        REC_IMU => &["t_us", "ax_g", "ay_g", "az_g", "gx_dps", "gy_dps", "gz_dps", "temp_c"],
        REC_HIGHG => &["t_us", "ax_g", "ay_g", "az_g"],
        REC_BARO => &["t_us", "pressure_pa", "temp_c", "altitude_m"],
        REC_GNSS => &[
            "t_us", "pps_us", "itow_ms", "lat_deg", "lon_deg", "hmsl_m", "vel_n_ms", "vel_e_ms", "vel_d_ms", "hacc_m", "vacc_m", "pdop",
            "fix_type", "num_sv", "flags",
        ],
        _ => &[],
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Imu {
    pub t_us: u32,
    pub temp_c: f64,
    pub gyro_dps: [f64; 3],
    pub accel_g: [f64; 3],
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct HighG {
    pub t_us: u32,
    pub accel_g: [f64; 3],
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Baro {
    pub t_us: u32,
    pub temp_c: f64,
    pub pressure_pa: f64,
    pub altitude_m: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Gnss {
    pub t_us: u32,
    pub pps_us: u32,
    pub itow_ms: u32,
    pub lat_deg: f64,
    pub lon_deg: f64,
    pub hmsl_m: f64,
    pub vel_ned_ms: [f64; 3],
    pub hacc_m: f64,
    pub vacc_m: f64,
    pub pdop: f64,
    pub fix_type: u8,
    pub num_sv: u8,
    pub flags: u8,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Decoded {
    Imu(Imu),
    HighG(HighG),
    Baro(Baro),
    Gnss(Gnss),
}

impl Decoded {
    /// Values in `columns()` order, as CSV text.
    pub fn csv(&self) -> Vec<String> {
        let f = |x: f64| format!("{x}");
        match self {
            Decoded::Imu(d) => {
                let mut v = vec![d.t_us.to_string()];
                v.extend(d.accel_g.iter().map(|&x| f(x)));
                v.extend(d.gyro_dps.iter().map(|&x| f(x)));
                v.push(f(d.temp_c));
                v
            }
            Decoded::HighG(d) => {
                let mut v = vec![d.t_us.to_string()];
                v.extend(d.accel_g.iter().map(|&x| f(x)));
                v
            }
            Decoded::Baro(d) => vec![d.t_us.to_string(), f(d.pressure_pa), f(d.temp_c), f(d.altitude_m)],
            Decoded::Gnss(d) => {
                let mut v = vec![d.t_us.to_string(), d.pps_us.to_string(), d.itow_ms.to_string(), f(d.lat_deg), f(d.lon_deg), f(d.hmsl_m)];
                v.extend(d.vel_ned_ms.iter().map(|&x| f(x)));
                v.extend([f(d.hacc_m), f(d.vacc_m), f(d.pdop), d.fix_type.to_string(), d.num_sv.to_string(), d.flags.to_string()]);
                v
            }
        }
    }
}

/// ISA troposphere (ICAO Doc 7488): h = 44330.8 (1 - (p/p0)^0.190263).
pub fn pressure_altitude_m(p_pa: f64, p0_pa: f64) -> f64 {
    if p_pa <= 0.0 {
        return f64::NAN;
    }
    44330.8 * (1.0 - (p_pa / p0_pa).powf(0.190263))
}

pub const P0_PA: f64 = 101_325.0;

/// One record's payload -> units. None for unknown types, short data, or a
/// config whose ranges have no known scale.
pub fn decode(t: u8, data: &[u8], config: &Values, p0_pa: f64) -> Option<Decoded> {
    let mut r = Rd::new(data);
    Some(match t {
        REC_IMU => {
            let a = cfg::accel_mg_per_lsb(config["imu_accel_fs_g"])? / 1000.0;
            let g = cfg::gyro_mdps_per_lsb(config["imu_gyro_fs_dps"])? / 1000.0;
            let t_us = r.u32().ok()?;
            let temp = r.i16().ok()?;
            let gyro = [r.i16().ok()?, r.i16().ok()?, r.i16().ok()?];
            let acc = [r.i16().ok()?, r.i16().ok()?, r.i16().ok()?];
            Decoded::Imu(Imu {
                t_us,
                temp_c: 25.0 + temp as f64 / 256.0, // DS13012 Table 4
                gyro_dps: gyro.map(|x| x as f64 * g),
                accel_g: acc.map(|x| x as f64 * a),
            })
        }
        REC_HIGHG => {
            let k = cfg::HIGHG_MG_PER_DIGIT / 1000.0;
            let t_us = r.u32().ok()?;
            let acc = [r.i8().ok()?, r.i8().ok()?, r.i8().ok()?];
            Decoded::HighG(HighG { t_us, accel_g: acc.map(|x| x as f64 * k) })
        }
        REC_BARO => {
            let t_us = r.u32().ok()?;
            let temp = r.i32().ok()?;
            let p = r.i32().ok()? as f64;
            Decoded::Baro(Baro { t_us, temp_c: temp as f64 / 100.0, pressure_pa: p, altitude_m: pressure_altitude_m(p, p0_pa) })
        }
        REC_GNSS => {
            let t_us = r.u32().ok()?;
            let pps_us = r.u32().ok()?;
            let itow_ms = r.u32().ok()?;
            let lat = r.i32().ok()?;
            let lon = r.i32().ok()?;
            let hmsl = r.i32().ok()?;
            let vel = [r.i32().ok()?, r.i32().ok()?, r.i32().ok()?];
            let hacc = r.u32().ok()?;
            let vacc = r.u32().ok()?;
            let pdop = r.u16().ok()?;
            Decoded::Gnss(Gnss {
                t_us,
                pps_us,
                itow_ms,
                lat_deg: lat as f64 * 1e-7,
                lon_deg: lon as f64 * 1e-7,
                hmsl_m: hmsl as f64 / 1000.0,
                vel_ned_ms: vel.map(|x| x as f64 / 1000.0),
                hacc_m: hacc as f64 / 1000.0,
                vacc_m: vacc as f64 / 1000.0,
                pdop: pdop as f64 / 100.0,
                fix_type: r.u8().ok()?,
                num_sv: r.u8().ok()?,
                flags: r.u8().ok()?,
            })
        }
        _ => return None,
    })
}

// ------------------------------------------------- raw packers (fakes, tests)

pub fn pack_imu(t_us: u32, temp: i16, gyro: [i16; 3], accel: [i16; 3]) -> Vec<u8> {
    let mut v = t_us.to_le_bytes().to_vec();
    v.extend_from_slice(&temp.to_le_bytes());
    for x in gyro.iter().chain(&accel) {
        v.extend_from_slice(&x.to_le_bytes());
    }
    v
}

pub fn pack_highg(t_us: u32, a: [i8; 3]) -> Vec<u8> {
    let mut v = t_us.to_le_bytes().to_vec();
    v.extend(a.map(|x| x as u8));
    v
}

pub fn pack_baro(t_us: u32, temp_c100: i32, pressure_pa: i32) -> Vec<u8> {
    let mut v = t_us.to_le_bytes().to_vec();
    v.extend_from_slice(&temp_c100.to_le_bytes());
    v.extend_from_slice(&pressure_pa.to_le_bytes());
    v
}

#[allow(clippy::too_many_arguments)]
pub fn pack_gnss(
    t_us: u32,
    pps_us: u32,
    itow_ms: u32,
    lat_e7: i32,
    lon_e7: i32,
    hmsl_mm: i32,
    vel_mm_s: [i32; 3],
    hacc_mm: u32,
    vacc_mm: u32,
    pdop_c: u16,
    fix: u8,
    sv: u8,
    flags: u8,
) -> Vec<u8> {
    let mut v = Vec::with_capacity(GNSS_SIZE);
    for x in [t_us, pps_us, itow_ms] {
        v.extend_from_slice(&x.to_le_bytes());
    }
    for x in [lat_e7, lon_e7, hmsl_mm, vel_mm_s[0], vel_mm_s[1], vel_mm_s[2]] {
        v.extend_from_slice(&x.to_le_bytes());
    }
    v.extend_from_slice(&hacc_mm.to_le_bytes());
    v.extend_from_slice(&vacc_mm.to_le_bytes());
    v.extend_from_slice(&pdop_c.to_le_bytes());
    v.extend([fix, sv, flags]);
    v
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::defaults;

    #[test]
    fn struct_sizes_match_records_h() {
        assert_eq!(pack_imu(0, 0, [0; 3], [0; 3]).len(), IMU_SIZE);
        assert_eq!(pack_highg(0, [0; 3]).len(), HIGHG_SIZE);
        assert_eq!(pack_baro(0, 0, 0).len(), BARO_SIZE);
        assert_eq!(pack_gnss(0, 0, 0, 0, 0, 0, [0; 3], 0, 0, 0, 0, 0, 0).len(), GNSS_SIZE);
    }

    #[test]
    fn imu_scale_follows_config() {
        // gyro x = 1000 raw, accel z = 2049 raw: records.h order is gyro then accel.
        let raw = pack_imu(0, 0, [1000, 0, 0], [0, 0, 2049]);
        let Some(Decoded::Imu(d16)) = decode(REC_IMU, &raw, &defaults(), P0_PA) else { panic!() };
        let conf = defaults().with("imu_accel_fs_g", 8).with("imu_gyro_fs_dps", 250);
        let Some(Decoded::Imu(d8)) = decode(REC_IMU, &raw, &conf, P0_PA) else { panic!() };
        assert!((d16.accel_g[2] - 2049.0 * 0.488e-3).abs() < 1e-9);
        assert!((d8.accel_g[2] - d16.accel_g[2] / 2.0).abs() < 1e-9);
        assert!((d16.gyro_dps[0] - 140.0).abs() < 1e-9);
        assert!((d8.gyro_dps[0] - 8.75).abs() < 1e-9);
        assert_eq!(Decoded::Imu(d16).csv().len(), columns(REC_IMU).len());
    }

    #[test]
    fn short_or_unscaled_records_are_not_decoded() {
        let raw = pack_imu(0, 0, [0; 3], [0; 3]);
        assert!(decode(REC_IMU, &raw[..17], &defaults(), P0_PA).is_none());
        assert!(decode(REC_IMU, &raw, &defaults().with("imu_accel_fs_g", 3), P0_PA).is_none());
    }

    #[test]
    fn isa_altitude() {
        assert!(pressure_altitude_m(101_325.0, P0_PA).abs() < 1e-6);
        // ICAO standard atmosphere: 1000 m <-> 89 874.6 Pa.
        assert!((pressure_altitude_m(89_874.6, P0_PA) - 1000.0).abs() < 1.0);
    }

    #[test]
    fn gnss_fields_in_order() {
        let raw = pack_gnss(1, 2, 3, 353_466_000, -1_178_085_000, 700_000, [1000, -2000, 3000], 1500, 2500, 120, 3, 12, 1);
        let Some(Decoded::Gnss(g)) = decode(REC_GNSS, &raw, &defaults(), P0_PA) else { panic!() };
        assert_eq!((g.t_us, g.pps_us, g.itow_ms), (1, 2, 3));
        assert!((g.lat_deg - 35.3466).abs() < 1e-9 && (g.lon_deg + 117.8085).abs() < 1e-9);
        assert_eq!(g.vel_ned_ms, [1.0, -2.0, 3.0]);
        assert_eq!((g.hmsl_m, g.hacc_m, g.vacc_m, g.pdop), (700.0, 1.5, 2.5, 1.2));
        assert_eq!((g.fix_type, g.num_sv, g.flags), (3, 12, 1));
        assert_eq!(Decoded::Gnss(g).csv().len(), columns(REC_GNSS).len());
    }
}
