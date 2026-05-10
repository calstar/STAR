#!/usr/bin/env python3
import sys
import time
import threading
import struct
from collections import deque
import queue

import serial
import serial.tools.list_ports

import tkinter as tk
from tkinter import ttk, messagebox

import matplotlib
matplotlib.use("TkAgg")
from matplotlib.figure import Figure
from matplotlib.backends.backend_tkagg import FigureCanvasTkAgg
import matplotlib.animation as animation

# ---------------- Config ----------------
NUM_CHANNELS = 10
MAX_POINTS = 2000
TIMING_MAX_POINTS = 1000
# Packet: <uint32 t_us, uint8 ch, int32 raw, float volts, uint32 read_us, float sps>
PACK_FMT = "<IBifIf"
PACK_SIZE = struct.calcsize(PACK_FMT)
DEFAULT_BAUD = 115200

RAW_MIN = -8388608
RAW_MAX =  8388607
# ---------------------------------------

def reltime_sec_32(cur_us, base_us):
    """Return (cur - base) in seconds with uint32 rollover handling."""
    return ((cur_us - base_us) & 0xFFFFFFFF) / 1_000_000.0

def record_is_plausible(t_us, ch, raw, volts, read_us, sps):
    if not (0 <= ch < NUM_CHANNELS):
        return False
    if not (RAW_MIN <= raw <= RAW_MAX):
        return False
    if not (-10.0 <= volts <= 10.0):
        return False
    if not (1 <= read_us <= 2_000_000):  # 1 us .. 2 s
        return False
    if not (0.0 <= sps <= 2_000_000.0):
        return False
    return True

class SerialReader(threading.Thread):
    """Reads bytes, maintains framing with plausibility-based resync, pushes tuples to a queue."""
    def __init__(self, port, baud, out_queue, on_error):
        super().__init__(daemon=True)
        self.port = port
        self.baud = baud
        self.out_queue = out_queue
        self.on_error = on_error
        self._stop = threading.Event()
        self.ser = None
        self.buf = bytearray()
        self.synced = False

    def stop(self):
        self._stop.set()
        try:
            if self.ser and self.ser.is_open:
                self.ser.close()
        except Exception:
            pass

    def _read_available(self):
        try:
            return self.ser.read(self.ser.in_waiting or 1)
        except Exception as e:
            self.on_error(f"Read error: {e}")
            return b""

    def _resync(self):
        """Search buffer for the first plausible record boundary."""
        # Try each starting offset in current buffer
        n = len(self.buf)
        for start in range(max(0, n - 4 * PACK_SIZE + 1)):
            try:
                rec1 = struct.unpack_from(PACK_FMT, self.buf, start)
                if not record_is_plausible(*rec1):
                    continue
                # Check that one more record after it is also plausible
                off2 = start + PACK_SIZE
                if n - off2 < PACK_SIZE:
                    break  # need more bytes
                rec2 = struct.unpack_from(PACK_FMT, self.buf, off2)
                if not record_is_plausible(*rec2):
                    continue
                # Found alignment
                if start > 0:
                    del self.buf[:start]
                self.synced = True
                return True
            except struct.error:
                continue
        return False

    def _try_unpack_synced(self):
        recs = []
        while len(self.buf) >= PACK_SIZE:
            chunk = self.buf[:PACK_SIZE]
            try:
                rec = struct.unpack(PACK_FMT, chunk)
            except struct.error:
                # should not happen when length is enough; fall out to resync
                self.synced = False
                del self.buf[0]
                break

            if record_is_plausible(*rec):
                recs.append(rec)
                del self.buf[:PACK_SIZE]
            else:
                # Lost framing
                self.synced = False
                del self.buf[0]
                break
        return recs

    def run(self):
        try:
            self.ser = serial.Serial(self.port, self.baud, timeout=0.05)
        except Exception as e:
            self.on_error(f"Could not open {self.port}: {e}")
            return

        time.sleep(0.2)
        while not self._stop.is_set():
            try:
                data = self._read_available()
                if data:
                    self.buf.extend(data)

                    if not self.synced:
                        self._resync()

                    if self.synced:
                        recs = self._try_unpack_synced()
                        for r in recs:
                            self.out_queue.put(r)
            except serial.SerialException as e:
                self.on_error(f"Serial error: {e}")
                break
            except Exception as e:
                self.on_error(f"Unexpected error: {e}")
                break

        try:
            if self.ser and self.ser.is_open:
                self.ser.close()
        except Exception:
            pass


