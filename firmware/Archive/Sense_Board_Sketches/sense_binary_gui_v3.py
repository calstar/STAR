#!/usr/bin/env python3
# Channel Plotter GUI
# - COM port selector, connect/refresh
# - Plot channels with toggles
# - Simple Metrics: windowed means of read_us and sps; per-channel mean V over last 100 ms
# - Settings window to adjust viewing window seconds
# - Raw Serial Console window (robust, thread-safe)

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
DEFAULT_WINDOW_SECONDS = 10.0
MAX_POINTS = 2000
NUM_CHANNELS_MAX = 16
RAW_MIN, RAW_MAX = -2147483648, 2147483648
TOGGLE_CHANNELS = list(range(1, 11))

VOLT_MEAN_WINDOW_S = 0.100  # 100 ms
RAW_Q_MAX = 2000            # cap console backlog


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
    def __init__(self, port, baud, out_q, status_cb, raw_q=None):
        super().__init__(daemon=True)
        self.port, self.baud = port, baud
        self.q = out_q
        self.raw_q = raw_q
        self.status = status_cb  # must be thread-safe (scheduled by caller)
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
                if not plausible(r1):
                    continue
                off2 = start + PACK_SIZE
                if n - off2 < PACK_SIZE:
                    break
                r2 = struct.unpack_from(PACK_FMT, self.buf, off2)
                if not plausible(r2):
                    continue
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
            try:
                self.status(f"Open failed: {e}")
            except Exception:
                pass
            return

        while not self.stop_evt.is_set():
            try:
                data = self.ser.read(self.ser.in_waiting or 1)
                if data:
                    # Mirror raw bytes to console queue without blocking
                    if self.raw_q is not None:
                        try:
                            self.raw_q.put_nowait(data)
                        except queue.Full:
                            # Drop if console is behind
                            pass
                    # Parse structured packets
                    self.buf.extend(data)
                    if not self.synced:
                        self._resync()
                    if self.synced:
                        for t_wall, rec in self._drain_synced():
                            self.q.put((t_wall, rec))
            except serial.SerialException as e:
                try:
                    self.status(f"Serial error: {e}")
                except Exception:
                    pass
                break
            except Exception as e:
                try:
                    self.status(f"Unexpected: {e}")
                except Exception:
                    pass
                break

        try:
            if self.ser and self.ser.is_open:
                self.ser.close()
        except Exception:
            pass
        try:
            self.status("Disconnected")
        except Exception:
            pass


class MetricsWindow(tk.Toplevel):
    def __init__(self, parent, selected_flags, t0, q, get_window_seconds):
        super().__init__(parent)
        self.title("Aggregated Metrics (read_us & sps)")
        self.geometry("900x500")
        self.selected = selected_flags
        self.q = q
        self.get_window_seconds = get_window_seconds
        self.t0 = t0
        self.t = deque(maxlen=MAX_POINTS)
        self.reads = deque()
        self.sps = deque()

        fig = Figure(figsize=(8, 4.6), dpi=100)
        self.ax1 = fig.add_subplot(211)
        self.ax2 = fig.add_subplot(212)
        self.ax1.set_ylabel("read_us")
        self.ax2.set_ylabel("sps")
        self.ax2.set_xlabel("Time (s)")
        self.ax1.grid(True, alpha=0.3)
        self.ax2.grid(True, alpha=0.3)

        (self.line_read,) = self.ax1.plot([], [], lw=1, label="read_us")
        (self.line_sps,) = self.ax2.plot([], [], lw=1, label="sps")

        self.canvas = FigureCanvasTkAgg(fig, master=self)
        self.canvas.draw()
        self.canvas.get_tk_widget().pack(fill="both", expand=True)

        self.after(100, self._update_plot)

    def _update_plot(self):
        drained = 0
        try:
            while True:
                t_wall, rec = self.q.get_nowait()
                t_us, ch, raw, volts, read_us, sps = rec
                if self.t0 is None:
                    self.t0 = t_wall
                t_rel = t_wall - self.t0
                if ch == 0:
                    ch = 10
                if ch in self.selected and self.selected[ch].get():
                    self.t.append(t_rel)
                    self.reads.append(read_us)
                    self.sps.append(sps)
                    drained += 1
        except queue.Empty:
            pass

        if drained:
            self.line_read.set_data(self.t, self.reads)
            self.line_sps.set_data(self.t, self.sps)

            window = self.get_window_seconds()
            for ax, data in [(self.ax1, self.reads), (self.ax2, self.sps)]:
                if self.t:
                    latest = self.t[-1]
                    xmin = max(0.0, latest - window)
                    ax.set_xlim(xmin, max(xmin + 1e-3, latest))
                if data:
                    vmin, vmax = min(data), max(data)
                    if vmax == vmin:
                        pad = 0.1 if vmax == 0 else abs(vmax) * 0.1
                        ax.set_ylim(vmin - pad, vmax + pad)
                    else:
                        rng = vmax - vmin
                        ax.set_ylim(vmin - 0.1 * rng, vmax + 0.1 * rng)

            self.ax1.legend(loc="upper right")
            self.ax2.legend(loc="upper right")
            self.canvas.draw_idle()

        self.after(100, self._update_plot)


