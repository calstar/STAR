//! A pretend flight computer that speaks PROTOCOL.md.
//!
//! It stands in for the board until the firmware side exists, and it is what
//! the tests drive. It behaves the way the real firmware should:
//!
//! - boots into SELF_TEST, moves to IDLE after a few seconds;
//! - loads its config from "flash" (a file), falls back to defaults if the file
//!   is missing or fails its CRC, and says so in STATUS;
//! - refuses config writes, saves and log wipes outside SELF_TEST/IDLE;
//! - streams samples only while the host holds DTR (the port is open) and a
//!   rate has been set: the gate the real board uses (PROTOCOL.md §4);
//! - holds an eMMC image with two recorded flights in the real block format.
//!
//! What it is not: a model of the sensors. The flight it records is a toy
//! profile (boost, coast, descent) so the plots have something to show.

use std::path::PathBuf;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use crate::config::{self as cfg, Values};
use crate::emmc::{self, BlockWriter};
use crate::protocol::{self as p, msg, result, self_test as st, state, Ack, Frame, FrameReader};
use crate::records as rec;

pub const SELF_TEST_S: f64 = 3.0;
pub const DATA_START: u32 = 8192;
pub const CAPACITY: u32 = 0x76_0000; // blocks, THGBMTG5D1LBAIL user area (EMMC-ARCHITECTURE.md §1)
pub const BLOCKS_PER_TICK: u32 = 64; // LOG_READ pacing: 64 blocks per 10 ms tick = 3.2 MB/s
const MAX_STREAM_HZ: u16 = 200;

/// SplitMix64 with Box-Muller: deterministic noise, no dependency.
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Self(seed)
    }
    pub fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    pub fn uniform(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64
    }
    pub fn gauss(&mut self, mu: f64, sigma: f64) -> f64 {
        let u1 = self.uniform().max(1e-300);
        let u2 = self.uniform();
        mu + sigma * (-2.0 * u1.ln()).sqrt() * (std::f64::consts::TAU * u2).cos()
    }
}

fn clamp16(x: f64) -> i16 {
    x.round().clamp(-32768.0, 32767.0) as i16
}

fn raw_accel(g: f64, fs_g: i64) -> i16 {
    clamp16(g / (cfg::accel_mg_per_lsb(fs_g).unwrap_or(0.488) / 1000.0))
}

fn raw_gyro(dps: f64, fs_dps: i64) -> i16 {
    clamp16(dps / (cfg::gyro_mdps_per_lsb(fs_dps).unwrap_or(140.0) / 1000.0))
}

/// (axial accel in g as felt, altitude m, vertical velocity m/s) of a toy flight.
fn toy_flight(t: f64) -> (f64, f64, f64) {
    let (burn, g0) = (3.0, 9.80665);
    if t < 0.0 {
        return (1.0, 0.0, 0.0);
    }
    let a = 8.0 * g0;
    if t < burn {
        return (9.0, 0.5 * a * t * t, a * t);
    }
    let v_bo = a * burn;
    let h_bo = 0.5 * a * burn * burn;
    let tc = t - burn;
    let t_apo = v_bo / g0;
    if tc < t_apo {
        return (0.0, h_bo + v_bo * tc - 0.5 * g0 * tc * tc, v_bo - g0 * tc);
    }
    let h_apo = h_bo + v_bo * t_apo - 0.5 * g0 * t_apo * t_apo;
    (1.0, (h_apo - 25.0 * (tc - t_apo)).max(0.0), -25.0)
}

fn pressure(alt_m: f64) -> f64 {
    101_325.0 * (1.0 - alt_m / 44330.8).powf(1.0 / 0.190263)
}

fn gnss(t_us: u32, hmsl_m: f64, vel_up: f64, sv: u8) -> Vec<u8> {
    let (lat, lon) = (35.3466, -117.8085); // FAR site, Mojave
    rec::pack_gnss(
        t_us,
        t_us,
        t_us / 1000,
        (lat * 1e7) as i32,
        (lon * 1e7) as i32,
        (hmsl_m * 1000.0) as i32,
        [0, 0, (-vel_up * 1000.0) as i32],
        1500,
        2500,
        120,
        3,
        sv,
        1,
    )
}

