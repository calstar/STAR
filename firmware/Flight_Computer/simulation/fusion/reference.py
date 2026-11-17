"""Independent float64 reference for the record-driven altitude filter."""

import math
import struct
import numpy as np

G = 9.80665
IMU, HIGHG, BARO, GNSS, FUSION = 0x10, 0x11, 0x12, 0x13, 0x17
FORMATS = {IMU: "<Ih3h3h", HIGHG: "<I3b", BARO: "<Iii", GNSS: "<IIIiiiiiiIIHBBB"}
OUTPUT = "<I10fII"
READY, HIGH_G, NO_ACCEL, GAP, BARO_REJECT, GNSS_REJECT, ATTITUDE_LOST = (
    1 << i for i in range(7)
)
RELATIVE_YAW = 128
HIGHG_UNALIGNED = 256


def mul(q, r):
    w, x, y, z = q
    a, b, c, d = r
    return np.array(
        [
            w * a - x * b - y * c - z * d,
            w * b + x * a + y * d - z * c,
            w * c - x * d + y * a + z * b,
            w * d + x * c - y * b + z * a,
        ]
    )


def vertical(q, a):
    w, x, y, z = q
    return (
        2 * (x * z - w * y) * a[0]
        + 2 * (y * z + w * x) * a[1]
        + (1 - 2 * (x * x + y * y)) * a[2]
    )


