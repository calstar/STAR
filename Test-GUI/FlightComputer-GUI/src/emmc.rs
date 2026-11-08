//! Decoder for the eMMC flight log.
//!
//! The format is Core/Inc/emmc_log.h on the firmware side; this is a second,
//! independent implementation of its reader, so a format bug cannot hide by
//! being read back with the code that wrote it.
//!
//! ```text
//! log block (512 B, little-endian)
//!    0 u32 magic "SLG1"   4 u32 epoch   8 u32 seq (= its own index)
//!   12 u32 session        16 u8 kind (1 DATA, 2 PAD)  17 u8 0
//!   18 u16 used           20 payload (488 B)          508 u32 CRC-32 of 0..507
//! record: u8 type, u8 len, u32 t_ms, len bytes
//! ```
//!
//! The app asks the board for raw blocks (LOG_READ) and does every check here:
//! a block is used only if magic, epoch, position and CRC all hold.

use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use crate::config::{self as cfg, Values};
use crate::protocol::{state, u16_at, u32_at};
use crate::records as rec;

pub const BLOCK: usize = 512;
pub const HEADER: usize = 20;
pub const PAYLOAD: usize = BLOCK - HEADER - 4; // 488
pub const BLOCK_MAGIC: u32 = 0x3147_4C53; // "SLG1"
pub const SUPER_MAGIC: u32 = 0x3142_5353; // "SSB1"
pub const KIND_DATA: u8 = 1;
pub const KIND_PAD: u8 = 2;
pub const RECORD_HEADER: usize = 6;

pub fn crc32(data: &[u8]) -> u32 {
    crc32fast::hash(data)
}

#[derive(Debug)]
pub struct Block<'a> {
    pub index: u32,
    pub epoch: u32,
    pub session: u32,
    pub kind: u8,
    pub payload: &'a [u8],
}

/// The block if valid, else why not.
pub fn check_block(raw: &[u8], index: u32, epoch: Option<u32>) -> Result<Block<'_>, String> {
    if raw.len() != BLOCK {
        return Err(format!("block {index}: {} bytes", raw.len()));
    }
    if u32_at(raw, 0) != BLOCK_MAGIC {
        return Err(format!("block {index}: bad magic"));
    }
    if crc32(&raw[..BLOCK - 4]) != u32_at(raw, BLOCK - 4) {
        return Err(format!("block {index}: CRC mismatch"));
    }
    let seq = u32_at(raw, 8);
    if seq != index {
        return Err(format!("block {index}: claims position {seq}"));
    }
    let ep = u32_at(raw, 4);
    if let Some(e) = epoch {
        if ep != e {
            return Err(format!("block {index}: epoch {ep}, card is on {e}"));
        }
    }
    let used = u16_at(raw, 18) as usize;
    if used > PAYLOAD {
        return Err(format!("block {index}: used {used} > {PAYLOAD}"));
    }
    Ok(Block { index, epoch: ep, session: u32_at(raw, 12), kind: raw[16], payload: &raw[HEADER..HEADER + used] })
}

/// (type, t_ms, data) for each record in a block payload.
pub fn iter_records(payload: &[u8]) -> impl Iterator<Item = (u8, u32, &[u8])> {
    let mut i = 0;
    std::iter::from_fn(move || {
        if i + RECORD_HEADER > payload.len() {
            return None;
        }
        let t = payload[i];
        let len = payload[i + 1] as usize;
        let t_ms = u32_at(payload, i + 2);
        i += RECORD_HEADER;
        if i + len > payload.len() {
            i = payload.len();
            return None; // truncated record: the writer never splits one, so stop
        }
        let d = &payload[i..i + len];
        i += len;
        Some((t, t_ms, d))
    })
}

#[derive(Clone, Debug, Default)]
pub struct Session {
    pub session: u32,
    pub blocks: u32,
    pub bad_blocks: Vec<String>,
    /// type -> [(t_ms, data)]
    pub records: BTreeMap<u8, Vec<(u32, Vec<u8>)>>,
    pub events: Vec<(u32, String)>,
    pub dropped: u64,
    pub config: Option<Values>,
    pub config_source: String,
}

fn state_at(d: &[u8], i: usize) -> String {
    d.get(i).map(|&s| state::name(s)).unwrap_or_else(|| "?".into())
}

impl Session {
    pub fn new(session: u32) -> Self {
        Self { session, ..Default::default() }
    }

