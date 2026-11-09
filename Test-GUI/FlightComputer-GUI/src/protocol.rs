//! USB wire protocol between the flight computer and this app.
//!
//! PROTOCOL.md is the contract the firmware implements; this module is its
//! reference implementation, and the simulated board (`fake_board`) speaks it too.
//!
//! Each message is `type u8 | seq u8 | payload | crc16 u16 (LE)`, COBS-encoded
//! and terminated by one 0x00 byte. The CRC is CRC-16/CCITT-FALSE over type,
//! seq and payload, the same CRC the radio link uses (src/frame.h); check value
//! `crc16(b"123456789") == 0x29B1`.
//!
//! A reply carries the seq of the request it answers. Unsolicited messages from
//! the board (STATUS heartbeats, SAMPLE, TEXT) carry seq 0; the host never sends 0.

pub const PROTOCOL_VERSION: u8 = 1;
/// Decoded bytes; the biggest real frame is LOG_BLOCK (~520).
pub const MAX_FRAME: usize = 1024;

// ---------------------------------------------------------------- CRC / COBS

/// CRC-16/CCITT-FALSE: poly 0x1021, init 0xFFFF, no reflection, no xorout.
pub fn crc16(data: &[u8]) -> u16 {
    let mut crc: u16 = 0xFFFF;
    for &b in data {
        crc ^= (b as u16) << 8;
        for _ in 0..8 {
            crc = if crc & 0x8000 != 0 { (crc << 1) ^ 0x1021 } else { crc << 1 };
        }
    }
    crc
}

pub fn cobs_encode(data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len() + data.len() / 254 + 2);
    let mut code_idx = 0;
    out.push(0);
    let mut code: u8 = 1;
    for &b in data {
        if b == 0 {
            out[code_idx] = code;
            code_idx = out.len();
            out.push(0);
            code = 1;
        } else {
            out.push(b);
            code += 1;
            if code == 0xFF {
                out[code_idx] = code;
                code_idx = out.len();
                out.push(0);
                code = 1;
            }
        }
    }
    out[code_idx] = code;
    out
}

pub fn cobs_decode(data: &[u8]) -> Result<Vec<u8>, String> {
    let mut out = Vec::with_capacity(data.len());
    let mut i = 0;
    let n = data.len();
    while i < n {
        let code = data[i] as usize;
        if code == 0 {
            return Err("zero byte inside COBS frame".into());
        }
        i += 1;
        let end = i + code - 1;
        if end > n {
            return Err("COBS block runs past the end of the frame".into());
        }
        out.extend_from_slice(&data[i..end]);
        i = end;
        if code != 0xFF && i < n {
            out.push(0);
        }
    }
    Ok(out)
}

// ------------------------------------------------------------------ messages

pub mod msg {
    // host -> board (requests)
    pub const HELLO: u8 = 0x01; // -> INFO
    pub const GET_STATUS: u8 = 0x02; // -> every VALUE row, then ACK
    pub const SET_STREAM: u8 = 0x03; // u16 rate_hz, u8 mask -> ACK
    pub const CONFIG_GET: u8 = 0x10; // u8 slot -> CONFIG
    pub const CONFIG_SET: u8 = 0x11; // blob -> ACK (RAM, not saved)
    pub const CONFIG_SAVE: u8 = 0x12; // -> ACK (RAM config to internal flash)
    pub const CONFIG_REVERT: u8 = 0x13; // -> ACK (RAM config reloaded from flash)
    pub const LOG_INFO: u8 = 0x20; // -> LOG_INFO_REPLY
    pub const LOG_SESSIONS: u8 = 0x21; // u16 start -> SESSIONS
    pub const LOG_READ: u8 = 0x22; // u32 first, u32 count -> LOG_BLOCK x count, then ACK
    pub const LOG_ABORT: u8 = 0x23; // -> ACK (ends a LOG_READ early)
    pub const LOG_WIPE: u8 = 0x24; // u32 WIPE_MAGIC -> ACK
    pub const REBOOT: u8 = 0x30; // u32 REBOOT_MAGIC -> ACK, then the board resets

