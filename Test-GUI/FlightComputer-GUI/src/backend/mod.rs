//! The app's brain, with no GUI in it.
//!
//! A controller thread owns the link to the board and every rule: what may be
//! sent when, what a reply means, what each line of the window says. It takes
//! [`Command`]s and publishes a [`View`], a plain snapshot of everything the
//! window shows, already worded. The window (the Tauri webview, or a test)
//! renders the view and sends commands; it decides nothing. That keeps every
//! check here, where a stale or skipped frontend cannot get around it, and lets
//! the whole app run headless in tests.
//!
//! Two things stream past the view because they are bulky: live samples (the
//! `live` event, batched) and a flight's plot data (fetched by `plot_id`).
//!
//! Replies come back tagged with the [`Purpose`] they were sent for, so the
//! part of the controller that asked handles them with plain `&mut self`.

pub mod config;
pub mod flights;
pub mod format;
pub mod ground;
pub mod heartbeats;
pub mod live;
pub mod stages;
pub mod status;

use std::path::PathBuf;
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::config::Values;
use crate::link::{Client, Event};
use crate::protocol::{self as p, msg, Frame};
use crate::transport::{self, SerialTransport, SimTransport};
use format::Tone;

/// What a request was for: its reply is routed by this.
#[derive(Clone, Debug)]
pub enum Purpose {
    Status,
    Stream,
    ConfigRead {
        then_editor: bool,
    },
    ConfigSet {
        vals: Values,
        save: bool,
    },
    ConfigReadback {
        vals: Values,
        save: bool,
    },
    ConfigSave {
        vals: Values,
    },
    ConfigSavedReadback {
        vals: Values,
    },
    ConfigRevert,
    LogInfo {
        gen: u32,
    },
    LogSessions {
        gen: u32,
    },
    LogRead {
        id: u32,
    },
    LogAbort,
    LogWipe,
    /// RADIO_ARM / RADIO_UNARM to a receiver board.
    Ground,
}

/// Everything the window can ask for. Each is checked here before anything is
/// sent; a command that is not allowed right now becomes a notice, not a frame.
#[derive(Deserialize, Debug, Clone, PartialEq)]
#[serde(tag = "cmd", rename_all = "snake_case")]
pub enum Command {
    Rescan,
    SelectPort {
        port: String,
    },
    Connect,
    Disconnect,
    SetStream {
        rate: u16,
        mask: u8,
    },
    /// A field's text as typed (numbers parse here, frequency in MHz).
    ConfigEdit {
        key: String,
        text: String,
    },
    /// Flip one bit of a bitmask field (the GNSS constellations).
    ConfigToggle {
        key: String,
        bit: i64,
    },
    ConfigRead,
    ConfigApply,
    ConfigSave,
    ConfigRevert,
    ConfigDefaults,
    ConfigImport {
        path: PathBuf,
    },
    ConfigExport {
        path: PathBuf,
    },
    FlightsRefresh,
    FlightDownload {
        session: u32,
    },
    FlightCancel,
    /// Plot a downloaded flight of the connected board's card.
    FlightOpen {
        session: u32,
    },
    /// Plot a flight folder from disk.
    FlightOpenFolder {
        path: PathBuf,
    },
    /// Show a flight's folder in Finder / Explorer: this card's flight
    /// `session` if given, else the plotted one.
    FlightReveal {
        session: Option<u32>,
    },
    /// `confirm` must be exactly "WIPE".
    FlightWipe {
        confirm: String,
    },
    DismissNotice,
    /// Receiver board: Arm / Un-arm the rocket, retried until it shows it.
    GroundArm,
    GroundUnarm,
}

/// Where the controller sends what the window should know. The Tauri app emits
/// these as webview events; tests collect them.
pub trait Sink: Send + Sync {
    /// `"view"` with a [`View`], or `"live"` with a [`live::Batch`].
    fn emit(&self, event: &str, payload: serde_json::Value);
}