/// Two recorded flights; session 2 carries a REC_CONFIG record, session 1 does not.
pub fn build_log(epoch: u32, conf: &Values) -> BlockWriter {
    let mut w = BlockWriter::new(epoch);
    let mut rng = Rng::new(7);
    let (fa, fg) = (conf["imu_accel_fs_g"], conf["imu_gyro_fs_dps"]);
    for (session, with_cfg, length_s) in [(1u32, false, 20.0), (2, true, 40.0)] {
        w.start_session(session);
        w.append(rec::REC_SESSION_START, 0, &[state::ARMED]);
        if with_cfg {
            w.append(rec::REC_CONFIG, 0, &cfg::pack(conf).expect("defaults pack"));
        }
        let pad_s = 5.0;
        // thinned for size
        let (imu_dt, highg_dt, baro_dt, gnss_dt) = (1.0 / 208.0, 1.0 / 100.0, 0.02, 0.1);
        let (mut t, mut next_h, mut next_b, mut next_g) = (0.0f64, 0.0, 0.0, 0.0);
        let mut launched = false;
        while t < length_s {
            let (acc, alt, vel) = toy_flight(t - pad_s);
            let ms = (t * 1000.0) as u32;
            if !launched && t >= pad_s {
                launched = true;
                w.append(rec::REC_STATE, ms, &[state::ARMED, state::LAUNCHED]);
            }
            let t_us = (t * 1e6) as u64 as u32;
            let az = acc + rng.gauss(0.0, 0.02);
            let spin = if launched { 20.0 } else { 0.0 };
            let gyro = [raw_gyro(rng.gauss(0.0, 0.5), fg), raw_gyro(rng.gauss(0.0, 0.5), fg), raw_gyro(rng.gauss(0.0, 0.5) + spin, fg)];
            let accel = [raw_accel(rng.gauss(0.0, 0.02), fa), raw_accel(rng.gauss(0.0, 0.02), fa), raw_accel(az, fa)];
            w.append(rec::REC_IMU, ms, &rec::pack_imu(t_us, rng.gauss(0.0, 30.0) as i16, gyro, accel));
            if t >= next_h {
                next_h += highg_dt;
                let d = (az / 0.78).round().clamp(-128.0, 127.0) as i8;
                w.append(rec::REC_HIGHG, ms, &rec::pack_highg(t_us, [0, 0, d]));
            }
            if t >= next_b {
                next_b += baro_dt;
                let pr = pressure(alt) + rng.gauss(0.0, 3.0);
                w.append(rec::REC_BARO, ms, &rec::pack_baro(t_us, 2500, pr as i32));
            }
            if t >= next_g {
                next_g += gnss_dt;
                w.append(rec::REC_GNSS, ms, &gnss(t_us, alt + 700.0, vel, 12));
            }
            t += imu_dt;
        }
        let ms = (t * 1000.0) as u32;
        w.append(rec::REC_STATE, ms, &[state::LAUNCHED, state::RECOVERY]);
        w.append(rec::REC_SESSION_END, ms, &[state::RECOVERY]);
    }
    w.flush();
    w
}

pub type Clock = Box<dyn Fn() -> f64 + Send>;

pub fn monotonic() -> Clock {
    let t0 = Instant::now();
    Box::new(move || t0.elapsed().as_secs_f64())
}

struct ReadJob {
    seq: u8,
    next: u32,
    end: u32,
}

pub struct FakeBoard {
    clock: Clock,
    pub flash_path: Option<PathBuf>,
    out: Vec<u8>,
    reader: FrameReader,
    rng: Rng,
    pub dtr: bool,
    /// Tests: force a flight state.
    pub state_override: Option<u8>,
    log: BlockWriter,
    /// Session -> UTC start. Session 1 was recorded before a GNSS fix (no date).
    pub utc_starts: Vec<(u32, u32)>,
    t0: f64,
    pub saved: Option<Vec<u8>>,
    pub from_defaults: bool,
    pub active: Values,
    pub stream_rate: u16,
    pub stream_mask: u8,
    next_sample: f64,
    next_status: f64,
    read_job: Option<ReadJob>,
    /// The card mounts on Arm or on the first log request.
    pub mounted: bool,
}

