"""Structured logging for robust DDP controller."""

from __future__ import annotations

import json
import csv
from pathlib import Path
from typing import Optional, Dict, Any, List
from datetime import datetime
import numpy as np

from .data_models import Measurement
from .actuation import ActuationCommand
from .engine_wrapper import EngineEstimate
from .constraints import constraint_values


class ControllerLogger:
    """Structured logger for controller runs."""
    
    def __init__(self, log_file: Optional[str] = None, format: str = "json"):
        """
        Initialize logger.
        
        Parameters:
        -----------
        log_file : str, optional
            Path to log file. If None, logs to stdout.
        format : str
            Log format: "json" or "csv"
        """
        self.log_file = log_file
        self.format = format
        self.logs: List[Dict[str, Any]] = []
        
        if log_file:
            self.log_path = Path(log_file)
            self.log_path.parent.mkdir(parents=True, exist_ok=True)
        else:
            self.log_path = None
    
    def log_tick(
        self,
        tick: int,
        timestamp: float,
        meas: Measurement,
        eng_est: Optional[EngineEstimate],
        constraints: Dict[str, float],
        u_proposed: np.ndarray,
        u_filtered: np.ndarray,
        actuation_cmd: ActuationCommand,
        w_bar: np.ndarray,
        F_ref: Optional[float] = None,
        MR_ref: Optional[float] = None,
    ) -> None:
        """
        Log one control tick.
        
        Parameters:
        -----------
        tick : int
            Tick number
        timestamp : float
            Timestamp [s]
        meas : Measurement
            Sensor measurements
        eng_est : EngineEstimate, optional
            Engine performance estimate
        constraints : Dict[str, float]
            Constraint margins
        u_proposed : np.ndarray
            Proposed relaxed control
        u_filtered : np.ndarray
            Filtered (safe) relaxed control
        actuation_cmd : ActuationCommand
            Actuation command
        w_bar : np.ndarray
            Residual bounds
        F_ref : float, optional
            Reference thrust [N]
        MR_ref : float, optional
            Reference mixture ratio
        """
        log_entry = {
            "tick": int(tick),
            "timestamp": float(timestamp),
            "pressures": {
                "P_copv": float(meas.P_copv),
                "P_reg": float(meas.P_reg),
                "P_u_fuel": float(meas.P_u_fuel),
                "P_u_ox": float(meas.P_u_ox),
                "P_d_fuel": float(meas.P_d_fuel),
                "P_d_ox": float(meas.P_d_ox),
            },
            "engine": {
                "P_ch": float(eng_est.P_ch) if eng_est else None,
                "F": float(eng_est.F) if eng_est else None,
                "MR": float(eng_est.MR) if eng_est else None,
                "mdot_F": float(eng_est.mdot_F) if eng_est else None,
                "mdot_O": float(eng_est.mdot_O) if eng_est else None,
            },
            "constraints": {k: float(v) for k, v in constraints.items()},
            "control": {
                "u_proposed_F": float(u_proposed[0]),
                "u_proposed_O": float(u_proposed[1]),
                "u_filtered_F": float(u_filtered[0]),
                "u_filtered_O": float(u_filtered[1]),
                "duty_F": float(actuation_cmd.duty_F),
                "duty_O": float(actuation_cmd.duty_O),
                "u_F_onoff": bool(actuation_cmd.u_F_onoff),
                "u_O_onoff": bool(actuation_cmd.u_O_onoff),
            },
            "robustness": {
                "w_bar": w_bar.tolist(),
            },
            "reference": {
                "F_ref": float(F_ref) if F_ref is not None else None,
                "MR_ref": float(MR_ref) if MR_ref is not None else None,
            },
        }
        
        self.logs.append(log_entry)
        
        # Write immediately if file specified
        if self.log_path:
            if self.format == "json":
                self._write_json(log_entry)
            elif self.format == "csv":
                self._write_csv(log_entry)
    
    def _write_json(self, entry: Dict[str, Any]) -> None:
        """Write JSON log entry."""
        with open(self.log_path, 'a') as f:
            json.dump(entry, f)
            f.write('\n')
    
    def _write_csv(self, entry: Dict[str, Any]) -> None:
        """Write CSV log entry."""
        # Flatten entry for CSV
        flat_entry = {
            "tick": entry["tick"],
            "timestamp": entry["timestamp"],
            "P_copv": entry["pressures"]["P_copv"],
            "P_reg": entry["pressures"]["P_reg"],
            "P_u_fuel": entry["pressures"]["P_u_fuel"],
            "P_u_ox": entry["pressures"]["P_u_ox"],
            "P_d_fuel": entry["pressures"]["P_d_fuel"],
            "P_d_ox": entry["pressures"]["P_d_ox"],
            "P_ch": entry["engine"]["P_ch"],
            "F": entry["engine"]["F"],
            "MR": entry["engine"]["MR"],
            "mdot_F": entry["engine"]["mdot_F"],
            "mdot_O": entry["engine"]["mdot_O"],
            "u_proposed_F": entry["control"]["u_proposed_F"],
            "u_proposed_O": entry["control"]["u_proposed_O"],
            "u_filtered_F": entry["control"]["u_filtered_F"],
            "u_filtered_O": entry["control"]["u_filtered_O"],
            "duty_F": entry["control"]["duty_F"],
            "duty_O": entry["control"]["duty_O"],
            "u_F_onoff": entry["control"]["u_F_onoff"],
            "u_O_onoff": entry["control"]["u_O_onoff"],
            "F_ref": entry["reference"]["F_ref"],
            "MR_ref": entry["reference"]["MR_ref"],
        }
        
        # Add constraint margins
        for key, value in entry["constraints"].items():
            flat_entry[f"constraint_{key}"] = value
        
        # Add w_bar components
        w_bar = entry["robustness"]["w_bar"]
        for i in range(len(w_bar)):
            flat_entry[f"w_bar_{i}"] = w_bar[i]
        
        # Write header if file is new
        file_exists = self.log_path.exists()
        with open(self.log_path, 'a', newline='') as f:
            writer = csv.DictWriter(f, fieldnames=flat_entry.keys())
            if not file_exists:
                writer.writeheader()
            writer.writerow(flat_entry)
    
    def save(self, filepath: Optional[str] = None) -> None:
        """
        Save all logs to file.
        
        Parameters:
        -----------
        filepath : str, optional
            Path to save file. If None, uses self.log_file.
        """
        if filepath:
            path = Path(filepath)
        elif self.log_path:
            path = self.log_path
        else:
            raise ValueError("No filepath specified")
        
        path.parent.mkdir(parents=True, exist_ok=True)
        
        if self.format == "json":
            with open(path, 'w') as f:
                json.dump(self.logs, f, indent=2)
        elif self.format == "csv":
            if self.logs:
                with open(path, 'w', newline='') as f:
                    # Flatten first entry to get fieldnames
                    first_entry = self.logs[0]
                    flat_entry = self._flatten_entry(first_entry)
                    writer = csv.DictWriter(f, fieldnames=flat_entry.keys())
                    writer.writeheader()
                    for entry in self.logs:
                        writer.writerow(self._flatten_entry(entry))
    
    def _flatten_entry(self, entry: Dict[str, Any]) -> Dict[str, Any]:
        """Flatten nested entry for CSV."""
        flat = {
            "tick": entry["tick"],
            "timestamp": entry["timestamp"],
            "P_copv": entry["pressures"]["P_copv"],
            "P_reg": entry["pressures"]["P_reg"],
            "P_u_fuel": entry["pressures"]["P_u_fuel"],
            "P_u_ox": entry["pressures"]["P_u_ox"],
            "P_d_fuel": entry["pressures"]["P_d_fuel"],
            "P_d_ox": entry["pressures"]["P_d_ox"],
            "P_ch": entry["engine"]["P_ch"] or "",
            "F": entry["engine"]["F"] or "",
            "MR": entry["engine"]["MR"] or "",
            "mdot_F": entry["engine"]["mdot_F"] or "",
            "mdot_O": entry["engine"]["mdot_O"] or "",
            "u_proposed_F": entry["control"]["u_proposed_F"],
            "u_proposed_O": entry["control"]["u_proposed_O"],
            "u_filtered_F": entry["control"]["u_filtered_F"],
            "u_filtered_O": entry["control"]["u_filtered_O"],
            "duty_F": entry["control"]["duty_F"],
            "duty_O": entry["control"]["duty_O"],
            "u_F_onoff": entry["control"]["u_F_onoff"],
            "u_O_onoff": entry["control"]["u_O_onoff"],
            "F_ref": entry["reference"]["F_ref"] or "",
            "MR_ref": entry["reference"]["MR_ref"] or "",
        }
        
        # Add constraint margins
        for key, value in entry["constraints"].items():
            flat[f"constraint_{key}"] = value
        
        # Add w_bar components
        w_bar = entry["robustness"]["w_bar"]
        for i in range(len(w_bar)):
            flat[f"w_bar_{i}"] = w_bar[i]
        
        return flat
    
    @classmethod
    def load(cls, filepath: str) -> List[Dict[str, Any]]:
        """
        Load logs from file.
        
        Parameters:
        -----------
        filepath : str
            Path to log file
        
        Returns:
        --------
        logs : List[Dict[str, Any]]
            List of log entries
        """
        path = Path(filepath)
        
        if path.suffix == '.json':
            with open(path, 'r') as f:
                return json.load(f)
        elif path.suffix == '.csv':
            logs = []
            with open(path, 'r') as f:
                reader = csv.DictReader(f)
                for row in reader:
                    # Reconstruct nested structure
                    entry = {
                        "tick": int(row["tick"]),
                        "timestamp": float(row["timestamp"]),
                        "pressures": {
                            "P_copv": float(row["P_copv"]),
                            "P_reg": float(row["P_reg"]),
                            "P_u_fuel": float(row["P_u_fuel"]),
                            "P_u_ox": float(row["P_u_ox"]),
                            "P_d_fuel": float(row["P_d_fuel"]),
                            "P_d_ox": float(row["P_d_ox"]),
                        },
                        "engine": {
                            "P_ch": float(row["P_ch"]) if row["P_ch"] else None,
                            "F": float(row["F"]) if row["F"] else None,
                            "MR": float(row["MR"]) if row["MR"] else None,
                            "mdot_F": float(row["mdot_F"]) if row["mdot_F"] else None,
                            "mdot_O": float(row["mdot_O"]) if row["mdot_O"] else None,
                        },
                        "control": {
                            "u_proposed_F": float(row["u_proposed_F"]),
                            "u_proposed_O": float(row["u_proposed_O"]),
                            "u_filtered_F": float(row["u_filtered_F"]),
                            "u_filtered_O": float(row["u_filtered_O"]),
                            "duty_F": float(row["duty_F"]),
                            "duty_O": float(row["duty_O"]),
                            "u_F_onoff": bool(int(row["u_F_onoff"])) if row["u_F_onoff"] else False,
                            "u_O_onoff": bool(int(row["u_O_onoff"])) if row["u_O_onoff"] else False,
                        },
                        "reference": {
                            "F_ref": float(row["F_ref"]) if row["F_ref"] else None,
                            "MR_ref": float(row["MR_ref"]) if row["MR_ref"] else None,
                        },
                        "constraints": {},
                        "robustness": {"w_bar": []},
                    }
                    
                    # Extract constraints
                    for key in row.keys():
                        if key.startswith("constraint_"):
                            constraint_name = key[len("constraint_"):]
                            entry["constraints"][constraint_name] = float(row[key])
                    
                    # Extract w_bar
                    w_bar = []
                    i = 0
                    while f"w_bar_{i}" in row:
                        w_bar.append(float(row[f"w_bar_{i}"]))
                        i += 1
                    entry["robustness"]["w_bar"] = w_bar
                    
                    logs.append(entry)
            return logs
        else:
            raise ValueError(f"Unsupported file format: {path.suffix}")

