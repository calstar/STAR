"""
MLC 8-Decision Tree Training, Validation, and Unico-GUI Exporter.

Trains 8 independent DecisionTreeClassifier models constrained to a collective
hard budget of <= 512 total nodes for STMicroelectronics Machine Learning Core (MLC).

Tree Specifications:
- Tree 1: Flight Phase (Pad, Boost, Coast, Apogee, Descent, Touchdown) [max_leaf_nodes=64]
- Tree 2: Signal Drop Risk (Binary: High risk vs Normal)              [max_leaf_nodes=32]
- Tree 3: Apogee Turnover (Binary)                                   [max_leaf_nodes=32]
- Tree 4: First Chute Verification (Binary)                          [max_leaf_nodes=32]
- Tree 5: Main Chute Deployment (Binary)                             [max_leaf_nodes=32]
- Tree 6: Touchdown Confirmed (Binary)                               [max_leaf_nodes=16]
- Tree 7: Extreme Tumbling / Abort (Binary)                          [max_leaf_nodes=32]
- Tree 8: Emergency Chute Trigger (Binary)                           [max_leaf_nodes=16]
"""

import os
import datetime
from typing import Dict, List, Tuple, Any
import numpy as np
import pandas as pd
from sklearn.tree import DecisionTreeClassifier, _tree
from sklearn.model_selection import train_test_split
from sklearn.metrics import accuracy_score, f1_score, classification_report

from src.features import compute_rolling_mlc_features


TOTAL_NODE_BUDGET = 512

TREE_CONFIGS = [
    {
        "id": 1,
        "name": "Flight Phase",
        "target_col": "flight_phase",
        "max_leaf_nodes": 64,
        "class_type": "multiclass",
        "description": "Classifies rocket flight state (Pad, Boost, Coast, Apogee, Descent, Touchdown)",
    },
    {
        "id": 2,
        "name": "Signal Drop Risk",
        "target_col": "signal_drop_risk",
        "max_leaf_nodes": 32,
        "class_type": "binary",
        "description": "Detects high probability of RF telemetry loss from tumbling/misalignment",
    },
    {
        "id": 3,
        "name": "Apogee Turnover",
        "target_col": "apogee_turnover",
        "max_leaf_nodes": 32,
        "class_type": "binary",
        "description": "Identifies ballistic apex and vehicle pitch/yaw rollover",
    },
    {
        "id": 4,
        "name": "First Chute Verification",
        "target_col": "first_chute_verified",
        "max_leaf_nodes": 32,
        "class_type": "binary",
        "description": "Confirms drogue parachute deployment shock and initial deceleration",
    },
    {
        "id": 5,
        "name": "Main Chute Deployment",
        "target_col": "main_chute_deployed",
        "max_leaf_nodes": 32,
        "class_type": "binary",
        "description": "Verifies main canopy inflation and terminal velocity stabilization",
    },
    {
        "id": 6,
        "name": "Touchdown Confirmed",
        "target_col": "touchdown_confirmed",
        "max_leaf_nodes": 16,
        "class_type": "binary",
        "description": "Confirms landing impact and stationary resting state on ground",
    },
    {
        "id": 7,
        "name": "Extreme Tumbling / Abort",
        "target_col": "extreme_tumbling",
        "max_leaf_nodes": 32,
        "class_type": "binary",
        "description": "Flags catastrophic tumbling (>1000 dps) and structural instability",
    },
    {
        "id": 8,
        "name": "Emergency Chute Trigger",
        "target_col": "emergency_chute_trigger",
        "max_leaf_nodes": 16,
        "class_type": "binary",
        "description": "Signals autonomous pyrotechnic recovery deployment override",
    },
]