impl FakeBoard {
    pub fn new(flash_path: Option<PathBuf>, clock: Clock) -> Self {
        let mut reader = FrameReader::new();
        reader.mark_synced();
        let mut b = Self {
            clock,
            flash_path,
            out: Vec::new(),
            reader,
            rng: Rng::new(1),
            dtr: false,
            state_override: None,
            log: build_log(3, &cfg::defaults()),
            utc_starts: vec![(1, 0), (2, 1_793_548_800)], // 2026-11-01 16:00 UTC
            t0: 0.0,
            saved: None,
            from_defaults: true,
            active: cfg::defaults(),
            stream_rate: 0,
            stream_mask: p::STREAM_ALL,
            next_sample: 0.0,
            next_status: 0.0,
            read_job: None,
            mounted: false,
        };
        b.boot();
        b
    }

    fn boot(&mut self) {
        self.t0 = (self.clock)();
        self.saved = self.read_flash();
        self.from_defaults = self.saved.is_none();
        self.active = self.saved.as_deref().and_then(|b| cfg::unpack(b).ok()).unwrap_or_else(cfg::defaults);
        self.stream_rate = 0;
        self.stream_mask = p::STREAM_ALL;
        self.next_sample = 0.0;
        self.next_status = 0.0;
        self.read_job = None;
        self.mounted = false;
    }

    fn read_flash(&self) -> Option<Vec<u8>> {
        let blob = std::fs::read(self.flash_path.as_ref()?).ok()?;
        cfg::unpack(&blob).ok()?;
        Some(blob[..cfg::SIZE].to_vec())
    }

    fn write_flash(&mut self, blob: Vec<u8>) {
        if let Some(path) = &self.flash_path {
            let _ = std::fs::write(path, &blob);
        }
        self.saved = Some(blob);
    }

    pub fn uptime(&self) -> f64 {
        (self.clock)() - self.t0
    }

    pub fn state(&self) -> u8 {
        self.state_override.unwrap_or(if self.uptime() < SELF_TEST_S { state::SELF_TEST } else { state::IDLE })
    }

    pub fn log_blocks(&self) -> &[Vec<u8>] {
        &self.log.blocks
    }

    // ---- transport side
    pub fn host_write(&mut self, data: &[u8]) {
        for fr in self.reader.feed(data) {
            self.handle(fr);
        }
    }

