"""
Train one pad/idle MLC decision tree: still / handled / vibration.

Replaces the previous 8-tree in-flight Unico pipeline for STAR firmware use.
Node budget check retained (ISM330DHCX MLC capacity); one shallow tree is expected.
"""

from __future__ import annotations

import os
from typing import Any, Dict, List

import pandas as pd
from sklearn.metrics import accuracy_score, f1_score
from sklearn.model_selection import train_test_split
from sklearn.tree import DecisionTreeClassifier

from src.export_ucf import export_pad_idle_artifacts
from src.features import DEFAULT_MLC_ODR_HZ, DEFAULT_WINDOW_S, compute_pad_mlc_features

TOTAL_NODE_BUDGET = 512
CLASS_ORDER = ["still", "handled", "vibration"]

TREE_META = {
    "id": 1,
    "name": "Pad Idle",
    "target_col": "pad_class",
    "max_leaf_nodes": 16,
    "description": "Pad/idle state: still, handled (carried), vibration — hint only",
}


def prepare_pad_dataset(
    csv_path: str,
    odr_hz: float = DEFAULT_MLC_ODR_HZ,
    window_s: float = DEFAULT_WINDOW_S,
):
    if not os.path.exists(csv_path):
        raise FileNotFoundError(f"pad/idle data not found at '{csv_path}'")
    raw = pd.read_csv(csv_path)
    if "pad_class" not in raw.columns:
        raise KeyError("CSV must include pad_class column: still|handled|vibration")
    features, names = compute_pad_mlc_features(raw, odr_hz=odr_hz, window_s=window_s)
    return features, raw, names


def train_and_evaluate_pad_mlc(
    csv_path: str = "data/pad_idle_bench.csv",
    export_dir: str = "exports",
    odr_hz: float = DEFAULT_MLC_ODR_HZ,
    window_s: float = DEFAULT_WINDOW_S,
    random_state: int = 42,
) -> Dict[str, Any]:
    features_df, raw_df, feature_names = prepare_pad_dataset(csv_path, odr_hz, window_s)

    train_idx, test_idx = train_test_split(
        raw_df.index,
        test_size=0.20,
        random_state=random_state,
        stratify=raw_df["pad_class"],
    )
    X_train = features_df.loc[train_idx]
    X_test = features_df.loc[test_idx]
    y_train = raw_df.loc[train_idx, "pad_class"]
    y_test = raw_df.loc[test_idx, "pad_class"]

    clf = DecisionTreeClassifier(
        criterion="gini",
        max_leaf_nodes=TREE_META["max_leaf_nodes"],
        random_state=random_state,
        min_samples_leaf=5,
    )
    clf.fit(X_train, y_train)
    y_pred = clf.predict(X_test)

    # Stable class name order for exports when present.
    present = [c for c in CLASS_ORDER if c in set(clf.classes_)]
    for c in clf.classes_:
        if c not in present:
            present.append(str(c))

    acc = accuracy_score(y_test, y_pred)
    f1 = f1_score(y_test, y_pred, average="weighted")
    nodes = int(clf.tree_.node_count)
    leaves = int(clf.get_n_leaves())
    if nodes > TOTAL_NODE_BUDGET:
        raise ValueError(f"node budget exceeded: {nodes} > {TOTAL_NODE_BUDGET}")

    paths = export_pad_idle_artifacts(
        clf,
        feature_names,
        present,
        export_dir=export_dir,
        odr_hz=odr_hz,
        raw_df=raw_df,
    )

    result = {
        "tree_id": 1,
        "name": TREE_META["name"],
        "type": "multiclass",
        "leaf_budget": TREE_META["max_leaf_nodes"],
        "leaves_used": leaves,
        "nodes_used": nodes,
        "accuracy": acc,
        "f1_score": f1,
        "features": feature_names,
        "classes": present,
        "odr_hz": odr_hz,
        "export_files": paths,
    }
    return {
        "results": [result],
        "total_nodes": nodes,
        "budget": TOTAL_NODE_BUDGET,
        "budget_passed": True,
        "feature_count": len(feature_names),
        "model": clf,
    }


def format_summary(summary: Dict[str, Any]) -> str:
    r = summary["results"][0]
    lines: List[str] = [
        "=" * 72,
        " PAD/IDLE MLC (1 tree, 3 classes) ",
        "=" * 72,
        f"  Classes     : {r['classes']}",
        f"  Features    : {r['features']}",
        f"  MLC ODR     : {r['odr_hz']} Hz",
        f"  Leaves/Nodes: {r['leaves_used']} / {r['nodes_used']} (budget {summary['budget']})",
        f"  Accuracy    : {r['accuracy']*100:.2f}%",
        f"  F1 (wgt)    : {r['f1_score']*100:.2f}%",
        "  Exports:",
    ]
    for k, v in r["export_files"].items():
        lines.append(f"    - {k}: {v}")
    lines.append(
        "  NOTE: bring-up .ucf enables MLC+INT2 only; MEMS Studio emits filter/tree bytes "
        "(see exports/mems-studio-import/STEPS.md)."
    )
    lines.append("=" * 72)
    return "\n".join(lines)
