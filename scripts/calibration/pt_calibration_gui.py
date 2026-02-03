#!/usr/bin/env python3
"""
High-Performance PT Calibration GUI
Real-time calibration with sub-10ms latency and professional interface
"""

import sys
import os
import time
import threading
import queue
import json
import numpy as np
import tkinter as tk
from tkinter import ttk, messagebox, filedialog
import matplotlib.pyplot as plt
from matplotlib.backends.backend_tkagg import FigureCanvasTkAgg
from matplotlib.figure import Figure
import serial
import struct
from collections import deque
from datetime import datetime
import logging
from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple
import subprocess
import signal

# Configure logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

@dataclass
class PTMeasurement:
    """PT measurement data structure"""
    sensor_id: int
    voltage: float
    timestamp: float
    pt_location: str
    filtered_voltage: float = 0.0
    calculated_pressure: float = 0.0
    reference_pressure: float = 0.0
    temperature: float = 25.0
    humidity: float = 50.0

@dataclass
class CalibrationPoint:
    """Calibration data point"""
    voltages: List[float]  # One per sensor
    reference_pressures: List[float]  # One per gauge
    timestamp: float
    environmental_conditions: Dict[str, float]

class HighPerformanceCalibrationGUI:
    """High-performance calibration GUI with real-time feedback"""
    
    def __init__(self):
        self.root = tk.Tk()
        self.root.title("PT Calibration System - Diablo FSW")
        self.root.geometry("1600x1000")
        self.root.configure(bg='#2b2b2b')
        
        # Data structures
        self.pt_measurements: Dict[int, deque] = {i: deque(maxlen=1000) for i in range(9)}
        self.calibration_points: List[CalibrationPoint] = []
        self.calibration_polynomials: Dict[int, np.ndarray] = {}
        self.reference_gauges: Dict[int, float] = {}
        self.gauge_mapping: Dict[int, int] = {}  # PT sensor -> gauge mapping
        
        # Real-time data
        self.latest_measurements: Dict[int, PTMeasurement] = {}
        self.data_queue = queue.Queue(maxsize=1000)
        self.calibration_active = False
        self.recording_data = False
        
        # Serial connection
        self.serial_connection: Optional[serial.Serial] = None
        self.serial_thread: Optional[threading.Thread] = None
        self.stop_serial = threading.Event()
        
        # Performance tracking
        self.performance_stats = {
            'data_rate_hz': 0.0,
            'latency_ms': 0.0,
            'packet_loss_rate': 0.0,
            'last_update': time.time()
        }
        
        # Initialize GUI
        self.setup_gui()
        self.setup_serial()
        self.start_data_processing()
        
    def setup_gui(self):
        """Setup the GUI layout"""
        # Main container
        main_frame = ttk.Frame(self.root)
        main_frame.pack(fill=tk.BOTH, expand=True, padx=10, pady=10)
        
        # Control panel
        self.setup_control_panel(main_frame)
        
        # Data display area
        self.setup_data_display(main_frame)
        
        # Real-time plots
        self.setup_realtime_plots(main_frame)
        
        # Status bar
        self.setup_status_bar(main_frame)
        
    def setup_control_panel(self, parent):
        """Setup control panel"""
        control_frame = ttk.LabelFrame(parent, text="Calibration Controls", padding=10)
        control_frame.grid(row=0, column=0, columnspan=2, sticky='ew', pady=(0, 10))
        
        # Connection controls
        conn_frame = ttk.Frame(control_frame)
        conn_frame.pack(fill=tk.X, pady=(0, 10))
        
        ttk.Label(conn_frame, text="Serial Port:").pack(side=tk.LEFT)
        self.port_var = tk.StringVar(value="/dev/ttyUSB0")
        port_combo = ttk.Combobox(conn_frame, textvariable=self.port_var, width=15)
        port_combo['values'] = self.get_available_ports()
        port_combo.pack(side=tk.LEFT, padx=(5, 10))
        
        self.connect_btn = ttk.Button(conn_frame, text="Connect", command=self.toggle_connection)
        self.connect_btn.pack(side=tk.LEFT, padx=(0, 10))
        
        # Calibration controls
        calib_frame = ttk.Frame(control_frame)
        calib_frame.pack(fill=tk.X, pady=(0, 10))
        
        self.calibration_btn = ttk.Button(calib_frame, text="Start Calibration", 
                                        command=self.toggle_calibration, state='disabled')
        self.calibration_btn.pack(side=tk.LEFT, padx=(0, 10))
        
        self.record_btn = ttk.Button(calib_frame, text="Record Data Point", 
                                   command=self.record_calibration_point, state='disabled')
        self.record_btn.pack(side=tk.LEFT, padx=(0, 10))
        
        self.fit_btn = ttk.Button(calib_frame, text="Fit Calibration", 
                                command=self.fit_calibration, state='disabled')
        self.fit_btn.pack(side=tk.LEFT, padx=(0, 10))
        
        self.save_btn = ttk.Button(calib_frame, text="Save Calibration", 
                                 command=self.save_calibration, state='disabled')
        self.save_btn.pack(side=tk.LEFT)
        
        # Reference pressure input
        ref_frame = ttk.Frame(control_frame)
        ref_frame.pack(fill=tk.X)
        
        ttk.Label(ref_frame, text="Reference Pressures (kPa):").pack(side=tk.LEFT)
        self.ref_pressures = []
        for i in range(9):
            ref_var = tk.StringVar()
            ref_entry = ttk.Entry(ref_frame, textvariable=ref_var, width=8)
            ref_entry.pack(side=tk.LEFT, padx=(5, 2))
            self.ref_pressures.append(ref_var)
            
    def setup_data_display(self, parent):
        """Setup real-time data display"""
        data_frame = ttk.LabelFrame(parent, text="Real-Time Data", padding=10)
        data_frame.grid(row=1, column=0, sticky='nsew', padx=(0, 5))
        
        # Create data display tree
        columns = ('Sensor', 'Location', 'Voltage (V)', 'Pressure (kPa)', 'Filtered (V)', 'Status')
        self.data_tree = ttk.Treeview(data_frame, columns=columns, show='headings', height=10)
        
        for col in columns:
            self.data_tree.heading(col, text=col)
            self.data_tree.column(col, width=100, anchor='center')
            
        # Add scrollbar
        scrollbar = ttk.Scrollbar(data_frame, orient=tk.VERTICAL, command=self.data_tree.yview)
        self.data_tree.configure(yscrollcommand=scrollbar.set)
        
        self.data_tree.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        scrollbar.pack(side=tk.RIGHT, fill=tk.Y)
        
        # Initialize sensor rows
        pt_locations = [
            "Pressurant Tank", "Kero Inlet", "Kero Outlet", "Lox Inlet", "Lox Outlet",
            "Injector", "Chamber Wall #1", "Chamber Wall #2", "Nozzle Exit"
        ]
        
        for i, location in enumerate(pt_locations):
            self.data_tree.insert('', 'end', values=(
                f"PT {i}", location, "0.000", "0.000", "0.000", "Offline"
            ))
            
    def setup_realtime_plots(self, parent):
        """Setup real-time plotting area"""
        plot_frame = ttk.LabelFrame(parent, text="Real-Time Plots", padding=10)
        plot_frame.grid(row=1, column=1, sticky='nsew', padx=(5, 0))
        
        # Create matplotlib figure
        self.fig = Figure(figsize=(8, 6), dpi=100)
        self.fig.patch.set_facecolor('#2b2b2b')
        
        # Create subplots
        self.ax_voltage = self.fig.add_subplot(2, 1, 1)
        self.ax_pressure = self.fig.add_subplot(2, 1, 2)
        
        # Configure plots
        self.ax_voltage.set_title('Real-Time Voltage Readings', color='white')
        self.ax_voltage.set_ylabel('Voltage (V)', color='white')
        self.ax_voltage.tick_params(colors='white')
        self.ax_voltage.set_facecolor('#3b3b3b')
        
        self.ax_pressure.set_title('Real-Time Pressure Readings', color='white')
        self.ax_pressure.set_xlabel('Time (s)', color='white')
        self.ax_pressure.set_ylabel('Pressure (kPa)', color='white')
        self.ax_pressure.tick_params(colors='white')
        self.ax_pressure.set_facecolor('#3b3b3b')
        
        # Embed in tkinter
        self.canvas = FigureCanvasTkAgg(self.fig, plot_frame)
        self.canvas.get_tk_widget().pack(fill=tk.BOTH, expand=True)
        
        # Initialize plot data
        self.plot_data = {
            'time': deque(maxlen=1000),
            'voltages': {i: deque(maxlen=1000) for i in range(9)},
            'pressures': {i: deque(maxlen=1000) for i in range(9)}
        }
        
    def setup_status_bar(self, parent):
        """Setup status bar"""
        status_frame = ttk.Frame(parent)
        status_frame.grid(row=2, column=0, columnspan=2, sticky='ew', pady=(10, 0))
        
        self.status_var = tk.StringVar(value="Ready")
        ttk.Label(status_frame, textvariable=self.status_var).pack(side=tk.LEFT)
        
        # Performance indicators
        perf_frame = ttk.Frame(status_frame)
        perf_frame.pack(side=tk.RIGHT)
        
        self.data_rate_var = tk.StringVar(value="Data Rate: 0 Hz")
        self.latency_var = tk.StringVar(value="Latency: 0 ms")
        
        ttk.Label(perf_frame, textvariable=self.data_rate_var).pack(side=tk.LEFT, padx=(10, 0))
        ttk.Label(perf_frame, textvariable=self.latency_var).pack(side=tk.LEFT, padx=(10, 0))
        
        # Configure grid weights
        parent.grid_rowconfigure(1, weight=1)
        parent.grid_columnconfigure(0, weight=1)
        parent.grid_columnconfigure(1, weight=1)
        
    def get_available_ports(self):
        """Get list of available serial ports"""
        ports = []
        try:
            import serial.tools.list_ports
            for port in serial.tools.list_ports.comports():
                ports.append(port.device)
        except:
            # Fallback for systems without pyserial tools
            for i in range(10):
                ports.extend([f"/dev/ttyUSB{i}", f"/dev/ttyACM{i}", f"COM{i}"])
        return ports
        
    def setup_serial(self):
        """Setup serial connection"""
        try:
            self.serial_connection = serial.Serial(
                port=self.port_var.get(),
                baudrate=115200,
                timeout=0.001,  # 1ms timeout for low latency
                write_timeout=0.1
            )
            self.serial_connection.reset_input_buffer()
            self.serial_connection.reset_output_buffer()
            logger.info(f"Serial connection established on {self.port_var.get()}")
            return True
        except Exception as e:
            logger.error(f"Failed to connect to serial port: {e}")
            messagebox.showerror("Connection Error", f"Failed to connect to {self.port_var.get()}: {e}")
            return False
            
    def start_data_processing(self):
        """Start the data processing thread"""
        self.data_thread = threading.Thread(target=self.data_processor, daemon=True)
        self.data_thread.start()
        
        # Start GUI update timer
        self.update_gui()
        
    def data_processor(self):
        """High-performance data processing thread"""
        while not self.stop_serial.is_set():
            if self.serial_connection and self.serial_connection.is_open:
                try:
                    # Read binary data with minimal latency
                    if self.serial_connection.in_waiting >= 20:  # ESP32SampleRecord size
                        data = self.serial_connection.read(20)
                        if len(data) == 20:
                            # Parse binary data (matching ESP32SampleRecord structure)
                            timestamp_us, channel, voltage_raw, voltage, read_time_us, sps, sent_us = struct.unpack('<I B i f I f I', data)
                            
                            # Create measurement
                            measurement = PTMeasurement(
                                sensor_id=channel,
                                voltage=voltage,
                                timestamp=time.time(),
                                pt_location=f"PT {channel}",
                                temperature=25.0,  # Could be read from sensors
                                humidity=50.0
                            )
                            
                            # Apply high-performance filtering
                            measurement.filtered_voltage = self.apply_kalman_filter(measurement.voltage, channel)
                            
                            # Calculate pressure if calibrated
                            if channel in self.calibration_polynomials:
                                measurement.calculated_pressure = np.polyval(
                                    self.calibration_polynomials[channel], 
                                    measurement.filtered_voltage
                                )
                            
                            # Update latest measurements
                            self.latest_measurements[channel] = measurement
                            
                            # Update performance stats
                            self.update_performance_stats()
                            
                except Exception as e:
                    logger.error(f"Error processing serial data: {e}")
                    time.sleep(0.001)  # 1ms sleep on error
            else:
                time.sleep(0.001)
                
    def apply_kalman_filter(self, voltage: float, sensor_id: int) -> float:
        """Apply Kalman filter for high-performance voltage filtering"""
        if not hasattr(self, 'kalman_states'):
            self.kalman_states = {}
            
        if sensor_id not in self.kalman_states:
            # Initialize Kalman filter state
            self.kalman_states[sensor_id] = {
                'x': voltage,  # State estimate
                'P': 1.0,     # Error covariance
                'Q': 0.01,    # Process noise
                'R': 0.1      # Measurement noise
            }
            
        state = self.kalman_states[sensor_id]
        
        # Predict step
        state['P'] += state['Q']
        
        # Update step
        K = state['P'] / (state['P'] + state['R'])  # Kalman gain
        state['x'] += K * (voltage - state['x'])
        state['P'] *= (1 - K)
        
        return state['x']
        
    def update_performance_stats(self):
        """Update performance statistics"""
        current_time = time.time()
        time_diff = current_time - self.performance_stats['last_update']
        
        if time_diff > 0.1:  # Update every 100ms
            self.performance_stats['data_rate_hz'] = 1.0 / time_diff if time_diff > 0 else 0
            self.performance_stats['latency_ms'] = time_diff * 1000
            self.performance_stats['last_update'] = current_time
            
    def update_gui(self):
        """Update GUI elements"""
        # Update data tree
        for item in self.data_tree.get_children():
            values = list(self.data_tree.item(item)['values'])
            sensor_id = int(values[0].split()[1])
            
            if sensor_id in self.latest_measurements:
                measurement = self.latest_measurements[sensor_id]
                values[2] = f"{measurement.voltage:.3f}"
                values[3] = f"{measurement.calculated_pressure:.1f}"
                values[4] = f"{measurement.filtered_voltage:.3f}"
                values[5] = "Online" if measurement.calculated_pressure > 0 else "Uncalibrated"
            else:
                values[2] = "0.000"
                values[3] = "0.000"
                values[4] = "0.000"
                values[5] = "Offline"
                
            self.data_tree.item(item, values=values)
            
        # Update plots
        self.update_plots()
        
        # Update performance indicators
        self.data_rate_var.set(f"Data Rate: {self.performance_stats['data_rate_hz']:.1f} Hz")
        self.latency_var.set(f"Latency: {self.performance_stats['latency_ms']:.1f} ms")
        
        # Schedule next update
        self.root.after(50, self.update_gui)  # 20 FPS update rate
        
    def update_plots(self):
        """Update real-time plots"""
        current_time = time.time()
        
        # Clear and redraw voltage plot
        self.ax_voltage.clear()
        self.ax_voltage.set_title('Real-Time Voltage Readings', color='white')
        self.ax_voltage.set_ylabel('Voltage (V)', color='white')
        self.ax_voltage.tick_params(colors='white')
        self.ax_voltage.set_facecolor('#3b3b3b')
        
        # Plot voltage data for active sensors
        for sensor_id, measurement in self.latest_measurements.items():
            if len(self.pt_measurements[sensor_id]) > 1:
                times = [m.timestamp - current_time for m in self.pt_measurements[sensor_id]]
                voltages = [m.filtered_voltage for m in self.pt_measurements[sensor_id]]
                self.ax_voltage.plot(times, voltages, label=f'PT {sensor_id}', linewidth=1)
                
        self.ax_voltage.legend()
        
        # Clear and redraw pressure plot
        self.ax_pressure.clear()
        self.ax_pressure.set_title('Real-Time Pressure Readings', color='white')
        self.ax_pressure.set_xlabel('Time (s)', color='white')
        self.ax_pressure.set_ylabel('Pressure (kPa)', color='white')
        self.ax_pressure.tick_params(colors='white')
        self.ax_pressure.set_facecolor('#3b3b3b')
        
        # Plot pressure data for calibrated sensors
        for sensor_id, measurement in self.latest_measurements.items():
            if sensor_id in self.calibration_polynomials and len(self.pt_measurements[sensor_id]) > 1:
                times = [m.timestamp - current_time for m in self.pt_measurements[sensor_id]]
                pressures = [m.calculated_pressure for m in self.pt_measurements[sensor_id]]
                self.ax_pressure.plot(times, pressures, label=f'PT {sensor_id}', linewidth=1)
                
        self.ax_pressure.legend()
        
        self.canvas.draw_idle()
        
    def toggle_connection(self):
        """Toggle serial connection"""
        if self.serial_connection and self.serial_connection.is_open:
            self.disconnect()
        else:
            self.connect()
            
    def connect(self):
        """Connect to serial port"""
        if self.setup_serial():
            self.connect_btn.config(text="Disconnect")
            self.calibration_btn.config(state='normal')
            self.status_var.set("Connected")
            logger.info("Connected to serial port")
        else:
            self.status_var.set("Connection Failed")
            
    def disconnect(self):
        """Disconnect from serial port"""
        if self.serial_connection:
            self.serial_connection.close()
        self.connect_btn.config(text="Connect")
        self.calibration_btn.config(state='disabled')
        self.record_btn.config(state='disabled')
        self.fit_btn.config(state='disabled')
        self.status_var.set("Disconnected")
        logger.info("Disconnected from serial port")
        
    def toggle_calibration(self):
        """Toggle calibration mode"""
        self.calibration_active = not self.calibration_active
        if self.calibration_active:
            self.calibration_btn.config(text="Stop Calibration")
            self.record_btn.config(state='normal')
            self.status_var.set("Calibration Mode Active")
        else:
            self.calibration_btn.config(text="Start Calibration")
            self.record_btn.config(state='disabled')
            self.fit_btn.config(state='normal')
            self.status_var.set("Ready")
            
    def record_calibration_point(self):
        """Record current measurements as calibration point"""
        if not self.calibration_active:
            return
            
        # Get reference pressures from GUI
        reference_pressures = []
        for i, ref_var in enumerate(self.ref_pressures):
            try:
                pressure = float(ref_var.get()) if ref_var.get() else 0.0
                reference_pressures.append(pressure)
            except ValueError:
                messagebox.showerror("Invalid Input", f"Invalid pressure value for gauge {i+1}")
                return
                
        # Get current measurements
        voltages = []
        for sensor_id in range(9):
            if sensor_id in self.latest_measurements:
                voltages.append(self.latest_measurements[sensor_id].filtered_voltage)
            else:
                voltages.append(0.0)
                
        # Create calibration point
        calibration_point = CalibrationPoint(
            voltages=voltages,
            reference_pressures=reference_pressures,
            timestamp=time.time(),
            environmental_conditions={'temperature': 25.0, 'humidity': 50.0}
        )
        
        self.calibration_points.append(calibration_point)
        
        # Show confirmation
        messagebox.showinfo("Data Recorded", f"Calibration point recorded!\nTotal points: {len(self.calibration_points)}")
        
    def fit_calibration(self):
        """Fit calibration polynomials"""
        if len(self.calibration_points) < 3:
            messagebox.showerror("Insufficient Data", "Need at least 3 calibration points")
            return
            
        # Fit polynomials for each sensor
        for sensor_id in range(9):
            voltages = []
            pressures = []
            
            for point in self.calibration_points:
                if sensor_id < len(point.voltages) and sensor_id < len(point.reference_pressures):
                    voltages.append(point.voltages[sensor_id])
                    pressures.append(point.reference_pressures[sensor_id])
                    
            if len(voltages) >= 3 and len(set(voltages)) > 1:  # Need unique voltage values
                try:
                    # Fit polynomial (degree 2 for good fit without overfitting)
                    poly_coeffs = np.polyfit(voltages, pressures, 2)
                    self.calibration_polynomials[sensor_id] = poly_coeffs
                    
                    # Calculate R-squared
                    y_pred = np.polyval(poly_coeffs, voltages)
                    ss_res = np.sum((pressures - y_pred) ** 2)
                    ss_tot = np.sum((pressures - np.mean(pressures)) ** 2)
                    r_squared = 1 - (ss_res / ss_tot) if ss_tot > 0 else 0
                    
                    logger.info(f"PT {sensor_id} calibration fitted: R² = {r_squared:.3f}")
                    
                except Exception as e:
                    logger.error(f"Failed to fit calibration for PT {sensor_id}: {e}")
                    
        self.save_btn.config(state='normal')
        messagebox.showinfo("Calibration Complete", "Calibration polynomials fitted successfully!")
        
    def save_calibration(self):
        """Save calibration data"""
        filename = filedialog.asksaveasfilename(
            defaultextension=".json",
            filetypes=[("JSON files", "*.json"), ("All files", "*.*")],
            title="Save Calibration Data"
        )
        
        if filename:
            calibration_data = {
                'timestamp': datetime.now().isoformat(),
                'calibration_points': [
                    {
                        'voltages': cp.voltages,
                        'reference_pressures': cp.reference_pressures,
                        'timestamp': cp.timestamp,
                        'environmental_conditions': cp.environmental_conditions
                    }
                    for cp in self.calibration_points
                ],
                'calibration_polynomials': {
                    str(sensor_id): coeffs.tolist()
                    for sensor_id, coeffs in self.calibration_polynomials.items()
                }
            }
            
            with open(filename, 'w') as f:
                json.dump(calibration_data, f, indent=2)
                
            messagebox.showinfo("Saved", f"Calibration data saved to {filename}")
            
    def run(self):
        """Run the GUI"""
        try:
            self.root.mainloop()
        except KeyboardInterrupt:
            logger.info("GUI interrupted by user")
        finally:
            self.cleanup()
            
    def cleanup(self):
        """Cleanup resources"""
        self.stop_serial.set()
        if self.serial_connection and self.serial_connection.is_open:
            self.serial_connection.close()
        logger.info("GUI cleanup complete")

def main():
    """Main entry point"""
    try:
        app = HighPerformanceCalibrationGUI()
        app.run()
    except Exception as e:
        logger.error(f"GUI failed to start: {e}")
        messagebox.showerror("Startup Error", f"Failed to start calibration GUI: {e}")

if __name__ == "__main__":
    main()