/// A message for the person at the bench, shown until dismissed.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Notice {
    pub title: String,
    pub text: String,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct PortView {
    pub dev: String,
    pub label: String,
}

#[derive(Serialize, Clone, Debug, PartialEq, Default)]
pub struct LinkView {
    pub open: bool,
    pub ready: bool,
    /// "Connected: COM5 · firmware abc123", or why not.
    pub text: String,
    pub heartbeat_lost: bool,
}

/// The whole window, worded. Rebuilt and compared every tick; emitted when it changes.
#[derive(Serialize, Clone, Debug, PartialEq, Default)]
pub struct View {
    pub ports: Vec<PortView>,
    pub port: String,
    pub link: LinkView,
    /// The flight state chip in the top bar.
    pub state: Option<(String, Tone)>,
    pub notices: Vec<Notice>,
    pub status: status::StatusView,
    /// The flight stages, for the Live tab's side panel.
    pub stages: Vec<stages::Stage>,
    pub live: live::LiveView,
    pub config: config::ConfigView,
    pub flights: flights::FlightsView,
    pub ground: ground::GroundView,
}

/// What every part may touch: the link, the notice queue, what the board said.
pub struct Shared {
    pub client: Client<Purpose>,
    pub notices: Vec<Notice>,
    /// The config the board reported as ACTIVE: live samples are scaled with it.
    pub active_config: Option<Values>,
    /// The board's value table, by row index (firmware gui_map.c).
    pub values: Vec<Option<p::Value>>,
    pub flights_root: PathBuf,
}

impl Shared {
    pub fn warn(&mut self, title: &str, text: impl Into<String>) {
        self.notices.push(Notice { title: title.into(), text: text.into() });
    }
    /// A row of the board's table, by its GUI name.
    pub fn value(&self, name: &str) -> Option<&p::Value> {
        self.values.iter().flatten().find(|v| v.name == name)
    }
    pub fn state(&self) -> Option<u8> {
        self.value("state").map(|v| v.number() as u8)
    }
    pub fn flags(&self) -> Option<u8> {
        self.value("flags").map(|v| v.number() as u8)
    }
    pub fn configurable(&self) -> bool {
        self.state().is_some_and(p::state::configurable)
    }
}

/// `Documents/STAR Flights`, or the home folder if there is no Documents.
pub fn default_flights_root() -> PathBuf {
    dirs::document_dir().or_else(dirs::home_dir).unwrap_or_else(|| PathBuf::from(".")).join("STAR Flights")
}

pub struct Options {
    /// The simulated board keeps its config flash in this file.
    pub sim_flash: PathBuf,
    /// Downloaded flights go here, one folder each.
    pub flights_root: PathBuf,
    /// Connect to the simulated board at start.
    pub connect_sim: bool,
}

impl Default for Options {
    fn default() -> Self {
        Self { sim_flash: std::env::temp_dir().join("star-fc-sim-flash.bin"), flights_root: default_flights_root(), connect_sim: false }
    }
}

const HEARTBEAT_LIMIT: Duration = Duration::from_secs(4);
const PORT_SCAN: Duration = Duration::from_secs(2);
/// The view is rebuilt at least this often (the watchdog needs it), and the
/// live batch is flushed this often.
const TICK: Duration = Duration::from_millis(50);

/// The controller's state. Lives on its own thread; `Backend` is the handle.
pub struct Controller {
    pub sh: Shared,
    pub live: live::LiveState,
    pub heartbeats: heartbeats::Heartbeats,
    pub config: config::ConfigState,
    pub flights: flights::FlightsState,
    pub ground: ground::GroundState,
    pub messages: std::collections::VecDeque<String>,
    pub ports: Vec<(String, String)>,
    pub port: String,
    pub conn: String,
    sim_flash: PathBuf,
    last_heartbeat: Instant,
    last_scan: Instant,
}

