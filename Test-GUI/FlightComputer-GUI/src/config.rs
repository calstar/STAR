//! The flight computer's settings: one versioned, CRC-checked blob.
//!
//! The board keeps this blob in internal flash and applies it at boot (radio
//! modulation, sensor ranges and rates, GNSS settings over UBX-CFG-VALSET into
//! the module's RAM layer). PROTOCOL.md §5 lists the layout as a table. Values
//! are physical units (Hz, g, dps), not chip register codes, so a blob read back
//! from a log says what it means without the datasheet; the firmware maps them.
//!
//! Every allowed value set comes from a datasheet, cited on the field. The board
//! re-checks every field and refuses (BAD_VALUE, detail = field id) anything
//! outside these sets: the app's check is a convenience, not the guard.
//!
//! Defaults are what the firmware does today with its compile-time constants
//! (chips/dev_ism330dhcx.c, app/sensors_core.h, app/gnss_core.h). The radio
//! defaults are placeholders: nothing has picked them yet (Flight_Computer
//! README, "Decisions for the lead").

use std::collections::BTreeMap;
use std::ops::{Index, IndexMut};

pub const CONFIG_VERSION: u8 = 1;
const HEADER: usize = 4; // u8 version, u8 reserved, u16 size (whole blob incl. CRC)

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Ty {
    U8,
    I8,
    U16,
    U32,
}

impl Ty {
    pub const fn size(self) -> usize {
        match self {
            Ty::U8 | Ty::I8 => 1,
            Ty::U16 => 2,
            Ty::U32 => 4,
        }
    }
    fn fits(self, v: i64) -> bool {
        match self {
            Ty::U8 => (0..=0xFF).contains(&v),
            Ty::I8 => (-128..=127).contains(&v),
            Ty::U16 => (0..=0xFFFF).contains(&v),
            Ty::U32 => (0..=0xFFFF_FFFF).contains(&v),
        }
    }
}

#[derive(Debug)]
pub struct Field {
    pub id: u16, // BAD_VALUE detail; never reuse an id
    pub key: &'static str,
    pub group: &'static str,
    pub label: &'static str,
    pub ty: Ty,
    pub default: i64,
    pub unit: &'static str,
    pub choices: Option<&'static [i64]>,        // allowed values, or
    pub limits: Option<(i64, i64)>,             // inclusive min, max
    pub labels: &'static [(i64, &'static str)], // display names for choices
    pub source: &'static str,                   // where the allowed values come from
    pub help: &'static str,
}

impl Field {
    /// None if allowed, else a reason.
    pub fn check(&self, v: i64) -> Option<String> {
        if let Some(c) = self.choices {
            if !c.contains(&v) {
                return Some(format!("{}: {} is not one of {:?}", self.label, v, c));
            }
        }
        if let Some((lo, hi)) = self.limits {
            if !(lo..=hi).contains(&v) {
                return Some(format!("{}: {} outside {}..{} {}", self.label, v, lo, hi, self.unit).trim_end().to_string());
            }
        }
        None
    }

    pub fn show(&self, v: i64) -> String {
        if let Some((_, l)) = self.labels.iter().find(|(k, _)| *k == v) {
            return l.to_string();
        }
        format!("{} {}", v, self.unit).trim_end().to_string()
    }
}

/// The US amateur 33 cm band (47 CFR 97.301): the whole signal, carrier ±
/// half the bandwidth, must be inside it.
pub const BAND_HZ: (i64, i64) = (902_000_000, 928_000_000);

// Constellation bits (CFG-SIGNAL-*_ENA in the M10 interface description).
pub const GNSS_GPS: i64 = 1 << 0;
pub const GNSS_SBAS: i64 = 1 << 1;
pub const GNSS_GALILEO: i64 = 1 << 2;
pub const GNSS_BEIDOU: i64 = 1 << 3;
pub const GNSS_QZSS: i64 = 1 << 4;
pub const GNSS_GLONASS: i64 = 1 << 5;
pub const GNSS_NAMES: [(i64, &str); 6] = [
    (GNSS_GPS, "GPS"),
    (GNSS_SBAS, "SBAS"),
    (GNSS_GALILEO, "Galileo"),
    (GNSS_BEIDOU, "BeiDou"),
    (GNSS_QZSS, "QZSS"),
    (GNSS_GLONASS, "GLONASS"),
];

