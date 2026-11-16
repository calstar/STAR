"""The pin map in main/Kconfig.projbuild against the board: every GPIO default
as the schematic has it, no pin used twice, none on USB (24/25), the BOOT
button (35) or the pulled-up strap (36)."""
from __future__ import annotations

import re
from pathlib import Path

KCONFIG = Path(__file__).resolve().parents[2] / "main/Kconfig.projbuild"

BOARD = {
    # TS link
    "FPGA_DREQ": 6, "FPGA_CS": 7, "FPGA_MOSI": 8, "FPGA_SCK": 9, "FPGA_MISO": 10,
    # FPGA configuration
    "CFG_PROGRAMN": 11, "CFG_INITN": 12, "CFG_DONE": 13, "CFG_CFG0": 14, "CFG_CFG1": 15,
    "CFG_SN": 28, "CFG_MOSI": 29, "CFG_CCLK": 30, "CFG_MISO": 31,
    # AD9116 bus, DAC control, ADRF6755 lines
    "DAC_SCLK": 16, "DAC_SDIO": 17, "ADRF_SDO": 18, "DAC_CS": 19, "ADRF_CS": 20,
    "DAC_RESET": 21, "ADRF_TXDIS": 22, "ADRF_LDET": 23, "ADRF_CLK": 32, "ADRF_SDI": 33,
    # power, PA, arming, LED
    "RF_PWR": 0, "PA_EN": 1, "ARM": 47, "LED": 48,
    # I2C0 (Si5351A), camera
    "I2C_SDA": 49, "I2C_SCL": 50, "CAM_SCCB_SDA": 51, "CAM_SCCB_SCL": 52, "CAM_EN": 54,
    # flight computer UART
    "FC_TX": 45, "FC_RX": 46,
    # SD NAND (D1-D3 = D0 + 1..3)
    "SD_D0": 39, "SD_CLK": 43, "SD_CMD": 44,
}
AVOID = {24, 25, 35, 36}


def gpio_defaults() -> dict[str, int]:
    out = {}
    for m in re.finditer(r"config DVBT_(\w+)\n\s+int \"[^\"]*GPIO[^\"]*\"\n(?:\s+range[^\n]*\n)?\s+default (-?\d+)",
                         KCONFIG.read_text()):
        out[m.group(1)] = int(m.group(2))
    return out


def test_pin_defaults_match_the_board():
    got = gpio_defaults()
    assert {k: got.get(k) for k in BOARD} == BOARD
    extra = {k: v for k, v in got.items() if k not in BOARD and v >= 0}
    assert not extra, f"GPIOs not on the board table: {extra}"


def test_no_pin_used_twice_or_on_a_reserved_one():
    got = {k: v for k, v in gpio_defaults().items() if v >= 0}
    used = list(got.values()) + [got["SD_D0"] + i for i in (1, 2, 3)]
    assert len(used) == len(set(used)), sorted(used)
    assert not AVOID & set(used) and all(0 <= v <= 54 for v in used)
