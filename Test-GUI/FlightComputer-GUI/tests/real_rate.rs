//! Live rate from a real board: FC_PORT=/dev/cu.usbmodem… cargo test --test real_rate -- --ignored --nocapture

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use star_fc::backend::{Backend, Command, Options, Sink};
use star_fc::protocol::STREAM_ALL;

#[derive(Default)]
struct S(Mutex<Vec<(Instant, [usize; 5])>>, Mutex<String>);
impl Sink for S {
    fn emit(&self, event: &str, p: serde_json::Value) {
        if event == "view" {
            *self.1.lock().unwrap() = format!("{} | state {:?} | live {:?} | role {:?}", p["link"]["text"], p["state"], p["live"]["error"], { let t = p.to_string(); t.find("RECEIVER").map(|_| "RECEIVER").or(t.find("TRANSMITTER").map(|_| "TRANSMITTER")) });
            return;
        }
        let mut n = [0; 5];
        for q in p["points"].as_array().into_iter().flatten() {
            if q["y"].as_array().is_some_and(|y| y.iter().any(|v| v.is_f64())) {
                n[q["plot"].as_u64().unwrap() as usize] += 1;
            }
        }
        self.0.lock().unwrap().push((Instant::now(), n));
    }
}

#[test]
#[ignore = "needs a board"]
fn real_board_rate() {
    let port = std::env::var("FC_PORT").expect("FC_PORT");
    let dir = tempfile::tempdir().unwrap();
    let s = Arc::new(S::default());
    let b = Backend::start(Options { sim_flash: dir.path().join("f"), flights_root: dir.path().join("fl"), connect_sim: false }, s.clone());
    std::thread::sleep(Duration::from_millis(1500));
    b.send(Command::SelectPort { port });
    b.send(Command::Connect);
    std::thread::sleep(Duration::from_secs(4));
    println!("{}", s.1.lock().unwrap());
    for rate in [50u16, 200] {
        b.send(Command::SetStream { rate, mask: STREAM_ALL });
        std::thread::sleep(Duration::from_secs(1));
        let t0 = Instant::now();
        std::thread::sleep(Duration::from_secs(3));
        let all = s.0.lock().unwrap();
        let got: Vec<_> = all.iter().filter(|x| x.0 >= t0).collect();
        let per = |i: usize| got.iter().map(|x| x.1[i]).sum::<usize>() as f64 / 3.0;
        let gap = got.windows(2).map(|w| w[1].0.duration_since(w[0].0).as_millis()).max().unwrap_or(0);
        println!("{rate} Hz: batches/s {:.1}, worst gap {gap} ms, accel {:.0} gyro {:.0} highg {:.0} baro {:.0} gnss {:.0}", got.len() as f64 / 3.0, per(0), per(1), per(2), per(3), per(4));
    }
    println!("{}", s.1.lock().unwrap());
}