class SettingsWindow(tk.Toplevel):
    def __init__(self, parent):
        super().__init__(parent)
        self.parent = parent
        self.title("Settings")
        self.geometry("360x160")
        frm = ttk.Frame(self, padding=10)
        frm.pack(fill="both", expand=True)

        ttk.Label(frm, text="Viewing window (seconds)").pack(anchor="w")
        row = ttk.Frame(frm)
        row.pack(fill="x", pady=(6,0))

        self.var = tk.DoubleVar(value=self.parent.window_seconds)
        self.lbl = ttk.Label(row, text=f"{self.var.get():.1f}s")
        self.lbl.pack(side="right")

        self.scale = ttk.Scale(row, from_=1.0, to=60.0, orient="horizontal",
                               variable=self.var, command=self._on_change)
        self.scale.pack(side="left", fill="x", expand=True)

        ttk.Button(frm, text="Close", command=self.destroy).pack(pady=(12,0))

    def _on_change(self, _evt=None):
        val = float(self.var.get())
        self.parent.window_seconds = val
        self.lbl.config(text=f"{val:.1f}s")


class ConsoleWindow(tk.Toplevel):
    def __init__(self, parent, raw_q):
        super().__init__(parent)
        self.title("Raw Serial Console")
        self.geometry("800x400")
        self.raw_q = raw_q
        self._alive = True
        self.after_id = None
        self.paused = tk.BooleanVar(value=False)

        top = ttk.Frame(self, padding=6)
        top.pack(fill="x")
        ttk.Checkbutton(top, text="Pause", variable=self.paused).pack(side="left")
        ttk.Button(top, text="Clear", command=self._clear).pack(side="left", padx=6)

        text_frame = ttk.Frame(self)
        text_frame.pack(fill="both", expand=True)

        self.text = tk.Text(text_frame, wrap="none")
        self.text.configure(font=("Courier", 10))
        self.text.configure(state="disabled")
        yscroll = ttk.Scrollbar(text_frame, orient="vertical", command=self.text.yview)
        xscroll = ttk.Scrollbar(text_frame, orient="horizontal", command=self.text.xview)
        self.text.configure(yscrollcommand=yscroll.set, xscrollcommand=xscroll.set)
        self.text.pack(side="left", fill="both", expand=True)
        yscroll.pack(side="right", fill="y")
        xscroll.pack(side="bottom", fill="x")

        self.protocol("WM_DELETE_WINDOW", self._on_close)
        self.after_id = self.after(50, self._poll)

    def _on_close(self):
        self._alive = False
        if self.after_id is not None:
            try:
                self.after_cancel(self.after_id)
            except Exception:
                pass
        try:
            self.destroy()
        except Exception:
            pass

    def _clear(self):
        try:
            self.text.configure(state="normal")
            self.text.delete("1.0", "end")
            self.text.configure(state="disabled")
        except tk.TclError:
            pass

    def _poll(self):
        if not self._alive:
            return
        try:
            if not self.paused.get():
                # drain queue and batch-insert
                chunks = []
                while True:
                    chunks.append(self.raw_q.get_nowait())
        except queue.Empty:
            pass
        except tk.TclError:
            self._alive = False
            return
        try:
            if chunks:
                s = b"".join(chunks).decode("utf-8", errors="replace")
                self.text.configure(state="normal")
                self.text.insert("end", s)
                self.text.see("end")
                self.text.configure(state="disabled")
        except Exception:
            # ignore any late widget issues
            pass
        self.after_id = self.after(50, self._poll)


