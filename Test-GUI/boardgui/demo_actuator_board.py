"""
Headless demo actuator board — a fake Actuator board for testing the GUI with
no hardware.

It behaves like the real firmware's UDP side (Actuator_Hotfire/src/main.cpp):
  * sends BOARD_HEARTBEAT once per second (Setup until configured, then Active),
  * listens for SERVER_HEARTBEAT / ACTUATOR_CONFIG / ACTUATOR_COMMAND /
    PWM_ACTUATOR_COMMAND / ABORT / CLEAR_ABORT,
  * once Active: streams SENSOR_DATA at 10 Hz — one chunk of per-actuator
    current-sense voltages, IEEE-754 float encoded in the u32 datapoint field
    exactly like readCurrentSensePinsAndSend(). An actuator that is ON draws
    ~1.5 V of "current"; OFF sits near 0 V — so toggling in the GUI visibly
    moves the plot.

Run it alongside the GUI (both on localhost):

    # terminal 1
    python -m boardgui.demo_actuator_board
    # terminal 2
    python Actuator-GUI/actuator_gui.py --board-ip 127.0.0.1

Pure stdlib + boardgui.protocol — no Qt.
"""

from __future__ import annotations

import argparse
import math
import random
import socket
import struct
import time
from typing import Dict

from . import protocol

ON_VOLTS = 1.5      # current-sense level for an energized actuator
OFF_VOLTS = 0.02    # leakage/noise floor for an off actuator
NOISE_VOLTS = 0.03  # ripple so the plot visibly moves


class SimActuator:
    """One actuator channel: plain on/off plus an optional timed PWM burst."""

    def __init__(self) -> None:
        self.on = False
        self.pwm_until = 0.0
        self.pwm_duty = 0.0
        self.pwm_freq = 0.0

    def set(self, on: bool) -> None:
        self.on = on
        self.pwm_until = 0.0  # a plain command cancels PWM, like the firmware

    def start_pwm(self, duration_ms: int, duty: float, freq: float) -> None:
        self.pwm_until = time.time() + duration_ms / 1000.0
        self.pwm_duty = max(0.0, min(1.0, duty))
        self.pwm_freq = max(0.0, freq)
        self.on = self.pwm_duty > 0.0

    def volts(self, now: float) -> float:
        if self.pwm_until > 0.0:
            if now >= self.pwm_until:
                self.pwm_until = 0.0
                self.on = False
            else:
                # instantaneous pin state within the PWM cycle
                phase = (now * self.pwm_freq) % 1.0 if self.pwm_freq > 0 else 0.0
                high = phase < self.pwm_duty
                return (ON_VOLTS if high else OFF_VOLTS) + \
                    NOISE_VOLTS * math.sin(now * 40.0)
        base = ON_VOLTS if self.on else OFF_VOLTS
        return base + NOISE_VOLTS * math.sin(now * 3.0) + \
            random.uniform(-0.005, 0.005)