macro_rules! field {
    ($id:expr, $key:expr, $group:expr, $label:expr, $ty:ident, $default:expr, $unit:expr $(, $name:ident = $val:expr)* $(,)?) => {{
        #[allow(unused_mut)]
        let mut f = Field {
            id: $id, key: $key, group: $group, label: $label, ty: Ty::$ty, default: $default, unit: $unit,
            choices: None, limits: None, labels: &[], source: "", help: "",
        };
        $( field!(@set f, $name, $val); )*
        f
    }};
    (@set $f:ident, choices, $v:expr) => { $f.choices = Some($v) };
    (@set $f:ident, limits, $v:expr) => { $f.limits = Some($v) };
    (@set $f:ident, labels, $v:expr) => { $f.labels = $v };
    (@set $f:ident, source, $v:expr) => { $f.source = $v };
    (@set $f:ident, help, $v:expr) => { $f.help = $v };
}

pub const N: usize = 18;

pub fn fields() -> &'static [Field; N] {
    use std::sync::OnceLock;
    static F: OnceLock<[Field; N]> = OnceLock::new();
    F.get_or_init(build_fields)
}

fn build_fields() -> [Field; N] {
    [
        // ---- LoRa radio (SX1262)
        field!(
            1,
            "radio_freq_hz",
            "Radio",
            "Frequency",
            U32,
            915_000_000,
            "Hz",
            limits = (902_000_000, 928_000_000),
            source = "Semtech SX1261/2 datasheet Rev 2.2 (150-960 MHz chip range); limits are the US amateur 33 cm band, 47 CFR 97.301",
            help = "Carrier frequency, anywhere in the 33 cm ham band. The ground station must match."
        ),
        field!(
            2,
            "radio_sf",
            "Radio",
            "Spreading factor",
            U8,
            9,
            "",
            choices = &[7, 8, 9, 10, 11, 12],
            labels = &[(7, "SF7"), (8, "SF8"), (9, "SF9"), (10, "SF10"), (11, "SF11"), (12, "SF12")],
            source = "Semtech SX1261/2 datasheet Rev 2.2 §6.1.1.1 (chip: SF5-SF12); SF7-12 is what the firmware's time on air covers (firmware src/app/fc_config.c)",
            help = "Higher is longer range but slower."
        ),
        field!(
            3,
            "radio_bw_hz",
            "Radio",
            "Bandwidth",
            U32,
            125_000,
            "Hz",
            choices = &[125_000, 250_000, 500_000],
            labels = &[(125_000, "125 kHz"), (250_000, "250 kHz"), (500_000, "500 kHz")],
            source = "Semtech SX1261/2 datasheet Rev 2.2 §13.4.5 SetModulationParams (chip: 7.8-500 kHz); 125/250/500 kHz is what the firmware's time on air covers (firmware src/app/fc_config.c)",
            help = "Narrower is longer range but slower."
        ),
        field!(
            4,
            "radio_cr",
            "Radio",
            "Coding rate",
            U8,
            5,
            "",
            choices = &[5, 6, 7, 8],
            labels = &[(5, "4/5"), (6, "4/6"), (7, "4/7"), (8, "4/8")],
            source = "Semtech SX1261/2 datasheet Rev 2.2 §13.4.5, CR 4/5..4/8",
            help = "Extra error correction. Higher is more robust but slower."
        ),
        field!(
            5,
            "radio_tx_dbm",
            "Radio",
            "TX power",
            I8,
            22,
            "dBm",
            limits = (-9, 22),
            source = "Semtech SX1261/2 datasheet Rev 2.2 §13.4.4 SetTxParams, -9..+22 dBm on the SX1262 PA",
            help = "Transmit power."
        ),
        field!(
            6,
            "radio_preamble",
            "Radio",
            "Preamble",
            U16,
            8,
            "symbols",
            limits = (6, 1024),
            source = "Semtech SX1261/2 datasheet Rev 2.2 §13.4.6 SetPacketParams (chip allows 1..65535)",
            help = "Length of the lead-in before each packet. Must match the ground station."
        ),
        field!(
            7,
            "radio_sync_word",
            "Radio",
            "Sync word",
            U16,
            0x1424,
            "",
            choices = &[0x1424, 0x3444],
            labels = &[(0x1424, "0x1424 (private)"), (0x3444, "0x3444 (public / LoRaWAN)")],
            source = "Semtech SX1261/2 datasheet Rev 2.2 §13.4.7, LoRa sync word register 0x0740",
            help = "Network ID. Must match the ground station."
        ),
        field!(
            8,
            "hb_self_test_ms",
            "Radio",
            "Heartbeat in self-test",
            U16,
            1000,
            "ms",
            limits = (100, 60_000),
            source = "#137: 1-2 Hz during self-test",
            help = "How often the board radios its status during self-test. Saved, but the firmware sends nothing during self-test yet."
        ),
        field!(
            9,
            "hb_idle_ms",
            "Radio",
            "Heartbeat in idle",
            U16,
            10_000,
            "ms",
            limits = (1000, 60_000),
            source = "#137: roughly every ten seconds in idle; at least 1 s (Idle sleeps in whole seconds, firmware src/app/fc_config.c)",
            help = "How often the board radios its status while idle on the pad."
        ),
        field!(
            10,
            "hb_flight_ms",
            "Radio",
            "Heartbeat armed / in flight",
            U16,
            500,
            "ms",
            limits = (500, 60_000),
            source = "firmware src/app/telemetry_task.c: a 57-byte telemetry frame is ~350 ms on air at SF9/125 kHz, and the radio needs a gap to hear an Un-arm",
            help = "How often the armed board radios its latest sensor readings (telemetry)."
        ),
        // ---- GNSS (MAX-M10S)
        field!(
            11,
            "gnss_rate_ms",
            "GNSS",
            "Navigation rate",
            U16,
            100,
            "ms",
            choices = &[100, 125, 200, 250, 500, 1000],
            labels = &[(100, "10 Hz"), (125, "8 Hz"), (200, "5 Hz"), (250, "4 Hz"), (500, "2 Hz"), (1000, "1 Hz")],
            source = "MAX-M10S datasheet UBX-20035208 p.4: up to 10 Hz (app/gnss_core.h)",
            help = "How often the GNSS reports a position."
        ),
        field!(
            12,
            "gnss_dyn_model",
            "GNSS",
            "Dynamic model",
            U8,
            8,
            "",
            choices = &[0, 2, 3, 4, 5, 6, 7, 8],
            labels = &[
                (0, "Portable"),
                (2, "Stationary"),
                (3, "Pedestrian"),
                (4, "Automotive"),
                (5, "Sea"),
                (6, "Airborne <1g"),
                (7, "Airborne <2g"),
                (8, "Airborne <4g")
            ],
            source = "u-blox M10 interface description, CFG-NAVSPG-DYNMODEL",
            help = "The motion the GNSS receiver expects. Airborne suits a rocket."
        ),
        field!(
            13,
            "gnss_constellations",
            "GNSS",
            "Constellations",
            U8,
            GNSS_GPS | GNSS_SBAS | GNSS_GALILEO | GNSS_BEIDOU | GNSS_QZSS,
            "",
            limits = (0x1F, 0x1F),
            source = "u-blox M10 interface description, CFG-SIGNAL-*_ENA; the module's default, which the firmware does not change yet (firmware src/app/fc_config.c)",
            help = "Which satellite systems to track. Fixed at the module's default until the firmware sends CFG-SIGNAL."
        ),
        // ---- IMU (ISM330DHCX)
        field!(
            14,
            "imu_odr_hz",
            "IMU",
            "Output data rate",
            U16,
            833,
            "Hz",
            choices = &[26, 52, 104, 208, 416, 833],
            source = "ST ISM330DHCX datasheet DS13012 Rev 7 p.49 Table 43 (ODR_XL) / p.50 Table 46 (ODR_G); up to 833 Hz, the rate the sensor task and eMMC log are tested at (firmware src/app/fc_config.c)",
            help = "IMU sample rate, for both accel and gyro."
        ),
        field!(
            15,
            "imu_accel_fs_g",
            "IMU",
            "Accel range",
            U8,
            16,
            "g",
            choices = &[2, 4, 8, 16],
            labels = &[(2, "±2 g"), (4, "±4 g"), (8, "±8 g"), (16, "±16 g")],
            source = "ST ISM330DHCX datasheet DS13012 Rev 7 p.49 Table 42 (FS_XL); sensitivity Table 2",
            help = "Largest acceleration the IMU can read. Higher range, coarser steps."
        ),
        field!(
            16,
            "imu_gyro_fs_dps",
            "IMU",
            "Gyro range",
            U16,
            4000,
            "dps",
            choices = &[125, 250, 500, 1000, 2000, 4000],
            labels =
                &[(125, "±125 dps"), (250, "±250 dps"), (500, "±500 dps"), (1000, "±1000 dps"), (2000, "±2000 dps"), (4000, "±4000 dps")],
            source = "ST ISM330DHCX datasheet DS13012 Rev 7 p.50 Table 45 (FS_G, FS_125, FS_4000); sensitivity Table 2",
            help = "Largest rotation rate the IMU can read. Higher range, coarser steps."
        ),
        // ---- high-g accelerometer (H3LIS100DL)
        field!(
            17,
            "highg_odr_hz",
            "High-g",
            "Output data rate",
            U16,
            400,
            "Hz",
            choices = &[50, 100, 400],
            source = "ST H3LIS100DL datasheet DocID027504 Rev 2 p.26, CTRL_REG1 DR bits: normal mode 50/100/400 Hz (DR=11 not allowed)",
            help = "High-g accelerometer sample rate."
        ),
        // ---- barometer (MS5611)
        field!(
            18,
            "baro_osr",
            "Barometer",
            "Oversampling",
            U16,
            4096,
            "",
            choices = &[256, 512, 1024, 2048, 4096],
            labels =
                &[(256, "256 (0.6 ms)"), (512, "512 (1.2 ms)"), (1024, "1024 (2.3 ms)"), (2048, "2048 (4.5 ms)"), (4096, "4096 (9.0 ms)")],
            source = "TE MS5611-01BA03 datasheet p.3 (max conversion time per OSR)",
            help = "Barometer oversampling. Higher is less noise but slower."
        ),
    ]
}

