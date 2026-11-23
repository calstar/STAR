# imu_mlc (pad / idle retarget)

**The IMU does not run this Python.** It runs a **`.ucf`** (register write + WAIT list). This package helps produce / document that `.ucf` for MEMS Studio and for firmware `ism330_mlc_load`.

Train a **single** ISM330DHCX Machine Learning Core tree for pad/idle state:

| Class | Meaning |
|-------|---------|
| `still` | Vehicle at rest on the pad |
| `handled` | Carried / moved by hand |
| `vibration` | Sustained vibration |

**Not** the previous 8-tree in-flight / chute / abort trainer. MLC is a **hint only** — never launch, apogee, or pyro authority.

## Defaults (board brief + AN5392 Rev 5)
- MLC ODR: **26 Hz** (12.5 / 26 / 52 / 104 allowed; Table 1 in AN5392)
- Features (v1): variance of \|a\|, zero-crossings of a_z (~1 s window)
- Sensor full-scale match firmware: ±16 g / ±4000 dps (`CTRL1_XL=0x74`, `CTRL2_G=0x71`); host sensor ODR stays 833 Hz
- Export: sklearn rules + **feature-threshold bring-up `.ucf`** / C header + MEMS Studio import pack

## What lands in `exports/`
| Artifact | Status |
|----------|--------|
| `mlc_pad.ucf` / `pad_idle_mlc.ucf` | **Bring-up** — enable MLC @ 26 Hz + INT2 (masks `0x10`/`0x10`/`0x02`). Labeled *not* a full tree program |
| `mlc_pad_writes.h` | Same list for `ism330_mlc_load` |
| `tree_1_pad_idle_rules.txt` + `feature_thresholds.json` | Trained thresholds for MEMS Studio handoff |
| `mems-studio-import/` | Per-class CSV (mg/dps), ARFF, `STEPS.md` |

Full ST decision-tree / filter-bank bytes **require MEMS Studio** (or Unico MLC). Follow `exports/mems-studio-import/STEPS.md`, then replace `mlc_pad.ucf` + regenerate the header.

## Authoritative silicon path
1. Prefer labelled **bench** logs at MLC ODR (synthetic CSVs here are a stand-in).
2. Build the tree in **MEMS Studio** / Unico MLC tool ([MEMS Studio](https://www.st.com/en/development-tools/mems-studio.html)).
3. Export `.ucf`; convert to `.h` via Unico “C code generation” (AN5392 §2) or this package’s parser.
4. Firmware: `ism330_init` → `ism330_mlc_load(mlc_pad_writes)`; INT2/PD1; SPI3 lock across page switches; no `ism330_power_down` while MLC Idle wake is on.

Community MLC walk-through (LSM6DSOX, same family patterns):  
https://community.st.com/mems-and-sensors-62/how-to-use-the-machine-learning-core-to-detect-inclination-angles-an-example-with-lsm6dsox-148

## CLI
```bash
python -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
python main.py                  # generate + train + export
python main.py --odr 26 --train
```
