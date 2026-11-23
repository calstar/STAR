"""
.ucf-oriented export helpers for ISM330DHCX MLC.

Production MLC programs should be authored in ST MEMS Studio
(https://www.st.com/en/development-tools/mems-studio.html) and exported as
.ucf register-write lists. See also:
  - ST MEMS tools hub: https://www.st.com/en/mems-and-sensors.html#tools-software
  - Community MLC example (LSM6DSOX, same MLC family patterns):
    https://community.st.com/mems-and-sensors-62/how-to-use-the-machine-learning-core-to-detect-inclination-angles-an-example-with-lsm6dsox-148

This module:
  1) Writes human-readable decision-tree rules for MEMS Studio / review.
  2) Emits a *deterministic feature-threshold bring-up* .ucf that enables MLC
     at 26 Hz and routes INT2 (NOT bit-identical filter/tree program bytes —
     MEMS Studio must emit those).
  3) Emits a C header of {op,reg,val} rows for ism330_mlc_load.
  4) Emits Unico/MEMS Studio import artifacts (per-class CSV, ARFF, steps).

Bit masks (board brief + DS13012 / AN5392 Table 1):
  MD2_CFG INT2_EMB_FUNC          = bit1  0x02
  EMB_FUNC_ODR_CFG_C MLC_ODR 26  = bits5:4 encoding 0x10
  EMB_FUNC_INIT_B MLC_INIT       = bit4  0x10
  EMB_FUNC_EN_B MLC_EN           = bit4  0x10
"""

from __future__ import annotations

import datetime
import json
import os
from typing import Any, Dict, List, Sequence

import numpy as np
import pandas as pd
from sklearn.tree import DecisionTreeClassifier, _tree

# Main / embedded register addresses used by the bring-up (DS13012 Rev 7).
REG_FUNC_CFG_ACCESS = 0x01
REG_MD2_CFG = 0x5F
REG_EMB_FUNC_EN_B = 0x05
REG_MLC_INT2 = 0x11
REG_EMB_FUNC_ODR_CFG_C = 0x60
REG_EMB_FUNC_INIT_B = 0x67

FUNC_CFG_ACCESS_EMB = 0x80  # FUNC_CFG_ACCESS bit7 → embedded page
MD2_CFG_INT2_EMB_FUNC = 0x02  # MD2_CFG (5Fh) INT2_EMB_FUNC (bit1)
EMB_FUNC_EN_B_MLC_EN = 0x10  # EMB_FUNC_EN_B (05h) MLC_EN (bit4)
EMB_FUNC_INIT_B_MLC_INIT = 0x10  # EMB_FUNC_INIT_B (67h) MLC_INIT (bit4)
MLC_INT2_TREE1 = 0x01  # MLC_INT2 (11h) route decision tree 1 / MLC0

# AN5392 Rev 5 Table 1 — MLC_ODR bits in EMB_FUNC_ODR_CFG_C (60h).
# Encoding places the 2-bit field in bits5:4 (board brief).
MLC_ODR_ENCODING = {
    12.5: 0x00,  # 00b
    26.0: 0x10,  # 01b default
    52.0: 0x20,  # 10b
    104.0: 0x30,  # 11b
}

CLASS_RESULT_CODES = {
    "still": 0x00,
    "handled": 0x01,
    "vibration": 0x02,
}