pub const GROUPS: [&str; 5] = ["Radio", "GNSS", "IMU", "High-g", "Barometer"];

pub const SIZE: usize = {
    // header + body + CRC-32; body sizes in FIELDS order (checked in a test)
    HEADER + (4 + 1 + 4 + 1 + 1 + 2 + 2 + 2 + 2 + 2) + (2 + 1 + 1) + (2 + 1 + 2) + 2 + 2 + 4
};

pub fn index(key: &str) -> usize {
    fields().iter().position(|f| f.key == key).unwrap_or_else(|| panic!("no config field {key}"))
}

pub fn by_key(key: &str) -> &'static Field {
    &fields()[index(key)]
}

pub fn by_id(id: u16) -> Option<&'static Field> {
    fields().iter().find(|f| f.id == id)
}

/// One value per field, in `fields()` order.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Values(pub [i64; N]);

impl Index<&str> for Values {
    type Output = i64;
    fn index(&self, key: &str) -> &i64 {
        &self.0[index(key)]
    }
}

impl IndexMut<&str> for Values {
    fn index_mut(&mut self, key: &str) -> &mut i64 {
        &mut self.0[index(key)]
    }
}

impl Values {
    pub fn with(mut self, key: &str, v: i64) -> Self {
        self[key] = v;
        self
    }

