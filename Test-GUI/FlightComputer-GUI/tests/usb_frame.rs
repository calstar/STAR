//! The app's frame code against the firmware's own (src/app/usb_frame.c,
//! compiled here via tests/c/usb_frame_io.c), both ways, so the two cannot
//! drift apart while each passes its own tests.
//!
//! Skipped without a C compiler or the firmware sources, unless
//! FC_REQUIRE_FIRMWARE_TEST=1 (CI sets it on Linux and macOS).

use std::path::{Path, PathBuf};
use std::process::Command;

use star_fc::protocol::{decode_frame, encode_frame, Value};

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