def export_unico_gui_format(
    clf: DecisionTreeClassifier,
    feature_names: List[str],
    class_names: List[str],
    tree_meta: Dict[str, Any],
    output_path: str,
) -> None:
    """
    Exports decision tree rules into plain-text format compatible with STMicroelectronics Unico-GUI
    (standard Weka J48 / C4.5 grammar recognized by Unico-GUI MLC loader).
    """
    tree_ = clf.tree_
    lines = []

    # Unico-GUI header with sensor MLC configuration metadata
    lines.append("// ==============================================================================")
    lines.append("// STMicroelectronics Unico-GUI MLC Decision Tree Export")
    lines.append(f"// Tree {tree_meta['id']}: {tree_meta['name']}")
    lines.append(f"// Description: {tree_meta['description']}")
    lines.append(f"// Target Column: {tree_meta['target_col']}")
    lines.append(f"// Exported: {datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    lines.append(f"// Leaf Nodes: {clf.get_n_leaves()} | Total Nodes: {tree_.node_count}")
    lines.append(f"// Max Depth: {clf.get_depth()}")
    lines.append(f"// Target Classes: {list(class_names)}")
    lines.append("// Target Hardware: ST LSM6DSOX / LSM6DSRX / ISM330DHCX Machine Learning Core")
    lines.append("// ==============================================================================\n")

    def recurse(node_id: int, depth: int, prefix: str = ""):
        left_child = tree_.children_left[node_id]
        right_child = tree_.children_right[node_id]

        # Is this a leaf node?
        if left_child == _tree.TREE_LEAF:
            class_idx = int(np.argmax(tree_.value[node_id][0]))
            class_label = class_names[class_idx]
            samples = int(tree_.n_node_samples[node_id])
            return f" : {class_label} ({samples}.0)"

        feat_idx = tree_.feature[node_id]
        feat_name = feature_names[feat_idx]
        thresh = tree_.threshold[node_id]

        indent = "|   " * depth

        # Left branch (<= threshold)
        left_is_leaf = tree_.children_left[left_child] == _tree.TREE_LEAF
        if left_is_leaf:
            left_class_idx = int(np.argmax(tree_.value[left_child][0]))
            left_label = class_names[left_class_idx]
            left_samples = int(tree_.n_node_samples[left_child])
            lines.append(f"{indent}{feat_name} <= {thresh:.6f} : {left_label} ({left_samples}.0)")
        else:
            lines.append(f"{indent}{feat_name} <= {thresh:.6f}")
            recurse(left_child, depth + 1)

        # Right branch (> threshold)
        right_is_leaf = tree_.children_left[right_child] == _tree.TREE_LEAF
        if right_is_leaf:
            right_class_idx = int(np.argmax(tree_.value[right_child][0]))
            right_label = class_names[right_class_idx]
            right_samples = int(tree_.n_node_samples[right_child])
            lines.append(f"{indent}{feat_name} > {thresh:.6f} : {right_label} ({right_samples}.0)")
        else:
            lines.append(f"{indent}{feat_name} > {thresh:.6f}")
            recurse(right_child, depth + 1)

    recurse(0, 0)

    # Number of rules note
    lines.append(f"\nNumber of Leaves  : {clf.get_n_leaves()}")
    lines.append(f"Size of the tree : {tree_.node_count}")

    os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")


def prepare_dataset(
    csv_path: str = "data/simulated_flight.csv",
    window_size: int = 20,
) -> Tuple[pd.DataFrame, pd.DataFrame, List[str]]:
    """Loads flight data and extracts rolling MLC features."""
    if not os.path.exists(csv_path):
        raise FileNotFoundError(f"Flight data not found at '{csv_path}'. Run data generator first.")

    raw_df = pd.read_csv(csv_path)
    features_df, feature_names = compute_rolling_mlc_features(raw_df, window_size=window_size)
    return features_df, raw_df, feature_names


def train_and_evaluate_mlc_trees(
    csv_path: str = "data/simulated_flight.csv",
    export_dir: str = "exports",
    window_size: int = 20,
    random_state: int = 42,
) -> Dict[str, Any]:
    """
    Trains all 8 DecisionTreeClassifier models, enforces the <= 512 total node budget,
    evaluates performance on a holdout test split, and exports Unico-GUI compatible rule files.
    """
    features_df, raw_df, feature_names = prepare_dataset(csv_path, window_size=window_size)

    # Train / Test split (80% train, 20% test)
    train_idx, test_idx = train_test_split(
        raw_df.index,
        test_size=0.20,
        random_state=random_state,
        stratify=raw_df["flight_phase"],
    )

    X_train = features_df.loc[train_idx]
    X_test = features_df.loc[test_idx]

    results = []
    trained_models = {}
    total_nodes_used = 0

    os.makedirs(export_dir, exist_ok=True)

    for cfg in TREE_CONFIGS:
        target_col = cfg["target_col"]
        y_train = raw_df.loc[train_idx, target_col]
        y_test = raw_df.loc[test_idx, target_col]

        # Get class names
        unique_classes = sorted(list(raw_df[target_col].unique()))
        class_names = [str(c) for c in unique_classes]

        # Train decision tree with specified max_leaf_nodes
        clf = DecisionTreeClassifier(
            criterion="gini",
            max_leaf_nodes=cfg["max_leaf_nodes"],
            random_state=random_state,
            min_samples_leaf=2,
        )
        clf.fit(X_train, y_train)

        # Predictions & Metrics
        y_pred = clf.predict(X_test)
        acc = accuracy_score(y_test, y_pred)
        f1 = f1_score(y_test, y_pred, average="weighted" if cfg["class_type"] == "multiclass" else "binary")

        leaf_count = clf.get_n_leaves()
        node_count = clf.tree_.node_count
        total_nodes_used += node_count

        trained_models[cfg["id"]] = {
            "model": clf,
            "config": cfg,
            "classes": class_names,
            "accuracy": acc,
            "f1": f1,
            "leaves": leaf_count,
            "nodes": node_count,
        }

        # Export to Unico-GUI format
        clean_name = cfg["name"].lower().replace(" ", "_").replace("/", "_")
        filename = f"tree_{cfg['id']}_{clean_name}.txt"
        export_path = os.path.join(export_dir, filename)
        export_unico_gui_format(clf, feature_names, class_names, cfg, export_path)

        results.append(
            {
                "tree_id": cfg["id"],
                "name": cfg["name"],
                "target": target_col,
                "type": cfg["class_type"],
                "leaf_budget": cfg["max_leaf_nodes"],
                "leaves_used": leaf_count,
                "nodes_used": node_count,
                "accuracy": acc,
                "f1_score": f1,
                "export_file": filename,
            }
        )

    # Validate node budget constraint
    budget_passed = total_nodes_used <= TOTAL_NODE_BUDGET
    if not budget_passed:
        raise ValueError(
            f"Hardware Budget Violation! Total nodes ({total_nodes_used}) exceeds "
            f"maximum MLC capacity of {TOTAL_NODE_BUDGET} nodes."
        )

    return {
        "results": results,
        "total_nodes": total_nodes_used,
        "budget": TOTAL_NODE_BUDGET,
        "budget_passed": budget_passed,
        "feature_count": len(feature_names),
        "models": trained_models,
    }
