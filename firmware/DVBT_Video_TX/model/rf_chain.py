"""Everything between the DAC pins and the receiver's demodulator that the
digital simulation does not have: DAC errors, the reconstruction filter,
the ADRF6755, driver and PA, the air, and the receiver's front end.

Input: the e2e harness's rf.iq (the DAC codes the AD9116 latched, at the
DAC rate the Si5351A really produced). Output: complex baseband at the
receiver's own sample rate (48/7 MS/s on its own crystal), for gr-dtv.

Every number is a Param with a unit, a source and a reference, as the rest
of this repository does it: a value nobody can trace is not a model. Some
are not in any datasheet we have (the PA at 1.28 GHz, the receiver's noise
figure, the rocket antenna's pattern); those say "assumption" and are
the first things to measure.

Processing is in chunks (a second of air is 33 M samples at the DAC rate)
with filter state carried across; everything that depends on time
(phase noise, Doppler, roll, multipath) is indexed by absolute sample time.
"""
from __future__ import annotations

import dataclasses
import math
from dataclasses import dataclass, field, replace

import numpy as np
from scipy import signal


@dataclass(frozen=True)
class Param:
    value: float
    unit: str
    source: str
    reference: str = ""


def P(v, unit, source, ref=""):
    return field(default_factory=lambda: Param(v, unit, source, ref))


DS_DAC = "AD9116 datasheet Rev. F"
DS_MOD = "ADRF6755 datasheet Rev. B"
DOC = "design doc level plan (claude.ai artifact Gho1kSfthaowz8mzk3Naav)"