    // board -> host
    pub const ACK: u8 = 0x7F; // u8 for_type, u8 result, u16 detail
    pub const INFO: u8 = 0x81;
    pub const VALUE: u8 = 0x83; // one row of the board's table; all rows at 1 Hz (seq 0)
    pub const CONFIG: u8 = 0x90; // u8 slot, blob
    pub const LOG_INFO_REPLY: u8 = 0xA0;
    pub const SESSIONS: u8 = 0xA1;
    pub const LOG_BLOCK: u8 = 0xA2; // u32 index, 512 raw bytes
    pub const SAMPLE: u8 = 0xB0; // u8 record type, record bytes (records.h)
    pub const TEXT: u8 = 0xB1; // UTF-8 debug line
}

pub mod result {
    pub const OK: u8 = 0;
    pub const BAD_FRAME: u8 = 1; // payload the wrong size for its type
    pub const UNKNOWN_TYPE: u8 = 2;
    pub const BAD_VALUE: u8 = 3; // detail = the config field id that was refused
    pub const WRONG_STATE: u8 = 4; // detail = the flight state that refused it
    pub const BUSY: u8 = 5; // e.g. a LOG_READ is already running
    pub const FLASH_ERROR: u8 = 6;
    pub const STORAGE_ERROR: u8 = 7; // the eMMC failed to come up or to read
    pub const NOT_IMPLEMENTED: u8 = 8;
    pub const BAD_MAGIC: u8 = 9;
    pub const RADIO_ERROR: u8 = 10; // RADIO_ARM/UNARM: the radio did not send

    pub fn name(r: u8) -> String {
        const NAMES: [&str; 11] = [
            "OK",
            "BAD_FRAME",
            "UNKNOWN_TYPE",
            "BAD_VALUE",
            "WRONG_STATE",
            "BUSY",
            "FLASH_ERROR",
            "STORAGE_ERROR",
            "NOT_IMPLEMENTED",
            "BAD_MAGIC",
            "RADIO_ERROR",
        ];
        NAMES.get(r as usize).map(|s| s.to_string()).unwrap_or_else(|| format!("result {r}"))
    }
}

pub mod slot {
    pub const ACTIVE: u8 = 0; // what the board is running (RAM)
    pub const SAVED: u8 = 1; // what is in internal flash
    pub const DEFAULTS: u8 = 2; // compiled into the firmware
}

/// src/app/flight_state.h
pub mod state {
    pub const SELF_TEST: u8 = 0;
    pub const IDLE: u8 = 1;
    pub const ARMED: u8 = 2;
    pub const LAUNCHED: u8 = 3;
    pub const RECOVERY: u8 = 4;

    pub const NAMES: [&str; 5] = ["SELF_TEST", "IDLE", "ARMED", "LAUNCHED", "RECOVERY"];

    pub fn name(s: u8) -> String {
        NAMES.get(s as usize).map(|s| s.to_string()).unwrap_or_else(|| format!("state {s}"))
    }

    /// Settings, saves and wipes are allowed only here.
    pub fn configurable(s: u8) -> bool {
        s == SELF_TEST || s == IDLE
    }
}

/// src/app/self_test_port.h
pub mod self_test {
    pub const PENDING: u8 = 0;
    pub const PASS: u8 = 1;
    pub const FAIL: u8 = 2;
    pub const TIMEOUT: u8 = 3;
    pub const NOT_CONFIGURED: u8 = 4;
    pub const NOT_IMPLEMENTED: u8 = 5;

    pub fn name(r: u8) -> String {
        const N: [&str; 6] = ["pending", "pass", "fail", "timeout", "not configured", "not implemented"];
        N.get(r as usize).map(|s| s.to_string()).unwrap_or_else(|| format!("code {r}"))
    }

    /// src/app/self_test_devices.h, in ID order.
    pub const DEVICES: [&str; 8] = ["IMU", "High-g", "Barometer", "Ethernet", "Radio", "GNSS", "NAND", "eMMC"];
}