impl Controller {
    pub fn new(opts: &Options) -> Self {
        let mut c = Self {
            sh: Shared {
                client: Client::new(),
                notices: Vec::new(),
                active_config: None,
                values: Vec::new(),
                flights_root: opts.flights_root.clone(),
            },
            live: live::LiveState::new(),
            heartbeats: heartbeats::Heartbeats::default(),
            config: config::ConfigState::new(),
            flights: flights::FlightsState::default(),
            ground: ground::GroundState::default(),
            messages: Default::default(),
            ports: Vec::new(),
            port: String::new(),
            conn: "Not connected".into(),
            sim_flash: opts.sim_flash.clone(),
            last_heartbeat: Instant::now(),
            last_scan: Instant::now(),
        };
        c.rescan();
        c
    }

    pub fn rescan(&mut self) {
        self.last_scan = Instant::now();
        self.ports = transport::list_ports();
        if !self.ports.iter().any(|(d, _)| *d == self.port) {
            self.port = self.ports.first().map(|p| p.0.clone()).unwrap_or_default();
        }
    }

    fn port_label(&self, dev: &str) -> String {
        match self.ports.iter().find(|(d, _)| d == dev) {
            Some((d, desc)) if d == transport::SIM_PORT => desc.clone(),
            Some((d, desc)) => format!("{d} — {desc}"),
            None => dev.to_string(),
        }
    }

    pub fn connect(&mut self, dev: &str) {
        if self.sh.client.is_open() {
            return;
        }
        self.port = dev.to_string();
        let t: Box<dyn transport::Transport> = if dev == transport::SIM_PORT {
            Box::new(SimTransport::new(Some(self.sim_flash.clone())))
        } else {
            Box::new(SerialTransport::new(dev))
        };
        self.conn = format!("Connecting to {}…", self.port_label(dev));
        self.sh.client.open(t);
    }

    pub fn command(&mut self, c: Command) {
        use Command::*;
        let ready = self.sh.client.is_ready();
        match c {
            Rescan => self.rescan(),
            SelectPort { port } => {
                if !self.sh.client.is_open() && self.ports.iter().any(|(d, _)| *d == port) {
                    self.port = port;
                }
            }
            Connect => {
                if !self.port.is_empty() {
                    let dev = self.port.clone();
                    self.connect(&dev);
                }
            }
            Disconnect => self.sh.client.close("disconnected by you"),
            SetStream { rate, mask } => self.live.set_stream(&mut self.sh, rate, mask),
            ConfigEdit { key, text } => self.config.edit(&key, &text),
            ConfigToggle { key, bit } => self.config.toggle(&key, bit),
            ConfigRead => {
                if ready {
                    self.config.read_board(&mut self.sh, true)
                }
            }
            ConfigApply => self.config.apply(&mut self.sh, false),
            ConfigSave => self.config.apply(&mut self.sh, true),
            ConfigRevert => self.config.revert(&mut self.sh),
            ConfigDefaults => self.config.set_editor(crate::config::defaults()),
            ConfigImport { path } => self.config.import(&mut self.sh, &path),
            ConfigExport { path } => self.config.export(&mut self.sh, &path),
            FlightsRefresh => {
                if ready && !self.flights.busy() {
                    self.flights.refresh(&mut self.sh)
                }
            }
            FlightDownload { session } => self.flights.download(&mut self.sh, session),
            FlightCancel => self.flights.cancel(&mut self.sh),
            FlightOpen { session } => self.flights.open_session(&mut self.sh, session),
            FlightOpenFolder { path } => self.flights.open_folder(&mut self.sh, &path),
            FlightReveal { session } => self.flights.reveal(session),
            FlightWipe { confirm } => self.flights.wipe(&mut self.sh, &confirm),
            GroundArm | GroundUnarm => {
                if ready && self.receiver() {
                    self.ground.command(&mut self.sh, c == GroundArm)
                }
            }
            DismissNotice => {
                if !self.sh.notices.is_empty() {
                    self.sh.notices.remove(0);
                }
            }
        }
    }

