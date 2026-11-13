//! Flights: the eMMC as a list of files, one per recorded flight.
//!
//! A "flight" is one log session (Arm to Un-arm, or to power-off). The board
//! lists them (LOG_SESSIONS), the app downloads one as raw blocks (LOG_READ),
//! checks every block itself, and saves a folder per flight:
//!
//! ```text
//! Documents/STAR Flights/<date> flight <n> (<board>)/
//!     flight.slg     the raw blocks, exactly as read (re-decodable later)
//!     meta.json      board, epoch, session, block range, download time
//!     imu.csv highg.csv baro.csv gnss.csv events.csv session.txt
//! ```

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use super::format::{fmt_bytes, fmt_duration, now_utc_iso, utc, utc_text, Tone};
use super::{Purpose, Shared};
use crate::config as cfg;
use crate::emmc::{self, Session};
use crate::protocol::{self as p, msg, Frame, SessionEntry};
use crate::records::{self as rec, Decoded, P0_PA};

pub const FALLBACK_SOURCE: &str =
    "firmware defaults -- the session has no config record, so the ranges it was recorded with are assumed, not known";
const LOG_TIMEOUT: Duration = Duration::from_secs(5);
/// A plotted line keeps at most this many points (min and max of each bucket),
/// which is more than a screen has pixels. The CSVs keep every sample.
pub const PLOT_POINTS: usize = 8000;
pub const WIPE_WORD: &str = "WIPE";

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Meta {
    pub board_uid: String,
    pub firmware: String,
    pub epoch: u32,
    pub session: u32,
    pub first_block: u32,
    pub blocks: u32,
    pub duration_ms: u32,
    pub utc_start: u32,
    pub downloaded_utc: String,
    pub format: String,
}

pub fn flight_title(e: &SessionEntry) -> String {
    let when = if e.utc_start != 0 {
        let (y, mo, d, h, mi, _) = utc(e.utc_start as u64);
        format!("{y:04}-{mo:02}-{d:02} {h:02}{mi:02}Z")
    } else {
        "no GPS time".into()
    };
    format!("{when} flight {}", e.session)
}

/// session -> folder, for flights already downloaded from this board and card epoch.
pub fn find_downloaded(root: &Path, uid: &str, epoch: u32) -> HashMap<u32, PathBuf> {
    let mut out = HashMap::new();
    let Ok(dir) = std::fs::read_dir(root) else { return out };
    for ent in dir.flatten() {
        let Ok(text) = std::fs::read_to_string(ent.path().join("meta.json")) else { continue };
        let Ok(m) = serde_json::from_str::<Meta>(&text) else { continue };
        if m.board_uid == uid && m.epoch == epoch {
            out.insert(m.session, ent.path());
        }
    }
    out
}

pub fn load_folder(folder: &Path) -> Result<(Session, Meta), String> {
    let meta: Meta = serde_json::from_str(&std::fs::read_to_string(folder.join("meta.json")).map_err(|e| format!("meta.json: {e}"))?)
        .map_err(|e| format!("meta.json: {e}"))?;
    let raw = std::fs::read(folder.join("flight.slg")).map_err(|e| format!("flight.slg: {e}"))?;
    let blocks = raw.chunks(emmc::BLOCK).enumerate().map(|(i, b)| (meta.first_block + i as u32, b));
    let mut sessions = emmc::decode_blocks(blocks, Some(meta.epoch), &cfg::defaults(), FALLBACK_SOURCE);
    let bad = sessions.remove(&0).map(|s| s.bad_blocks).unwrap_or_default();
    let mut s = sessions.remove(&meta.session).unwrap_or_else(|| {
        let mut s = Session::new(meta.session);
        s.config = Some(cfg::defaults());
        s.config_source = FALLBACK_SOURCE.into();
        s
    });
    s.bad_blocks.extend(bad);
    Ok((s, meta))
}

