"""generate_dhcp_config.py: what star-dhcp-sync runs as root on every config save.

Run: python3 -m pytest daq-server/deploy/dhcp -q
"""
import ipaddress
from pathlib import Path

import pytest

import generate_dhcp_config as g

SUBNET = ipaddress.ip_network("192.168.2.0/24")


def board(ip, mac, board_id=None):
    b = {"ip": ip, "mac": mac}
    if board_id is not None:
        b["board_id"] = board_id
    return b


def cfg(**boards):
    return {"boards": boards}


def test_recovery_address_matches_firmware_and_ota_tool():
    # The same vectors as test_board_net.cpp and ota_upload.py --self-test.
    assert g.recovery_address("4a:27:e2:3a:ad:71") == "169.254.174.113"
    assert g.recovery_address("00:00:00:00:00:00") == "169.254.1.0"
    assert g.recovery_address("00:00:00:00:fe:ff") == "169.254.1.255"
    assert g.recovery_address("00:00:00:00:ff:01") == "169.254.2.1"


def test_two_boards_sharing_a_recovery_address_are_refused():
    # 0x00 and 0xfe both map to third octet 1; same last byte.
    c = cfg(a=board("192.168.2.21", "aa:aa:aa:aa:00:10"),
            b=board("192.168.2.22", "bb:bb:bb:bb:fe:10"))
    with pytest.raises(SystemExit):
        g.collect_reservations(c, SUBNET)


def test_board_id_must_match_its_address():
    # The board takes its ID from its address, so the server would file it wrong.
    with pytest.raises(SystemExit):
        g.collect_reservations(cfg(rtd=board("192.168.2.31", "4a:27:e2:3a:ad:71", 32)), SUBNET)
    ok = g.collect_reservations(cfg(rtd=board("192.168.2.31", "4a:27:e2:3a:ad:71", 31)), SUBNET)
    assert ok == [("rtd", "4a:27:e2:3a:ad:71", "192.168.2.31")]


IP_ADDR = """\
1: lo    inet 127.0.0.1/8 scope host lo\\       valid_lft forever preferred_lft forever
2: enp4s0    inet 192.168.2.20/24 brd 192.168.2.255 scope global enp4s0\\       valid_lft forever
2: enp4s0    inet 169.254.0.20/16 scope global enp4s0\\       valid_lft forever
3: wlx0cef15768c39    inet 10.0.0.5/24 brd 10.0.0.255 scope global dynamic wlx0cef15768c39
"""


def test_interface_is_the_one_on_the_board_subnet():
    # Not the laptop adapter name that used to be hardcoded.
    assert g.interfaces_in_subnet(IP_ADDR, SUBNET) == ["enp4s0"]
    assert g.interfaces_in_subnet(IP_ADDR, ipaddress.ip_network("172.16.0.0/16")) == []


CONFIG = """
[boards.rtd_board]
ip = "192.168.2.31"
board_id = 31
mac = "4a:27:e2:3a:ad:71"
"""


def test_hosts_only_writes_just_the_reservations(tmp_path: Path):
    c = tmp_path / "config.toml"
    c.write_text(CONFIG)
    assert g.main(["--config", str(c), "--out-dir", str(tmp_path), "--hosts-only"]) == 0
    assert (tmp_path / "star-dhcp.hosts").read_text().strip().endswith(
        "4a:27:e2:3a:ad:71,192.168.2.31,rtd-board,infinite")
    assert not (tmp_path / "star-dhcp.conf").exists()


def test_a_refused_config_leaves_the_served_list_alone(tmp_path: Path):
    hosts = tmp_path / "star-dhcp.hosts"
    hosts.write_text("served before\n")
    c = tmp_path / "config.toml"
    c.write_text(CONFIG.replace("board_id = 31", "board_id = 32"))
    with pytest.raises(SystemExit):
        g.main(["--config", str(c), "--out-dir", str(tmp_path), "--hosts-only"])
    assert hosts.read_text() == "served before\n"
    assert not (tmp_path / "star-dhcp.hosts.tmp").exists()
