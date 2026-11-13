//! The app's frame code against the firmware's own (src/app/usb_frame.c,
//! compiled here via tests/c/usb_frame_io.c), both ways, so the two cannot
//! drift apart while each passes its own tests.
//!
//! Skipped without a C compiler or the firmware sources, unless
//! FC_REQUIRE_FIRMWARE_TEST=1 (CI sets it on Linux and macOS).

use std::path::{Path, PathBuf};
use std::process::Command;

use star_fc::config::{self, by_key, defaults, fields};
use star_fc::protocol::{decode_frame, encode_frame, Value};
use star_fc::radio::{Status, Telemetry};

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn unhex(s: &str) -> Vec<u8> {
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
}

/// The payloads usb_frame_io.c encodes, in its order (after the VALUE row).
fn payloads() -> Vec<(u8, Vec<u8>)> {
    vec![(0xB0, (0..600).map(|i| (i % 7) as u8).collect()), (0xB0, vec![0xAB; 300]), (0x7F, vec![])]
}

fn firmware_io() -> Option<PathBuf> {
    let here = Path::new(env!("CARGO_MANIFEST_DIR"));
    let src = here.join("../../firmware/Flight_Computer/src/app");
    let cc = ["gcc", "clang", "cc"].into_iter().find(|c| Command::new(c).arg("--version").output().is_ok_and(|o| o.status.success()));
    let why = match (src.join("usb_frame.c").exists(), cc) {
        (false, _) => "firmware sources not found",
        (true, None) => "no C compiler",
        (true, Some(cc)) => {
            let dir = tempfile::tempdir().unwrap().keep();
            let exe = dir.join(if cfg!(windows) { "usb_frame_io.exe" } else { "usb_frame_io" });
            let st = Command::new(cc)
                .args(["-std=c11", "-O1", "-o"])
                .arg(&exe)
                .arg(here.join("tests/c/usb_frame_io.c"))
                .arg(src.join("usb_frame.c"))
                .arg(src.join("fc_config.c"))
                .arg(src.join("emmc_log.c"))
                .arg(src.join("flight_state.c"))
                .arg(src.join("status_report.c"))
                .arg("-I")
                .arg(&src)
                .status()
                .expect("run the C compiler");
            assert!(st.success(), "compiling usb_frame_io.c failed");
            return Some(exe);
        }
    };
    assert!(std::env::var("FC_REQUIRE_FIRMWARE_TEST").as_deref() != Ok("1"), "usb frame test cannot run: {why}");
    eprintln!("SKIPPED: {why}");
    None
}

fn run(exe: &Path, args: &[&str]) -> String {
    let out = Command::new(exe).args(args).output().expect("run usb_frame_io");
    assert!(out.status.success());
    String::from_utf8(out.stdout).unwrap()
}

#[test]
fn firmware_frames_decode_here_and_ours_decode_there() {
    let Some(exe) = firmware_io() else { return };
    let lines: Vec<Vec<u8>> = run(&exe, &["encode"]).lines().map(unhex).collect();
    assert_eq!(lines.len(), 4);
    // The firmware's frames, read by the app.
    let value = decode_frame(&lines[0][..lines[0].len() - 1]).unwrap();
    assert_eq!((value.ty, value.seq), (0x83, 7));
    let v = Value::unpack(&value.payload).unwrap();
    assert_eq!((v.name.as_str(), v.text(), v.index, v.count), ("state", "IDLE".into(), 1, 3));
    for ((ty, payload), wire) in payloads().into_iter().zip(&lines[1..]) {
        assert_eq!(*wire, encode_frame(ty, 7, &payload), "byte for byte, as the app encodes it");
        let fr = decode_frame(&wire[..wire.len() - 1]).unwrap();
        assert_eq!((fr.ty, fr.payload), (ty, payload));
    }
    // The app's frames, read by the firmware.
    for (ty, payload) in payloads() {
        let wire = encode_frame(ty, 9, &payload);
        let got = run(&exe, &["decode", &hex(&wire[..wire.len() - 1])]);
        assert_eq!(got.trim(), format!("{ty} 9 {}", hex(&payload)).trim());
    }
    let mut bad = encode_frame(0x01, 9, &[1, 2, 3]);
    bad[2] ^= 0x40;
    assert_eq!(run(&exe, &["decode", &hex(&bad[..bad.len() - 1])]).trim(), "bad", "a corrupt frame is refused");
}

#[test]
fn the_app_and_the_firmware_agree_on_the_config() {
    let Some(exe) = firmware_io() else { return };
    // Same defaults, byte for byte (layout, values, CRC).
    let firmware = unhex(run(&exe, &["defaults"]).trim());
    assert_eq!(firmware, config::pack(&defaults()).unwrap(), "default blob");
    // Every value the app offers is one the firmware runs, and the app's
    // limits refuse what the firmware refuses (same field named).
    for f in fields() {
        let tries: Vec<i64> = match (f.choices, f.limits) {
            (Some(c), _) => c.to_vec(),
            (None, Some((lo, hi))) => vec![lo - 1, lo, hi, hi + 1],
            _ => vec![],
        };
        for v in tries {
            let Ok(blob) = config::pack(&defaults().with(f.key, v)) else { continue }; // does not fit the field
            let verdict = run(&exe, &["check", &hex(&blob)]);
            let app_ok = config::problems(&defaults().with(f.key, v)).is_empty();
            assert_eq!(verdict.trim() == "0", app_ok, "{} = {v}: firmware says {}", f.key, verdict.trim());
        }
    }
    let bad = config::pack(&defaults().with("highg_odr_hz", 1000)).unwrap();
    assert_eq!(run(&exe, &["check", &hex(&bad)]).trim(), by_key("highg_odr_hz").id.to_string());
}

#[test]
fn the_app_reads_the_rockets_radio_reports_as_the_firmware_packs_them() {
    let Some(exe) = firmware_io() else { return };
    let out = run(&exe, &["reports"]);
    let lines: Vec<Vec<u8>> = out.lines().map(unhex).collect();
    let s = Status::unpack(&lines[0]).unwrap();
    assert_eq!((s.state, s.uptime_ms, s.heartbeat, s.battery_mv, s.on_usb, s.live_mask), (1, 123456, 42, 7920, true, 0x97));
    assert_eq!(s.adc, [1000, 2000, 3000, 4000, 5000, 6000, 7000]);
    assert_eq!((s.chips[0], s.chips[7], s.radio_device_errors), ((1, 0x6B), (2, 9), 0x20));
    let t = Telemetry::unpack(&lines[1]).unwrap();
    assert_eq!((t.state, t.uptime_ms, t.fresh, t.fix_type, t.num_sv), (2, 5000, 0x05, 3, 11));
    assert_eq!(i16::from_le_bytes([t.imu[16], t.imu[17]]), 2049, "rec_imu_t accel z, as-is");
    assert_eq!(i32::from_le_bytes(t.baro[8..12].try_into().unwrap()), 101325, "rec_baro_t pressure");
    assert_eq!((t.lat_e7, t.hmsl_mm), (-123456789, 150000));
}