@dataclass(frozen=True)
class Chain:
    # ---- DAC (AD9116) -----------------------------------------------------------
    dac_gain_err_i: Param = P(0.0, "fraction of FS", DS_DAC, "Table 1: gain error +-2 % FSR (min/max)")
    dac_gain_err_q: Param = P(0.0, "fraction of FS", DS_DAC, "Table 1: gain error +-2 % FSR (min/max)")
    dac_offset_i: Param = P(0.0, "LSB", DS_DAC, "Table 1: offset +-1 mV of ~0.5 V peak = +-4 LSB")
    dac_offset_q: Param = P(0.0, "LSB", DS_DAC, "Table 1: offset +-1 mV of ~0.5 V peak = +-4 LSB")
    dac_inl: Param = P(0.0, "LSB peak (bow)", DS_DAC, "Table 1: INL +-0.68 LSB precalibration")
    dac_nsd: Param = P(-200.0, "dBFS/Hz", DS_DAC, "Table 1: NSD -153 dBc/Hz (8-tone, 125 MSPS)")
    clkin_jitter_ps: Param = P(0.0, "ps RMS", "Si5351A datasheet (not in hand)",
                               "assumption: ~70 ps pk-pk period jitter in fractional mode -> ~12 ps RMS")
    # ---- reconstruction filter -------------------------------------------------
    lpf_fc_hz: Param = P(4.5e6, "Hz", DOC, "5th order, 4.5 MHz (Butterworth assumed)")
    lpf_order: Param = P(5, "", DOC, "5th order")
    lpf_tol_i: Param = P(0.0, "fraction", "component tolerance", "wire-wound L +-5 %, C0G C +-5 %: cutoff shift per rail")
    lpf_tol_q: Param = P(0.0, "fraction", "component tolerance", "wire-wound L +-5 %, C0G C +-5 %: cutoff shift per rail")
    # ---- I/Q modulator (ADRF6755) ----------------------------------------------
    mod_dbm_at_fs_sine: Param = P(-1.7, "dBm", DS_MOD, "nominal output -1.7 dBm at 0.9 V p-p diff (~0.9 of DAC FS)")
    mod_p1db_dbm: Param = P(8.0, "dBm", DS_MOD, "output P1dB 6.5-9 dBm by band; doc uses ~8")
    iq_gain_db: Param = P(0.0, "dB", DS_MOD, "sideband suppression -40 dBc typ -> 0.12 dB with 0.8 deg")
    iq_phase_deg: Param = P(0.0, "deg", DS_MOD, "sideband suppression -40 dBc typ")
    lo_leak_dbc: Param = P(-200.0, "dBc of nominal output", DS_MOD, "LO carrier feedthrough -43 dBc")
    lo_leak_deg: Param = P(30.0, "deg", "assumption", "phase of the feedthrough relative to I (any; calibration nulls it)")
    phase_noise: Param = P(0.0, "on/off", DS_MOD, "PN: -85/-96/-100/-107/-132/-152 dBc/Hz at 100 Hz..10 MHz; 0.25 deg rms")
    pn_scale_db: Param = P(0.0, "dB", "", "added to the datasheet phase-noise curve")
    mod_floor_dbm_hz: Param = P(-250.0, "dBm/Hz", DS_MOD, "noise floor -160.5 dBm/Hz at 0 dB attenuation")
    atten_db: Param = P(0.0, "dB", "firmware CONFIG_DVBT_ADRF_ATTEN_DB", "default 0")
    # ---- driver, PA, filter -------------------------------------------------------
    drv_gain_db: Param = P(21.8, "dB", DOC, "ADL5611: 22.2 dB @ 900 MHz, 21.4 dB @ 1900 MHz")
    drv_p1db_dbm: Param = P(21.0, "dBm", DOC, "ADL5611 P1dB about 21 dBm")
    pa_gain_db: Param = P(18.0, "dB", DOC, "TQP7M9104 17-19 dB, to be measured at 1.28 GHz")
    pa_p1db_dbm: Param = P(32.8, "dBm", DOC, "TQP7M9104 P1dB 32.8 dBm at 2.14 GHz; not given at 1.28 GHz")
    pa_ampm_deg: Param = P(0.0, "deg at P1dB", "assumption", "AM-PM of a GaAs HBT PA: a few degrees at P1dB")
    rapp_p: Param = P(2.0, "", "assumption", "Rapp smoothness for solid-state amplifiers, 2-3")
    filt_loss_db: Param = P(1.0, "dB", DOC, "LFCN-1400+ insertion loss ~1 dB")
    # ---- air -----------------------------------------------------------------------
    range_m: Param = P(0.0, "m", "", "0: no channel (cable to the receiver)")
    tx_ant_dbi: Param = P(0.0, "dBi", "assumption", "rocket antenna toward the ground station")
    roll_hz: Param = P(0.0, "rev/s", "assumption", "airframe roll rate")
    roll_ripple_db: Param = P(0.0, "dB pk-pk", "assumption", "antenna gain ripple around the roll axis")
    roll_lobes: Param = P(2.0, "per rev", "assumption", "lobes of the roll pattern")
    pol_loss_db: Param = P(0.0, "dB", "", "polarisation mismatch (0 for RHCP to RHCP)")
    ground_rho: Param = P(0.0, "", "assumption", "ground-reflection magnitude reaching the helix")
    ground_fade_hz: Param = P(1.0, "Hz", "two-ray geometry", "rate the reflected path's phase turns")
    v_radial: Param = P(0.0, "m/s", "", "range rate (positive: moving away)")
    a_radial: Param = P(0.0, "m/s^2", "", "range acceleration")
    rx_ant_dbi: Param = P(12.0, "dBi", DOC, "RHCP helix 12-15 dBi")
    rx_point_loss_db: Param = P(1.0, "dB", "assumption", "hand-aimed helix")
    rx_nf_db: Param = P(6.0, "dB", "assumption", "USB DVB-T receiver without LNA (typ 5-8 dB)")
    # ---- receiver ---------------------------------------------------------------------
    rx_lo_ppm: Param = P(0.0, "ppm", "assumption", "receiver tuner crystal")
    rx_clk_ppm: Param = P(0.0, "ppm", "assumption", "receiver ADC/demod crystal")
    rx_adc_bits: Param = P(16, "bits", "assumption", "demodulator ADC")
    seed: Param = P(1, "", "", "")

    def with_(self, **kw) -> "Chain":
        """Copy with values replaced (sources kept)."""
        return replace(self, **{k: replace(getattr(self, k), value=v) for k, v in kw.items()})

    def v(self, name: str) -> float:
        return getattr(self, name).value

    def describe(self) -> list[str]:
        return [f"{f.name} = {getattr(self, f.name).value} {getattr(self, f.name).unit}  "
                f"[{getattr(self, f.name).source}: {getattr(self, f.name).reference}]"
                for f in dataclasses.fields(self)]


