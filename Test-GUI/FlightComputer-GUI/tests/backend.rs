//! The whole app minus the webview, against the simulated board.
//!
//! The backend is where every rule lives and the window only renders its view,
//! so these drive it exactly as the window does (commands in, `view` and `live`
//! events out): the link thread, the controller, a flight download to disk and
//! a config save through to the board's flash. The browser tests (e2e/) check
//! the window draws the view and sends the right commands.

use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use star_fc::backend::format::Tone;
use star_fc::backend::live::PLOT_ACCEL;
use star_fc::backend::{Backend, Command, Options, Sink, View};
use star_fc::fake_board::{monotonic, FakeBoard};

#[derive(Default)]
struct Collect {
    live: Mutex<Vec<serde_json::Value>>,
    views: Mutex<u32>,
}

impl Sink for Collect {
    fn emit(&self, event: &str, payload: serde_json::Value) {
        match event {
            "live" => self.live.lock().unwrap().push(payload),
            "view" => *self.views.lock().unwrap() += 1,
            other => panic!("unexpected event {other}"),
        }
    }
}

struct Rig {
    b: Backend,
    sink: Arc<Collect>,
    dir: tempfile::TempDir,
}

impl Rig {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let sink = Arc::new(Collect::default());
        let b = Backend::start(
            Options { sim_flash: dir.path().join("flash.bin"), flights_root: dir.path().join("flights"), connect_sim: true },
            sink.clone(),
        );
        let r = Self { b, sink, dir };
        assert!(r.wait(10.0, |v| v.link.ready && v.state.as_ref().is_some_and(|s| s.0 == "IDLE")), "{:?}", r.b.view().link);
        r
    }

    /// Wait until the view satisfies `until`, or `secs` pass.
    fn wait(&self, secs: f64, until: impl Fn(&View) -> bool) -> bool {
        let end = Instant::now() + Duration::from_secs_f64(secs);
        while Instant::now() < end {
            if until(&self.b.view()) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        until(&self.b.view())
    }

    fn send(&self, c: Command) {
        self.b.send(c);
    }

    fn field(&self, key: &str) -> star_fc::backend::config::FieldView {
        self.b.view().config.groups.into_iter().flat_map(|g| g.fields).find(|f| f.key == key).unwrap()
    }
}

impl Drop for Rig {
    fn drop(&mut self) {
        let notices = self.b.view().notices;
        self.b.stop();
        if !std::thread::panicking() {
            assert!(notices.is_empty(), "unexpected notices: {notices:?}");
        }
    }
}

#[test]
fn status_and_live() {
    let r = Rig::new();
    // The Status tab is the board's value table, shown as sent (gui_map.c).
    let st = r.b.view().status;
    assert_eq!(st.self_test.len(), 8);
    assert!(st.self_test.iter().all(|row| row.value != "—"));
    let rows: Vec<_> = st.sections.iter().flat_map(|s| s.rows.iter()).collect();
    let find = |name: &str| rows.iter().find(|r| r.name == name).unwrap_or_else(|| panic!("{name}"));
    assert_eq!((find("State").value.as_str(), find("State").chip), ("IDLE", Some(Tone::Good)));
    // The simulated board reads 7890-7909 mV, shown in volts.
    let battery = find("Battery");
    let volts: f64 = battery.value.strip_suffix(" V").and_then(|v| v.parse().ok()).unwrap_or_else(|| panic!("{}", battery.value));
    assert!((7.85..=7.95).contains(&volts), "{}", battery.value);
    assert_eq!((find("Battery state").value.as_str(), find("Battery state").chip), ("OK", Some(Tone::Good)));
    assert_eq!(find("Gnss satellites").value, "11", "a row the app has no code for is still shown");
    // Samples are scaled with the ACTIVE config: a resting board reads ~1 g.
    let az = || -> Option<f64> {
        let live = r.sink.live.lock().unwrap();
        live.iter()
            .rev()
            .filter_map(|v| serde_json::from_value::<serde_json::Value>(v.clone()).ok())
            .flat_map(|v| v["points"].as_array().cloned().unwrap_or_default())
            .find(|p| p["plot"] == PLOT_ACCEL)
            .and_then(|p| p["y"][2].as_f64())
    };
    let end = Instant::now() + Duration::from_secs(10);
    while az().is_none() && Instant::now() < end {
        std::thread::sleep(Duration::from_millis(20));
    }
    let az = az().expect("live accel samples");
    assert!((az - 1.0).abs() < 0.1, "resting board reads ~1 g, got {az}");
    // Stream off: the board stops (it says so in its stream_rate_hz row).
    r.send(Command::SetStream { rate: 0, mask: 0x0F });
    assert!(r.wait(5.0, |v| v.status.sections[0].rows.iter().any(|r| r.name == "Stream rate hz" && r.value == "0 Hz")));
    assert!(*r.sink.views.lock().unwrap() > 0);
}