    pub fn to_map(&self) -> BTreeMap<String, i64> {
        fields().iter().zip(self.0).map(|(f, v)| (f.key.to_string(), v)).collect()
    }

    /// Every key exactly once, nothing unknown.
    pub fn from_map(m: &BTreeMap<String, i64>) -> Result<Self, String> {
        let unknown: Vec<_> = m.keys().filter(|k| fields().iter().all(|f| f.key != k.as_str())).cloned().collect();
        if !unknown.is_empty() {
            return Err(format!("unknown settings: {}", unknown.join(", ")));
        }
        let missing: Vec<_> = fields().iter().filter(|f| !m.contains_key(f.key)).map(|f| f.key).collect();
        if !missing.is_empty() {
            return Err(format!("missing settings: {}", missing.join(", ")));
        }
        Ok(Values(core::array::from_fn(|i| m[fields()[i].key])))
    }
}

pub fn defaults() -> Values {
    Values(core::array::from_fn(|i| fields()[i].default))
}

/// IEEE CRC-32, the one the eMMC log uses (emmc_log_crc32).
pub fn crc32(data: &[u8]) -> u32 {
    crc32fast::hash(data)
}

/// The blob. Values that do not fit their field's type are an error: they would
/// be truncated on the wire and the board would see something else.
pub fn pack(v: &Values) -> Result<Vec<u8>, String> {
    let mut b = vec![CONFIG_VERSION, 0];
    b.extend_from_slice(&(SIZE as u16).to_le_bytes());
    for (f, &x) in fields().iter().zip(&v.0) {
        if !f.ty.fits(x) {
            return Err(format!("{}: {} does not fit the field", f.label, x));
        }
        match f.ty {
            Ty::U8 => b.push(x as u8),
            Ty::I8 => b.push(x as i8 as u8),
            Ty::U16 => b.extend_from_slice(&(x as u16).to_le_bytes()),
            Ty::U32 => b.extend_from_slice(&(x as u32).to_le_bytes()),
        }
    }
    let crc = crc32(&b);
    b.extend_from_slice(&crc.to_le_bytes());
    debug_assert_eq!(b.len(), SIZE);
    Ok(b)
}