    pub fn add(&mut self, t: u8, t_ms: u32, d: &[u8]) {
        match t {
            rec::REC_SESSION_START => self.events.push((t_ms, format!("session start ({})", state_at(d, 0)))),
            rec::REC_STATE => self.events.push((t_ms, format!("{} -> {}", state_at(d, 0), state_at(d, 1)))),
            rec::REC_SESSION_END => self.events.push((t_ms, format!("session end ({})", state_at(d, 0)))),
            rec::REC_DROPPED if d.len() >= 4 => {
                let n = u32_at(d, 0);
                self.dropped += n as u64;
                self.events.push((t_ms, format!("{n} records dropped (card stalled)")));
            }
            rec::REC_CONFIG if self.config.is_none() => match cfg::unpack(d) {
                Ok(v) => {
                    self.config = Some(v);
                    self.config_source = "recorded in the session".into();
                }
                Err(e) => self.events.push((t_ms, format!("unreadable config record: {e}"))),
            },
            _ => self.records.entry(t).or_default().push((t_ms, d.to_vec())),
        }
    }

    pub fn count(&self, t: u8) -> usize {
        self.records.get(&t).map_or(0, Vec::len)
    }

    pub fn duration_s(&self) -> f64 {
        let ts: Vec<u32> = self.records.values().flat_map(|l| l.first().into_iter().chain(l.last()).map(|r| r.0)).collect();
        match (ts.iter().min(), ts.iter().max()) {
            (Some(a), Some(b)) => (b - a) as f64 / 1000.0,
            _ => 0.0,
        }
    }

    pub fn config_recorded(&self) -> bool {
        self.config_source.starts_with("recorded")
    }
}

/// Raw (index, bytes) blocks -> sessions. Blocks that fail a check are listed
/// under session 0 (which session a bad block belonged to can't be known).
pub fn decode_blocks<'a>(
    blocks: impl IntoIterator<Item = (u32, &'a [u8])>,
    epoch: Option<u32>,
    fallback: &Values,
    fallback_source: &str,
) -> BTreeMap<u32, Session> {
    let mut out: BTreeMap<u32, Session> = BTreeMap::new();
    for (index, raw) in blocks {
        match check_block(raw, index, epoch) {
            Err(why) => out.entry(0).or_insert_with(|| Session::new(0)).bad_blocks.push(why),
            Ok(b) => {
                let s = out.entry(b.session).or_insert_with(|| Session::new(b.session));
                s.blocks += 1;
                if b.kind == KIND_DATA {
                    for (t, t_ms, d) in iter_records(b.payload) {
                        s.add(t, t_ms, d);
                    }
                }
            }
        }
    }
    for s in out.values_mut() {
        if s.config.is_none() {
            s.config = Some(*fallback);
            s.config_source = fallback_source.to_string();
        }
    }
    out
}

/// One CSV per sensor plus events.csv and session.txt. Returns the files written.
pub fn export_csv(s: &Session, dir: &Path, p0_pa: f64) -> io::Result<Vec<PathBuf>> {
    fs::create_dir_all(dir)?;
    let conf = s.config.unwrap_or_else(cfg::defaults);
    let mut written = Vec::new();
    for t in rec::SENSORS {
        let Some(rows) = s.records.get(&t).filter(|r| !r.is_empty()) else { continue };
        let path = dir.join(format!("{}.csv", rec::name(t)));
        let mut w = io::BufWriter::new(fs::File::create(&path)?);
        writeln!(w, "t_ms,{}", rec::columns(t).join(","))?;
        for (t_ms, d) in rows {
            if let Some(dec) = rec::decode(t, d, &conf, p0_pa) {
                writeln!(w, "{t_ms},{}", dec.csv().join(","))?;
            }
        }
        w.flush()?;
        written.push(path);
    }
    let path = dir.join("events.csv");
    let mut text = String::from("t_ms,event\n");
    for (t, e) in &s.events {
        let _ = writeln!(text, "{t},{}", csv_quote(e));
    }
    fs::write(&path, text)?;
    written.push(path);

    let path = dir.join("session.txt");
    let mut text = format!("session {}\nblocks {}\ndropped records {}\nconfig ({}):\n", s.session, s.blocks, s.dropped, s.config_source);
    for (f, v) in cfg::fields().iter().zip(conf.0) {
        let _ = writeln!(text, "  {} = {v}", f.key);
    }
    for why in &s.bad_blocks {
        let _ = writeln!(text, "bad: {why}");
    }
    fs::write(&path, text)?;
    written.push(path);
    Ok(written)
}