def build_sensor_data(actuators: Dict[int, SimActuator], board_ms: int) -> bytes:
    """One chunk, all channels, float volts in the u32 field (firmware-alike)."""
    now = time.time()
    body = bytearray(struct.pack(protocol.SENSOR_DATA_HEADER_FORMAT, 1, len(actuators)))
    body += struct.pack(protocol.SENSOR_DATA_CHUNK_FORMAT, board_ms & 0xFFFFFFFF)
    for aid in sorted(actuators):
        raw = protocol.float_to_raw(actuators[aid].volts(now))
        body += struct.pack(protocol.SENSOR_DATAPOINT_FORMAT, aid, raw)
    return protocol._make_header(protocol.PacketType.SENSOR_DATA, board_ms) + bytes(body)


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="Fake Actuator board that feeds a board GUI.")
    p.add_argument("--server-ip", default="127.0.0.1", help="where to send data (the GUI host)")
    p.add_argument("--server-port", type=int, default=5006)
    p.add_argument("--listen-port", type=int, default=5005, help="where the GUI sends control")
    p.add_argument("--board-id", type=int, default=21)
    p.add_argument("--num-actuators", type=int, default=10)
    args = p.parse_args(argv)

    actuators = {aid: SimActuator() for aid in range(1, args.num_actuators + 1)}
    fw_hash = bytes(range(32))

    rx = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    rx.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    rx.bind(("0.0.0.0", args.listen_port))
    rx.settimeout(0.02)
    tx = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)

    dest = (args.server_ip, args.server_port)
    start = time.time()
    board_state = protocol.BoardState.SETUP
    engine_state = protocol.EngineState.SAFE
    last_hb = 0.0
    last_data = 0.0
    print(f"[demo_actuator] id={args.board_id} -> {dest}, listening on :{args.listen_port}, "
          f"actuators=1..{args.num_actuators}")

    while True:
        now = time.time()
        board_ms = int((now - start) * 1000) & 0xFFFFFFFF

        # receive control packets
        try:
            data, addr = rx.recvfrom(protocol.MAX_PACKET_SIZE)
            hdr = protocol.parse_header(data)
            if hdr:
                ptype = hdr.packet_type
                if ptype == protocol.PacketType.ACTUATOR_CONFIG:
                    cfg = protocol.parse_actuator_config(data)
                    if cfg:
                        print(f"[demo_actuator] ACTUATOR_CONFIG controller={cfg.is_abort_controller} "
                              f"actuators={len(cfg.abort_actuators)} pts={len(cfg.abort_pts)} -> Active")
                        board_state = protocol.BoardState.ACTIVE
                elif ptype == protocol.PacketType.ACTUATOR_COMMAND:
                    cmds = protocol.parse_actuator_command(data)
                    for cmd in cmds or []:
                        if cmd.actuator_id in actuators:
                            actuators[cmd.actuator_id].set(cmd.actuator_state != 0)
                            print(f"[demo_actuator] actuator {cmd.actuator_id} -> "
                                  f"{'ON' if cmd.actuator_state else 'OFF'}")
                elif ptype == protocol.PacketType.PWM_ACTUATOR_COMMAND:
                    cmds = protocol.parse_pwm_actuator_command(data)
                    for cmd in cmds or []:
                        if cmd.actuator_id in actuators:
                            actuators[cmd.actuator_id].start_pwm(
                                cmd.duration_ms, cmd.duty_cycle, cmd.frequency_hz)
                            print(f"[demo_actuator] PWM actuator {cmd.actuator_id}: "
                                  f"{cmd.duration_ms}ms duty={cmd.duty_cycle:.2f} "
                                  f"{cmd.frequency_hz:.1f}Hz")
                elif ptype == protocol.PacketType.SERVER_HEARTBEAT and len(data) > 6:
                    engine_state = data[6]
                elif ptype == protocol.PacketType.ABORT:
                    board_state = protocol.BoardState.ABORT_FINISHED
                    for a in actuators.values():
                        a.set(False)
                    print("[demo_actuator] ABORT -> Abort Finished (all off)")
                elif ptype == protocol.PacketType.CLEAR_ABORT:
                    board_state = protocol.BoardState.ACTIVE
                    print("[demo_actuator] CLEAR_ABORT -> Active")
                else:
                    print(f"[demo_actuator] rx {protocol.packet_type_name(ptype)}")
        except socket.timeout:
            pass

        # 1 Hz heartbeat
        if now - last_hb >= 1.0:
            last_hb = now
            hb = protocol._make_header(protocol.PacketType.BOARD_HEARTBEAT, board_ms) + \
                struct.pack(protocol.BOARD_HEARTBEAT_BODY_FORMAT, fw_hash, args.board_id,
                            engine_state, board_state)
            tx.sendto(hb, dest)

        # 10 Hz current-sense data when active (ADC_READ_INTERVAL_MS = 100)
        if board_state == protocol.BoardState.ACTIVE and now - last_data >= 0.1:
            last_data = now
            tx.sendto(build_sensor_data(actuators, board_ms), dest)

        time.sleep(0.005)


if __name__ == "__main__":
    raise SystemExit(main())