pub fn unpack(blob: &[u8]) -> Result<Values, String> {
    if blob.len() < HEADER + 4 {
        return Err("config blob too short".into());
    }
    let version = blob[0];
    let size = u16::from_le_bytes([blob[2], blob[3]]) as usize;
    if version != CONFIG_VERSION {
        return Err(format!("config version {version}; this app reads version {CONFIG_VERSION}"));
    }
    if size != SIZE || blob.len() < SIZE {
        return Err(format!("config size {size} (blob {} B); expected {SIZE}", blob.len()));
    }
    let crc = u32::from_le_bytes(blob[SIZE - 4..SIZE].try_into().unwrap());
    if crc32(&blob[..SIZE - 4]) != crc {
        return Err("config CRC mismatch".into());
    }
    let mut i = HEADER;
    let mut out = [0i64; N];
    for (k, f) in fields().iter().enumerate() {
        let s = &blob[i..i + f.ty.size()];
        out[k] = match f.ty {
            Ty::U8 => s[0] as i64,
            Ty::I8 => s[0] as i8 as i64,
            Ty::U16 => u16::from_le_bytes([s[0], s[1]]) as i64,
            Ty::U32 => u32::from_le_bytes(s.try_into().unwrap()) as i64,
        };
        i += f.ty.size();
    }
    Ok(Values(out))
}

/// Every field outside its allowed set, plus cross-field rules.
pub fn problems(v: &Values) -> Vec<(&'static Field, String)> {
    let mut out: Vec<_> = fields().iter().zip(&v.0).filter_map(|(f, &x)| f.check(x).map(|m| (f, m))).collect();
    let (f, half) = (v["radio_freq_hz"], v["radio_bw_hz"] / 2);
    if by_key("radio_freq_hz").check(f).is_none() && (f - half < BAND_HZ.0 || f + half > BAND_HZ.1) {
        out.push((
            by_key("radio_freq_hz"),
            format!(
                "Frequency: at {} kHz bandwidth the signal spans {:.4}-{:.4} MHz, outside the 902-928 MHz band",
                v["radio_bw_hz"] as f64 / 1000.0,
                (f - half) as f64 / 1e6,
                (f + half) as f64 / 1e6
            ),
        ));
    }
    if v["gnss_constellations"] & GNSS_GPS == 0 {
        out.push((by_key("gnss_constellations"), "GPS must stay enabled".into()));
    }
    out
}

pub fn diff(a: &Values, b: &Values) -> Vec<&'static Field> {
    fields().iter().enumerate().filter(|(i, _)| a.0[*i] != b.0[*i]).map(|(_, f)| f).collect()
}

pub fn gnss_mask_text(mask: i64) -> String {
    let s: Vec<_> = GNSS_NAMES.iter().filter(|(b, _)| mask & b != 0).map(|(_, n)| *n).collect();
    if s.is_empty() {
        "none".into()
    } else {
        s.join(", ")
    }
}

// ---------------------------------------------------------- unit conversions
// Sensitivities: ISM330DHCX DS13012 Table 2 (typical).

/// mg per LSB for an accel full scale in g.
pub fn accel_mg_per_lsb(fs_g: i64) -> Option<f64> {
    Some(match fs_g {
        2 => 0.061,
        4 => 0.122,
        8 => 0.244,
        16 => 0.488,
        _ => return None,
    })
}

/// mdps per LSB for a gyro full scale in dps.
pub fn gyro_mdps_per_lsb(fs_dps: i64) -> Option<f64> {
    Some(match fs_dps {
        125 => 4.375,
        250 => 8.75,
        500 => 17.5,
        1000 => 35.0,
        2000 => 70.0,
        4000 => 140.0,
        _ => return None,
    })
}