/// emmc_disk_state_t
pub mod disk {
    pub const UNMOUNTED: u8 = 0;
    pub const MOUNTED: u8 = 1;
    pub const FULL: u8 = 2;
    pub const FAULT: u8 = 3;

    pub fn name(d: u8) -> String {
        const N: [&str; 4] = ["unmounted", "mounted", "full", "fault"];
        N.get(d as usize).map(|s| s.to_string()).unwrap_or_else(|| format!("state {d}"))
    }
}

// SET_STREAM mask bits: which records the board streams.
pub const STREAM_IMU: u8 = 1 << 0;
pub const STREAM_HIGHG: u8 = 1 << 1;
pub const STREAM_BARO: u8 = 1 << 2;
pub const STREAM_GNSS: u8 = 1 << 3;
pub const STREAM_ALL: u8 = 0x0F;

pub const WIPE_MAGIC: u32 = 0x4550_4957; // "WIPE"
pub const REBOOT_MAGIC: u32 = 0x544F_4F42; // "BOOT"

// Bits of the "flags" value.
pub const FLAG_ON_USB_POWER: u8 = 1 << 0; // TPS2121 says USB is powering the board
pub const FLAG_CONFIG_UNSAVED: u8 = 1 << 1; // RAM config differs from flash
pub const FLAG_STREAMING: u8 = 1 << 2;
pub const FLAG_CONFIG_DEFAULTS: u8 = 1 << 3; // flash had no valid config; running defaults

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Frame {
    pub ty: u8,
    pub seq: u8,
    pub payload: Vec<u8>,
}

pub fn encode_frame(ty: u8, seq: u8, payload: &[u8]) -> Vec<u8> {
    let mut body = Vec::with_capacity(payload.len() + 4);
    body.push(ty);
    body.push(seq);
    body.extend_from_slice(payload);
    let crc = crc16(&body);
    body.extend_from_slice(&crc.to_le_bytes());
    let mut out = cobs_encode(&body);
    out.push(0);
    out
}

/// Decode one frame (without its 0x00 terminator).
pub fn decode_frame(encoded: &[u8]) -> Result<Frame, String> {
    let body = cobs_decode(encoded)?;
    if body.len() < 4 {
        return Err("frame too short".into());
    }
    if body.len() > MAX_FRAME {
        return Err("frame too long".into());
    }
    let n = body.len();
    let crc = u16::from_le_bytes([body[n - 2], body[n - 1]]);
    if crc16(&body[..n - 2]) != crc {
        return Err("CRC mismatch".into());
    }
    Ok(Frame { ty: body[0], seq: body[1], payload: body[2..n - 2].to_vec() })
}

/// Accumulates bytes from the port and yields whole frames.
///
/// Bad frames are counted, not raised: a USB glitch must not stop the link.
/// The port may open mid-frame, so the first chunk after connecting is kept
/// only if it decodes (COBS and CRC); a partial one is dropped without counting
/// as bad. It must not be dropped unread: when the board has sent nothing since
/// the port opened, the first frame is the answer to HELLO.
#[derive(Default)]
pub struct FrameReader {
    buf: Vec<u8>,
    synced: bool,
    pub bad_frames: u32,
    pub good_frames: u32,
}

impl FrameReader {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn feed(&mut self, data: &[u8]) -> Vec<Frame> {
        let mut frames = Vec::new();
        self.buf.extend_from_slice(data);
        let mut start = 0;
        while let Some(rel) = self.buf[start..].iter().position(|&b| b == 0) {
            let chunk = &self.buf[start..start + rel];
            start += rel + 1;
            if !self.synced {
                self.synced = true;
                if let Ok(f) = decode_frame(chunk) {
                    frames.push(f);
                    self.good_frames += 1;
                }
                continue;
            }
            if chunk.is_empty() {
                continue;
            }
            match decode_frame(chunk) {
                Ok(f) => {
                    frames.push(f);
                    self.good_frames += 1;
                }
                Err(_) => self.bad_frames += 1,
            }
        }
        self.buf.drain(..start);
        if self.buf.len() > 2 * MAX_FRAME {
            // never terminated: drop
            self.buf.clear();
            self.bad_frames += 1;
        }
        frames
    }

