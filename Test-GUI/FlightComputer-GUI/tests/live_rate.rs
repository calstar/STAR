//! How fast Live data reaches the window: the backend against the simulated
//! board, `live` batches timestamped as they are emitted.
//!
//!   cargo test --test live_rate -- --ignored --nocapture   (the table per rate)

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use star_fc::backend::live::{DEFAULT_RATE, PLOT_ACCEL, PLOT_BARO, PLOT_GNSS, PLOT_HIGHG, RATES};
use star_fc::backend::{Backend, Command, Options, Sink};
use star_fc::protocol::STREAM_ALL;

#[derive(Default)]
struct Stamps {
    /// (when emitted, points per chart)
    batches: Mutex<Vec<(Instant, [usize; 5])>>,
}

impl Sink for Stamps {
    fn emit(&self, event: &str, payload: serde_json::Value) {
        if event != "live" {
            return;
        }
        let mut n = [0; 5];
        for p in payload["points"].as_array().into_iter().flatten() {
            if p["y"].as_array().is_some_and(|y| y.iter().any(|v| v.is_f64())) {
                n[p["plot"].as_u64().unwrap() as usize] += 1;
            }
        }
        self.batches.lock().unwrap().push((Instant::now(), n));
    }
}

struct Rate {
    batches_per_s: f64,
    worst_gap_ms: f64,
    /// Points per second per chart: accel, high-g, baro, GNSS.
    points_per_s: [f64; 4],
}

fn start() -> (Backend, Arc<Stamps>, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let sink = Arc::new(Stamps::default());
    let b = Backend::start(
        Options { sim_flash: dir.path().join("flash.bin"), flights_root: dir.path().join("flights"), connect_sim: true },
        sink.clone(),
    );
    let end = Instant::now() + Duration::from_secs(10);
    while sink.batches.lock().unwrap().iter().all(|b| b.1[PLOT_ACCEL] == 0) {
        assert!(Instant::now() < end, "no live samples");
        std::thread::sleep(Duration::from_millis(10));
    }
    (b, sink, dir)
}

fn measure(b: &Backend, sink: &Stamps, rate: Option<u16>, secs: f64) -> Rate {
    if let Some(rate) = rate {
        b.send(Command::SetStream { rate, mask: STREAM_ALL });
    }
    std::thread::sleep(Duration::from_millis(500));
    let t0 = Instant::now();
    std::thread::sleep(Duration::from_secs_f64(secs));
    let all = sink.batches.lock().unwrap();
    let got: Vec<_> = all.iter().filter(|b| b.0 >= t0).collect();
    let span = got.last().unwrap().0.duration_since(got[0].0).as_secs_f64();
    let gaps = got.windows(2).map(|w| w[1].0.duration_since(w[0].0).as_secs_f64() * 1000.0);
    let per = |plot: usize| got.iter().map(|b| b.1[plot]).sum::<usize>() as f64 / secs;
    Rate {
        batches_per_s: (got.len() - 1) as f64 / span,
        worst_gap_ms: gaps.fold(0.0, f64::max),
        points_per_s: [per(PLOT_ACCEL), per(PLOT_HIGHG), per(PLOT_BARO), per(PLOT_GNSS)],
    }
}

/// At the default rate the window gets about every sample the board sends,
/// in batches frequent enough for smooth charts.
#[test]
fn the_default_rate_reaches_the_window() {
    let (b, sink, _dir) = start();
    let r = measure(&b, &sink, None, 2.0);
    let hz = DEFAULT_RATE as f64;
    assert!(r.points_per_s[0] > 0.7 * hz, "accel {:.1} points/s at {hz} Hz", r.points_per_s[0]);
    assert!(r.batches_per_s > 10.0, "{:.1} batches/s", r.batches_per_s);
}

#[test]
#[ignore = "a measurement: run with --ignored --nocapture"]
fn live_rates_table() {
    let (b, sink, _dir) = start();
    println!("\nrate   batches/s  worst gap   accel/s  high-g/s  baro/s  gnss/s");
    let rates = RATES.iter().filter(|&&r| r >= 10).map(|&r| Some(r));
    for rate in std::iter::once(None).chain(rates) {
        let r = measure(&b, &sink, rate, 3.0);
        let label = rate.map_or(format!("{DEFAULT_RATE}*"), |r| r.to_string());
        let [a, h, p, g] = r.points_per_s;
        println!("{label:>4}   {:>9.1}  {:>6.0} ms  {a:>8.1}  {h:>8.1}  {p:>6.1}  {g:>6.1}", r.batches_per_s, r.worst_gap_ms);
    }
}