class Filter:
    def __init__(
        self,
        accel_scale=0.000488 * G,
        gyro_scale=0.140 * math.pi / 180,
        highg_axes=(1, 2, 3),
    ):
        self.accel_scale, self.gyro_scale = accel_scale, gyro_scale
        self.x = np.zeros(3)
        self.P = np.diag([4.0, 1.0, 0.25])
        self.q = np.array([1.0, 0.0, 0.0, 0.0])
        self.gyro_bias = np.zeros(3)
        self.acc_sum = np.zeros(3)
        self.gyro_sum = np.zeros(3)
        self.n = 0
        self.pn = 0
        self.p0 = 0.0
        self.last = None
        self.last_out = None
        self.highg = None
        self.highg_t = 0
        self.gnss_origin = None
        self.itow = None
        self.baro_t = None
        self.on_pad = True
        if highg_axes is not None and sorted(abs(a) for a in highg_axes) != [1, 2, 3]:
            raise ValueError("high-g axes must be a signed permutation of 1, 2, 3")
        self.highg_axes = highg_axes
        self.flags = RELATIVE_YAW | (HIGHG_UNALIGNED if highg_axes is None else 0)
        self.acceleration = 0.0
        self.dropped = 0
        self.baro_rejections = 0
        self.highg_uses = 0

    def update(self, z, H, variance, gate):
        ph = self.P @ H
        s = float(H @ ph + variance)
        error = float(z - H @ self.x)
        if error * error > 25 * s or abs(error) > gate:
            return False
        k = ph / s
        self.x += k * error
        m = np.eye(3) - np.outer(k, H)
        self.P = m @ self.P @ m.T + variance * np.outer(k, k)
        self.P = (self.P + self.P.T) * 0.5
        return True

    def feed(self, kind, data):
        r = struct.unpack(FORMATS[kind], data)
        t = r[0]
        if kind == HIGHG:
            if self.highg_axes is None:
                return
            if self.highg is None or 0 < ((t - self.highg_t) & 0xFFFFFFFF) < 0x80000000:
                self.highg_t = t
                self.highg = np.array(
                    [r[abs(a)] * (1 if a > 0 else -1) for a in self.highg_axes],
                    dtype=float,
                ) * (0.780 * G)
            return
        if kind == BARO:
            if (
                self.baro_t is not None
                and not 0 < ((t - self.baro_t) & 0xFFFFFFFF) < 0x80000000
            ):
                self.flags |= BARO_REJECT
                self.dropped += 1
                return
            self.baro_t = t
            p = r[2]
            if not 1000 <= p <= 120000:
                self.flags |= BARO_REJECT
                return
            if not self.flags & READY:
                self.pn += 1
                self.p0 += (p - self.p0) / self.pn
                return
            age = ((self.last - t) & 0xFFFFFFFF) * 1e-6
            if age > 0.1:
                self.flags |= BARO_REJECT
                return
            h = 44330.0 * (1 - (p / self.p0) ** 0.19029495)
            # h(t-age) = h(t)-v(t)*age + a(t)*age**2/2.
            H = np.array([1.0, -age, 0.0])
            ok = self.update(h - 0.5 * self.acceleration * age * age, H, 2.25, 30.0)
            self.flags = self.flags & ~BARO_REJECT if ok else self.flags | BARO_REJECT
            self.baro_rejections += not ok
            return
        if kind == GNSS:
            _, _, itow, _, _, height, _, _, vd, _, vacc, _, fix, sv, flags = r
            if (
                fix < 3
                or not flags & 1
                or sv < 4
                or vacc == 0
                or vacc > 50000
                or itow >= 604800000
                or (
                    self.itow is not None
                    and not 0 < (itow - self.itow) % 604800000 < 302400000
                )
            ):
                self.flags |= GNSS_REJECT
                return
            self.itow = itow
            if not self.flags & READY:
                self.gnss_origin = height * 0.001
                return
            age = (((self.last - t + 0x80000000) & 0xFFFFFFFF) - 0x80000000) * 1e-6
            if age < -0.005 or age > 0.2:
                self.flags |= GNSS_REJECT
                return
            # A pad fix can arrive after alignment, but never establish an
            # origin from an in-flight altitude (cold starts are common).
            if self.gnss_origin is None and self.on_pad:
                self.gnss_origin = height * 0.001 - self.x[0]
            if self.gnss_origin is None:
                self.flags |= GNSS_REJECT
                return
            age = max(0.0, age)
            R = max(9.0, (vacc * 0.001) ** 2) + (0.1 * self.x[1]) ** 2
            ok = self.update(
                height * 0.001 - self.gnss_origin - 0.5 * self.acceleration * age * age,
                np.array([1.0, -age, 0.0]),
                R,
                100.0,
            )
            self.flags = self.flags & ~GNSS_REJECT if ok else self.flags | GNSS_REJECT
            return
        if kind != IMU:
            return
        gyro = np.array(r[2:5], dtype=float) * self.gyro_scale
        accel = np.array(r[5:8], dtype=float) * self.accel_scale
        delta = None if self.last is None else ((t - self.last) & 0xFFFFFFFF)
        if delta is not None and (delta == 0 or delta >= 0x80000000):
            self.dropped += 1
            return
        self.last = t
        if not self.flags & READY:
            norm = np.linalg.norm(accel)
            if (
                delta is not None
                and delta > 50000
                or not 0.8 * G < norm < 1.2 * G
                or np.linalg.norm(gyro) > 0.05
            ):
                self.n = 0
                self.acc_sum[:] = 0
                self.gyro_sum[:] = 0
                self.pn = 0
                self.p0 = 0.0
                self.gnss_origin = None
                return
            self.acc_sum += accel
            self.gyro_sum += gyro
            self.n += 1
            if self.n < 256 or self.pn < 8:
                return
            a = self.acc_sum / self.n
            norm = np.linalg.norm(a)
            u = a / norm
            self.q = (
                np.array([1 + u[2], u[1], -u[0], 0.0])
                if u[2] > -0.99999
                else np.array([0.0, 1.0, 0.0, 0.0])
            )
            self.q /= np.linalg.norm(self.q)
            self.gyro_bias = self.gyro_sum / self.n
            self.x[2] = norm - G
            self.flags |= READY
            self.last_out = t
            return self.output(t)
        dt = delta * 1e-6
        self.flags &= ~(HIGH_G | NO_ACCEL)
        if delta > 50000:
            self.flags |= GAP | ATTITUDE_LOST | NO_ACCEL
            self.P += np.diag([100.0, 100.0, 1.0])
            self.acceleration = 0.0
            self.dropped += 1
            return self.output(t)
        if any(abs(v) >= 28000 for v in r[2:5]):
            self.flags |= ATTITUDE_LOST
        w = gyro - self.gyro_bias
        angle = np.linalg.norm(w) * dt
        dq = np.r_[
            math.cos(angle / 2),
            w * (math.sin(angle / 2) * dt / angle if angle > 1e-12 else dt * 0.5),
        ]
        self.q = mul(self.q, dq)
        self.q /= np.linalg.norm(self.q)
        qa = 0.64
        if any(abs(v) >= 32000 for v in r[5:8]):
            age = (t - self.highg_t) & 0xFFFFFFFF
            if (
                self.highg is not None
                and age <= 10000
                and np.max(np.abs(self.highg)) < 127 * 0.780 * G
            ):
                accel = self.highg
                self.flags |= HIGH_G
                qa = 64.0
                self.highg_uses += 1
            else:
                self.flags |= NO_ACCEL
                qa = 2500.0
        if self.flags & ATTITUDE_LOST:
            self.flags |= NO_ACCEL
            qa = 2500.0
        a = self.x[2] if self.flags & NO_ACCEL else vertical(self.q, accel) - G
        self.acceleration = a - self.x[2]
        if abs(self.acceleration) > 3.0 or abs(self.x[1]) > 3.0 or self.x[0] > 5.0:
            self.on_pad = False
        F = np.array([[1.0, dt, -0.5 * dt * dt], [0.0, 1.0, -dt], [0.0, 0.0, 1.0]])
        self.x = F @ self.x + np.array([0.5 * dt * dt, dt, 0.0]) * a
        Q = qa * np.array(
            [[dt**3 / 3, dt * dt / 2, 0.0], [dt * dt / 2, dt, 0.0], [0.0, 0.0, 0.0]]
        )
        Q += 0.0001 * np.array(
            [
                [dt**5 / 20, dt**4 / 8, -(dt**3) / 6],
                [dt**4 / 8, dt**3 / 3, -dt * dt / 2],
                [-(dt**3) / 6, -dt * dt / 2, dt],
            ]
        )
        self.P = F @ self.P @ F.T + Q
        if ((t - self.last_out) & 0xFFFFFFFF) >= 20000:
            self.last_out = t
            return self.output(t)

    def output(self, t):
        return (
            t,
            *self.x[:2],
            self.acceleration,
            self.x[2],
            *self.q,
            math.sqrt(max(0, self.P[0, 0])),
            math.sqrt(max(0, self.P[1, 1])),
            self.flags,
            self.dropped,
        )
