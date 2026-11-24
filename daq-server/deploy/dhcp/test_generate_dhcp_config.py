"""generate_dhcp_config.py: what star-dhcp-sync runs as root on every config save.

Run: python3 -m pytest daq-server/deploy/dhcp -q
"""
from __future__ import annotations

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


# ── board_macs.toml: the MAC -> board ID map beside the config ────────────────

PT23 = '[[board]]\nmac = "36:85:18:6f:ce:55"\nboard_id = 23\n'


def write(tmp_path: Path, config: str, macs: str | None) -> Path:
    c = tmp_path / "config.toml"
    c.write_text(config)
    if macs is not None:
        (tmp_path / "board_macs.toml").write_text(macs)
    return c


def hosts_lines(tmp_path: Path) -> list[str]:
    text = (tmp_path / "star-dhcp.hosts").read_text()
    return [l for l in text.splitlines() if l and not l.startswith("#")]


def run_hosts_only(tmp_path: Path, c: Path, *extra: str) -> int:
    return g.main(["--config", str(c), "--out-dir", str(tmp_path), "--hosts-only", *extra])


def test_a_mapped_board_with_no_config_entry_is_served_its_id_address(tmp_path: Path):
    c = write(tmp_path, CONFIG, PT23)
    assert run_hosts_only(tmp_path, c) == 0
    assert hosts_lines(tmp_path) == [
        "4a:27:e2:3a:ad:71,192.168.2.31,rtd-board,infinite",
        "36:85:18:6f:ce:55,192.168.2.23,board-23,infinite",
    ]


def test_without_the_map_the_output_is_the_config_only_output(tmp_path: Path):
    a, b = tmp_path / "a", tmp_path / "b"
    a.mkdir(); b.mkdir()
    run_hosts_only(a, write(a, CONFIG, None))
    run_hosts_only(b, write(b, CONFIG, "# no boards yet\n"))
    expected = g.build_hosts(g.collect_reservations(g._toml.loads(CONFIG), SUBNET))
    assert (a / "star-dhcp.hosts").read_text() == expected
    assert (b / "star-dhcp.hosts").read_text() == expected


def test_a_named_map_that_is_missing_is_refused(tmp_path: Path):
    c = write(tmp_path, CONFIG, None)
    with pytest.raises(SystemExit):
        run_hosts_only(tmp_path, c, "--board-macs", str(tmp_path / "nope.toml"))


def test_agreeing_sources_are_one_reservation_under_the_config_name(tmp_path: Path):
    c = write(tmp_path, CONFIG, '[[board]]\nmac = "4A-27-E2-3A-AD-71"\nboard_id = 31\n')
    assert run_hosts_only(tmp_path, c) == 0
    assert hosts_lines(tmp_path) == ["4a:27:e2:3a:ad:71,192.168.2.31,rtd-board,infinite"]


def test_a_config_entry_without_a_mac_lends_the_mapped_board_its_name(tmp_path: Path):
    config = CONFIG + '\n[boards.pt_board_3]\nip = "192.168.2.23"\nboard_id = 23\n'
    c = write(tmp_path, config, PT23)
    assert run_hosts_only(tmp_path, c) == 0
    assert "36:85:18:6f:ce:55,192.168.2.23,pt-board-3,infinite" in hosts_lines(tmp_path)


def test_sources_disagreeing_about_a_board_are_refused_and_nothing_changes(tmp_path: Path):
    hosts = tmp_path / "star-dhcp.hosts"
    hosts.write_text("served before\n")
    c = write(tmp_path, CONFIG, '[[board]]\nmac = "aa:bb:cc:dd:ee:01"\nboard_id = 31\n')
    with pytest.raises(SystemExit):
        run_hosts_only(tmp_path, c)
    assert hosts.read_text() == "served before\n"


@pytest.mark.parametrize("macs, why", [
    # the rtd board's MAC claimed for a second board
    ('[[board]]\nmac = "4a:27:e2:3a:ad:71"\nboard_id = 23\n', "duplicate MAC"),
    # a recovery address shared with the rtd board (ad:71 -> 169.254.174.113)
    ('[[board]]\nmac = "00:00:00:00:ad:71"\nboard_id = 23\n', "recovery address"),
    # the same board listed twice
    (PT23 + '[[board]]\nmac = "36:85:18:6f:ce:56"\nboard_id = 23\n', "listed twice"),
    # IDs that are not addresses a board can take
    ('[[board]]\nmac = "36:85:18:6f:ce:55"\nboard_id = 0\n', "integer 1-254"),
    ('[[board]]\nmac = "36:85:18:6f:ce:55"\nboard_id = 255\n', "integer 1-254"),
    ('[[board]]\nmac = "36:85:18:6f:ce:55"\nboard_id = "23"\n', "integer 1-254"),
    ('[[board]]\nmac = "36:85:18:6f:ce:55"\nboard_id = true\n', "integer 1-254"),
    # inside the dynamic pool
    ('[[board]]\nmac = "36:85:18:6f:ce:55"\nboard_id = 210\n', "dynamic pool"),
    # no MAC, or not a MAC
    ('[[board]]\nboard_id = 23\n', "has no mac"),
    ('[[board]]\nmac = "36:85:18:6f:ce"\nboard_id = 23\n', "malformed MAC"),
])
def test_a_bad_map_is_refused_for_its_own_reason(tmp_path: Path, capsys, macs: str, why: str):
    # Asserting the reason, not just the refusal: several of these would also
    # trip a neighbouring check, which would hide the loss of their own.
    c = write(tmp_path, CONFIG, macs)
    with pytest.raises(SystemExit):
        run_hosts_only(tmp_path, c)
    assert why in capsys.readouterr().err
    assert not (tmp_path / "star-dhcp.hosts").exists()


def test_a_mapped_board_outside_a_narrower_subnet_is_refused(capsys):
    # On a /24 every ID 1-254 is inside; a /25 holding .128-.255 has no .23.
    with pytest.raises(SystemExit):
        g.merge_reservations([], [(23, "36:85:18:6f:ce:55")], {},
                             ipaddress.ip_network("192.168.2.128/25"))
    assert "outside subnet" in capsys.readouterr().err


def test_gui_reservations_give_a_mapped_board_its_id(tmp_path: Path):
    cfg_ = g._toml.loads(CONFIG)
    res = g.merge_reservations(g.collect_reservations(cfg_, SUBNET),
                               [(23, "36:85:18:6f:ce:55")], cfg_, SUBNET)
    entries = g.json.loads(g.build_gui_reservations(res, cfg_["boards"]))["reservations"]
    assert entries[0] == {"mac": "36:85:18:6f:ce:55", "ip": "192.168.2.23",
                          "board_id": 23, "label": "board_23"}