    /// For transports that never start mid-frame (the simulator).
    pub fn mark_synced(&mut self) {
        self.synced = true;
    }
}

// ------------------------------------------------------------ byte helpers

/// Little-endian reader over a payload; reading past the end is an error.
pub struct Rd<'a> {
    b: &'a [u8],
    i: usize,
}

impl<'a> Rd<'a> {
    pub fn new(b: &'a [u8]) -> Self {
        Self { b, i: 0 }
    }
    pub fn take(&mut self, n: usize) -> Result<&'a [u8], String> {
        if self.i + n > self.b.len() {
            return Err(format!("payload too short ({} B)", self.b.len()));
        }
        let s = &self.b[self.i..self.i + n];
        self.i += n;
        Ok(s)
    }
    pub fn u8(&mut self) -> Result<u8, String> {
        Ok(self.take(1)?[0])
    }
    pub fn i8(&mut self) -> Result<i8, String> {
        Ok(self.take(1)?[0] as i8)
    }
    pub fn u16(&mut self) -> Result<u16, String> {
        Ok(u16::from_le_bytes(self.take(2)?.try_into().unwrap()))
    }
    pub fn i16(&mut self) -> Result<i16, String> {
        Ok(i16::from_le_bytes(self.take(2)?.try_into().unwrap()))
    }
    pub fn u32(&mut self) -> Result<u32, String> {
        Ok(u32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }
    pub fn i32(&mut self) -> Result<i32, String> {
        Ok(i32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }
}

pub fn u32_at(b: &[u8], i: usize) -> u32 {
    u32::from_le_bytes(b[i..i + 4].try_into().unwrap())
}

pub fn u16_at(b: &[u8], i: usize) -> u16 {
    u16::from_le_bytes(b[i..i + 2].try_into().unwrap())
}

// ------------------------------------------------------------------ payloads

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Ack {
    pub for_type: u8,
    pub result: u8,
    pub detail: u16,
}

impl Ack {
    pub const SIZE: usize = 4;

    pub fn pack(&self) -> Vec<u8> {
        let mut v = vec![self.for_type, self.result];
        v.extend_from_slice(&self.detail.to_le_bytes());
        v
    }
    pub fn unpack(b: &[u8]) -> Result<Self, String> {
        let mut r = Rd::new(b);
        Ok(Self { for_type: r.u8()?, result: r.u8()?, detail: r.u16()? })
    }
    pub fn ok(&self) -> bool {
        self.result == result::OK
    }
    pub fn describe(&self) -> String {
        let r = result::name(self.result);
        match self.result {
            result::WRONG_STATE if (self.detail as usize) < state::NAMES.len() => {
                format!("{r} (board is in {})", state::name(self.detail as u8))
            }
            result::BAD_VALUE => format!("{r} (field id {})", self.detail),
            _ => r,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Info {
    pub protocol_version: u8,
    pub config_version: u8,
    pub config_size: u16,
    pub uptime_ms: u32,
    pub uid: [u8; 12],   // STM32 96-bit unique ID
    pub fw_git: String,  // short git hash of the firmware build (16 B field)
    pub build_unix: u32, // build time, seconds since 1970 (UTC)
}

impl Info {
    pub const SIZE: usize = 40;

    pub fn pack(&self) -> Vec<u8> {
        let mut v = vec![self.protocol_version, self.config_version];
        v.extend_from_slice(&self.config_size.to_le_bytes());
        v.extend_from_slice(&self.uptime_ms.to_le_bytes());
        v.extend_from_slice(&self.uid);
        let mut git = [0u8; 16];
        let g = self.fw_git.as_bytes();
        git[..g.len().min(16)].copy_from_slice(&g[..g.len().min(16)]);
        v.extend_from_slice(&git);
        v.extend_from_slice(&self.build_unix.to_le_bytes());
        v
    }
    pub fn unpack(b: &[u8]) -> Result<Self, String> {
        let mut r = Rd::new(b);
        let protocol_version = r.u8()?;
        let config_version = r.u8()?;
        let config_size = r.u16()?;
        let uptime_ms = r.u32()?;
        let uid: [u8; 12] = r.take(12)?.try_into().unwrap();
        let git = r.take(16)?;
        let end = git.iter().position(|&c| c == 0).unwrap_or(16);
        let fw_git = String::from_utf8_lossy(&git[..end]).into_owned();
        Ok(Self { protocol_version, config_version, config_size, uptime_ms, uid, fw_git, build_unix: r.u32()? })
    }
    pub fn uid_hex(&self) -> String {
        self.uid.iter().map(|b| format!("{b:02x}")).collect()
    }
}

/// One row of the board's value table (firmware `src/app/gui_map.c`): the board
/// names it, so the GUI shows whatever the table holds.
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct Value {
    pub index: u8,
    pub count: u8,
    /// `value_type::*`: how to read `raw`.
    pub ty: u8,
    pub raw: u32,
    pub name: String,
    pub unit: String,
    /// The enum's names, from 0; empty for a plain number.
    pub labels: Vec<String>,
}

pub mod value_type {
    pub const U8: u8 = 0;
    pub const U16: u8 = 1;
    pub const U32: u8 = 2;
    pub const I8: u8 = 3;
    pub const I16: u8 = 4;
    pub const I32: u8 = 5;
}

impl Value {
    pub fn number(&self) -> i64 {
        use value_type::*;
        match self.ty {
            I8 => self.raw as u8 as i8 as i64,
            I16 => self.raw as u16 as i16 as i64,
            I32 => self.raw as i32 as i64,
            U8 => (self.raw & 0xFF) as i64,
            U16 => (self.raw & 0xFFFF) as i64,
            _ => self.raw as i64,
        }
    }
    /// The enum's name, if it has one for this value.
    pub fn label(&self) -> Option<&str> {
        usize::try_from(self.number()).ok().and_then(|i| self.labels.get(i)).map(|s| s.as_str())
    }
    pub fn text(&self) -> String {
        match (self.label(), self.unit.is_empty()) {
            (Some(l), _) => l.to_string(),
            (None, true) => self.number().to_string(),
            (None, false) => match self.unit.as_str() {
                "mV" => format!("{:.2} V", self.number() as f64 / 1000.0),
                "ms" => {
                    let t = self.number().max(0) / 1000;
                    format!("{} h {:02} min {:02} s", t / 3600, t / 60 % 60, t % 60)
                }
                unit => format!("{} {unit}", self.number()),
            },
        }
    }
    pub fn pack(&self) -> Vec<u8> {
        let mut v = vec![self.index, self.count, self.ty];
        v.extend_from_slice(&self.raw.to_le_bytes());
        for s in [&self.name, &self.unit, &self.labels.join(",")] {
            v.extend_from_slice(s.as_bytes());
            v.push(0);
        }
        v
    }
    pub fn unpack(b: &[u8]) -> Result<Self, String> {
        let mut r = Rd::new(b);
        let (index, count, ty, raw) = (r.u8()?, r.u8()?, r.u8()?, r.u32()?);
        let mut strs = b[7..].split(|&c| c == 0).map(|s| String::from_utf8_lossy(s).into_owned());
        let mut next = || strs.next().ok_or_else(|| "VALUE: missing name, unit or labels".to_string());
        let (name, unit, labels) = (next()?, next()?, next()?);
        if index >= count || name.is_empty() {
            return Err(format!("VALUE: bad row {index} of {count}"));
        }
        let labels = if labels.is_empty() { Vec::new() } else { labels.split(',').map(String::from).collect() };
        Ok(Self { index, count, ty, raw, name, unit, labels })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LogInfo {
    pub disk: u8,
    pub epoch: u32,
    pub data_start: u32, // LBA of log block 0
    pub capacity: u32,   // blocks on the card
    pub head: u32,       // log blocks written = emmc_log_t.head - data_start (head is an LBA)
    pub sessions: u32,
}

impl LogInfo {
    pub fn pack(&self) -> Vec<u8> {
        let mut v = vec![self.disk];
        for x in [self.epoch, self.data_start, self.capacity, self.head, self.sessions] {
            v.extend_from_slice(&x.to_le_bytes());
        }
        v
    }
    pub fn unpack(b: &[u8]) -> Result<Self, String> {
        let mut r = Rd::new(b);
        Ok(Self { disk: r.u8()?, epoch: r.u32()?, data_start: r.u32()?, capacity: r.u32()?, head: r.u32()?, sessions: r.u32()? })
    }
}

/// One recorded flight (Arm to Un-arm or power-off): one row of the file list.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SessionEntry {
    pub session: u32,
    pub first_block: u32, // log block index (not LBA)
    pub blocks: u32,
    pub duration_ms: u32, // last record's t_ms minus the first's (board reads 2 blocks)
    pub utc_start: u32,   // Unix seconds from the first GNSS fix of the session; 0 = no fix
}

impl SessionEntry {
    pub const SIZE: usize = 20;
    pub fn size_bytes(&self) -> u64 {
        self.blocks as u64 * 512
    }
}

pub const SESSIONS_PER_FRAME: usize = 24;

pub fn pack_sessions(total: u16, entries: &[SessionEntry]) -> Vec<u8> {
    let mut v = total.to_le_bytes().to_vec();
    v.push(entries.len() as u8);
    for e in entries {
        for x in [e.session, e.first_block, e.blocks, e.duration_ms, e.utc_start] {
            v.extend_from_slice(&x.to_le_bytes());
        }
    }
    v
}

pub fn unpack_sessions(b: &[u8]) -> Result<(u16, Vec<SessionEntry>), String> {
    let mut r = Rd::new(b);
    let total = r.u16()?;
    let n = r.u8()?;
    let mut out = Vec::with_capacity(n as usize);
    for _ in 0..n {
        out.push(SessionEntry { session: r.u32()?, first_block: r.u32()?, blocks: r.u32()?, duration_ms: r.u32()?, utc_start: r.u32()? });
    }
    Ok((total, out))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crc16_check_value() {
        // CRC-16/CCITT-FALSE catalogue check value; same as src/frame.h.
        assert_eq!(crc16(b"123456789"), 0x29B1);
    }

    #[test]
    fn cobs_round_trip_and_no_zeros() {
        let mut cases: Vec<Vec<u8>> = vec![vec![], vec![0], vec![0, 0], vec![0x11, 0x22, 0, 0x33], (1..255).collect()];
        cases.push((1..=255u8).cycle().take(255 * 3).collect());
        cases.push(vec![0; 600]);
        cases.push([0u8, 1].iter().cycle().take(600).copied().collect());
        for data in cases {
            let enc = cobs_encode(&data);
            assert!(!enc.contains(&0));
            assert_eq!(cobs_decode(&enc).unwrap(), data);
        }
    }

    #[test]
    fn cobs_known_vectors() {
        // Cheshire & Baker's examples.
        assert_eq!(cobs_encode(&[0]), vec![1, 1]);
        assert_eq!(cobs_encode(&[0x11, 0x22, 0, 0x33]), vec![3, 0x11, 0x22, 2, 0x33]);
        assert_eq!(cobs_encode(&[0x11, 0, 0, 0]), vec![2, 0x11, 1, 1, 1]);
    }

    #[test]
    fn frame_reader_splits_and_rejects_corruption() {
        let a = encode_frame(msg::HELLO, 1, &[]);
        let b = encode_frame(msg::ACK, 2, &Ack { for_type: 1, result: 0, detail: 0 }.pack());
        let mut bad = encode_frame(msg::GET_STATUS, 3, &[]);
        bad[2] ^= 0x40;
        let mut r = FrameReader::new();
        r.mark_synced();
        let mut frames = r.feed(&a[..3]);
        let mut rest = a[3..].to_vec();
        rest.extend_from_slice(&bad);
        rest.extend_from_slice(&b);
        frames.extend(r.feed(&rest));
        let got: Vec<_> = frames.iter().map(|f| (f.ty, f.seq)).collect();
        assert_eq!(got, vec![(msg::HELLO, 1), (msg::ACK, 2)]);
        assert_eq!(r.bad_frames, 1);
    }

    #[test]
    fn frame_reader_drops_partial_frame_at_connect() {
        let mut r = FrameReader::new();
        let whole = encode_frame(msg::HELLO, 5, &[]);
        let mut data = whole[2..].to_vec(); // port opened mid-frame
        data.extend_from_slice(&whole);
        let got: Vec<_> = r.feed(&data).iter().map(|f| (f.ty, f.seq)).collect();
        assert_eq!(got, vec![(msg::HELLO, 5)]);
        assert_eq!(r.bad_frames, 0, "a partial first frame is not a bad frame");
    }

    #[test]
    fn frame_reader_keeps_a_whole_first_frame() {
        // The answer to HELLO is often the first thing the board sends.
        let mut r = FrameReader::new();
        let got: Vec<_> = r.feed(&encode_frame(msg::INFO, 1, &[7; 40])).iter().map(|f| (f.ty, f.seq)).collect();
        assert_eq!(got, vec![(msg::INFO, 1)]);
    }

    #[test]
    fn payload_structs_round_trip_and_sizes_match_protocol_md() {
        let v = Value {
            index: 1,
            count: 3,
            ty: value_type::U8,
            raw: 1,
            name: "state".into(),
            unit: String::new(),
            labels: vec!["SELF_TEST".into(), "IDLE".into()],
        };
        assert_eq!(Value::unpack(&v.pack()).unwrap(), v);
        assert_eq!(v.text(), "IDLE");
        assert_eq!(Value { raw: 7, ..v.clone() }.text(), "7", "no label for 7: the number");
        let signed = Value { ty: value_type::I16, raw: (-5i16) as u16 as u32, unit: "Hz".into(), labels: vec![], ..v.clone() };
        assert_eq!(Value::unpack(&signed.pack()).unwrap().text(), "-5 Hz");
        let mv = Value { ty: value_type::U16, raw: 7_915, unit: "mV".into(), labels: vec![], ..v.clone() };
        assert_eq!(mv.text(), "7.92 V", "mV is shown in volts");
        let ms = Value { ty: value_type::U32, raw: 3_725_400, unit: "ms".into(), labels: vec![], ..v.clone() };
        assert_eq!(ms.text(), "1 h 02 min 05 s", "ms is shown as a duration");
        assert!(Value::unpack(&v.pack()[..8]).is_err(), "cut short");
        assert!(Value::unpack(&Value { index: 3, ..v.clone() }.pack()).is_err(), "row past the count");
        let i = Info {
            protocol_version: 1,
            config_version: 1,
            config_size: 42,
            uptime_ms: 99,
            uid: core::array::from_fn(|k| k as u8),
            fw_git: "abc1234".into(),
            build_unix: 1_700_000_000,
        };
        assert_eq!(i.pack().len(), Info::SIZE);
        assert_eq!(Info::unpack(&i.pack()).unwrap(), i);
        let e = vec![
            SessionEntry { session: 1, first_block: 0, blocks: 10, duration_ms: 2000, utc_start: 0 },
            SessionEntry { session: 2, first_block: 10, blocks: 5, duration_ms: 100, utc_start: 1_793_548_800 },
        ];
        assert_eq!(unpack_sessions(&pack_sessions(2, &e)).unwrap(), (2, e));
    }

    #[test]
    fn biggest_frame_fits() {
        let frame = encode_frame(msg::LOG_BLOCK, 1, &[0; 4 + 512]);
        assert!(cobs_decode(&frame[..frame.len() - 1]).unwrap().len() <= MAX_FRAME);
        let one = SessionEntry { session: 1, first_block: 1, blocks: 1, duration_ms: 1, utc_start: 1 };
        let sess = pack_sessions(1, &[one; SESSIONS_PER_FRAME]);
        assert!(sess.len() + 4 <= MAX_FRAME);
    }
}
