# MEMS Studio / Unico — pad/idle MLC import steps

Exact handoff from this drop’s synthetic (or later bench) logs to a silicon `.ucf`.

## Goal
One decision tree, classes **still / handled / vibration**, MLC ODR **26.0 Hz**,
features **variance(|a|)** and **zero-crossing(a_z)** (~1 s window), INT2/PD1 IRQ.
Hint only — no pyro/launch authority.

## Files in this folder
| File | Use |
|------|-----|
| `log_still_26hz.csv` | Unico/MEMS Studio log for class still (mg / dps) |
| `log_handled_26hz.csv` | Class handled |
| `log_vibration_26hz.csv` | Class vibration |
| `pad_idle_features.arff` | Optional WEKA/external tree import of window features |
| `feature_thresholds.json` | sklearn split thresholds (reference while configuring features) |
| `../tree_1_pad_idle_rules.txt` | Human-readable tree (sibling export) |

## Steps (prefer MEMS Studio; Unico MLC tool is the AN5392 path)

1. Install [MEMS Studio](https://www.st.com/en/development-tools/mems-studio.html)
   (or Unico GUI + MLC plugin per AN5392 §2). Select device **ISM330DHCX**.
2. Set sensor full-scale to match firmware: **±16 g**, **±4000 dps**. Prefer logging /
   MLC ODR **26.0 Hz** (AN5392: log at the chosen MLC ODR when known).
3. Open the MLC configuration tool. Load each `log_*.csv` and assign the class
   label matching the filename (`still`, `handled`, `vibration`).
4. Configure computation block:
   - Window ≈ 1.0 s → window length ≈ 26 samples at 26.0 Hz
   - Features: **VARIANCE** of accelerometer magnitude; **ZERO-CROSSING** on accel Z
   - Use `feature_thresholds.json` / `tree_1_pad_idle_rules.txt` as the target split guide
5. Build / import the decision tree (Unico built-in or WEKA `.txt` / ARFF path per
   AN5392 Figure 27). Map leaf results:
   - still → result `0x00`
   - handled → result `0x01`
   - vibration → result `0x02`
6. Generate configuration → export **`.ucf`**.
7. Optionally use Unico **Options → C code generation** to turn `.ucf` → `.h`, or run
   this package’s `parse_ucf_to_writes` / `write_c_header`.
8. Replace `imu_mlc/exports/mlc_pad.ucf` and regenerate
   `firmware/.../mlc_pad_writes.h`. Keep INT2 routing and page exit; omit or set
   `CTRL1_XL`/`CTRL2_G` to **0x74/0x71**.
9. On bench: `ism330_init` → `ism330_mlc_load(mlc_pad_writes)` → watch `MLC0_SRC`
   while moving; confirm INT2/PD1 edges. Do **not** call `ism330_power_down` while
   MLC Idle wake is enabled.

## What this drop’s bring-up `.ucf` is *not*
`mlc_pad.ucf` / `pad_idle_mlc.ucf` enable MLC @ 26 Hz + INT2 only. They are labeled
**DETERMINISTIC FEATURE-THRESHOLD BRING-UP** and do **not** contain filter/tree
program bytes. Trust class codes only after step 8’s MEMS Studio export is loaded.
