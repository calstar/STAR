//! eMMC (or FC_CARD=1: SD NAND) on a real board: FC_PORT=/dev/cu.usbmodem… cargo test --test real_emmc -- --ignored --nocapture
//! Runs the card's write/read-back check (spare area only), lists the flights
//! and downloads the newest one, if any.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use star_fc::backend::{Backend, Command, Options, Sink};

#[derive(Default)]
struct S(Mutex<serde_json::Value>);
impl Sink for S {
    fn emit(&self, event: &str, p: serde_json::Value) {
        if event == "view" {
            *self.0.lock().unwrap() = p;
        }
    }
}

fn wait(s: &S, secs: u64, done: impl Fn(&serde_json::Value) -> bool) -> serde_json::Value {
    let end = Instant::now() + Duration::from_secs(secs);
    loop {
        let v = s.0.lock().unwrap().clone();
        if done(&v) || Instant::now() > end {
            return v;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

#[test]
#[ignore = "needs a board"]
fn real_board_emmc() {
    let port = std::env::var("FC_PORT").expect("FC_PORT");
    let dir = tempfile::tempdir().unwrap();
    let s = Arc::new(S::default());
    let b = Backend::start(Options { sim_flash: dir.path().join("f"), flights_root: std::env::var("FC_OUT").map(Into::into).unwrap_or(dir.path().join("fl")), connect_sim: false }, s.clone());
    std::thread::sleep(Duration::from_millis(1500));
    b.send(Command::SelectPort { port });
    b.send(Command::Connect);
    // FC_CARD=1: the SD NAND backup log instead of the eMMC.
    if let Some(card) = std::env::var("FC_CARD").ok().and_then(|c| c.parse().ok()) {
        std::thread::sleep(Duration::from_millis(1500));
        b.send(Command::FlightCard { card });
    }
    let v = wait(&s, 20, |v| {
        v["flights"]["can_check"].as_bool() == Some(true)
            && !v["flights"]["busy"].as_bool().unwrap_or(true)
            && v["flights"]["summary"].as_str().is_some_and(|t| t != "Not connected." && !t.contains("..."))
    });
    println!("link: {}", v["link"]["text"]);
    println!("summary: {}", v["flights"]["summary"]);
    for r in v["status"].to_string().split("},{") { if r.to_lowercase().contains("emmc") || r.contains("state") { println!("  {}", r.chars().take(200).collect::<String>()); } }
    b.send(Command::FlightCheckCard);
    let v = wait(&s, 30, |v| v["flights"]["card_check"].as_str().is_some_and(|t| !t.is_empty() && !t.contains("running")));
    println!("card check: {}", v["flights"]["card_check"]);
    let v = wait(&s, 10, |v| v["flights"]["summary"].as_str().is_some_and(|t| t.starts_with(if std::env::var("FC_CARD").is_ok_and(|c| c == "1") { "SD NAND" } else { "eMMC" }) || t.starts_with("Could not")));
    println!("list: {}", v["flights"]["summary"]);
    let entries = v["flights"]["entries"].as_array().cloned().unwrap_or_default();
    for e in &entries {
        println!("  {} | {} | {} | {}", e["name"], e["started"], e["length"], e["size"]);
    }
    if let Some(e) = entries.first() {
        b.send(Command::FlightDownload { session: e["session"].as_u64().unwrap() as u32 });
        std::thread::sleep(Duration::from_millis(500));
        let v = wait(&s, 120, |v| !v["flights"]["busy"].as_bool().unwrap_or(true));
        println!("after download: {}", v["flights"]["summary"]);
        for n in v["notices"].as_array().into_iter().flatten() {
            println!("notice: {} — {}", n["title"], n["text"]);
        }
        for f in walk(&std::env::var("FC_OUT").map(Into::into).unwrap_or(dir.path().join("fl"))) {
            let text = std::fs::read_to_string(&f).unwrap_or_default();
            println!("  {} : {} lines", f.display(), text.lines().count());
            if f.ends_with("session.txt") || f.ends_with("events.csv") {
                println!("{}", text.lines().take(12).collect::<Vec<_>>().join("\n"));
            }
        }
    }
    for n in s.0.lock().unwrap()["notices"].as_array().into_iter().flatten() {
        println!("notice: {} — {}", n["title"], n["text"]);
    }
}

fn walk(d: &std::path::Path) -> Vec<std::path::PathBuf> {
    let mut out = vec![];
    for e in std::fs::read_dir(d).into_iter().flatten().flatten() {
        let p = e.path();
        if p.is_dir() { out.extend(walk(&p)) } else { out.push(p) }
    }
    out
}
