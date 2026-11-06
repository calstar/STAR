"""Fake Diablo DAQ server. Drives the host build of CapFill's daq_link and checks its behavior.
Decodes board packets with the club's own parser functions from DiabloAvionics/test_guis/sense_testing_gui.py."""
import ast, socket, struct, subprocess, sys, time, typing, os

GUI = os.path.join(os.environ['REF'], 'DiabloAvionics/test_guis/sense_testing_gui.py')
tree = ast.parse(open(GUI).read())
keep = [n for n in tree.body if (isinstance(n, ast.Assign) and all(isinstance(t, ast.Name) and (t.id.isupper() or t.id == 'PacketType') for t in n.targets) and 'Path' not in ast.unparse(n))
        or (isinstance(n, ast.FunctionDef) and n.name.startswith('parse_'))]
G = {'struct': struct, 'Optional': typing.Optional, 'Tuple': typing.Tuple, 'List': typing.List, 'Dict': typing.Dict}
exec(compile(ast.Module(body=keep, type_ignores=[]), 'gui', 'exec'), G)

BOARD = ('127.0.0.1', 5005)
def hdr(t): return struct.pack('<BBI', t, 0, int(time.time() * 1000) & 0xffffffff)
def sensor_config(ids, ref=0, abort=False, ip=(0, 0, 0, 0), serial=1):
    b = hdr(5) + bytes([len(ids)]) + bytes(ids) + bytes([ref, 1 if abort else 0])
    if abort: b += bytes(ip)
    return b + bytes([serial])
def server_hb(engine): return hdr(2) + bytes([engine])

server = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); server.bind(('127.0.2.20', 5006)); server.settimeout(0.05)
ctrl = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); ctrl.bind(('127.0.2.11', 5006)); ctrl.settimeout(0.05)
tx = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)

results = []
def SELFTEST_OK(parsed, expect_adc):
    # parsed = (header, adc_good, [ {sensor_id, result} | (id, result) ... ]) per the club GUI parser
    header, items = parsed
    adc = header['adc_good']
    pairs = [(i['sensor_id'], i['result']) if isinstance(i, dict) else tuple(i) for i in items]
    want = [(4, expect_adc), (1, expect_adc), (7, 0)]
    return adc == expect_adc and pairs == want
def check(name, ok, detail=''):
    results.append(ok); print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f"  ({detail})" if detail else ''))

def collect(sock, secs):
    out, end = [], time.time() + secs
    while time.time() < end:
        try: data, src = sock.recvfrom(2048); out.append((time.time(), data, src))
        except socket.timeout: pass
    return out

def split(pkts):
    hb, sd, st = [], [], []
    for t, d, src in pkts:
        if d[0] == 1: hb.append((t, G['parse_board_heartbeat_packet'](d), src))
        elif d[0] == 3: sd.append((t, G['parse_sensor_data_packet'](d), src))
        elif d[0] == 12: st.append((t, G['parse_self_test_packet'](d), src))
    return hb, sd, st