    pub fn host_read(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.out)
    }

    fn send(&mut self, ty: u8, seq: u8, payload: &[u8]) {
        self.out.extend(p::encode_frame(ty, seq, payload));
    }

    fn ack(&mut self, req: &Frame, res: u8, detail: u16) {
        self.send(msg::ACK, req.seq, &Ack { for_type: req.ty, result: res, detail }.pack());
    }

    // ---- commands
    fn configurable(&self) -> bool {
        state::configurable(self.state())
    }

    fn handle(&mut self, fr: Frame) {
        let pl = fr.payload.as_slice();
        match fr.ty {
            msg::HELLO => {
                let info = p::Info {
                    protocol_version: p::PROTOCOL_VERSION,
                    config_version: cfg::CONFIG_VERSION,
                    config_size: cfg::SIZE as u16,
                    uptime_ms: (self.uptime() * 1000.0) as u32,
                    uid: core::array::from_fn(|i| i as u8),
                    fw_git: "simulated".into(),
                    build_unix: SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as u32).unwrap_or(0),
                };
                self.send(msg::INFO, fr.seq, &info.pack());
            }
            msg::GET_STATUS => {
                let s = self.status().pack();
                self.send(msg::STATUS, fr.seq, &s);
            }
            msg::SET_STREAM => {
                if pl.len() != 3 {
                    return self.ack(&fr, result::BAD_FRAME, 0);
                }
                let rate = u16::from_le_bytes([pl[0], pl[1]]);
                if rate > MAX_STREAM_HZ {
                    return self.ack(&fr, result::BAD_VALUE, rate);
                }
                self.stream_rate = rate;
                self.stream_mask = pl[2];
                self.ack(&fr, result::OK, 0);
            }
            msg::CONFIG_GET => {
                let which = pl.first().copied().unwrap_or(0);
                let blob = match which {
                    p::slot::ACTIVE => cfg::pack(&self.active).ok(),
                    p::slot::SAVED => self.saved.clone(),
                    p::slot::DEFAULTS => cfg::pack(&cfg::defaults()).ok(),
                    _ => None,
                };
                match blob {
                    None => self.ack(&fr, result::FLASH_ERROR, 0),
                    Some(b) => {
                        let mut v = vec![which];
                        v.extend(b);
                        self.send(msg::CONFIG, fr.seq, &v);
                    }
                }
            }
            msg::CONFIG_SET => {
                if !self.configurable() {
                    return self.ack(&fr, result::WRONG_STATE, self.state() as u16);
                }
                let Ok(vals) = cfg::unpack(pl) else { return self.ack(&fr, result::BAD_FRAME, 0) };
                if let Some((f, _)) = cfg::problems(&vals).first() {
                    return self.ack(&fr, result::BAD_VALUE, f.id);
                }
                self.active = vals;
                self.ack(&fr, result::OK, 0);
            }
            msg::CONFIG_SAVE => {
                if !self.configurable() {
                    return self.ack(&fr, result::WRONG_STATE, self.state() as u16);
                }
                let blob = cfg::pack(&self.active).expect("active config packs");
                self.write_flash(blob);
                self.from_defaults = false;
                self.ack(&fr, result::OK, 0);
            }
            msg::CONFIG_REVERT => {
                self.active = self.saved.as_deref().and_then(|b| cfg::unpack(b).ok()).unwrap_or_else(cfg::defaults);
                self.ack(&fr, result::OK, 0);
            }
            msg::LOG_INFO | msg::LOG_SESSIONS | msg::LOG_READ => {
                self.mounted = true;
                self.handle_log(fr);
            }
            _ => self.other(fr),
        }
    }

    fn handle_log(&mut self, fr: Frame) {
        let pl = fr.payload.as_slice();
        match fr.ty {
            msg::LOG_INFO => {
                let li = p::LogInfo {
                    disk: p::disk::MOUNTED,
                    epoch: self.log.epoch,
                    data_start: DATA_START,
                    capacity: CAPACITY,
                    head: self.log.blocks.len() as u32,
                    sessions: self.sessions().len() as u32,
                };
                self.send(msg::LOG_INFO_REPLY, fr.seq, &li.pack());
            }
            msg::LOG_SESSIONS => {
                let start = if pl.len() == 2 { u16::from_le_bytes([pl[0], pl[1]]) as usize } else { 0 };
                let ss = self.sessions();
                let page = &ss[start.min(ss.len())..(start + p::SESSIONS_PER_FRAME).min(ss.len())];
                let payload = p::pack_sessions(ss.len() as u16, page);
                self.send(msg::SESSIONS, fr.seq, &payload);
            }
            msg::LOG_READ => {
                if pl.len() != 8 {
                    return self.ack(&fr, result::BAD_FRAME, 0);
                }
                if self.read_job.is_some() {
                    return self.ack(&fr, result::BUSY, 0);
                }
                let first = p::u32_at(pl, 0);
                let count = p::u32_at(pl, 4);
                let end = first.saturating_add(count).min(self.log.blocks.len() as u32);
                self.read_job = Some(ReadJob { seq: fr.seq, next: first, end });
            }
            _ => unreachable!(),
        }
    }

    fn other(&mut self, fr: Frame) {
        let pl = fr.payload.as_slice();
        match fr.ty {
            msg::LOG_ABORT => {
                if let Some(job) = self.read_job.take() {
                    // detail 1: ended early
                    self.send(msg::ACK, job.seq, &Ack { for_type: msg::LOG_READ, result: result::OK, detail: 1 }.pack());
                }
                self.ack(&fr, result::OK, 0);
            }
            msg::LOG_WIPE => {
                if !self.configurable() {
                    return self.ack(&fr, result::WRONG_STATE, self.state() as u16);
                }
                if pl != p::WIPE_MAGIC.to_le_bytes() {
                    return self.ack(&fr, result::BAD_MAGIC, 0);
                }
                self.log = BlockWriter::new(self.log.epoch + 1);
                self.ack(&fr, result::OK, 0);
            }
            msg::REBOOT => {
                if pl != p::REBOOT_MAGIC.to_le_bytes() {
                    return self.ack(&fr, result::BAD_MAGIC, 0);
                }
                self.ack(&fr, result::OK, 0);
                self.boot();
            }
            _ => self.ack(&fr, result::UNKNOWN_TYPE, 0),
        }
    }

    /// What the board works out from block headers plus each session's first and last block.
    pub fn sessions(&self) -> Vec<p::SessionEntry> {
        let mut out: Vec<p::SessionEntry> = Vec::new();
        for (i, raw) in self.log.blocks.iter().enumerate() {
            let s = p::u32_at(raw, 12);
            match out.last_mut() {
                Some(e) if e.session == s => e.blocks += 1,
                _ => out.push(p::SessionEntry { session: s, first_block: i as u32, blocks: 1, duration_ms: 0, utc_start: 0 }),
            }
        }
        for e in &mut out {
            let first = &self.log.blocks[e.first_block as usize];
            let last = &self.log.blocks[(e.first_block + e.blocks - 1) as usize];
            let t0 = p::u32_at(first, emmc::HEADER + 2);
            let used = p::u16_at(last, 18) as usize;
            let last_t = emmc::iter_records(&last[emmc::HEADER..emmc::HEADER + used]).last().map(|r| r.1);
            e.duration_ms = last_t.map_or(0, |t| t - t0);
            e.utc_start = self.utc_starts.iter().find(|(s, _)| *s == e.session).map_or(0, |x| x.1);
        }
        out
    }

    pub fn status(&mut self) -> p::Status {
        let mut flags = p::FLAG_ON_USB_POWER;
        let active_blob = cfg::pack(&self.active).ok();
        if self.saved.is_none() || active_blob != self.saved {
            flags |= p::FLAG_CONFIG_UNSAVED;
        }
        if self.dtr && self.stream_rate > 0 {
            flags |= p::FLAG_STREAMING;
        }
        if self.from_defaults {
            flags |= p::FLAG_CONFIG_DEFAULTS;
        }
        let done = self.state() != state::SELF_TEST;
        let mut results = [st::PASS, st::PASS, st::PASS, st::NOT_CONFIGURED, st::PASS, st::PASS, st::NOT_IMPLEMENTED, st::PASS];
        if !done {
            for r in &mut results {
                if *r == st::PASS {
                    *r = st::PENDING;
                }
            }
        }
        p::Status {
            state: self.state(),
            flags,
            uptime_ms: (self.uptime() * 1000.0) as u64 as u32,
            // A 2S LiPo near full, judged OK; the real board converts and judges.
            battery_mv: (7_900 + (self.rng.uniform() * 20.0) as i32 - 10) as u16,
            battery_state: p::battery::OK,
            self_test: results,
            gnss_fix: if done { 3 } else { 0 },
            gnss_sv: if done { 11 } else { 0 },
            disk: if self.mounted { p::disk::MOUNTED } else { p::disk::UNMOUNTED },
            log_blocks_used: self.log.blocks.len() as u32,
            log_blocks_total: CAPACITY - DATA_START,
            log_dropped: 0,
            // Channel 1 has an e-match on it, channel 2 is empty.
            pyro_state: [p::pyro::CONTINUITY, p::pyro::OPEN],
            pyro_mohm: [(1_600 + (self.rng.uniform() * 10.0) as i32) as u16, p::pyro::OVER_RANGE],
            sensor_errors: 0,
            stream_rate_hz: self.stream_rate,
        }
    }

    // ---- time
    pub fn tick(&mut self) {
        let now = self.uptime();
        if let Some(mut job) = self.read_job.take() {
            let stop = job.end.min(job.next + BLOCKS_PER_TICK);
            for i in job.next..stop {
                let mut pl = i.to_le_bytes().to_vec();
                pl.extend_from_slice(&self.log.blocks[i as usize]);
                self.send(msg::LOG_BLOCK, job.seq, &pl);
            }
            if stop >= job.end {
                self.send(msg::ACK, job.seq, &Ack { for_type: msg::LOG_READ, result: result::OK, detail: 0 }.pack());
            } else {
                job.next = stop;
                self.read_job = Some(job);
            }
        }
        if !self.dtr {
            return; // nobody listening: no heartbeat, no stream (PROTOCOL.md §4)
        }
        if now >= self.next_status {
            self.next_status = now + 1.0;
            let s = self.status().pack();
            self.send(msg::STATUS, 0, &s);
        }
        if self.stream_rate > 0 && now >= self.next_sample {
            self.next_sample = now + 1.0 / self.stream_rate as f64;
            self.stream_samples(now);
        }
    }

    fn stream_samples(&mut self, now: f64) {
        let (fa, fg) = (self.active["imu_accel_fs_g"], self.active["imu_gyro_fs_dps"]);
        let t_us = (now * 1e6) as u64 as u32;
        let wob = 0.05 * (now * 2.0).sin();
        let m = self.stream_mask;
        let r = &mut self.rng;
        let mut frames: Vec<(u8, Vec<u8>)> = Vec::new();
        if m & p::STREAM_IMU != 0 {
            let gyro = [raw_gyro(r.gauss(0.0, 0.3) + 5.0 * wob, fg), raw_gyro(r.gauss(0.0, 0.3), fg), raw_gyro(r.gauss(0.0, 0.3), fg)];
            let accel =
                [raw_accel(r.gauss(0.0, 0.01) + wob, fa), raw_accel(r.gauss(0.0, 0.01), fa), raw_accel(1.0 + r.gauss(0.0, 0.01), fa)];
            frames.push((rec::REC_IMU, rec::pack_imu(t_us, r.gauss(0.0, 20.0) as i16, gyro, accel)));
        }
        if m & p::STREAM_HIGHG != 0 {
            frames.push((rec::REC_HIGHG, rec::pack_highg(t_us, [0, 0, 1])));
        }
        if m & p::STREAM_BARO != 0 {
            let pr = pressure(0.0) - 8000.0 + r.gauss(0.0, 2.0);
            frames.push((rec::REC_BARO, rec::pack_baro(t_us, 2412 + r.gauss(0.0, 3.0) as i32, pr as i32)));
        }
        if m & p::STREAM_GNSS != 0 {
            frames.push((rec::REC_GNSS, gnss(t_us, 700.0 + r.gauss(0.0, 1.5), 0.0, 11)));
        }
        for (t, d) in frames {
            let mut pl = vec![t];
            pl.extend(d);
            self.send(msg::SAMPLE, 0, &pl);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    struct Host {
        board: FakeBoard,
        reader: FrameReader,
        seq: u8,
    }

    impl Host {
        fn new(board: FakeBoard) -> Self {
            let mut reader = FrameReader::new();
            reader.mark_synced();
            Self { board, reader, seq: 0 }
        }
        fn ask(&mut self, ty: u8, payload: &[u8], ticks: usize) -> Vec<Frame> {
            self.seq += 1;
            self.board.host_write(&p::encode_frame(ty, self.seq, payload));
            let mut out = Vec::new();
            for _ in 0..ticks {
                self.board.tick();
                out.extend(self.reader.feed(&self.board.host_read()));
            }
            out.into_iter().filter(|f| f.seq == self.seq).collect()
        }
        fn ack(&mut self, ty: u8, payload: &[u8]) -> Ack {
            let fr = self.ask(ty, payload, 1);
            assert_eq!(fr.len(), 1);
            assert_eq!(fr[0].ty, msg::ACK);
            Ack::unpack(&fr[0].payload).unwrap()
        }
    }

    fn manual_clock() -> (Arc<Mutex<f64>>, Clock) {
        let t = Arc::new(Mutex::new(100.0));
        let t2 = t.clone();
        (t, Box::new(move || *t2.lock().unwrap()))
    }

    #[test]
    fn config_is_remembered_across_reboot() {
        let dir = tempfile::tempdir().unwrap();
        let flash = dir.path().join("flash.bin");
        let (_t, clock) = manual_clock();
        let mut h = Host::new(FakeBoard::new(Some(flash.clone()), clock));
        let conf = cfg::pack(&cfg::defaults().with("radio_sf", 11)).unwrap();
        assert!(h.ack(msg::CONFIG_SET, &conf).ok());
        assert!(h.ack(msg::REBOOT, &p::REBOOT_MAGIC.to_le_bytes()).ok());
        assert_eq!(h.board.active["radio_sf"], 9); // applied, never saved: gone
        assert!(h.ack(msg::CONFIG_SET, &conf).ok());
        assert!(h.ack(msg::CONFIG_SAVE, &[]).ok());
        let (_t, clock) = manual_clock();
        let b2 = FakeBoard::new(Some(flash), clock); // power cycle
        assert_eq!(b2.active["radio_sf"], 11);
        assert!(!b2.from_defaults);
    }

    #[test]
    fn board_refuses_bad_values_and_writes_when_armed() {
        let mut h = Host::new(FakeBoard::new(None, monotonic()));
        let bad = cfg::pack(&cfg::defaults().with("imu_accel_fs_g", 3)).unwrap();
        let a = h.ack(msg::CONFIG_SET, &bad);
        assert_eq!((a.result, a.detail), (result::BAD_VALUE, cfg::by_key("imu_accel_fs_g").id));
        h.board.state_override = Some(state::ARMED);
        let a = h.ack(msg::CONFIG_SET, &cfg::pack(&cfg::defaults()).unwrap());
        assert_eq!((a.result, a.detail), (result::WRONG_STATE, state::ARMED as u16));
        assert_eq!(h.ack(msg::CONFIG_SAVE, &[]).result, result::WRONG_STATE);
        assert_eq!(h.ack(msg::LOG_WIPE, &p::WIPE_MAGIC.to_le_bytes()).result, result::WRONG_STATE);
    }

    #[test]
    fn no_stream_without_dtr() {
        let (t, clock) = manual_clock();
        let mut h = Host::new(FakeBoard::new(None, clock));
        h.board.dtr = true;
        let mut pl = 50u16.to_le_bytes().to_vec();
        pl.push(p::STREAM_ALL);
        assert!(h.ack(msg::SET_STREAM, &pl).ok());
        h.board.dtr = false;
        for _ in 0..20 {
            *t.lock().unwrap() += 0.1;
            h.board.tick();
        }
        assert!(h.board.host_read().is_empty());
        h.board.dtr = true;
        *t.lock().unwrap() += 0.1;
        h.board.tick();
        let types: Vec<u8> = h.reader.feed(&h.board.host_read()).iter().map(|f| f.ty).collect();
        assert!(types.contains(&msg::SAMPLE) && types.contains(&msg::STATUS));
    }

    #[test]
    fn download_a_flight_end_to_end() {
        let mut h = Host::new(FakeBoard::new(None, monotonic()));
        let info = h.ask(msg::LOG_INFO, &[], 1);
        let li = p::LogInfo::unpack(&info[0].payload).unwrap();
        let fr = h.ask(msg::LOG_SESSIONS, &0u16.to_le_bytes(), 1);
        let (total, entries) = p::unpack_sessions(&fr[0].payload).unwrap();
        assert_eq!(total, 2);
        assert!(entries[1].utc_start != 0 && entries[0].utc_start == 0);
        let e = entries[1];
        let mut req = e.first_block.to_le_bytes().to_vec();
        req.extend(e.blocks.to_le_bytes());
        let frames = h.ask(msg::LOG_READ, &req, 50);
        let last = frames.last().unwrap();
        assert_eq!(last.ty, msg::ACK);
        assert!(Ack::unpack(&last.payload).unwrap().ok());
        let blocks: Vec<(u32, &[u8])> =
            frames.iter().filter(|f| f.ty == msg::LOG_BLOCK).map(|f| (p::u32_at(&f.payload, 0), &f.payload[4..])).collect();
        assert_eq!(blocks.len() as u32, e.blocks);
        let s = emmc::decode_blocks(blocks, Some(li.epoch), &cfg::defaults(), "fallback");
        assert_eq!(s.keys().copied().collect::<Vec<_>>(), vec![e.session]);
        let s = &s[&e.session];
        assert!(s.config_recorded());
        assert!((s.duration_s() - e.duration_ms as f64 / 1000.0).abs() < 0.01);
    }
}