def export_tree_rules_txt(
    clf: DecisionTreeClassifier,
    feature_names: Sequence[str],
    class_names: Sequence[str],
    meta: Dict[str, Any],
    output_path: str,
) -> None:
    """Plain-text tree for human / MEMS Studio review (not the firmware load format)."""
    tree_ = clf.tree_
    lines: List[str] = [
        "// ==============================================================================",
        "// STAR pad/idle MLC decision tree (review copy — prefer MEMS Studio .ucf for silicon)",
        f"// Tree {meta.get('id', 1)}: {meta.get('name', 'Pad Idle')}",
        f"// Classes: {list(class_names)}",
        f"// Features: {list(feature_names)}",
        f"// MLC ODR Hz: {meta.get('odr_hz', 26.0)}",
        f"// Exported: {datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')}",
        f"// Leaves: {clf.get_n_leaves()} | Nodes: {tree_.node_count}",
        "// Target: ISM330DHCX MLC — hint only, no pyro/launch authority",
        "// ==============================================================================",
        "",
    ]

    def recurse(node_id: int, depth: int) -> None:
        left = tree_.children_left[node_id]
        right = tree_.children_right[node_id]
        indent = "|   " * depth
        if left == _tree.TREE_LEAF:
            return
        feat = feature_names[tree_.feature[node_id]]
        thresh = tree_.threshold[node_id]

        def leaf_or_branch(child: int, op: str) -> None:
            if tree_.children_left[child] == _tree.TREE_LEAF:
                label = class_names[int(np.argmax(tree_.value[child][0]))]
                n = int(tree_.n_node_samples[child])
                lines.append(f"{indent}{feat} {op} {thresh:.6f} : {label} ({n}.0)")
            else:
                lines.append(f"{indent}{feat} {op} {thresh:.6f}")
                recurse(child, depth + 1)

        leaf_or_branch(left, "<=")
        leaf_or_branch(right, ">")

    recurse(0, 0)
    lines.append(f"\nNumber of Leaves  : {clf.get_n_leaves()}")
    lines.append(f"Size of the tree : {tree_.node_count}")
    os.makedirs(os.path.dirname(os.path.abspath(output_path)) or ".", exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")


def extract_feature_thresholds(
    clf: DecisionTreeClassifier,
    feature_names: Sequence[str],
    class_names: Sequence[str],
) -> Dict[str, Any]:
    """Flatten tree splits into a deterministic threshold summary for MEMS Studio handoff."""
    tree_ = clf.tree_
    splits: List[Dict[str, Any]] = []

    def walk(node_id: int, path: List[str]) -> None:
        left = tree_.children_left[node_id]
        right = tree_.children_right[node_id]
        if left == _tree.TREE_LEAF:
            label = class_names[int(np.argmax(tree_.value[node_id][0]))]
            splits.append(
                {
                    "kind": "leaf",
                    "class": label,
                    "result_code": CLASS_RESULT_CODES.get(str(label), 0xFF),
                    "path": list(path),
                    "n_samples": int(tree_.n_node_samples[node_id]),
                }
            )
            return
        feat = feature_names[tree_.feature[node_id]]
        thresh = float(tree_.threshold[node_id])
        splits.append(
            {
                "kind": "split",
                "feature": feat,
                "threshold": thresh,
                "path": list(path),
            }
        )
        walk(left, path + [f"{feat}<={thresh:.6g}"])
        walk(right, path + [f"{feat}>{thresh:.6g}"])

    walk(0, [])
    return {
        "features": list(feature_names),
        "classes": list(class_names),
        "class_result_codes": dict(CLASS_RESULT_CODES),
        "nodes": splits,
        "note": (
            "Thresholds are sklearn-derived for MEMS Studio feature/tree setup. "
            "They are NOT encoded as ISM330 filter/tree program bytes in the bring-up .ucf."
        ),
    }


def bringup_ucf_lines(
    odr_hz: float = 26.0,
    thresholds: Dict[str, Any] | None = None,
) -> List[str]:
    """
    Deterministic feature-threshold *bring-up* .ucf (clearly labeled).

    Enables MLC @ ODR, pulses MLC_INIT, routes tree1 → INT2 / MD2_CFG.
    Does NOT program filter banks or decision-tree node RAM — MEMS Studio
    must emit those bytes. Thresholds are recorded as comments only.
    """
    if odr_hz not in MLC_ODR_ENCODING:
        raise ValueError(f"unsupported MLC ODR {odr_hz}")
    odr_val = MLC_ODR_ENCODING[odr_hz]
    lines: List[str] = [
        "// ==============================================================================",
        "// LABEL: DETERMINISTIC FEATURE-THRESHOLD BRING-UP — NOT A FULL MLC TREE PROGRAM",
        "// ==============================================================================",
        "// This .ucf only enables MLC + INT2 routing with corrected bit masks.",
        "// It does NOT contain ISM330 filter-bank / decision-tree program bytes.",
        "// Silicon class results require a MEMS Studio / Unico MLC export that embeds",
        "// the trained still/handled/vibration tree (see mems-studio-import/STEPS.md).",
        f"// MLC ODR = {odr_hz} Hz → EMB_FUNC_ODR_CFG_C bits5:4 encoding 0x{odr_val:02X}",
        "// Bit masks (board brief):",
        "//   MD2_CFG INT2_EMB_FUNC     = 0x02 (bit1)",
        "//   EMB_FUNC_ODR_CFG_C 26 Hz  = 0x10 (bits5:4)",
        "//   EMB_FUNC_INIT_B MLC_INIT  = 0x10 (bit4)",
        "//   EMB_FUNC_EN_B MLC_EN      = 0x10 (bit4)",
        "// CTRL1_XL/CTRL2_G omitted — firmware ism330_init already sets 0x74/0x71.",
        "// Safety: MLC is hint-only — never pyro/launch/apogee authority.",
    ]
    if thresholds:
        lines.append("// --- sklearn feature thresholds (for MEMS Studio handoff) ---")
        lines.append(f"// features: {thresholds.get('features')}")
        lines.append(f"// classes:  {thresholds.get('classes')}")
        for node in thresholds.get("nodes", []):
            if node.get("kind") == "split":
                lines.append(
                    f"// SPLIT {node['feature']} threshold={node['threshold']:.6g}"
                )
            elif node.get("kind") == "leaf":
                lines.append(
                    f"// LEAF  class={node['class']} code=0x{node['result_code']:02X} "
                    f"path={' && '.join(node['path']) or '(root)'}"
                )
        lines.append("// --- end threshold comments ---")
    lines.extend(
        [
            f"Ac {REG_FUNC_CFG_ACCESS:02X} {FUNC_CFG_ACCESS_EMB:02X}",
            f"Ac {REG_EMB_FUNC_EN_B:02X} {EMB_FUNC_EN_B_MLC_EN:02X}",
            f"Ac {REG_EMB_FUNC_ODR_CFG_C:02X} {odr_val:02X}",
            f"Ac {REG_EMB_FUNC_INIT_B:02X} {EMB_FUNC_INIT_B_MLC_INIT:02X}",
            "WAIT 10",
            f"Ac {REG_MLC_INT2:02X} {MLC_INT2_TREE1:02X}",
            f"Ac {REG_FUNC_CFG_ACCESS:02X} 00",
            f"Ac {REG_MD2_CFG:02X} {MD2_CFG_INT2_EMB_FUNC:02X}",
        ]
    )
    return lines


# Back-compat alias used by older call sites / docs.
def fixture_ucf_lines(odr_hz: float = 26.0) -> List[str]:
    return bringup_ucf_lines(odr_hz=odr_hz, thresholds=None)


def write_ucf(path: str, lines: Sequence[str]) -> None:
    os.makedirs(os.path.dirname(os.path.abspath(path)) or ".", exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")


def parse_ucf_to_writes(lines: Sequence[str]) -> List[Dict[str, int]]:
    """Parse Ac/WAIT lines into dicts: {op:0 write|1 wait, reg, val}."""
    out: List[Dict[str, int]] = []
    for raw in lines:
        line = raw.split("//", 1)[0].strip()
        if not line:
            continue
        parts = line.split()
        if parts[0].upper() == "WAIT":
            out.append({"op": 1, "reg": 0, "val": int(parts[1])})
        elif parts[0] in ("Ac", "AC", "Write", "WRITE"):
            out.append({"op": 0, "reg": int(parts[1], 16), "val": int(parts[2], 16)})
        else:
            raise ValueError(f"unrecognized .ucf line: {raw!r}")
    return out


def write_c_header(
    path: str,
    writes: Sequence[Dict[str, int]],
    array_name: str = "mlc_pad_writes",
    source_note: str = "Converted from pad bring-up .ucf",
) -> None:
    os.makedirs(os.path.dirname(os.path.abspath(path)) or ".", exist_ok=True)
    rows = []
    for w in writes:
        if w["op"] == 1:
            rows.append(f"    {{ISM330_MLC_OP_WAIT_MS, 0x{w['reg']:02X}, {w['val']}}},")
        else:
            rows.append(
                f"    {{ISM330_MLC_OP_WRITE, 0x{w['reg']:02X}, 0x{w['val']:02X}}},"
            )
    body = "\n".join(rows)
    guard = "STAR_MLC_PAD_WRITES_H"
    text = f"""/* {source_note}
 * Bit masks: MD2 INT2_EMB_FUNC=0x02; MLC_ODR 26Hz=0x10; MLC_INIT=0x10.
 * Bring-up only until MEMS Studio emits a full still/handled/vibration .ucf.
 * Do not invent flight-event trees. */
#ifndef {guard}
#define {guard}

#include <stddef.h>

#include "dev_ism330dhcx_mlc.h"

static const ism330_mlc_write_t {array_name}[] = {{
{body}
}};

static const size_t {array_name}_len =
    sizeof({array_name}) / sizeof({array_name}[0]);

#endif
"""
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)


def write_mems_studio_import(
    raw_df: pd.DataFrame,
    thresholds: Dict[str, Any],
    import_dir: str,
    odr_hz: float,
) -> Dict[str, str]:
    """
    Unico / MEMS Studio import artifacts (AN5392 §2 supervised path).

    Per-class CSVs in mg / dps (Unico Load/Save convention), ARFF of window
    features, threshold JSON, and exact STEPS.md.
    """
    os.makedirs(import_dir, exist_ok=True)
    paths: Dict[str, str] = {}

    # Accel g → mg, gyro dps (synthetic already in dps-like units).
    for label in ("still", "handled", "vibration"):
        part = raw_df.loc[raw_df["pad_class"] == label].copy()
        out = pd.DataFrame(
            {
                "acc_x[mg]": np.round(
                    part["accel_x"].to_numpy(dtype=float) * 1000.0, 3
                ),
                "acc_y[mg]": np.round(
                    part["accel_y"].to_numpy(dtype=float) * 1000.0, 3
                ),
                "acc_z[mg]": np.round(
                    part["accel_z"].to_numpy(dtype=float) * 1000.0, 3
                ),
                "gyr_x[dps]": np.round(part["gyro_x"].to_numpy(dtype=float), 4),
                "gyr_y[dps]": np.round(part["gyro_y"].to_numpy(dtype=float), 4),
                "gyr_z[dps]": np.round(part["gyro_z"].to_numpy(dtype=float), 4),
            }
        )
        csv_path = os.path.join(import_dir, f"log_{label}_{int(odr_hz)}hz.csv")
        out.to_csv(csv_path, index=False)
        paths[f"log_{label}"] = csv_path

    # ARFF of feature columns for external WEKA / Unico tree import.
    from src.features import compute_pad_mlc_features

    feat_df, feat_names = compute_pad_mlc_features(raw_df, odr_hz=odr_hz)
    arff_path = os.path.join(import_dir, "pad_idle_features.arff")
    classes = sorted(set(raw_df["pad_class"].astype(str)))
    with open(arff_path, "w", encoding="utf-8") as f:
        f.write("% STAR pad/idle MLC features for Unico/WEKA import\n")
        f.write(f"% MLC ODR {odr_hz} Hz | firmware FS ±16 g / ±4000 dps\n")
        f.write("@RELATION pad_idle_mlc\n\n")
        for name in feat_names:
            f.write(f"@ATTRIBUTE {name} NUMERIC\n")
        f.write(f"@ATTRIBUTE class {{{','.join(classes)}}}\n\n")
        f.write("@DATA\n")
        for idx in raw_df.index:
            vals = [f"{feat_df.loc[idx, n]:.8f}" for n in feat_names]
            vals.append(str(raw_df.loc[idx, "pad_class"]))
            f.write(",".join(vals) + "\n")
    paths["arff"] = arff_path

    thr_path = os.path.join(import_dir, "feature_thresholds.json")
    with open(thr_path, "w", encoding="utf-8") as f:
        json.dump(thresholds, f, indent=2)
        f.write("\n")
    paths["thresholds"] = thr_path

    steps_path = os.path.join(import_dir, "STEPS.md")
    with open(steps_path, "w", encoding="utf-8") as f:
        f.write(f"""# MEMS Studio / Unico — pad/idle MLC import steps

Exact handoff from this drop’s synthetic (or later bench) logs to a silicon `.ucf`.

## Goal
One decision tree, classes **still / handled / vibration**, MLC ODR **{odr_hz} Hz**,
features **variance(|a|)** and **zero-crossing(a_z)** (~1 s window), INT2/PD1 IRQ.
Hint only — no pyro/launch authority.

## Files in this folder
| File | Use |
|------|-----|
| `log_still_{int(odr_hz)}hz.csv` | Unico/MEMS Studio log for class still (mg / dps) |
| `log_handled_{int(odr_hz)}hz.csv` | Class handled |
| `log_vibration_{int(odr_hz)}hz.csv` | Class vibration |
| `pad_idle_features.arff` | Optional WEKA/external tree import of window features |
| `feature_thresholds.json` | sklearn split thresholds (reference while configuring features) |
| `../tree_1_pad_idle_rules.txt` | Human-readable tree (sibling export) |

## Steps (prefer MEMS Studio; Unico MLC tool is the AN5392 path)

1. Install [MEMS Studio](https://www.st.com/en/development-tools/mems-studio.html)
   (or Unico GUI + MLC plugin per AN5392 §2). Select device **ISM330DHCX**.
2. Set sensor full-scale to match firmware: **±16 g**, **±4000 dps**. Prefer logging /
   MLC ODR **{odr_hz} Hz** (AN5392: log at the chosen MLC ODR when known).
3. Open the MLC configuration tool. Load each `log_*.csv` and assign the class
   label matching the filename (`still`, `handled`, `vibration`).
4. Configure computation block:
   - Window ≈ 1.0 s → window length ≈ {int(round(odr_hz))} samples at {odr_hz} Hz
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
""")
    paths["steps"] = steps_path
    return paths


def export_pad_idle_artifacts(
    clf: DecisionTreeClassifier,
    feature_names: Sequence[str],
    class_names: Sequence[str],
    export_dir: str,
    odr_hz: float = 26.0,
    raw_df: pd.DataFrame | None = None,
) -> Dict[str, str]:
    """Write rules, bring-up .ucf(s), C headers, thresholds, and MEMS Studio import pack."""
    os.makedirs(export_dir, exist_ok=True)
    meta = {"id": 1, "name": "Pad Idle", "odr_hz": odr_hz}
    thresholds = extract_feature_thresholds(clf, feature_names, class_names)

    rules = os.path.join(export_dir, "tree_1_pad_idle_rules.txt")
    ucf_pad = os.path.join(export_dir, "mlc_pad.ucf")
    ucf_alias = os.path.join(export_dir, "pad_idle_mlc.ucf")
    hdr = os.path.join(export_dir, "mlc_pad_writes.h")
    thr_json = os.path.join(export_dir, "feature_thresholds.json")

    export_tree_rules_txt(clf, feature_names, class_names, meta, rules)
    lines = bringup_ucf_lines(odr_hz, thresholds)
    write_ucf(ucf_pad, lines)
    write_ucf(ucf_alias, lines)
    write_c_header(
        hdr,
        parse_ucf_to_writes(lines),
        array_name="mlc_pad_writes",
        source_note="Converted from imu_mlc/exports/mlc_pad.ucf — feature-threshold bring-up",
    )
    with open(thr_json, "w", encoding="utf-8") as f:
        json.dump(thresholds, f, indent=2)
        f.write("\n")

    paths: Dict[str, str] = {
        "rules": rules,
        "ucf": ucf_pad,
        "ucf_alias": ucf_alias,
        "header": hdr,
        "thresholds": thr_json,
    }

    if raw_df is not None:
        import_dir = os.path.join(export_dir, "mems-studio-import")
        paths.update(
            {
                f"import_{k}": v
                for k, v in write_mems_studio_import(
                    raw_df, thresholds, import_dir, odr_hz
                ).items()
            }
        )
    return paths
