#!/usr/bin/env python3
# ch_multi_toggle.py with COM port selector and connect/refresh buttons

import struct, threading, time, queue, sys
from collections import deque, defaultdict

import serial, serial.tools.list_ports
import tkinter as tk
from tkinter import ttk

from matplotlib.figure import Figure
from matplotlib.backends.backend_tkagg import FigureCanvasTkAgg
import matplotlib
matplotlib.use("TkAgg")

PACK_FMT = "<IBifIf"
PACK_SIZE = struct.calcsize(PACK_FMT)

PORT = None
BAUD = 115200
WINDOW_SECONDS = 10.0
MAX_POINTS = 2000
NUM_CHANNELS_MAX = 16
RAW_MIN, RAW_MAX = -2147483648, 2147483648
TOGGLE_CHANNELS = list(range(1, 11))

def plausible(rec):
    t_us, ch, raw, volts, read_us, sps = rec
    if not (0 <= ch < NUM_CHANNELS_MAX): return False
    if not (RAW_MIN <= raw <= RAW_MAX): return False
    if not (-10.0 <= volts <= 10.0): return False
    if not (1 <= read_us <= 2_000_000): return False
    if not (0.0 <= sps <= 2_000_000.0): return False
    return True

def list_ports():
    return [p.device for p in serial.tools.list_ports.comports()]

class Reader(threading.Thread):
    def __init__(self, port, baud, out_q, status_cb):
        super().__init__(daemon=True)
        self.port, self.baud = port, baud
        self.q = out_q
        self.status = status_cb
        self.stop_evt = threading.Event()
        self.ser = None
        self.buf = bytearray()
        self.synced = False

    def stop(self):
        self.stop_evt.set()
        try:
            if self.ser and self.ser.is_open:
                self.ser.close()
        except Exception:
            pass

    def _resync(self):
        n = len(self.buf)
        for start in range(max(0, n - 4 * PACK_SIZE + 1)):
            try:
                r1 = struct.unpack_from(PACK_FMT, self.buf, start)
                if not plausible(r1): continue
                off2 = start + PACK_SIZE
                if n - off2 < PACK_SIZE: break
                r2 = struct.unpack_from(PACK_FMT, self.buf, off2)
                if not plausible(r2): continue
                if start:
                    del self.buf[:start]
                self.synced = True
                return True
            except struct.error:
                continue
        return False

    def _drain_synced(self):
        out = []
        while len(self.buf) >= PACK_SIZE:
            try:
                rec = struct.unpack_from(PACK_FMT, self.buf, 0)
            except struct.error:
                self.synced = False
                del self.buf[0]
                break
            if plausible(rec):
                t_wall = time.monotonic()
                out.append((t_wall, rec))
                del self.buf[:PACK_SIZE]
            else:
                self.synced = False
                del self.buf[0]
                break
        return out

    def run(self):
        try:
            self.ser = serial.Serial(self.port, self.baud, timeout=0.05)
            self.status(f"Connected {self.port} @ {self.baud}")
        except Exception as e:
            self.status(f"Open failed: {e}")
            return

        while not self.stop_evt.is_set():
            try:
                data = self.ser.read(self.ser.in_waiting or 1)
                if data:
                    self.buf.extend(data)
                    if not self.synced:
                        self._resync()
                    if self.synced:
                        for t_wall, rec in self._drain_synced():
                            _, ch, _, volts, _, _ = rec
                            self.q.put((t_wall, ch, volts))
            except serial.SerialException as e:
                self.status(f"Serial error: {e}")
                break
            except Exception as e:
                self.status(f"Unexpected: {e}")
                break

        try:
            if self.ser and self.ser.is_open:
                self.ser.close()
        except Exception:
            pass
        self.status("Disconnected")