    /// Drain the link and route what came in.
    pub fn tick(&mut self) {
        // A board plugged in (or flashed) after the app started shows up on its own.
        if self.last_scan.elapsed() > PORT_SCAN {
            self.rescan();
        }
        for ev in self.sh.client.poll() {
            match ev {
                Event::Connected(info) => {
                    self.last_heartbeat = Instant::now();
                    self.conn = format!("Connected: {}  ·  firmware {}", self.port_label(&self.port), info.fw_git);
                    self.live.restart();
                    self.heartbeats.clear();
                    self.ground.clear();
                    self.sh.client.request(msg::GET_STATUS, &[], Purpose::Status);
                    self.live.push_stream(&mut self.sh);
                    self.config.read_board(&mut self.sh, true);
                    self.flights.refresh(&mut self.sh);
                }
                Event::Disconnected(why) => {
                    self.conn = format!("Not connected ({why})");
                    self.sh.active_config = None;
                    self.sh.values.clear();
                    self.config.on_disconnected();
                    self.flights.on_disconnected(&mut self.sh);
                }
                Event::Value(v) => {
                    self.last_heartbeat = Instant::now();
                    let (i, n) = (v.index as usize, v.count as usize);
                    self.sh.values.resize(n, None); // a table that changed size drops the rows past it
                    self.sh.values[i] = Some(v);
                    if i + 1 == n {
                        self.heartbeats.on_round(&self.sh);
                    }
                }
                Event::Sample(t, d) => self.live.on_sample(&self.sh, t, &d),
                Event::Radio(r) => self.ground.on_radio(&self.sh, &mut self.live, r),
                Event::Text(line) => {
                    if self.messages.len() == status::TEXT_LINES {
                        self.messages.pop_front();
                    }
                    self.messages.push_back(line);
                }
                Event::Reply(purpose, res) => self.route(purpose, res),
                Event::Block(Purpose::LogRead { id }, fr) => self.flights.on_block(id, &fr),
                Event::Block(..) => {}
            }
        }
        self.ground.tick(&mut self.sh); // Arm/Un-arm: confirmed yet, or send again
    }

    fn route(&mut self, purpose: Purpose, res: Result<Frame, String>) {
        use Purpose::*;
        match purpose {
            Status => {}
            Stream => self.live.on_stream_reply(res),
            ConfigRead { .. }
            | ConfigSet { .. }
            | ConfigReadback { .. }
            | ConfigSave { .. }
            | ConfigSavedReadback { .. }
            | ConfigRevert => self.config.on_reply(&mut self.sh, purpose, res),
            LogInfo { .. } | LogSessions { .. } | LogRead { .. } | LogAbort | LogWipe => self.flights.on_reply(&mut self.sh, purpose, res),
            Ground => self.ground.on_reply(&mut self.sh, res),
        }
    }

    pub fn heartbeat_lost(&self) -> bool {
        self.sh.client.is_ready() && self.last_heartbeat.elapsed() > HEARTBEAT_LIMIT
    }

    pub fn view(&self) -> View {
        let lost = self.heartbeat_lost();
        View {
            ports: self.ports.iter().map(|(d, _)| PortView { dev: d.clone(), label: self.port_label(d) }).collect(),
            port: self.port.clone(),
            link: LinkView {
                open: self.sh.client.is_open(),
                ready: self.sh.client.is_ready(),
                text: if lost { "No heartbeat from the board for 4 s".into() } else { self.conn.clone() },
                heartbeat_lost: lost,
            },
            state: self.sh.value("state").and_then(|v| v.label()).map(|l| (l.replace('_', " "), format::label_tone(l))),
            notices: self.sh.notices.clone(),
            status: status::view(&self.sh, &self.messages),
            stages: stages::stages(self.sh.state()),
            live: self.live_view(),
            config: self.config.view(&self.sh),
            flights: self.flights.view(&self.sh),
            ground: self.ground.view(self.receiver()),
        }
    }