# Datasheet phase noise of the ADRF6755 (Rev. B, LO 1.8 GHz table), dBc/Hz.
PN_F = np.array([10, 100, 1e3, 1e4, 1e5, 1e6, 1e7])
PN_L = np.array([-65, -85, -96, -100, -107, -132, -152])     # 10 Hz extrapolated at -20 dB/decade


def phase_noise(n: int, fs: float, rng, scale_db=0.0) -> np.ndarray:
    """A phase sequence whose spectrum follows the datasheet curve,
    generated at a low rate (+-1.37 MHz covers everything above the floor)
    and interpolated to fs."""
    dec = max(1, int(fs // 2.74e6))
    fl = fs / dec
    m = int(2 ** math.ceil(math.log2(n // dec + 16)))
    f = np.fft.rfftfreq(m, 1 / fl)
    L = np.interp(np.log10(np.maximum(f, 1)), np.log10(PN_F), PN_L) + scale_db
    # single-sideband L(f) (dBc/Hz) -> phase PSD S_phi = 2 L (rad^2/Hz, one-sided)
    s_phi = 2 * 10 ** (L / 10)
    s_phi[0] = 0
    spec = (rng.normal(size=len(f)) + 1j * rng.normal(size=len(f))) * np.sqrt(s_phi * fl * m / 4)
    ph = np.fft.irfft(spec, m)[: n // dec + 2]
    t = np.arange(n) / dec
    return np.interp(t, np.arange(len(ph)), ph)


def rapp(v: np.ndarray, p1db_dbm: float, p: float, ampm_deg: float = 0.0) -> np.ndarray:
    """Rapp AM-AM (output saturates smoothly; the 1 dB point at p1db) with
    an optional AM-PM rising as the square of the drive. v in sqrt(mW)."""
    a = np.abs(v)
    # Saturation amplitude so that the gain at P1dB is 1 dB down.
    p1 = math.sqrt(10 ** (p1db_dbm / 10))
    # input amplitude at P1dB, x1: out = x1 * g, g = 10^(-1/20); solve Rapp for A_sat
    g = 10 ** (-1 / 20)
    x1 = p1 / g
    asat = x1 / (g ** (-2 * p) - 1) ** (1 / (2 * p))
    out = a / (1 + (a / asat) ** (2 * p)) ** (1 / (2 * p))
    ph = np.deg2rad(ampm_deg) * (a / x1) ** 2
    return np.where(a > 0, v / np.maximum(a, 1e-30) * out * np.exp(1j * ph), 0)


def lo_null_codes(ch: Chain) -> tuple[int, int]:
    """The DC offsets (DAC LSBs, as tx_config_t.dc_i/dc_q) that a bench
    calibration would find: minus the feedthrough, rounded to an LSB."""
    a = 10 ** (ch.v("lo_leak_dbc") / 20) * 0.9 * 2047 * np.exp(1j * math.radians(ch.v("lo_leak_deg")))
    return int(round(-a.real)), int(round(-a.imag))


def dbm_to_amp(dbm):
    return math.sqrt(10 ** (dbm / 10))


def run(iq_path: str, fs_dac: float, ch: Chain, lo_offset_hz: float = 0.0, chunk: int = 1 << 20,
        report: dict | None = None) -> tuple[np.ndarray, float]:
    """rf.iq -> receiver baseband. lo_offset_hz: the ADRF6755's LO error
    (from the harness report). Returns (samples, sample rate the receiver
    believes it has, 48/7 MS/s)."""
    rng = np.random.default_rng(int(ch.v("seed")))
    raw = np.memmap(iq_path, np.int16, "r").reshape(-1, 2)
    n_dac = len(raw)
    fs2 = 2 * fs_dac                                   # analog modelling rate
    n2 = 2 * n_dac
    t_total = n_dac / fs_dac
    rep = report if report is not None else {}

    # ---- static pieces ----
    lpf = []
    for tol in (ch.v("lpf_tol_i"), ch.v("lpf_tol_q")):
        b, a = signal.butter(int(ch.v("lpf_order")), ch.v("lpf_fc_hz") * (1 + tol), fs=fs2)
        lpf.append((b, a, signal.lfilter_zi(b, a) * 0))
    inl_sign = rng.choice([-1, 1], size=2)
    pn = phase_noise(n2, fs2, rng, ch.v("pn_scale_db")) if ch.v("phase_noise") else None
    k_mod = dbm_to_amp(ch.v("mod_dbm_at_fs_sine")) / (0.9 * 2047)   # sqrt(mW) per DAC code
    eps = 10 ** (ch.v("iq_gain_db") / 20) - 1
    phi = math.radians(ch.v("iq_phase_deg"))
    leak = dbm_to_amp(ch.v("mod_dbm_at_fs_sine") + ch.v("lo_leak_dbc")) * np.exp(1j * math.radians(ch.v("lo_leak_deg")))
    lam = 299792458 / 1279e6
    rx_lo_hz = ch.v("rx_lo_ppm") * 1e-6 * 1279e6
    # channel filter of the receiver (DVB-T 6 MHz: +-2.86 MHz occupied)
    chan = signal.firwin(255, 3.1e6, fs=fs2)
    chan_zi = np.zeros(len(chan) - 1, complex)
    dec_taps = signal.firwin(127, 3.2e6, fs=fs2)      # before the /4 to 2x the DVB-T rate
    dec_zi = np.zeros(len(dec_taps) - 1, complex)
    path_db = 0.0
    if ch.v("range_m") > 0:
        fspl = 20 * math.log10(4 * math.pi * ch.v("range_m") / lam)
        path_db = (-ch.v("filt_loss_db") + ch.v("tx_ant_dbi") - fspl - ch.v("pol_loss_db")
                   + ch.v("rx_ant_dbi") - ch.v("rx_point_loss_db"))
    noise_dbm_hz = -174 + ch.v("rx_nf_db")
    out = []
    prev_codes = np.zeros(2)
    pa_pk = 0.0
    sig_pow = []
    for c0 in range(0, n_dac, chunk):
        codes = np.asarray(raw[c0:c0 + chunk], np.float64)
        on = np.any(codes != 0, axis=1)
        # ---- DAC ----
        x = codes.copy()
        x[:, 0] = x[:, 0] * (1 + ch.v("dac_gain_err_i")) + ch.v("dac_offset_i") * on
        x[:, 1] = x[:, 1] * (1 + ch.v("dac_gain_err_q")) + ch.v("dac_offset_q") * on
        if ch.v("dac_inl"):
            x += ch.v("dac_inl") * inl_sign * (1 - (codes / 2048) ** 2) * on[:, None]
        if ch.v("clkin_jitter_ps"):
            d = np.diff(np.vstack([prev_codes, codes]), axis=0)
            x += d * (rng.normal(size=(len(x), 1)) * ch.v("clkin_jitter_ps") * 1e-12 * fs_dac)
        prev_codes = codes[-1]
        if ch.v("dac_nsd") > -199:
            sd = 2047 * math.sqrt(10 ** (ch.v("dac_nsd") / 10) * fs_dac / 2)
            x += rng.normal(size=x.shape) * sd * on[:, None]
        # ---- zero-order hold at 2x, then each rail's reconstruction filter ----
        xi = np.repeat(x[:, 0], 2)
        xq = np.repeat(x[:, 1], 2)
        b, a, zi = lpf[0]
        xi, zi = signal.lfilter(b, a, xi, zi=zi)
        lpf[0] = (b, a, zi)
        b, a, zq = lpf[1]
        xq, zq = signal.lfilter(b, a, xq, zi=zq)
        lpf[1] = (b, a, zq)
        on2 = np.repeat(on, 2)
        # ---- modulator: I/Q imbalance, LO feedthrough, phase noise, LO error ----
        y = ((1 + eps / 2) * xi + 1j * (1 - eps / 2) * (xq * math.cos(phi) + xi * math.sin(phi))) * k_mod
        y = y + leak * on2
        i0 = 2 * c0
        tt = (i0 + np.arange(len(y))) / fs2
        ph = 2 * math.pi * lo_offset_hz * tt
        if pn is not None:
            ph = ph + pn[i0:i0 + len(y)]
        y = y * np.exp(1j * ph)
        y = rapp(y, ch.v("mod_p1db_dbm"), ch.v("rapp_p"))
        if ch.v("mod_floor_dbm_hz") > -249:
            sd = dbm_to_amp(ch.v("mod_floor_dbm_hz") + 10 * math.log10(fs2)) / math.sqrt(2)
            y = y + (rng.normal(size=len(y)) + 1j * rng.normal(size=len(y))) * sd * on2
        y = y * 10 ** (-ch.v("atten_db") / 20)
        # ---- driver, PA ----
        y = rapp(y * 10 ** (ch.v("drv_gain_db") / 20), ch.v("drv_p1db_dbm"), ch.v("rapp_p"))
        y = rapp(y * 10 ** (ch.v("pa_gain_db") / 20), ch.v("pa_p1db_dbm"), ch.v("rapp_p"), ch.v("pa_ampm_deg"))
        if on2.any():
            sig_pow.append(np.mean(np.abs(y[on2]) ** 2))
            pa_pk = max(pa_pk, float(np.max(np.abs(y)) ** 2))
        # ---- air: path loss, roll pattern, ground reflection, Doppler ----
        if ch.v("range_m") > 0:
            g_db = path_db
            if ch.v("roll_ripple_db"):
                g_db = g_db + ch.v("roll_ripple_db") / 2 * np.cos(2 * math.pi * ch.v("roll_hz") * ch.v("roll_lobes") * tt)
            gain = 10 ** (np.asarray(g_db) / 20)
            if ch.v("ground_rho"):
                gain = gain * np.abs(1 + ch.v("ground_rho") * np.exp(2j * math.pi * ch.v("ground_fade_hz") * tt))
            y = y * gain
            sd = dbm_to_amp(noise_dbm_hz + 10 * math.log10(fs2)) / math.sqrt(2)
            y = y + (rng.normal(size=len(y)) + 1j * rng.normal(size=len(y))) * sd
        else:
            y = y * 10 ** ((-ch.v("filt_loss_db") - 30) / 20)          # cable + 30 dB pad
        v0, a0 = ch.v("v_radial"), ch.v("a_radial")
        if v0 or a0:                                                   # Doppler (range rate)
            y = y * np.exp(-2j * math.pi / lam * (v0 * tt + 0.5 * a0 * tt ** 2))
        # ---- receiver: its LO error, channel filter, /4 ----
        if rx_lo_hz:
            y = y * np.exp(-2j * math.pi * rx_lo_hz * tt)
        y, chan_zi = signal.lfilter(chan, 1, y, zi=chan_zi)
        y, dec_zi = signal.lfilter(dec_taps, 1, y, zi=dec_zi)
        k0 = (-i0) % 4
        out.append(y[k0::4].astype(np.complex64))
    z = np.concatenate(out)                                # fs2/4 = DAC rate / 2 (13.7 MS/s)
    fs_z = fs2 / 4
    # ---- the receiver's own clock: resample to 48/7 MS/s x (1 + ppm), cubic ----
    fs_rx = 48e6 / 7 * (1 + ch.v("rx_clk_ppm") * 1e-6)
    n_out = int((len(z) - 4) * fs_rx / fs_z)
    pos = np.arange(n_out) * (fs_z / fs_rx) + 1
    i = pos.astype(np.int64)
    f = pos - i
    zm1, z0, z1, z2 = z[i - 1], z[i], z[i + 1], z[i + 2]
    w = (-f * (f - 1) * (f - 2) / 6, (f + 1) * (f - 1) * (f - 2) / 2, -(f + 1) * f * (f - 2) / 2, (f + 1) * f * (f - 1) / 6)
    r = (w[0] * zm1 + w[1] * z0 + w[2] * z1 + w[3] * z2).astype(np.complex64)
    # ---- AGC and ADC ----
    rms = np.sqrt(np.mean(np.abs(r[len(r) // 4:]) ** 2)) or 1.0
    bits = int(ch.v("rx_adc_bits"))
    fsc = 4 * rms                                          # -12 dBFS operating point
    q = 2 ** (bits - 1)
    r = np.clip(np.round(r.real / fsc * q), -q, q - 1) + 1j * np.clip(np.round(r.imag / fsc * q), -q, q - 1)
    pa_avg = 10 * math.log10(np.mean(sig_pow)) if sig_pow else float("nan")
    rep.update(pa_out_avg_dbm=pa_avg, pa_out_peak_dbm=10 * math.log10(pa_pk) if pa_pk else float("nan"),
               rx_power_dbm=pa_avg + path_db if ch.v("range_m") > 0 else float("nan"),
               rx_snr_db=(pa_avg + path_db - noise_dbm_hz - 10 * math.log10(5.71e6)) if ch.v("range_m") > 0 else float("nan"),
               duration_s=t_total)
    return r.astype(np.complex64), 48e6 / 7