/// Keep the shape of a long series in at most `max` points: for each bucket of
/// consecutive samples, its lowest and highest in time order. Spikes survive.
pub fn decimate(pts: &[[f64; 2]], max: usize) -> Vec<[f64; 2]> {
    if pts.len() <= max || max < 2 {
        return pts.to_vec();
    }
    let buckets = max / 2;
    let size = pts.len().div_ceil(buckets);
    let mut out = Vec::with_capacity(buckets * 2);
    for chunk in pts.chunks(size) {
        let (mut lo, mut hi) = (0, 0);
        for (i, p) in chunk.iter().enumerate() {
            if p[1] < chunk[lo][1] {
                lo = i;
            }
            if p[1] > chunk[hi][1] {
                hi = i;
            }
        }
        out.push(chunk[lo.min(hi)]);
        if lo != hi {
            out.push(chunk[lo.max(hi)]);
        }
    }
    out
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Line {
    pub name: String,
    pub x: Vec<f64>,
    pub y: Vec<f64>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Chart {
    pub title: String,
    pub unit: String,
    pub lines: Vec<Line>,
}

/// A downloaded flight's plot data, fetched by the window when `plot_id` changes.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct FlightPlot {
    pub id: u32,
    pub charts: Vec<Chart>,
    /// (seconds since arm, what happened): drawn as vertical markers.
    pub events: Vec<(f64, String)>,
    pub x_label: String,
}

fn plot_of(id: u32, session: &Session) -> FlightPlot {
    let conf = session.config.unwrap_or_else(cfg::defaults);
    let pick = |t: u8, f: fn(&Decoded) -> Option<f64>| -> Vec<[f64; 2]> {
        session.records.get(&t).map_or_else(Vec::new, |rows| {
            rows.iter()
                .filter_map(|(t_ms, d)| rec::decode(t, d, &conf, P0_PA).as_ref().and_then(f).map(|y| [*t_ms as f64 / 1000.0, y]))
                .collect()
        })
    };
    let line = |name: &str, pts: Vec<[f64; 2]>| {
        let pts = decimate(&pts, PLOT_POINTS);
        Line { name: name.into(), x: pts.iter().map(|p| p[0]).collect(), y: pts.iter().map(|p| p[1]).collect() }
    };
    let chart = |title: &str, unit: &str, lines: Vec<Line>| Chart { title: title.into(), unit: unit.into(), lines };
    FlightPlot {
        id,
        charts: vec![
            chart(
                "Baro altitude (ISA)",
                "m",
                vec![line("baro", pick(rec::REC_BARO, |d| if let Decoded::Baro(b) = d { Some(b.altitude_m) } else { None }))],
            ),
            chart(
                "Axial acceleration",
                "g",
                vec![
                    line("IMU", pick(rec::REC_IMU, |d| if let Decoded::Imu(i) = d { Some(i.accel_g[2]) } else { None })),
                    line("high-g", pick(rec::REC_HIGHG, |d| if let Decoded::HighG(h) = d { Some(h.accel_g[2]) } else { None })),
                ],
            ),
            chart(
                "GNSS altitude MSL",
                "m",
                vec![line("gnss", pick(rec::REC_GNSS, |d| if let Decoded::Gnss(g) = d { Some(g.hmsl_m) } else { None }))],
            ),
        ],
        events: session.events.iter().map(|(t, s)| (*t as f64 / 1000.0, s.clone())).collect(),
        x_label: "time since arm (s)".into(),
    }
}

struct Download {
    id: u32,
    entry: SessionEntry,
    epoch: u32,
    blocks: BTreeMap<u32, Vec<u8>>,
    t0: Instant,
}

/// A downloaded flight on screen.
pub struct Shown {
    pub session: Session,
    pub folder: PathBuf,
    pub plot: FlightPlot,
}

impl Shown {
    pub fn detail(&self) -> String {
        let s = &self.session;
        let counts: Vec<String> =
            rec::SENSORS.iter().filter(|&&t| s.count(t) > 0).map(|&t| format!("{} {}", s.count(t), rec::name(t))).collect();
        format!(
            "Flight {}: {} blocks, {:.1} s; {}; {} records dropped. Scaled with: {}",
            s.session,
            s.blocks,
            s.duration_s(),
            counts.join(", "),
            s.dropped,
            s.config_source
        )
    }
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct EntryView {
    pub session: u32,
    pub name: String,
    pub started: String,
    pub length: String,
    pub size: String,
    pub downloaded: bool,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Progress {
    pub fraction: f64,
    pub text: String,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct ShownView {
    pub plot_id: u32,
    pub detail: String,
    pub warnings: Vec<(String, Tone)>,
    pub folder: String,
}

#[derive(Serialize, Clone, Debug, PartialEq, Default)]
pub struct FlightsView {
    pub summary: String,
    /// Newest first.
    pub entries: Vec<EntryView>,
    pub busy: bool,
    pub can_refresh: bool,
    pub can_download: bool,
    pub can_wipe: bool,
    pub progress: Option<Progress>,
    /// What the wipe dialog says, including which flights are not saved here.
    pub wipe_warning: String,
    pub wipe_word: String,
    pub shown: Option<ShownView>,
    pub root: String,
}

#[derive(Default)]
pub struct FlightsState {
    pub log_info: Option<p::LogInfo>,
    pub entries: Vec<SessionEntry>,
    pub downloaded: HashMap<u32, PathBuf>,
    pub summary: String,
    pub shown: Option<Shown>,
    gen: u32,
    paging: Vec<SessionEntry>,
    download: Option<Download>,
    next_id: u32,
    plot_id: u32,
}

impl FlightsState {
    fn uid(sh: &Shared) -> String {
        sh.client.info.as_ref().map(|i| i.uid_hex()).unwrap_or_default()
    }

    pub fn busy(&self) -> bool {
        self.download.is_some()
    }

    pub fn plot_id(&self) -> u32 {
        self.shown.as_ref().map_or(0, |s| s.plot.id)
    }

    pub fn plot(&self) -> Option<FlightPlot> {
        self.shown.as_ref().map(|s| s.plot.clone())
    }

    pub fn on_disconnected(&mut self, sh: &mut Shared) {
        if self.download.is_some() {
            self.finish(sh, Err("the board disconnected".into()));
        }
        self.log_info = None;
        self.entries.clear();
        self.summary = "Not connected. Downloaded flights can still be opened.".into();
    }

    pub fn refresh(&mut self, sh: &mut Shared) {
        // A newer refresh supersedes an older one still paging: replies to the
        // old one are ignored, or both would append and every flight would show twice.
        self.gen += 1;
        sh.client.request_with_timeout(msg::LOG_INFO, &[], Purpose::LogInfo { gen: self.gen }, LOG_TIMEOUT);
    }

    fn page(&mut self, sh: &mut Shared, start: usize) {
        sh.client.request_with_timeout(
            msg::LOG_SESSIONS,
            &(start as u16).to_le_bytes(),
            Purpose::LogSessions { gen: self.gen },
            LOG_TIMEOUT,
        );
    }

    fn fill(&mut self, sh: &Shared) {
        let Some(li) = self.log_info else { return };
        self.downloaded = find_downloaded(&sh.flights_root, &Self::uid(sh), li.epoch);
        let used = li.head as u64 * emmc::BLOCK as u64;
        let cap = (li.capacity.saturating_sub(li.data_start)) as u64 * emmc::BLOCK as u64;
        self.summary = format!(
            "{} flights on the card; {} of {} used. Saved to {}",
            self.entries.len(),
            fmt_bytes(used),
            fmt_bytes(cap),
            sh.flights_root.display()
        );
    }

    pub fn on_reply(&mut self, sh: &mut Shared, purpose: Purpose, res: Result<Frame, String>) {
        match purpose {
            Purpose::LogInfo { gen } if gen == self.gen => {
                match res
                    .and_then(|fr| if fr.ty == msg::LOG_INFO_REPLY { p::LogInfo::unpack(&fr.payload) } else { Err(describe_refusal(&fr)) })
                {
                    Ok(li) => {
                        self.log_info = Some(li);
                        self.paging.clear();
                        self.page(sh, 0);
                    }
                    Err(e) => self.summary = format!("Could not read the card: {e}"),
                }
            }
            Purpose::LogSessions { gen } if gen == self.gen => {
                match res.and_then(|fr| if fr.ty == msg::SESSIONS { p::unpack_sessions(&fr.payload) } else { Err(describe_refusal(&fr)) }) {
                    Ok((total, got)) => {
                        let more = !got.is_empty();
                        self.paging.extend(got);
                        if more && self.paging.len() < total as usize {
                            let n = self.paging.len();
                            self.page(sh, n);
                        } else {
                            self.entries = std::mem::take(&mut self.paging);
                            self.fill(sh);
                        }
                    }
                    Err(e) => self.summary = format!("Could not list flights: {e}"),
                }
            }
            Purpose::LogInfo { .. } | Purpose::LogSessions { .. } => {} // superseded
            Purpose::LogRead { id } => {
                if self.download.as_ref().is_some_and(|d| d.id == id) {
                    let r = res.and_then(|fr| {
                        let a = p::Ack::unpack(&fr.payload)?;
                        if !a.ok() {
                            Err(a.describe())
                        } else if a.detail != 0 {
                            Err("cancelled".into())
                        } else {
                            Ok(())
                        }
                    });
                    self.finish(sh, r);
                }
            }
            Purpose::LogAbort => {}
            Purpose::LogWipe => match res.and_then(|fr| p::Ack::unpack(&fr.payload)) {
                Ok(a) if a.ok() => self.refresh(sh),
                Ok(a) => sh.warn("Wipe card", format!("The board did not wipe the card: {}", a.describe())),
                Err(e) => sh.warn("Wipe card", format!("The board did not wipe the card: {e}")),
            },
            _ => unreachable!("not a flights purpose"),
        }
    }

    // ---- download
    pub fn download(&mut self, sh: &mut Shared, session: u32) {
        if !sh.client.is_ready() || self.download.is_some() {
            return;
        }
        let (Some(e), Some(li)) = (self.entries.iter().copied().find(|e| e.session == session), self.log_info) else {
            return sh.warn("Download", format!("Flight {session} is not on the card."));
        };
        self.next_id += 1;
        self.download = Some(Download { id: self.next_id, entry: e, epoch: li.epoch, blocks: BTreeMap::new(), t0: Instant::now() });
        let mut pl = e.first_block.to_le_bytes().to_vec();
        pl.extend(e.blocks.to_le_bytes());
        sh.client.request_with_timeout(msg::LOG_READ, &pl, Purpose::LogRead { id: self.next_id }, LOG_TIMEOUT);
    }

    pub fn on_block(&mut self, id: u32, fr: &Frame) {
        let Some(d) = self.download.as_mut().filter(|d| d.id == id) else { return };
        if fr.payload.len() != 4 + emmc::BLOCK {
            return;
        }
        d.blocks.insert(p::u32_at(&fr.payload, 0), fr.payload[4..].to_vec());
    }

    pub fn cancel(&mut self, sh: &mut Shared) {
        if self.download.is_some() {
            sh.client.request(msg::LOG_ABORT, &[], Purpose::LogAbort);
        }
    }

    fn finish(&mut self, sh: &mut Shared, r: Result<(), String>) {
        let Some(d) = self.download.take() else { return };
        let e = d.entry;
        if let Err(err) = r {
            return sh.warn("Download", format!("Flight {}: download stopped ({err}). Nothing was saved.", e.session));
        }
        let missing: Vec<u32> = (e.first_block..e.first_block + e.blocks).filter(|i| !d.blocks.contains_key(i)).collect();
        if let Some(first) = missing.first() {
            return sh.warn(
                "Download",
                format!("Flight {}: {} blocks never arrived (first {first}). Nothing was saved; try again.", e.session, missing.len()),
            );
        }
        let uid = Self::uid(sh);
        let folder = sh.flights_root.join(format!("{} ({})", flight_title(&e), &uid[..uid.len().min(8)]));
        let meta = Meta {
            board_uid: uid,
            firmware: sh.client.info.as_ref().map(|i| i.fw_git.clone()).unwrap_or_default(),
            epoch: d.epoch,
            session: e.session,
            first_block: e.first_block,
            blocks: e.blocks,
            duration_ms: e.duration_ms,
            utc_start: e.utc_start,
            downloaded_utc: now_utc_iso(),
            format: "emmc_log.h layout 1, raw 512 B blocks in order".into(),
        };
        let save = || -> Result<Session, String> {
            std::fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
            let raw: Vec<u8> = d.blocks.values().flatten().copied().collect();
            std::fs::write(folder.join("flight.slg"), raw).map_err(|e| e.to_string())?;
            std::fs::write(folder.join("meta.json"), serde_json::to_string_pretty(&meta).unwrap()).map_err(|e| e.to_string())?;
            let (session, _) = load_folder(&folder)?;
            emmc::export_csv(&session, &folder, P0_PA).map_err(|e| e.to_string())?;
            Ok(session)
        };
        match save() {
            Err(err) => sh.warn("Download", format!("Flight {}: could not save to {}: {err}", e.session, folder.display())),
            Ok(session) => {
                self.downloaded.insert(e.session, folder.clone());
                self.fill(sh);
                self.show(session, folder);
            }
        }
    }

    fn show(&mut self, session: Session, folder: PathBuf) {
        self.plot_id += 1;
        let plot = plot_of(self.plot_id, &session);
        self.shown = Some(Shown { session, folder, plot });
    }

    /// Plot a flight of this card that is already on this computer.
    pub fn open_session(&mut self, sh: &mut Shared, session: u32) {
        match self.downloaded.get(&session).cloned() {
            Some(f) => self.open_folder(sh, &f),
            None => sh.warn("Open flight", format!("Flight {session} has not been downloaded to this computer.")),
        }
    }

    pub fn open_folder(&mut self, sh: &mut Shared, folder: &Path) {
        match load_folder(folder) {
            Ok((s, _)) => self.show(s, folder.to_path_buf()),
            Err(e) => sh.warn("Open flight", format!("{} is not a downloaded flight: {e}", folder.display())),
        }
    }

    pub fn reveal(&self, session: Option<u32>) {
        let folder = match session {
            Some(n) => self.downloaded.get(&n),
            None => self.shown.as_ref().map(|s| &s.folder),
        };
        if let Some(f) = folder {
            reveal(f);
        }
    }

    pub fn wipe(&mut self, sh: &mut Shared, confirm: &str) {
        if confirm.trim() != WIPE_WORD {
            return sh.warn("Wipe card", format!("Not wiped: type {WIPE_WORD} to confirm."));
        }
        if !sh.client.is_ready() || self.busy() {
            return sh.warn("Wipe card", "Not wiped: the board is not connected, or a download is running.");
        }
        sh.client.request_with_timeout(msg::LOG_WIPE, &p::WIPE_MAGIC.to_le_bytes(), Purpose::LogWipe, LOG_TIMEOUT);
    }

    pub fn view(&self, sh: &Shared) -> FlightsView {
        let ready = sh.client.is_ready();
        let busy = self.busy();
        let not_saved: Vec<String> =
            self.entries.iter().filter(|e| !self.downloaded.contains_key(&e.session)).map(|e| format!("#{}", e.session)).collect();
        let mut wipe_warning = format!("This makes all {} flights on the card unreadable. It cannot be undone.", self.entries.len());
        if !not_saved.is_empty() {
            wipe_warning.push_str(&format!(
                " {} of them have NOT been downloaded to this computer: {}.",
                not_saved.len(),
                not_saved.join(", ")
            ));
        }
        FlightsView {
            summary: if self.summary.is_empty() { "Not connected.".into() } else { self.summary.clone() },
            entries: self
                .entries
                .iter()
                .rev()
                .map(|e| EntryView {
                    session: e.session,
                    name: format!("#{}", e.session),
                    started: if e.utc_start != 0 { utc_text(e.utc_start as u64) } else { "no GPS fix".into() },
                    length: fmt_duration(e.duration_ms),
                    size: fmt_bytes(e.size_bytes()),
                    downloaded: self.downloaded.contains_key(&e.session),
                })
                .collect(),
            busy,
            can_refresh: ready && !busy,
            can_download: ready && !busy,
            can_wipe: ready && !busy && !self.entries.is_empty(),
            progress: self.download.as_ref().map(|d| {
                let n = d.blocks.len() as u32;
                let rate = n as f64 * emmc::BLOCK as f64 / d.t0.elapsed().as_secs_f64().max(1e-3);
                Progress {
                    fraction: n as f64 / d.entry.blocks.max(1) as f64,
                    text: format!("{n} / {} blocks  ({}/s)", d.entry.blocks, fmt_bytes(rate as u64)),
                }
            }),
            wipe_warning,
            wipe_word: WIPE_WORD.into(),
            shown: self.shown.as_ref().map(|s| {
                let mut warnings = Vec::new();
                if !s.session.config_recorded() {
                    warnings.push(("The accel and gyro scales are assumed: this session has no config record.".into(), Tone::Warn));
                }
                if !s.session.bad_blocks.is_empty() {
                    warnings.push((format!("{} blocks failed their check and were skipped.", s.session.bad_blocks.len()), Tone::Bad));
                }
                ShownView { plot_id: s.plot.id, detail: s.detail(), warnings, folder: s.folder.display().to_string() }
            }),
            root: sh.flights_root.display().to_string(),
        }
    }
}

fn describe_refusal(fr: &Frame) -> String {
    if fr.ty == msg::ACK {
        p::Ack::unpack(&fr.payload).map(|a| a.describe()).unwrap_or_else(|e| e)
    } else {
        format!("unexpected reply 0x{:02X}", fr.ty)
    }
}

/// Open a folder in Finder / Explorer / the file manager.
fn reveal(path: &Path) {
    let cmd = if cfg!(target_os = "macos") {
        "open"
    } else if cfg!(windows) {
        "explorer"
    } else {
        "xdg-open"
    };
    let _ = std::process::Command::new(cmd).arg(path).spawn();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decimation_keeps_spikes_and_order() {
        let mut pts: Vec<[f64; 2]> = (0..100_000).map(|i| [i as f64, 0.0]).collect();
        pts[54_321][1] = 9.0; // a one-sample spike
        pts[70_000][1] = -4.0;
        let d = decimate(&pts, 1000);
        assert!(d.len() <= 1000, "{}", d.len());
        assert!(d.iter().any(|p| p == &[54_321.0, 9.0]));
        assert!(d.iter().any(|p| p == &[70_000.0, -4.0]));
        assert!(d.windows(2).all(|w| w[0][0] < w[1][0]), "x stays increasing");
        assert_eq!(decimate(&pts[..10], 1000).len(), 10, "short series untouched");
    }
}
