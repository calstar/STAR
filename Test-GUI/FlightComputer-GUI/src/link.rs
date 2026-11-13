//! The connection to one board: a reader thread plus request/reply bookkeeping.
//!
//! The link thread owns the transport: it reads, cuts frames, and sends them to
//! the UI thread over a channel; writes come in over another channel, so only
//! that thread touches the port. `Client` (UI thread) numbers requests, matches
//! replies by seq, and times them out.
//!
//! A request carries a `purpose` (the app's own enum) instead of a callback: the
//! reply comes back as `Event::Reply(purpose, result)` from `poll()`, and the app
//! decides what it means with full `&mut` access to itself. No callback has to
//! borrow the UI.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc::{self, Receiver, Sender, TryRecvError};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use crate::protocol::{self as p, msg, Frame, FrameReader};
use crate::transport::Transport;

pub const REQUEST_TIMEOUT: Duration = Duration::from_millis(1500);

pub type Waker = Arc<dyn Fn() + Send + Sync>;

enum LinkMsg {
    Opened,
    Frame(Frame),
    Failed(String),
}

struct LinkThread {
    handle: Option<JoinHandle<()>>,
    tx: Sender<Vec<u8>>,
    rx: Receiver<LinkMsg>,
    stop: Arc<AtomicBool>,
    good: Arc<AtomicU32>,
    bad: Arc<AtomicU32>,
}

impl LinkThread {
    fn spawn(mut transport: Box<dyn Transport>, waker: Option<Waker>) -> Self {
        let (tx, wrx) = mpsc::channel::<Vec<u8>>();
        let (etx, rx) = mpsc::channel::<LinkMsg>();
        let stop = Arc::new(AtomicBool::new(false));
        let good = Arc::new(AtomicU32::new(0));
        let bad = Arc::new(AtomicU32::new(0));
        let (stop2, good2, bad2) = (stop.clone(), good.clone(), bad.clone());
        let wake = move || {
            if let Some(w) = &waker {
                w()
            }
        };
        let handle = std::thread::Builder::new()
            .name("fc-link".into())
            .spawn(move || {
                if let Err(e) = transport.open() {
                    let _ = etx.send(LinkMsg::Failed(format!("Could not open the port: {e}")));
                    wake();
                    return;
                }
                let _ = etx.send(LinkMsg::Opened);
                wake();
                let mut reader = FrameReader::new();
                let mut run = || -> std::io::Result<()> {
                    while !stop2.load(Ordering::Relaxed) {
                        loop {
                            match wrx.try_recv() {
                                Ok(data) => transport.write(&data)?,
                                Err(TryRecvError::Empty) => break,
                                Err(TryRecvError::Disconnected) => return Ok(()),
                            }
                        }
                        let data = transport.read()?;
                        if data.is_empty() {
                            continue;
                        }
                        let frames = reader.feed(&data);
                        good2.store(reader.good_frames, Ordering::Relaxed);
                        bad2.store(reader.bad_frames, Ordering::Relaxed);
                        if !frames.is_empty() {
                            for f in frames {
                                let _ = etx.send(LinkMsg::Frame(f));
                            }
                            wake();
                        }
                    }
                    Ok(())
                };
                // unplugged mid-session lands here
                let res = run();
                transport.close();
                if let Err(e) = res {
                    let _ = etx.send(LinkMsg::Failed(format!("Link lost: {e}")));
                    wake();
                }
            })
            .expect("spawn link thread");
        Self { handle: Some(handle), tx, rx, stop, good, bad }
    }

    fn stop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(h) = self.handle.take() {
            let _ = h.join(); // every transport read returns within ~50 ms
        }
    }
}

impl Drop for LinkThread {
    fn drop(&mut self) {
        self.stop();
    }
}

struct Pending<P> {
    purpose: Option<P>, // None: the client's own HELLO
    deadline: Instant,
    streaming: bool, // LOG_READ: LOG_BLOCK frames come before the final ACK
}

pub enum Event<P> {
    Connected(p::Info),
    Disconnected(String),
    /// One row of the board's value table.
    Value(p::Value),
    Sample(u8, Vec<u8>),
    /// A receiver board heard this radio frame from the rocket.
    Radio(crate::radio::RadioRx),
    Text(String),
    /// The answer to a request: the reply frame, or why there is none (timeout).
    Reply(P, Result<Frame, String>),
    /// One LOG_BLOCK of a streaming request; the request is still open.
    Block(P, Frame),
}

pub struct Client<P> {
    link: Option<LinkThread>,
    pub info: Option<p::Info>,
    seq: u8,
    pending: HashMap<u8, Pending<P>>,
    events: Vec<Event<P>>,
    waker: Option<Waker>,
}

impl<P> Default for Client<P> {
    fn default() -> Self {
        Self { link: None, info: None, seq: 0, pending: HashMap::new(), events: Vec::new(), waker: None }
    }
}

impl<P: Clone> Client<P> {
    pub fn new() -> Self {
        Self::default()
    }

    /// Called from the link thread whenever something arrives (the app's repaint).
    pub fn set_waker(&mut self, w: Waker) {
        self.waker = Some(w);
    }

    pub fn is_open(&self) -> bool {
        self.link.is_some()
    }

