//! What a receiver board hears from the rocket (PROTOCOL.md §8): each radio
//! frame comes over USB as RADIO_RX. Layouts are the firmware's
//! `src/app/status_report.h`; `tests/usb_frame.rs` holds the two together.

use crate::protocol::Rd;

/// One radio frame the receiver heard.
#[derive(Clone, Debug, PartialEq)]
pub struct RadioRx {
    pub ty: u8,
    pub seq: u16,
    pub rssi_dbm: f64,
    pub snr_db: f64,
    pub payload: Vec<u8>,
}

pub mod frame_type {
    pub const HEARTBEAT: u8 = 0x01;
    pub const STATUS: u8 = 0x03;
    pub const ARM: u8 = 0x10;
    pub const UNARM: u8 = 0x11;
    pub const TELEMETRY: u8 = 0x20;
}

impl RadioRx {
    /// RADIO_RX: u8 type, u16 seq, i16 rssi_x2, i16 snr_x4, u8 len, payload.
    pub fn unpack(b: &[u8]) -> Result<Self, String> {
        let mut r = Rd::new(b);
        let (ty, seq, rssi, snr, len) = (r.u8()?, r.u16()?, r.i16()?, r.i16()?, r.u8()?);
        let payload = r.take(len as usize)?.to_vec();
        Ok(Self { ty, seq, rssi_dbm: rssi as f64 / 2.0, snr_db: snr as f64 / 4.0, payload })
    }
}

/// Heartbeat (0x01): the rocket's Idle beacon.
#[derive(Clone, Debug, PartialEq)]
pub struct Heartbeat {
    pub state: u8,
    pub battery_mv: u16,
    pub uptime_s: u32,
}

impl Heartbeat {
    pub fn unpack(b: &[u8]) -> Result<Self, String> {
        let mut r = Rd::new(b);
        let h = Self { state: r.u8()?, battery_mv: r.u16()?, uptime_s: r.u32()? };
        if b.len() != 7 {
            return Err(format!("heartbeat is {} B, not 7", b.len()));
        }
        Ok(h)
    }
}

pub const ADC_NAMES: [&str; 7] = ["VBAT", "EXT_SENSE_1", "PYRO_1_CONT", "PYRO_2_CONT", "EXT_SENSE_2", "ALT_CURR", "CURR"];

/// Status (0x03, 45 B): every ADC count and each chip's check, after each heartbeat.
#[derive(Clone, Debug, PartialEq)]
pub struct Status {
    pub state: u8,
    pub uptime_ms: u32,
    pub heartbeat: u32,
    pub adc: [u16; 7],
    pub battery_mv: u16,
    pub on_usb: bool,
    /// Bit i: chip i was checked now; clear: its boot result.
    pub live_mask: u8,
    /// (self_test result, value read back) per chip, self-test order.
    pub chips: [(u8, u8); 8],
    pub radio_device_errors: u16,
}

impl Status {
    pub const SIZE: usize = 45;

    pub fn unpack(b: &[u8]) -> Result<Self, String> {
        if b.len() != Self::SIZE {
            return Err(format!("status is {} B, not {}", b.len(), Self::SIZE));
        }
        let mut r = Rd::new(b);
        let (state, uptime_ms, heartbeat) = (r.u8()?, r.u32()?, r.u32()?);
        let mut adc = [0u16; 7];
        for a in &mut adc {
            *a = r.u16()?;
        }
        let (battery_mv, flags, live_mask) = (r.u16()?, r.u8()?, r.u8()?);
        let mut chips = [(0u8, 0u8); 8];
        for c in &mut chips {
            *c = (r.u8()?, r.u8()?);
        }
        Ok(Self { state, uptime_ms, heartbeat, adc, battery_mv, on_usb: flags & 1 != 0, live_mask, chips, radio_device_errors: r.u16()? })
    }
}

/// Telemetry (0x20, 57 B): the latest of each sensor once armed. The three
/// records are records.h's, as-is, so they decode like any other sample.
#[derive(Clone, Debug, PartialEq)]
pub struct Telemetry {
    pub state: u8,
    pub uptime_ms: u32,
    /// Bits: IMU, high-g, baro, GNSS new since the last frame.
    pub fresh: u8,
    pub imu: Vec<u8>,
    pub highg: Vec<u8>,
    pub baro: Vec<u8>,
    pub lat_e7: i32,
    pub lon_e7: i32,
    pub hmsl_mm: i32,
    pub fix_type: u8,
    pub num_sv: u8,
}

pub const FRESH_IMU: u8 = 1;
pub const FRESH_HIGHG: u8 = 2;
pub const FRESH_BARO: u8 = 4;
pub const FRESH_GNSS: u8 = 8;

impl Telemetry {
    pub const SIZE: usize = 57;

    pub fn unpack(b: &[u8]) -> Result<Self, String> {
        if b.len() != Self::SIZE {
            return Err(format!("telemetry is {} B, not {}", b.len(), Self::SIZE));
        }
        let mut r = Rd::new(b);
        let (state, uptime_ms, fresh) = (r.u8()?, r.u32()?, r.u8()?);
        let (imu, highg, baro) = (r.take(18)?.to_vec(), r.take(7)?.to_vec(), r.take(12)?.to_vec());
        let (lat_e7, lon_e7, hmsl_mm) = (r.u32()? as i32, r.u32()? as i32, r.u32()? as i32);
        Ok(Self { state, uptime_ms, fresh, imu, highg, baro, lat_e7, lon_e7, hmsl_mm, fix_type: r.u8()?, num_sv: r.u8()? })
    }
}