class App(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("Channels")
        self.geometry("1280x740")

        self.window_seconds = DEFAULT_WINDOW_SECONDS
        self.console_win = None

        top = ttk.Frame(self, padding=6)
        top.pack(fill="x")

        ttk.Label(top, text="Port").pack(side="left")
        self.cmb_port = ttk.Combobox(top, values=list_ports(), width=26, state="readonly")
        ports0 = list_ports()
        if ports0:
            self.cmb_port.set(ports0[0])
        self.cmb_port.pack(side="left", padx=6)

        ttk.Label(top, text="Baud").pack(side="left")
        self.cmb_baud = ttk.Combobox(top, values=[9600,19200,38400,57600,115200,230400,460800,921600], width=10, state="readonly")
        self.cmb_baud.set(BAUD)
        self.cmb_baud.pack(side="left", padx=6)

        ttk.Button(top, text="Refresh", command=self._refresh_ports).pack(side="left", padx=6)
        self.btn_connect = ttk.Button(top, text="Connect", command=self._toggle_connect)
        self.btn_connect.pack(side="left")

        ttk.Button(top, text="Open Metrics", command=self._open_metrics).pack(side="left", padx=6)
        ttk.Button(top, text="Open Settings", command=self._open_settings).pack(side="left", padx=6)
        ttk.Button(top, text="Open Console", command=self._open_console).pack(side="left", padx=6)

        self.status_var = tk.StringVar(value="Idle")
        ttk.Label(top, textvariable=self.status_var).pack(side="right")

        main = ttk.Frame(self)
        main.pack(fill="both", expand=True)

        plot_frame = ttk.Frame(main)
        plot_frame.pack(side="left", fill="both", expand=True)

        right_frame = ttk.Frame(main, padding=(8, 8))
        right_frame.pack(side="right", fill="y")

        toggle_frame = ttk.Frame(right_frame)
        toggle_frame.pack(side="top", fill="y")

        metrics_frame = ttk.LabelFrame(right_frame, text="Simple Metrics", padding=(6,6))
        metrics_frame.pack(side="top", fill="x", pady=(10,0))

        # Overall windowed means
        self.avg_read_var = tk.StringVar(value="read_us mean: n/a")
        self.avg_sps_var = tk.StringVar(value="sps mean: n/a")
        ttk.Label(metrics_frame, textvariable=self.avg_read_var).pack(anchor="w")
        ttk.Label(metrics_frame, textvariable=self.avg_sps_var).pack(anchor="w")

        ttk.Separator(metrics_frame, orient="horizontal").pack(fill="x", pady=6)
        ttk.Label(metrics_frame, text=f"Per-channel mean V (last {int(VOLT_MEAN_WINDOW_S*1000)} ms)").pack(anchor="w")

        self.per_ch_volt_vars = {}
        per_ch_container = ttk.Frame(metrics_frame)
        per_ch_container.pack(fill="x", pady=(4,0))
        for ch in TOGGLE_CHANNELS:
            var = tk.StringVar(value=f"CH{ch}: n/a")
            self.per_ch_volt_vars[ch] = var
            ttk.Label(per_ch_container, textvariable=var).pack(anchor="w")

        self.q = queue.Queue()
        self.raw_q = queue.Queue(maxsize=RAW_Q_MAX)
        self.reader = None

        self.t0 = None
        # Time and voltage history per channel
        self.t = defaultdict(deque)
        self.v = defaultdict(deque)
        # Store (t_rel, metric) pairs for windowed means
        self.reads = deque(maxlen=MAX_POINTS)
        self.sps = deque(maxlen=MAX_POINTS)

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

    # Thread-safe status setter
    def set_status(self, text):
        try:
            self.after(0, self.status_var.set, text)
        except Exception:
            pass

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
            except Exception:
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
        self.reads.clear()
        self.sps.clear()
        with self.q.mutex:
            self.q.queue.clear()
        with self.raw_q.mutex:
            self.raw_q.queue.clear()
        self.reader = Reader(port, baud, self.q, self.set_status, raw_q=self.raw_q)
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
                t_wall, rec = self.q.get_nowait()
                t_us, ch, raw, volts, read_us, sps = rec
                if self.t0 is None:
                    self.t0 = t_wall
                t_rel = t_wall - self.t0
                if ch == 0:
                    ch = 10
                self.t[ch].append(t_rel)
                self.v[ch].append(volts)
                self.reads.append((t_rel, read_us))
                self.sps.append((t_rel, sps))
                drained += 1
        except queue.Empty:
            pass

        if drained:
            # Update lines
            for ch, var in self.selected.items():
                if var.get():
                    if ch not in self.lines:
                        (ln,) = self.ax.plot([], [], lw=1, label=f"CH{ch}")
                        self.lines[ch] = ln
                    self.lines[ch].set_data(self.t.get(ch, []), self.v.get(ch, []))
                else:
                    if ch in self.lines:
                        self.lines[ch].set_data([], [])

            # X window aligns to latest visible sample across shown channels
            latest = 0.0
            for ch, ln in self.lines.items():
                if ch in self.selected and self.selected[ch].get() and self.t.get(ch):
                    latest = max(latest, self.t[ch][-1])
            xmin = max(0.0, latest - self.window_seconds)
            self.ax.set_xlim(xmin, max(xmin + 1e-3, latest))

            # Time-based trimming to keep only the last window_seconds of history
            now = latest
            keep = self.window_seconds
            for ch in TOGGLE_CHANNELS:
                ts = self.t.get(ch, None)
                vs = self.v.get(ch, None)
                if ts and vs:
                    while ts and ts[0] < now - keep:
                        ts.popleft()
                        vs.popleft()
            while self.reads and self.reads[0][0] < now - keep:
                self.reads.popleft()
            while self.sps and self.sps[0][0] < now - keep:
                self.sps.popleft()

            # Y limits fit visible channels
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

            # self._refresh_legend() #remove for lag rzns
            self.canvas.draw_idle()

            # Overall means over the last window
            now = latest
            recent_reads = [val for t, val in self.reads if t >= now - self.window_seconds]
            recent_sps = [val for t, val in self.sps if t >= now - self.window_seconds]
            if recent_reads:
                mean_read = sum(recent_reads) / len(recent_reads)
                self.avg_read_var.set(f"read_us mean (last {self.window_seconds:.0f}s): {mean_read:.2f}")
            if recent_sps:
                mean_sps = sum(recent_sps) / len(recent_sps)
                self.avg_sps_var.set(f"sps mean (last {self.window_seconds:.0f}s): {mean_sps:.2f}")

            # Per-channel mean voltage over last 100 ms, only if channel is selected
            for ch in TOGGLE_CHANNELS:
                if not self.selected[ch].get():
                    self.per_ch_volt_vars[ch].set(f"CH{ch}: n/a")
                    continue
                times = self.t.get(ch, [])
                volts = self.v.get(ch, [])
                if times and volts:
                    recent_volts = [vv for tt, vv in zip(times, volts) if tt >= now - VOLT_MEAN_WINDOW_S]
                    if recent_volts:
                        mean_v = sum(recent_volts) / len(recent_volts)
                        self.per_ch_volt_vars[ch].set(f"CH{ch}: {mean_v:.4f} V")
                    else:
                        self.per_ch_volt_vars[ch].set(f"CH{ch}: n/a")
                else:
                    self.per_ch_volt_vars[ch].set(f"CH{ch}: n/a")

        self.after(50, self._update_plot)

    def _open_metrics(self):
        MetricsWindow(self, self.selected, self.t0, self.q, get_window_seconds=lambda: self.window_seconds)

    def _open_settings(self):
        SettingsWindow(self)

    def _open_console(self):
        if self.console_win and self.console_win.winfo_exists():
            try:
                self.console_win.deiconify()
                self.console_win.lift()
                return
            except Exception:
                pass
        self.console_win = ConsoleWindow(self, self.raw_q)

    def _close(self):
        if self.reader:
            try:
                self.reader.stop()
            except Exception:
                pass
        try:
            if self.console_win and self.console_win.winfo_exists():
                self.console_win._on_close()
        except Exception:
            pass
        self.destroy()


if __name__ == "__main__":
    try:
        App().mainloop()
    except KeyboardInterrupt:
        sys.exit(0)