#[test]
fn idle_shows_its_heartbeats_newest_first() {
    let r = Rig::new();
    // The simulated board counts a heartbeat every 10 s from its start, as the firmware does.
    assert!(r.wait(15.0, |v| v.live.heartbeats.as_ref().is_some_and(|h| h.len() >= 2)), "{:?}", r.b.view().live.heartbeats);
    let rows = r.b.view().live.heartbeats.unwrap();
    assert!(rows[0].n > rows[1].n, "newest first");
    assert_eq!(rows[0].chips, "6 of 8 pass"); // Ethernet not configured, NAND not implemented
    assert!(r.b.view().live.show_graphs, "the simulated board streams in IDLE, so its graphs stay");
}

#[test]
fn ground_arms_the_rocket_retrying_until_it_shows_it() {
    let r = Rig::new();
    // Role = receiver (on the board it takes a reboot; the simulator switches at once).
    r.send(Command::ConfigEdit { key: "role".into(), text: "1".into() });
    r.send(Command::ConfigApply);
    assert!(r.wait(5.0, |v| v.ground.show), "a receiver shows the Ground tab");
    assert!(r.wait(5.0, |v| v.ground.chips.len() == 8), "the rocket's Status report arrives");
    let g = r.b.view().ground;
    assert_eq!(g.rocket.as_ref().map(|x| x.0.as_str()), Some("IDLE"));
    assert_eq!((g.chips[0].value.as_str(), g.chips[0].expected.as_str()), ("0x6B (WHO_AM_I)", "0x6B"));
    assert_eq!(g.chips[3].when, "boot", "the W5500 is held in reset in Idle");
    assert_eq!(g.adc[0].value, "5.03 V supply", "VBAT 31000 counts: battery_counts_to_mv gives 5025.6 mV");
    // The simulated rocket never hears the first Arm: the app sends again.
    r.send(Command::GroundArm);
    assert!(r.wait(15.0, |v| v.ground.command.starts_with("Armed")), "{}", r.b.view().ground.command);
    assert!(r.b.view().ground.command.contains("after 2 tries"), "{}", r.b.view().ground.command);
    assert!(r.wait(5.0, |v| v.live.show_graphs), "the rocket's telemetry draws the Live graphs");
    r.send(Command::GroundUnarm);
    assert!(r.wait(10.0, |v| v.ground.command.starts_with("Un-armed")), "{}", r.b.view().ground.command);
    assert_eq!(r.b.view().ground.log[0].kind, "Status", "newest first: the Idle report after the heartbeat");
}

#[test]
fn download_a_flight() {
    let r = Rig::new();
    assert!(r.wait(10.0, |v| v.flights.entries.len() == 2));
    let v = r.b.view();
    assert_eq!(v.flights.entries[0].name, "#2", "newest first");
    assert!(v.flights.can_download);
    r.send(Command::FlightDownload { session: 2 }); // flight 2 has a config record
    assert!(r.wait(30.0, |v| v.flights.entries.iter().any(|e| e.session == 2 && e.downloaded)), "{}", r.b.view().flights.summary);
    let shown = r.b.view().flights.shown.expect("the downloaded flight is plotted");
    let folder = Path::new(&shown.folder);
    assert!(folder.starts_with(r.dir.path().join("flights")));
    for name in ["flight.slg", "meta.json", "imu.csv", "highg.csv", "baro.csv", "gnss.csv", "events.csv", "session.txt"] {
        assert!(folder.join(name).metadata().map(|m| m.len() > 0).unwrap_or(false), "{name}");
    }
    assert!(shown.warnings.is_empty(), "flight 2 is scaled with its own config record: {:?}", shown.warnings);
    let plot = r.b.flight_plot().expect("plot data");
    assert_eq!(plot.id, shown.plot_id);
    assert!(plot.charts.iter().all(|c| c.lines.iter().all(|l| !l.x.is_empty() && l.x.len() == l.y.len())));
    assert!(!plot.events.is_empty());

    // Flight 1 has no config record: plotted, but with the warning.
    r.send(Command::FlightDownload { session: 1 });
    assert!(r.wait(30.0, |v| v.flights.shown.as_ref().is_some_and(|s| s.plot_id != shown.plot_id)));
    assert!(r.b.view().flights.shown.unwrap().warnings[0].0.contains("assumed"));
}