class App(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("ADS126x Live Plotter")
        self.geometry("1200x800")

        # Data buffers
        self.chan_t = [deque(maxlen=MAX_POINTS) for _ in range(NUM_CHANNELS)]
        self.chan_v = [deque(maxlen=MAX_POINTS) for _ in range(NUM_CHANNELS)]
        self.timing_t = deque(maxlen=TIMING_MAX_POINTS)
        self.timing_read_us = deque(maxlen=TIMING_MAX_POINTS)
        self.timing_sps = deque(maxlen=TIMING_MAX_POINTS)
        self.t0_us = None

        # Serial
        self.reader = None
        self.q = queue.Queue()

        # Build UI
        self._build_ui()

        # Animation
        self.ani = animation.FuncAnimation(
            self.fig, self._update_animation, interval=50, blit=False
        )

        # Populate ports after UI shows
        self.after(200, self._populate_ports)

    # ------------ UI ------------
    def _build_ui(self):
        top = ttk.Frame(self, padding=8)
        top.pack(fill="x")

        ttk.Label(top, text="Port:").pack(side="left")
        self.cmb_port = ttk.Combobox(top, values=[], width=28, state="readonly")
        self.cmb_port.pack(side="left", padx=6)

        ttk.Label(top, text="Baud:").pack(side="left", padx=(12, 0))
        self.cmb_baud = ttk.Combobox(
            top,
            values=[9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600],
            width=10,
            state="readonly",
        )
        self.cmb_baud.set(DEFAULT_BAUD)
        self.cmb_baud.pack(side="left", padx=6)

        ttk.Button(top, text="Refresh", command=self._populate_ports).pack(side="left", padx=(12, 6))
        self.btn_connect = ttk.Button(top, text="Connect", command=self._toggle_connect)
        self.btn_connect.pack(side="left")

        self.lbl_status = ttk.Label(top, text="Disconnected")
        self.lbl_status.pack(side="right")

        # Matplotlib figures embedded
        self.fig = Figure(figsize=(10, 6), dpi=100)
        gs = self.fig.add_gridspec(3, 1, height_ratios=[2.0, 1.0, 1.0], hspace=0.35)

        self.ax_volt = self.fig.add_subplot(gs[0, 0])
        self.ax_rt = self.fig.add_subplot(gs[1, 0], sharex=self.ax_volt)
        self.ax_sps = self.fig.add_subplot(gs[2, 0], sharex=self.ax_volt)

        self.lines = []
        for ch in range(NUM_CHANNELS):
            (ln,) = self.ax_volt.plot([], [], lw=1.2, label=f"CH{ch}")
            self.lines.append(ln)

        self.ax_volt.set_ylabel("Voltage (V)")
        self.ax_volt.set_title("Voltages by Channel")
        self.ax_volt.legend(loc="upper right", ncol=2, fontsize=8)

        (self.line_rt,) = self.ax_rt.plot([], [], lw=1.2)
        self.ax_rt.set_ylabel("Read time (µs)")
        self.ax_rt.set_title("ADC Read Time")

        (self.line_sps,) = self.ax_sps.plot([], [], lw=1.2)
        self.ax_sps.set_xlabel("Time (s)")
        self.ax_sps.set_ylabel("Samples per second")
        self.ax_sps.set_title("Effective SPS")

        canvas = FigureCanvasTkAgg(self.fig, master=self)
        canvas.draw()
        canvas.get_tk_widget().pack(fill="both", expand=True, padx=8, pady=8)

    # ------------ Serial and ports ------------
    def _populate_ports(self):
        ports = [p.device for p in serial.tools.list_ports.comports()]
        self.cmb_port["values"] = ports
        if ports:
            if not self.cmb_port.get():
                self.cmb_port.set(ports[0])
        else:
            self.cmb_port.set("")

    def _toggle_connect(self):
        if self.reader is None:
            port = self.cmb_port.get().strip()
            if not port:
                messagebox.showwarning("Select Port", "Choose a serial port")
                return
            try:
                baud = int(self.cmb_baud.get())
            except Exception:
                messagebox.showwarning("Baud", "Choose a valid baud rate")
                return

            # Reset buffers
            for ch in range(NUM_CHANNELS):
                self.chan_t[ch].clear()
                self.chan_v[ch].clear()
            self.timing_t.clear()
            self.timing_read_us.clear()
            self.timing_sps.clear()
            self.t0_us = None
            self.q = queue.Queue()

            self.reader = SerialReader(
                port=port, baud=baud, out_queue=self.q, on_error=self._on_serial_error
            )
            self.reader.start()
            self.lbl_status.config(text=f"Connected to {port} @ {baud}")
            self.btn_connect.config(text="Disconnect")
        else:
            self.reader.stop()
            self.reader = None
            self.lbl_status.config(text="Disconnected")
            self.btn_connect.config(text="Connect")

    def _on_serial_error(self, msg):
        self.after(0, self._handle_serial_error_ui, msg)

    def _handle_serial_error_ui(self, msg):
        if self.reader:
            try:
                self.reader.stop()
            except Exception:
                pass
            self.reader = None
        self.lbl_status.config(text=msg)
        try:
            messagebox.showerror("Serial Error", msg)
        except Exception:
            pass
        self.btn_connect.config(text="Connect")

    # ------------ Plotting helpers ------------
    @staticmethod
    def _autoscale_y(ax, series, margin=0.1):
        vals_min = []
        vals_max = []
        for s in series:
            if len(s) > 0:
                vals_min.append(min(s))
                vals_max.append(max(s))
        if not vals_min:
            return
        y_min = min(vals_min)
        y_max = max(vals_max)
        if y_max == y_min:
            pad = 1.0 if y_max == 0 else abs(y_max) * 0.1
            ax.set_ylim(y_min - pad, y_max + pad)
        else:
            rng = y_max - y_min
            ax.set_ylim(y_min - margin * rng, y_max + margin * rng)

    def _drain_queue(self):
        updated = False
        try:
            while True:
                t_us, ch, raw, volts, read_us, sps = self.q.get_nowait()
                if ch < 0 or ch >= NUM_CHANNELS:
                    continue
                if self.t0_us is None:
                    self.t0_us = t_us
                t_sec = reltime_sec_32(t_us, self.t0_us)

                self.chan_t[ch].append(t_sec)
                self.chan_v[ch].append(volts)

                self.timing_t.append(t_sec)
                self.timing_read_us.append(read_us)
                self.timing_sps.append(sps)
                updated = True
        except queue.Empty:
            pass
        return updated

    def _update_animation(self, _frame):
        self._drain_queue()

        for ch in range(NUM_CHANNELS):
            self.lines[ch].set_data(self.chan_t[ch], self.chan_v[ch])

        # X range: last 10 s, protect against reversed limits
        all_times = [t for series in self.chan_t for t in series]
        if all_times:
            xmax = max(all_times)
            xmin = max(0.0, xmax - 10.0)
            if xmax <= xmin:
                xmax = xmin + 1.0
            self.ax_volt.set_xlim(xmin, xmax)

        self._autoscale_y(self.ax_volt, self.chan_v)

        # Timing plots
        self.line_rt.set_data(self.timing_t, self.timing_read_us)
        self.line_sps.set_data(self.timing_t, self.timing_sps)

        if len(self.timing_t) > 0:
            xmax2 = self.timing_t[-1]
            xmin2 = max(0.0, xmax2 - 10.0)
            if xmax2 <= xmin2:
                xmax2 = xmin2 + 1.0
            self.ax_rt.set_xlim(xmin2, xmax2)
            self.ax_sps.set_xlim(xmin2, xmax2)

        self._autoscale_y(self.ax_rt, [self.timing_read_us])
        self._autoscale_y(self.ax_sps, [self.timing_sps])

        return (*self.lines, self.line_rt, self.line_sps)


if __name__ == "__main__":
    try:
        app = App()
        app.mainloop()
    except KeyboardInterrupt:
        sys.exit(0)