fn csv_quote(s: &str) -> String {
    if s.contains([',', '"', '\n']) {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

// ------------------------------------------------------------- writer (fakes)

/// Builds log blocks the way emmc_log.c does. For the simulated board and tests only.
pub struct BlockWriter {
    pub epoch: u32,
    pub blocks: Vec<Vec<u8>>,
    session: u32,
    buf: Vec<u8>,
}

impl BlockWriter {
    pub fn new(epoch: u32) -> Self {
        Self { epoch, blocks: Vec::new(), session: 0, buf: Vec::new() }
    }

    fn seal(&mut self) {
        if self.buf.is_empty() {
            return;
        }
        let mut raw = Vec::with_capacity(BLOCK);
        for x in [BLOCK_MAGIC, self.epoch, self.blocks.len() as u32, self.session] {
            raw.extend_from_slice(&x.to_le_bytes());
        }
        raw.extend([KIND_DATA, 0]);
        raw.extend_from_slice(&(self.buf.len() as u16).to_le_bytes());
        raw.extend_from_slice(&self.buf);
        raw.resize(BLOCK - 4, 0);
        let crc = crc32(&raw);
        raw.extend_from_slice(&crc.to_le_bytes());
        self.blocks.push(raw);
        self.buf.clear();
    }

    pub fn start_session(&mut self, session: u32) {
        self.seal();
        self.session = session;
    }

    pub fn append(&mut self, t: u8, t_ms: u32, d: &[u8]) {
        if self.buf.len() + RECORD_HEADER + d.len() > PAYLOAD {
            self.seal();
        }
        self.buf.extend([t, d.len() as u8]);
        self.buf.extend_from_slice(&t_ms.to_le_bytes());
        self.buf.extend_from_slice(d);
    }

    pub fn flush(&mut self) {
        self.seal();
    }

    pub fn indexed(&self) -> impl Iterator<Item = (u32, &[u8])> {
        self.blocks.iter().enumerate().map(|(i, b)| (i as u32, b.as_slice()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::defaults;

    #[test]
    fn decoder_rejects_bad_blocks() {
        let mut w = BlockWriter::new(4);
        w.start_session(1);
        for i in 0..200 {
            w.append(rec::REC_BARO, i, &rec::pack_baro(i, 0, 100_000));
        }
        w.flush();
        assert!(w.blocks.len() >= 4);
        let mut crc_bad = w.blocks[1].clone();
        crc_bad[30] ^= 1;
        let mut blocks: Vec<(u32, &[u8])> = w.indexed().collect();
        blocks[1] = (1, &crc_bad);
        blocks[2] = (3, &w.blocks[2]); // claims to be block 2, offered as block 3
        let s = decode_blocks(blocks, Some(4), &defaults(), "test");
        assert_eq!(s[&0].bad_blocks.len(), 2);
        assert!(s[&0].bad_blocks[0].contains("CRC"));
        assert!(s[&0].bad_blocks[1].contains("claims position 2"));
        let other_epoch = decode_blocks(w.indexed(), Some(5), &defaults(), "test");
        assert_eq!(other_epoch.keys().copied().collect::<Vec<_>>(), vec![0]);
    }

    #[test]
    fn decoder_uses_recorded_config_over_fallback() {
        let mut w = BlockWriter::new(1);
        w.start_session(7);
        let conf = defaults().with("imu_accel_fs_g", 4);
        w.append(rec::REC_CONFIG, 0, &cfg::pack(&conf).unwrap());
        w.append(rec::REC_IMU, 1, &rec::pack_imu(0, 0, [0; 3], [0, 0, 1000]));
        w.flush();
        let s = &decode_blocks(w.indexed(), Some(1), &defaults(), "fallback")[&7];
        assert!(s.config_recorded());
        let Some(rec::Decoded::Imu(d)) = rec::decode(rec::REC_IMU, &s.records[&rec::REC_IMU][0].1, &s.config.unwrap(), rec::P0_PA) else {
            panic!()
        };
        assert!((d.accel_g[2] - 1000.0 * 0.122e-3).abs() < 1e-9);
    }

    #[test]
    fn truncated_record_stops_the_block() {
        let mut p = vec![rec::REC_BARO, 12, 1, 0, 0, 0];
        p.extend(rec::pack_baro(0, 0, 1));
        p.extend([rec::REC_BARO, 12, 2, 0, 0, 0, 1, 2]); // only 2 of 12 bytes
        let got: Vec<_> = iter_records(&p).collect();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].1, 1);
    }
}