pub const HIGHG_MG_PER_DIGIT: f64 = 780.0; // H3LIS100DL, records.h

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn size_matches_fields_and_protocol_md() {
        let body: usize = fields().iter().map(|f| f.ty.size()).sum();
        assert_eq!(SIZE, HEADER + body + 4);
        assert_eq!(SIZE, 42); // PROTOCOL.md §5
    }

    #[test]
    fn the_whole_signal_stays_in_the_band() {
        let d = defaults();
        assert!(problems(&d.with("radio_freq_hz", 927_937_500).with("radio_bw_hz", 125_000)).is_empty());
        let over = problems(&d.with("radio_freq_hz", 927_950_000).with("radio_bw_hz", 125_000));
        assert!(over.iter().any(|(f, m)| f.key == "radio_freq_hz" && m.contains("outside")), "{over:?}");
        // At the band's bottom edge, half of a 125 kHz signal is below it.
        let under = problems(&d.with("radio_freq_hz", 902_000_000).with("radio_bw_hz", 125_000));
        assert_eq!(under.len(), 1, "{under:?}");
        assert_eq!(under[0].0.key, "radio_freq_hz");
    }

    #[test]
    fn defaults_are_allowed_and_round_trip() {
        let d = defaults();
        assert!(problems(&d).is_empty());
        let blob = pack(&d).unwrap();
        assert_eq!(blob.len(), SIZE);
        assert_eq!(unpack(&blob).unwrap(), d);
        let neg = d.with("radio_tx_dbm", -9);
        assert_eq!(unpack(&pack(&neg).unwrap()).unwrap()["radio_tx_dbm"], -9);
    }

    #[test]
    fn defaults_match_the_firmware_today() {
        // chips/dev_ism330dhcx.c: CTRL1_XL 0x74 (833 Hz, ±16 g), CTRL2_G 0x71 (833 Hz, ±4000 dps);
        // app/sensors_core.h: high-g 400 Hz; app/gnss_core.h: 100 ms, airborne 4g.
        let d = defaults();
        assert_eq!((d["imu_odr_hz"], d["imu_accel_fs_g"], d["imu_gyro_fs_dps"]), (833, 16, 4000));
        assert_eq!(d["highg_odr_hz"], 400);
        assert_eq!((d["gnss_rate_ms"], d["gnss_dyn_model"]), (100, 8));
        // radio/sx1262_setup.h kDefaultLora and bringup_task.c, as fc_config_defaults().
        assert_eq!((d["radio_tx_dbm"], d["radio_preamble"], d["hb_self_test_ms"]), (22, 8, 1000));
        // records.h hard-codes these scales; the defaults must reproduce them.
        assert_eq!(accel_mg_per_lsb(d["imu_accel_fs_g"]), Some(0.488));
        assert_eq!(gyro_mdps_per_lsb(d["imu_gyro_fs_dps"]), Some(140.0));
    }

    #[test]
    fn crc_and_version_are_checked() {
        let mut blob = pack(&defaults()).unwrap();
        blob[6] ^= 1;
        assert!(unpack(&blob).unwrap_err().contains("CRC"));
        let mut blob = pack(&defaults()).unwrap();
        blob[0] = 99;
        assert!(unpack(&blob).unwrap_err().contains("version"));
    }

    #[test]
    fn problems_catch_out_of_range_and_gps_off() {
        let d = defaults().with("radio_sf", 13).with("radio_tx_dbm", 23).with("gnss_constellations", GNSS_GALILEO);
        let mut keys: Vec<_> = problems(&d).iter().map(|(f, _)| f.key).collect();
        keys.sort();
        keys.dedup();
        assert_eq!(keys, vec!["gnss_constellations", "radio_sf", "radio_tx_dbm"]);
    }

    #[test]
    fn pack_refuses_values_that_do_not_fit() {
        assert!(pack(&defaults().with("radio_sf", 256)).is_err());
    }

    #[test]
    fn field_ids_and_keys_unique() {
        let mut ids: Vec<_> = fields().iter().map(|f| f.id).collect();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), N);
        let mut keys: Vec<_> = fields().iter().map(|f| f.key).collect();
        keys.sort();
        keys.dedup();
        assert_eq!(keys.len(), N);
        assert!(fields().iter().all(|f| GROUPS.contains(&f.group)));
    }

    #[test]
    fn map_round_trip_rejects_unknown_and_missing() {
        let m = defaults().to_map();
        assert_eq!(Values::from_map(&m).unwrap(), defaults());
        let mut extra = m.clone();
        extra.insert("bogus".into(), 1);
        assert!(Values::from_map(&extra).unwrap_err().contains("unknown"));
        let mut less = m;
        less.remove("radio_sf");
        assert!(Values::from_map(&less).unwrap_err().contains("missing"));
    }
}