    /// SELF_TEST and IDLE show the heartbeats; graphs from ARMED on, or
    /// whenever samples arrive (the bench build, the simulated board).
    fn live_view(&self) -> live::LiveView {
        // A receiver's Live tab is the rocket's telemetry, not its own heartbeats.
        let quiet = !self.receiver() && self.sh.state().is_some_and(|s| s == p::state::SELF_TEST || s == p::state::IDLE);
        live::LiveView {
            heartbeats: quiet.then(|| self.heartbeats.rows()),
            show_graphs: !quiet || self.live.receiving(),
            ..self.live.view()
        }
    }

    /// The connected board's role (its "role" row) is the receiver.
    fn receiver(&self) -> bool {
        self.sh.value("role").and_then(|v| v.label()) == Some("RECEIVER")
    }

    pub fn shutdown(&mut self) {
        self.sh.client.close("closing");
    }
}

enum Msg {
    Cmd(Command),
    Wake,
    Stop,
}

/// The handle the window holds. Dropping it stops the controller and closes the port.
pub struct Backend {
    tx: Sender<Msg>,
    view: Arc<Mutex<View>>,
    plot: Arc<Mutex<Option<flights::FlightPlot>>>,
    thread: Option<JoinHandle<()>>,
}

impl Backend {
    pub fn start(opts: Options, sink: Arc<dyn Sink>) -> Self {
        let (tx, rx) = mpsc::channel::<Msg>();
        let view = Arc::new(Mutex::new(View::default()));
        let plot = Arc::new(Mutex::new(None));
        let (view2, plot2, wake_tx) = (view.clone(), plot.clone(), tx.clone());
        let thread = std::thread::Builder::new()
            .name("fc-controller".into())
            .spawn(move || {
                let mut c = Controller::new(&opts);
                c.sh.client.set_waker(Arc::new(move || {
                    let _ = wake_tx.send(Msg::Wake);
                }));
                if opts.connect_sim {
                    c.connect(transport::SIM_PORT);
                }
                let mut last = View::default();
                let mut last_build = Instant::now() - TICK;
                let mut last_flush = Instant::now();
                let mut plot_id = 0;
                loop {
                    // A command's effect shows at once; otherwise the view is
                    // rebuilt at most every TICK (frames can arrive at hundreds a second).
                    let mut urgent = false;
                    match rx.recv_timeout(TICK) {
                        Ok(Msg::Stop) | Err(RecvTimeoutError::Disconnected) => break,
                        Ok(Msg::Cmd(cmd)) => {
                            c.command(cmd);
                            urgent = true;
                        }
                        Ok(Msg::Wake) | Err(RecvTimeoutError::Timeout) => {}
                    }
                    c.tick();
                    if c.flights.plot_id() != plot_id {
                        plot_id = c.flights.plot_id();
                        *plot2.lock().unwrap() = c.flights.plot();
                        urgent = true;
                    }
                    if urgent || last_build.elapsed() >= TICK {
                        last_build = Instant::now();
                        let v = c.view();
                        if v != last {
                            *view2.lock().unwrap() = v.clone();
                            sink.emit("view", serde_json::to_value(&v).expect("view serialises"));
                            last = v;
                        }
                    }
                    if last_flush.elapsed() >= TICK {
                        last_flush = Instant::now();
                        if let Some(b) = c.live.take_batch() {
                            sink.emit("live", serde_json::to_value(&b).expect("batch serialises"));
                        }
                    }
                }
                c.shutdown();
            })
            .expect("spawn controller");
        Self { tx, view, plot, thread: Some(thread) }
    }

    pub fn send(&self, c: Command) {
        let _ = self.tx.send(Msg::Cmd(c));
    }

    /// The latest view (what was last emitted).
    pub fn view(&self) -> View {
        self.view.lock().unwrap().clone()
    }

    /// The plotted flight's data; its `id` matches `view.flights.shown.plot_id`.
    pub fn flight_plot(&self) -> Option<flights::FlightPlot> {
        self.plot.lock().unwrap().clone()
    }

    pub fn stop(&mut self) {
        let _ = self.tx.send(Msg::Stop);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

impl Drop for Backend {
    fn drop(&mut self) {
        self.stop();
    }
}
