//! The decoder against disk images written by the firmware's own emmc_log.c
//! (compiled here with the machine's C compiler via tests/c/write_image.c), so
//! a format bug cannot hide by being read back with the code that wrote it.
//!
//! Skipped without a C compiler or the firmware sources, unless
//! FC_REQUIRE_FIRMWARE_TEST=1 (CI sets it on Linux and macOS), where a skip fails.

use std::path::{Path, PathBuf};
use std::process::Command;

use star_fc::config::defaults;
use star_fc::emmc::{self, check_block};
use star_fc::protocol::u32_at;
use star_fc::records::{self as rec, Decoded, P0_PA};

fn skip(why: &str) {
    if std::env::var("FC_REQUIRE_FIRMWARE_TEST").as_deref() == Ok("1") {
        panic!("firmware writer test cannot run: {why}");
    }
    eprintln!("SKIPPED: {why}");
}

fn compiler() -> Option<&'static str> {
    ["gcc", "clang", "cc"].into_iter().find(|c| Command::new(c).arg("--version").output().is_ok_and(|o| o.status.success()))
}

/// (image bytes, head as an LBA): emmc_log_t.head is an LBA, not a block count.
fn firmware_image() -> Option<(Vec<u8>, u32)> {
    let here = Path::new(env!("CARGO_MANIFEST_DIR"));
    let fw: PathBuf = here.join("../../firmware/Flight_Computer");
    let src = fw.join("Core/Src");
    if !src.join("emmc_log.c").exists() {
        skip("firmware sources not found");
        return None;
    }
    let Some(cc) = compiler() else {
        skip("no C compiler");
        return None;
    };
    let dir = tempfile::tempdir().unwrap();
    let exe = dir.path().join(if cfg!(windows) { "write_image.exe" } else { "write_image" });
    let st = Command::new(cc)
        .args(["-std=c11", "-O1", "-o"])
        .arg(&exe)
        .arg(here.join("tests/c/write_image.c"))
        .arg(src.join("emmc_log.c"))
        .arg(src.join("flight_state.c"))
        .arg("-I")
        .arg(fw.join("Core/Inc"))
        .status()
        .expect("run the C compiler");
    assert!(st.success(), "compiling write_image.c failed");
    let img = dir.path().join("disk.img");
    let out = Command::new(&exe).arg(&img).output().expect("run write_image");
    assert!(out.status.success(), "write_image failed: {}", String::from_utf8_lossy(&out.stderr));
    let head: u32 = String::from_utf8_lossy(&out.stdout).trim().parse().expect("write_image prints head");
    Some((std::fs::read(&img).unwrap(), head))
}

#[test]
fn decodes_the_firmware_writer() {
    let Some((raw, head_lba)) = firmware_image() else { return };
    let sb = &raw[..512];
    let (magic, layout, epoch, data_start) = (u32_at(sb, 0), u32_at(sb, 4), u32_at(sb, 8), u32_at(sb, 12));
    assert_eq!(magic, emmc::SUPER_MAGIC);
    assert_eq!(layout, 1);
    assert_eq!(emmc::crc32(&sb[..508]), u32_at(sb, 508));
    let head = head_lba - data_start;
    let at = |k: u32| &raw[((data_start + k) as usize) * 512..((data_start + k + 1) as usize) * 512];
    let sessions = emmc::decode_blocks((0..head).map(|k| (k, at(k))), Some(epoch), &defaults(), "fallback");
    assert!(!sessions.contains_key(&0), "bad blocks: {:?}", sessions.get(&0).map(|s| &s.bad_blocks));
    assert_eq!(sessions.keys().copied().collect::<Vec<_>>(), vec![1, 2]);

    let s1 = &sessions[&1];
    let imu = &s1.records[&rec::REC_IMU];
    assert_eq!(imu.len(), 1000);
    assert_eq!(s1.count(rec::REC_BARO), 100);
    for (i, (t_ms, d)) in imu.iter().enumerate() {
        let Some(Decoded::Imu(d)) = rec::decode(rec::REC_IMU, d, &defaults(), P0_PA) else { panic!("imu {i}") };
        assert_eq!(*t_ms, i as u32);
        assert!((d.accel_g[2] - i as f64 * 0.488e-3).abs() < 1e-9);
        assert!((d.gyro_dps[0] + i as f64 * 0.140).abs() < 1e-9);
    }
    let pressures: Vec<f64> = s1.records[&rec::REC_BARO]
        .iter()
        .map(|(_, d)| match rec::decode(rec::REC_BARO, d, &defaults(), P0_PA) {
            Some(Decoded::Baro(b)) => b.pressure_pa,
            _ => panic!("baro"),
        })
        .collect();
    assert_eq!(pressures, (0..100).map(|i| 100_000.0 + i as f64).collect::<Vec<_>>());
    assert!(s1.events.iter().any(|(_, e)| e.contains("session start")));
    assert!(s1.events.iter().any(|(_, e)| e.contains("session end")));
    assert_eq!(sessions[&2].count(rec::REC_IMU), 10);
    // The block after the end is not a valid log block.
    assert!(check_block(at(head), head, Some(epoch)).is_err());
}