    /// Open and HELLO'd: the board answered with a protocol version we speak.
    pub fn is_ready(&self) -> bool {
        self.link.is_some() && self.info.is_some()
    }

    pub fn frame_counts(&self) -> (u32, u32) {
        self.link.as_ref().map_or((0, 0), |l| (l.good.load(Ordering::Relaxed), l.bad.load(Ordering::Relaxed)))
    }

    pub fn open(&mut self, transport: Box<dyn Transport>) {
        self.close("reconnecting");
        self.link = Some(LinkThread::spawn(transport, self.waker.clone()));
    }

    /// Requests in flight are dropped, not failed: each would report an error
    /// for what is one event, and every tab already hears `Disconnected`.
    pub fn close(&mut self, reason: &str) {
        let Some(mut l) = self.link.take() else { return };
        l.stop();
        self.pending.clear();
        self.info = None;
        self.events.push(Event::Disconnected(reason.to_string()));
    }

    fn send(&mut self, ty: u8, payload: &[u8], purpose: Option<P>, timeout: Duration) {
        let Some(l) = &self.link else {
            if let Some(pp) = purpose {
                self.events.push(Event::Reply(pp, Err("not connected".into())));
            }
            return;
        };
        self.seq = self.seq % 255 + 1; // 1..255; 0 is the board's unsolicited seq
        let streaming = ty == msg::LOG_READ;
        self.pending.insert(self.seq, Pending { purpose, deadline: Instant::now() + timeout, streaming });
        let _ = l.tx.send(p::encode_frame(ty, self.seq, payload));
    }

    /// The reply comes back from `poll()` as `Event::Reply(purpose, ..)`.
    pub fn request(&mut self, ty: u8, payload: &[u8], purpose: P) {
        self.send(ty, payload, Some(purpose), REQUEST_TIMEOUT);
    }

    pub fn request_with_timeout(&mut self, ty: u8, payload: &[u8], purpose: P, timeout: Duration) {
        self.send(ty, payload, Some(purpose), timeout);
    }

    /// Everything that happened since the last call, in order.
    pub fn poll(&mut self) -> Vec<Event<P>> {
        let mut msgs = Vec::new();
        if let Some(l) = &self.link {
            while let Ok(m) = l.rx.try_recv() {
                msgs.push(m);
            }
        }
        for m in msgs {
            match m {
                LinkMsg::Opened => self.send(msg::HELLO, &[], None, REQUEST_TIMEOUT),
                LinkMsg::Failed(why) => self.close(&why),
                LinkMsg::Frame(f) => self.on_frame(f),
            }
            if self.link.is_none() {
                break;
            }
        }
        self.expire();
        std::mem::take(&mut self.events)
    }

    fn on_frame(&mut self, fr: Frame) {
        if fr.seq == 0 {
            match fr.ty {
                msg::VALUE => {
                    if let Ok(v) = p::Value::unpack(&fr.payload) {
                        self.events.push(Event::Value(v));
                    }
                }
                msg::SAMPLE if !fr.payload.is_empty() => self.events.push(Event::Sample(fr.payload[0], fr.payload[1..].to_vec())),
                msg::TEXT => self.events.push(Event::Text(String::from_utf8_lossy(&fr.payload).into_owned())),
                msg::RADIO_RX => {
                    if let Ok(r) = crate::radio::RadioRx::unpack(&fr.payload) {
                        self.events.push(Event::Radio(r));
                    }
                }
                _ => {}
            }
            return;
        }
        let Some(pend) = self.pending.get_mut(&fr.seq) else {
            return; // late reply to something that already timed out
        };
        if fr.ty == msg::LOG_BLOCK && pend.streaming {
            pend.deadline = Instant::now() + REQUEST_TIMEOUT; // still streaming
            if let Some(pp) = pend.purpose.clone() {
                self.events.push(Event::Block(pp, fr));
            }
            return;
        }
        let pend = self.pending.remove(&fr.seq).unwrap();
        match pend.purpose {
            Some(pp) => self.events.push(Event::Reply(pp, Ok(fr))),
            None => self.on_hello(fr),
        }
    }

    fn on_hello(&mut self, fr: Frame) {
        let info = match (fr.ty, p::Info::unpack(&fr.payload)) {
            (msg::INFO, Ok(i)) => i,
            _ => return self.close("The board's answer to HELLO was not an INFO frame"),
        };
        if info.protocol_version != p::PROTOCOL_VERSION {
            return self.close(&format!("Board speaks protocol v{}; this app speaks v{}", info.protocol_version, p::PROTOCOL_VERSION));
        }
        self.info = Some(info.clone());
        self.events.push(Event::Connected(info));
    }

    fn expire(&mut self) {
        let now = Instant::now();
        let late: Vec<u8> = self.pending.iter().filter(|(_, v)| now > v.deadline).map(|(k, _)| *k).collect();
        for seq in late {
            let pend = self.pending.remove(&seq).unwrap();
            match pend.purpose {
                Some(pp) => self.events.push(Event::Reply(pp, Err("timed out".into()))),
                None => {
                    self.close("No answer from the board (timed out). Is this the flight computer's port?");
                    return;
                }
            }
        }
    }
}
