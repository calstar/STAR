//! The backend over a WebSocket, for the browser tests (e2e/).
//!
//!   cargo run --example serve -- --port 5179
//!
//! Each connection gets its own backend, simulated board and temp folders, so
//! every test page starts from a fresh board. The page (`ui/`, served by Vite
//! with `?ws=5179`) makes the same calls it makes over Tauri IPC: `send`,
//! `view`, `flight_plot`; and gets the same `view` and `live` events. Native
//! file dialogs (`pick`) do not exist here.

use std::net::{TcpListener, TcpStream};
use std::sync::mpsc;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use star_fc::backend::{Backend, Command, Options, Sink};
use tungstenite::{Message, WebSocket};

struct ChannelSink(mpsc::Sender<String>);

impl Sink for ChannelSink {
    fn emit(&self, event: &str, payload: Value) {
        let _ = self.0.send(json!({ "event": event, "payload": payload }).to_string());
    }
}

fn reply(b: &Backend, method: &str, args: &Value) -> Result<Value, String> {
    match method {
        "send" => {
            let c: Command = serde_json::from_value(args["command"].clone()).map_err(|e| e.to_string())?;
            b.send(c);
            Ok(Value::Null)
        }
        "view" => Ok(serde_json::to_value(b.view()).unwrap()),
        "flight_plot" => Ok(serde_json::to_value(b.flight_plot()).unwrap()),
        "pick" => Err("no file dialogs in the test harness".into()),
        other => Err(format!("unknown method {other}")),
    }
}

fn session(mut stream: TcpStream) {
    // A plain GET (Playwright checking the server is up) gets a 200, not a handshake error.
    let mut head = [0u8; 2048];
    let n = stream.peek(&mut head).unwrap_or(0);
    if !String::from_utf8_lossy(&head[..n]).to_ascii_lowercase().contains("upgrade: websocket") {
        use std::io::Write;
        let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\nConnection: close\r\n\r\nok\n");
        return;
    }
    let mut ws: WebSocket<TcpStream> = match tungstenite::accept(stream) {
        Ok(ws) => ws,
        Err(e) => return eprintln!("handshake: {e}"),
    };
    ws.get_ref().set_read_timeout(Some(Duration::from_millis(10))).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let (tx, rx) = mpsc::channel();
    let b = Backend::start(
        Options { sim_flash: dir.path().join("flash.bin"), flights_root: dir.path().join("flights"), connect_sim: false },
        Arc::new(ChannelSink(tx)),
    );
    loop {
        match ws.read() {
            Ok(Message::Text(t)) => {
                let req: Value = serde_json::from_str(&t).unwrap_or_default();
                let out = match reply(&b, req["method"].as_str().unwrap_or(""), &req["args"]) {
                    Ok(v) => json!({ "id": req["id"], "ok": v }),
                    Err(e) => json!({ "id": req["id"], "err": e }),
                };
                if ws.send(Message::text(out.to_string())).is_err() {
                    break;
                }
            }
            Ok(Message::Close(_)) => break,
            Ok(_) => {}
            Err(tungstenite::Error::Io(e)) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => {}
            Err(_) => break,
        }
        while let Ok(ev) = rx.try_recv() {
            if ws.send(Message::text(ev)).is_err() {
                return;
            }
        }
    }
}

fn main() {
    let mut port = 5179u16;
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        if a == "--port" {
            port = args.next().and_then(|p| p.parse().ok()).expect("--port N");
        }
    }
    let listener = TcpListener::bind(("::1", port)).expect("bind");
    println!("backend on ws://[::1]:{port}");
    for stream in listener.incoming().flatten() {
        std::thread::spawn(move || session(stream));
    }
}