sensor_down = len(sys.argv) > 1 and sys.argv[1] == 'down'
env = dict(os.environ); env.pop('SENSOR_DOWN', None)
if sensor_down: env['SENSOR_DOWN'] = '1'
fw = subprocess.Popen([os.path.join(os.path.dirname(os.path.abspath(__file__)), 'out', 'daq_host')], env=env, stderr=open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'out', 'fw.log'), 'w'))
time.sleep(0.2)
try:
    print("1) Boot, no config yet (3 s)")
    hb, sd, st = split(collect(server, 3.0))
    check("heartbeats arrive ~1/s", 2 <= len(hb) <= 4, f"{len(hb)} in 3 s")
    h = hb[-1][1]
    check("heartbeat decodes: board_id 99, state SETUP(1), engine SAFE(0)", h[2] == 99 and h[4] == 1 and h[3] == 0, f"id={h[2]} engine={h[3]} state={h[4]}")
    check("heartbeat carries 32-byte firmware hash", len(h[1]) == 32 and h[1][0] == 0xA0)
    check("header version 0, ms timestamp", h[0][1] == 0 and h[0][2] > 0)
    check("source port is 5005 (like club boards)", hb[-1][2][1] == 5005, str(hb[-1][2]))
    check("no sensor data before SENSOR_CONFIG", len(sd) == 0)

    print("2) SENSOR_CONFIG ids [4,1,7], no abort")
    tx.sendto(sensor_config([4, 1, 7]), BOARD)
    hb, sd, st = split(collect(server, 2.5))
    check("SELF_TEST packet sent once", len(st) == 1, f"{len(st)}")
    if st:
        print("     self test decoded:", st[0][1])
        flat = repr(st[0][1])
        EXPECT_ADC = 0 if sensor_down else 1
        check("self test: adc_good, ids 4,1 pass, 7 fails" if not sensor_down else "self test: adc_good=0, all fail",
              SELFTEST_OK(st[0][1], EXPECT_ADC))
    states = [x[1][4] for x in hb]
    check("heartbeat went to ACTIVE(2)", states and states[-1] == 2, f"states {states}")
    check("sensor data streaming", len(sd) >= 4, f"{len(sd)} packets in 2.5 s")
    if sd:
        (h0, chunks) = sd[-1][1]
        ids = [[dp['sensor_id'] for dp in c['datapoints']] for c in chunks]
        check("9 chunks per packet", len(chunks) == 9, str(len(chunks)))
        check("only CapFill ids 4,1 in config order (7 dropped)", all(i == [4, 1] for i in ids), str(ids[0]))
        vals = [[dp['data'] for dp in c['datapoints']] for c in chunks]
        check("values come from the right channels", all(v[0] // 1000000 == 4 and v[1] // 1000000 == 1 for v in vals), str(vals[0]))
        ts = [c['timestamp'] for c in chunks]
        check("chunk timestamps increase, ~40 ms apart", all(b > a for a, b in zip(ts, ts[1:])) and 25 <= (ts[-1] - ts[0]) / 8 <= 60, f"avg {(ts[-1]-ts[0])/8:.0f} ms")
        rate = len(sd) / 2.5 * 9
        print(f"     ~{rate:.0f} chunks/s")

    print("3) Server heartbeat engine_state=2 (LOX_FILL)")
    tx.sendto(server_hb(2), BOARD)
    hb, _, _ = split(collect(server, 1.5))
    check("board echoes engine state 2", hb and hb[-1][1][3] == 2, str([x[1][3] for x in hb]))

    print("4) NO_CONNECTION_ABORT while necessary_for_abort = false")
    tx.sendto(hdr(11), BOARD)
    hb, _, _ = split(collect(server, 1.5))
    check("stays ACTIVE", hb and hb[-1][1][4] == 2, str([x[1][4] for x in hb]))

    print("5) New config: ids [2,3], abort controller 192.168.2.11, serial off")
    tx.sendto(sensor_config([2, 3], abort=True, ip=(192, 168, 2, 11), serial=0), BOARD)
    _, sd, st = split(collect(server, 1.5))
    check("no second self test (already active)", len(st) == 0)
    check("stream switched to ids [2,3]", sd and all([dp['sensor_id'] for dp in c['datapoints']] == [2, 3] for c in sd[-1][1][1]))

    print("6) NO_CONNECTION_ABORT with necessary_for_abort = true")
    tx.sendto(hdr(11), BOARD)
    time.sleep(0.1)
    srv = collect(server, 1.5)
    hb, sd, _ = split(srv)
    chb, csd, _ = split(collect(ctrl, 0.05))
    check("state STANDALONE_ABORT(9)", hb and hb[-1][1][4] == 9, str([x[1][4] for x in hb]))
    check("server still gets data", len(sd) >= 2)

    print("   (controller copy, collected in parallel)")
    # collect both at once to compare
    end = time.time() + 1.5; cn = 0; sn = 0
    while time.time() < end:
        for s in (server, ctrl):
            try:
                d, _ = s.recvfrom(2048)
                if s is ctrl: cn += 1
                else: sn += 1
            except socket.timeout: pass
    check("abort controller 192.168.2.11 also gets data + heartbeats", cn >= 3, f"controller {cn} pkts, server {sn}")

    print("7) CLEAR_ABORT")
    tx.sendto(hdr(9), BOARD)
    hb, _, _ = split(collect(server, 1.5))
    check("back to ACTIVE(2)", hb and hb[-1][1][4] == 2, str([x[1][4] for x in hb]))

    print("8) Junk input")
    tx.sendto(b'\x05\x00\x00', BOARD); tx.sendto(bytes([5, 0, 0, 0, 0, 0, 3, 1]), BOARD); tx.sendto(b'', BOARD); tx.sendto(bytes([200]) * 40, BOARD)
    hb, sd, _ = split(collect(server, 1.5))
    check("survives truncated/garbage packets, keeps streaming", fw.poll() is None and len(sd) >= 2 and hb[-1][1][4] == 2)
finally:
    fw.terminate()
print(f"\n{sum(results)}/{len(results)} checks passed")
sys.exit(0 if all(results) else 1)