class App(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("Channels")
        self.geometry("1100x600")

        top = ttk.Frame(self, padding=6)
        top.pack(fill="x")

        ttk.Label(top, text="Port").pack(side="left")
        self.cmb_port = ttk.Combobox(top, values=list_ports(), width=26, state="readonly")
        if list_ports():
            self.cmb_port.set(list_ports()[0])
        self.cmb_port.pack(side="left", padx=6)

        ttk.Label(top, text="Baud").pack(side="left")
        self.cmb_baud = ttk.Combobox(top, values=[9600,19200,38400,57600,115200,230400,460800,921600], width=10, state="readonly")
        self.cmb_baud.set(BAUD)
        self.cmb_baud.pack(side="left", padx=6)

        ttk.Button(top, text="Refresh", command=self._refresh_ports).pack(side="left", padx=6)
        self.btn_connect = ttk.Button(top, text="Connect", command=self._toggle_connect)
        self.btn_connect.pack(side="left")

        self.status_var = tk.StringVar(value="Idle")
        ttk.Label(top, textvariable=self.status_var).pack(side="right")

        main = ttk.Frame(self)
        main.pack(fill="both", expand=True)

        plot_frame = ttk.Frame(main)
        plot_frame.pack(side="left", fill="both", expand=True)

        toggle_frame = ttk.Frame(main, padding=(8, 8))
        toggle_frame.pack(side="right", fill="y")

        self.q = queue.Queue()
        self.reader = None

        self.t0 = None
        self.t = defaultdict(lambda: deque(maxlen=MAX_POINTS))
        self.v = defaultdict(lambda: deque(maxlen=MAX_POINTS))

        fig = Figure(figsize=(8, 4.6), dpi=100)
        ax = fig.add_subplot(111)
        ax.set_xlabel("Time (s)")
        ax.set_ylabel("Voltage (V)")
        ax.set_title("Channels")
        ax.grid(True, alpha=0.3)
        ax.ticklabel_format(useOffset=False, style="plain", axis="both")

        self.lines = {}
        self.ax = ax
        self.canvas = FigureCanvasTkAgg(fig, master=plot_frame)
        self.canvas.draw()
        self.canvas.get_tk_widget().pack(fill="both", expand=True)

        self.selected = {}
        ttk.Label(toggle_frame, text="Show channels:").pack(anchor="w", pady=(0, 6))
        for ch in TOGGLE_CHANNELS:
            var = tk.BooleanVar(value=True)
            cb = ttk.Checkbutton(toggle_frame, text=f"CH{ch}", variable=var, command=self._on_toggle)
            cb.pack(anchor="w")
            self.selected[ch] = var

        self._refresh_legend()

        self.after(50, self._update_plot)
        self.protocol("WM_DELETE_WINDOW", self._close)

    def _refresh_ports(self):
        ports = list_ports()
        self.cmb_port["values"] = ports
        if ports:
            self.cmb_port.set(ports[0])

    def _toggle_connect(self):
        if self.reader is None:
            port = self.cmb_port.get().strip()
            try:
                baud = int(self.cmb_baud.get())
            except:
                self.status_var.set("Bad baud")
                return
            self._connect(port, baud)
            self.btn_connect.config(text="Disconnect")
        else:
            self.reader.stop()
            self.reader = None
            self.status_var.set("Disconnected")
            self.btn_connect.config(text="Connect")

    def _connect(self, port, baud):
        self.t0 = None
        self.t.clear()
        self.v.clear()
        with self.q.mutex:
            self.q.queue.clear()
        self.reader = Reader(port, baud, self.q, self.status_var.set)
        self.reader.start()

    def _on_toggle(self):
        changed = False
        for ch, var in self.selected.items():
            if var.get() and ch not in self.lines:
                (ln,) = self.ax.plot([], [], lw=1, label=f"CH{ch}")
                self.lines[ch] = ln
                changed = True
            if not var.get() and ch in self.lines:
                self.lines[ch].set_data([], [])
                changed = True
        if changed:
            self._refresh_legend()
            self.canvas.draw_idle()

    def _refresh_legend(self):
        handles, labels = [], []
        for ch, ln in self.lines.items():
            if ch in self.selected and self.selected[ch].get():
                handles.append(ln)
                labels.append(f"CH{ch}")
        if handles:
            self.ax.legend(handles, labels, loc="upper left")
        else:
            leg = self.ax.get_legend()
            if leg:
                leg.remove()

    def _update_plot(self):
        drained = 0
        try:
            while True:
                t_wall, ch, volts = self.q.get_nowait()
                if self.t0 is None:
                    self.t0 = t_wall
                t_rel = t_wall - self.t0
                if ch == 0:
                    ch = 10
                self.t[ch].append(t_rel)
                self.v[ch].append(volts)
                drained += 1
        except queue.Empty:
            pass

        if drained:
            for ch, var in self.selected.items():
                if var.get():
                    if ch not in self.lines:
                        (ln,) = self.ax.plot([], [], lw=1, label=f"CH{ch}")
                        self.lines[ch] = ln
                    self.lines[ch].set_data(self.t.get(ch, []), self.v.get(ch, []))
                else:
                    if ch in self.lines:
                        self.lines[ch].set_data([], [])

            latest = 0.0
            for ch, ln in self.lines.items():
                if ch in self.selected and self.selected[ch].get():
                    if self.t.get(ch):
                        latest = max(latest, self.t[ch][-1])
            xmin = max(0.0, latest - WINDOW_SECONDS)
            self.ax.set_xlim(xmin, max(xmin + 1e-3, latest))

            values = []
            for ch, ln in self.lines.items():
                if ch in self.selected and self.selected[ch].get():
                    values.extend(self.v.get(ch, []))
            if values:
                vmin, vmax = min(values), max(values)
                if vmax == vmin:
                    pad = 0.1 if vmax == 0 else abs(vmax) * 0.1
                    self.ax.set_ylim(vmin - pad, vmax + pad)
                else:
                    rng = vmax - vmin
                    self.ax.set_ylim(vmin - 0.1 * rng, vmax + 0.1 * rng)

            self._refresh_legend()
            self.canvas.draw_idle()

        self.after(50, self._update_plot)

    def _close(self):
        if self.reader:
            try:
                self.reader.stop()
            except Exception:
                pass
        self.destroy()

if __name__ == "__main__":
    try:
        App().mainloop()
    except KeyboardInterrupt:
        sys.exit(0)
