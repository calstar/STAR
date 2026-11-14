#!/usr/bin/env python3
"""Send a new FPGA image to the transmitter over its USB port (the P4's
USB Serial/JTAG), without reflashing the firmware. The firmware turns the
RF off, writes the image into its "fpga" partition, checks the CRC and
restarts; a failed or cut-short transfer leaves an image the boot-time
check rejects, so the FPGA then boots from its W25Q32.

    tools/make_fpga_image.py ../gateware/build/dvbt_tx_top/out.bit build/fpga.img
    tools/fpga_update.py /dev/ttyACM0 build/fpga.img

Needs pyserial (pip install pyserial).
"""
import sys
import time

import serial  # type: ignore

port, path = sys.argv[1], sys.argv[2]
img = open(path, "rb").read()
assert img[:8] == b"DVBTFPGA", "not an image from make_fpga_image.py"
with serial.Serial(port, 115200, timeout=0.2) as s:
    s.reset_input_buffer()
    for i in range(0, len(img), 4096):
        s.write(img[i:i + 4096])
        print(f"\r{min(i + 4096, len(img))}/{len(img)} bytes", end="", flush=True)
    print()
    deadline, buf = time.time() + 30, b""
    while time.time() < deadline:
        buf += s.read(256)
        for line in buf.split(b"\n"):
            if line.startswith(b"FPGA-UPDATE OK"):
                print(line.decode(), "- the transmitter restarts with it")
                sys.exit(0)
            if line.startswith(b"FPGA-UPDATE ERR"):
                print(line.decode())
                sys.exit(1)
    print("no answer from the transmitter (is CONFIG_DVBT_USB_FPGA_UPDATE on?)")
    sys.exit(2)