#[test]
fn config_save_survives_reboot() {
    let r = Rig::new();
    assert!(r.wait(10.0, |v| v.config.can_write));
    r.send(Command::ConfigEdit { key: "radio_sf".into(), text: "10".into() });
    r.send(Command::ConfigEdit { key: "imu_accel_fs_g".into(), text: "8".into() });
    r.send(Command::ConfigEdit { key: "radio_freq_hz".into(), text: "903.5".into() });
    assert!(r.wait(5.0, |_| r.field("radio_sf").differs));
    r.send(Command::ConfigSave);
    assert!(r.wait(10.0, |v| v.config.banner.starts_with("Saved.")), "{}", r.b.view().config.banner);
    assert!(!r.field("radio_sf").differs, "the board now runs what was sent");
    assert_eq!(r.field("radio_freq_hz").board.as_deref(), Some("903.500 MHz"));
    // A power cycle: a new board reading the same flash file.
    let b = FakeBoard::new(Some(r.dir.path().join("flash.bin")), monotonic());
    assert_eq!(b.active["imu_accel_fs_g"], 8);
    assert_eq!(b.active["radio_sf"], 10);
    assert_eq!(b.active["radio_freq_hz"], 903_500_000);
}

#[test]
fn bad_value_is_refused_here() {
    let r = Rig::new();
    assert!(r.wait(10.0, |v| v.config.can_write));
    // An SF12 heartbeat takes far longer than 100 ms on air.
    r.send(Command::ConfigEdit { key: "radio_sf".into(), text: "12".into() });
    r.send(Command::ConfigEdit { key: "hb_flight_ms".into(), text: "100".into() });
    assert!(r.wait(5.0, |v| !v.config.can_write));
    assert!(r.b.view().config.issues.iter().any(|i| i.contains("longer than")));
    // A window that sends Apply anyway (stale, or skipped the greyed button)
    // gets a notice; nothing reaches the board.
    r.send(Command::ConfigApply);
    assert!(r.wait(5.0, |v| v.notices.iter().any(|n| n.text.contains("Not sent"))));
    r.send(Command::DismissNotice);
    assert!(r.wait(5.0, |v| v.notices.is_empty()));
    assert!(r.field("radio_sf").board.as_deref() != Some("SF12"), "the board never got it");
    assert!(r.field("radio_sf").differs);
}

#[test]
fn wipe_needs_the_word() {
    let r = Rig::new();
    assert!(r.wait(10.0, |v| v.flights.entries.len() == 2 && v.flights.can_wipe));
    r.send(Command::FlightWipe { confirm: "wipe".into() });
    assert!(r.wait(5.0, |v| v.notices.iter().any(|n| n.text.contains("type WIPE"))));
    r.send(Command::DismissNotice);
    assert_eq!(r.b.view().flights.entries.len(), 2, "nothing wiped");
    assert!(r.b.view().flights.wipe_warning.contains("NOT been downloaded"));
    r.send(Command::FlightWipe { confirm: "WIPE".into() });
    assert!(r.wait(10.0, |v| v.flights.entries.is_empty()), "{}", r.b.view().flights.summary);
}

/// Turning a sensor off and on leaves a gap in its chart: the first point after
/// it comes back is preceded by a break, not joined to the last one before.
#[test]
fn a_sensor_turned_back_on_resumes_after_a_gap() {
    use star_fc::protocol::{STREAM_ALL, STREAM_IMU};
    let r = Rig::new();
    let accel = || -> Vec<serde_json::Value> {
        let live = r.sink.live.lock().unwrap();
        live.iter().flat_map(|v| v["points"].as_array().cloned().unwrap_or_default()).filter(|p| p["plot"] == PLOT_ACCEL).collect()
    };
    let wait_for = |n: usize| {
        let end = Instant::now() + Duration::from_secs(10);
        while accel().len() < n && Instant::now() < end {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(accel().len() >= n, "accel points");
    };
    wait_for(3);
    assert!(accel().iter().all(|p| p["y"].as_array().unwrap().iter().all(|y| y.is_f64())), "no break while it streams");
    r.send(Command::SetStream { rate: 10, mask: STREAM_ALL & !STREAM_IMU });
    std::thread::sleep(Duration::from_millis(600));
    // Its reading boxes fade (the last values stay); the others do not.
    let stale = |label: &str| -> Option<bool> {
        let live = r.sink.live.lock().unwrap();
        let rs = live.last()?["readings"].as_array()?.clone();
        rs.iter().find(|x| x["label"] == label)?["stale"].as_bool()
    };
    assert_eq!(stale("Accel (IMU)"), Some(true));
    assert_eq!(stale("Pressure"), Some(false));
    let before = accel().len();
    r.send(Command::SetStream { rate: 10, mask: STREAM_ALL });
    wait_for(before + 3);
    let pts = accel();
    let breaks: Vec<usize> = (0..pts.len()).filter(|&i| pts[i]["y"].as_array().unwrap().iter().all(|y| y.is_null())).collect();
    assert_eq!(breaks.len(), 1, "one break, where IMU came back");

    let i = breaks[0];
    assert!(i >= before && i > 0, "the break is after what came before the gap");
    let t = |j: usize| pts[j]["t"].as_f64().unwrap();
    assert!(t(i - 1) < t(i) && t(i) < t(i + 1), "the break sits inside the gap");
}
