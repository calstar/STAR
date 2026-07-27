"""Exercise the scraper against a local mock that mimics the HAR's API shape."""
import json
import os
import re
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse, parse_qs

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import scrape_fruitychutes as fc

# Records lifted verbatim from the HAR, plus a couple of synthetic ones with a
# trim suffix so the enumeration/prefix logic gets exercised.
DB = [
    json.loads(
        '{"id":410,"SKU":"CFC-96","model":"CFC","trim":null,"style":"Classic Elliptical with nylon lines","canopy_style":"elliptical","diameter":"96.0000","diameter_spill":"19.2000","gores":"12.0000","rate_20":"34.4539","rate_15":"19.3803","weight_oz":"30.0000","weight_grams":"850.5000","packing_volume":"166.67","area_projected":"48.2548","cd_projected":"1.5000","area_canopy":"85.8936","cd_area_canopy":"0.8427","equivalent_flattend_d":"125.4922","performance_ratio_20":"18.3754","performance_ratio_15":"10.3362","manufacturer":"Fruity Chutes","url":null,"description":"CFC-96 - 96 in diameter Classic Elliptical with nylon lines","area_spill":"2.0106"}'
    ),
    json.loads(
        '{"id":400,"SKU":"CFC-84","model":"CFC","trim":null,"style":"Classic Elliptical with nylon lines","canopy_style":"elliptical","diameter":"84.0000","diameter_spill":"16.8000","gores":"14.0000","rate_20":"26.3788","rate_15":"14.8381","weight_oz":"21.0000","weight_grams":"595.3500","packing_volume":"116.67","area_projected":"36.9451","cd_projected":"1.5000","area_canopy":"65.7623","cd_area_canopy":"0.8427","equivalent_flattend_d":"109.8057","performance_ratio_20":"20.0981","performance_ratio_15":"11.3052","manufacturer":"Fruity Chutes","url":null,"description":"CFC-84 - 84 in diameter Classic Elliptical with nylon lines","area_spill":"1.5394"}'
    ),
    json.loads(
        '{"id":430,"SKU":"TARC-16","model":"TARC","trim":null,"style":"Elliptical light weight with Spectra lines","canopy_style":"elliptical","diameter":"16.0000","diameter_spill":"3.2000","gores":"6.0000","rate_20":"0.9571","rate_15":"0.5383","weight_oz":"0.7500","weight_grams":"21.2625","packing_volume":"4.17","area_projected":"1.3404","cd_projected":"1.5000","area_canopy":"2.3859","cd_area_canopy":"0.8427","equivalent_flattend_d":"20.9154","performance_ratio_20":"20.4172","performance_ratio_15":"11.4846","manufacturer":"Fruity Chutes","url":null,"description":"TARC-16 - 16 in diameter Elliptical light weight with Spectra lines","area_spill":"0.0559"}'
    ),
    # The user's own example row -- an Iris Ultra with a trim suffix.
    {
        "id": 300, "SKU": "IFC-48-S", "model": "IFC", "trim": "S",
        "style": "Iris Ultra Standard with nylon lines", "canopy_style": "annular",
        "diameter": "48.0000", "diameter_spill": "8.4480", "gores": "8.0000",
        "rate_20": "12.7519", "rate_15": "7.1729", "weight_oz": "7.5000",
        "weight_grams": "212.6250", "packing_volume": "41.67",
        "area_projected": "12.1771", "cd_projected": "2.2000",
        "area_canopy": "21.6752", "cd_area_canopy": "1.2360",
        "equivalent_flattend_d": "63.0403", "performance_ratio_20": "27.2040",
        "performance_ratio_15": "15.3022", "manufacturer": "Fruity Chutes",
        "url": None, "description": "IFC-48-S", "area_spill": "0.3891",
    },
    {
        "id": 301, "SKU": "IFC-60-S", "model": "IFC", "trim": "S",
        "style": "Iris Ultra Standard with nylon lines", "canopy_style": "annular",
        "diameter": "60.0000", "diameter_spill": "10.5600", "gores": "8.0000",
        "rate_20": "19.9248", "rate_15": "11.2076", "weight_oz": "11.0000",
        "weight_grams": "311.8500", "packing_volume": "61.11",
        "area_projected": "19.0267", "cd_projected": "2.2000",
        "area_canopy": "33.8675", "cd_area_canopy": "1.2360",
        "equivalent_flattend_d": "78.8004", "performance_ratio_20": "28.9815",
        "performance_ratio_15": "16.3020", "manufacturer": "Fruity Chutes",
        "url": None, "description": "IFC-60-S", "area_spill": "0.6080",
    },
]

CALC_PAGE = """<!doctype html><html><body>
<form><select id="term" name="term" class="zelect">
  <option value="">-- choose --</option>
  <option value="CFC-84">CFC-84</option>
  <option value="CFC-96">CFC-96</option>
  <option value="TARC-16">TARC-16</option>
  <option value="IFC-48-S">IFC-48-S</option>
</select>
<select id="units"><option value="metric">Metric</option></select>
</form></body></html>"""

MODE = {"partial": True, "bulk": False}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == fc.CALCULATOR_PATH:
            return self._send(CALC_PAGE.encode(), "text/html")
        if parsed.path != fc.API_PATH:
            self.send_error(404)
            return
        q = parse_qs(parsed.query, keep_blank_values=True)
        method = (q.get("method") or [""])[0]
        term = (q.get("term") or [""])[0]

        if method in ("list", "all") or (method == "search" and not term):
            if not MODE["bulk"]:
                return self._send(b"", "text/javascript")
            return self._send(json.dumps(DB).encode(), "text/javascript")
        if method != "get":
            return self._send(b"", "text/javascript")
        if not term:
            return self._send(b"[]", "text/javascript")
        if MODE["partial"]:
            hits = [r for r in DB if term.upper() in r["SKU"].upper()]
        else:
            hits = [r for r in DB if term.upper() == r["SKU"].upper()]
        return self._send(json.dumps(hits).encode(), "text/javascript")

    def _send(self, body, ctype):
        self.send_response(200)
        self.send_header("Content-Type", ctype + "; charset=UTF-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def run_case(name, *, partial, bulk, want=None, **collect_kw):
    """Run collect() against the mock. `want` defaults to the full catalogue."""
    MODE["partial"], MODE["bulk"] = partial, bulk
    client = fc.FruityChutesClient(delay=0.0, retries=1, timeout=5)
    kw = dict(use_bulk=True, use_dropdown=True, use_sweep=True,
              enumerate_max=0, refetch=True)
    kw.update(collect_kw)
    records = fc.collect(client, None, **kw)
    got = sorted(str(r["SKU"]) for r in records)
    expected = sorted(want if want is not None else [r["SKU"] for r in DB])
    status = "PASS" if got == expected else "FAIL"
    print(f"[{status}] {name}: {len(got)}/{len(expected)} -> {got}")
    return status == "PASS", records


server = HTTPServer(("127.0.0.1", 8731), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
fc.BASE = "http://127.0.0.1:8731"

results = []
ok, recs = run_case("bulk dump available", partial=True, bulk=True)
results.append(ok)
ok, _ = run_case("no bulk, partial match (dropdown+sweep)", partial=True, bulk=False)
results.append(ok)
# With exact-match-only matching and no bulk dump, the dropdown is the only
# source, so a SKU the dropdown omits (IFC-60-S) is expected to be missed.
ok, _ = run_case("no bulk, exact match only -> dropdown SKUs only",
                 partial=False, bulk=False,
                 want=["CFC-84", "CFC-96", "IFC-48-S", "TARC-16"])
results.append(ok)
# ...and enumeration is the fallback that recovers it.
MODE["partial"], MODE["bulk"] = False, False
client = fc.FruityChutesClient(delay=0.0, retries=1, timeout=5)
recs = fc.collect(client, None, use_bulk=False, use_dropdown=True,
                  use_sweep=False, enumerate_max=60, refetch=False)
got = sorted(str(r["SKU"]) for r in recs)
ok = got == sorted(r["SKU"] for r in DB)
print(f"[{'PASS' if ok else 'FAIL'}] exact-match + enumeration: {got}")
results.append(ok)

# Explicit SKU mode
client = fc.FruityChutesClient(delay=0.0, retries=1, timeout=5)
MODE["partial"] = False
recs = fc.collect(client, ["CFC-96", "TARC-16", "NOPE-1"], use_bulk=False,
                  use_dropdown=False, use_sweep=False, enumerate_max=0, refetch=False)
got = sorted(str(r["SKU"]) for r in recs)
ok = got == ["CFC-96", "TARC-16"]
print(f"[{'PASS' if ok else 'FAIL'}] explicit SKUs (incl. one bogus): {got}")
results.append(ok)

# Output writers + the user's example table
import tempfile, os
d = tempfile.mkdtemp()
MODE["partial"] = True
client = fc.FruityChutesClient(delay=0.0, retries=1, timeout=5)
recs = fc.collect(client, None, use_bulk=True, use_dropdown=False,
                  use_sweep=False, enumerate_max=0, refetch=False)
MODE["bulk"] = True
recs = fc.collect(client, None, use_bulk=True, use_dropdown=False,
                  use_sweep=False, enumerate_max=0, refetch=False)
fc.write_json(recs, os.path.join(d, "parachutes.json"))
fc.write_csv(recs, os.path.join(d, "parachutes.csv"))
with open(os.path.join(d, "parachutes.csv")) as h:
    lines = h.read().splitlines()
print("\nCSV header:", lines[0][:160])
print("CSV rows:", len(lines) - 1)
results.append(len(lines) - 1 == len(DB))

print("\n--- print_metrics_table for IFC-48-S (compare to the user's example) ---")
fc.print_metrics_table(next(r for r in recs if r["SKU"] == "IFC-48-S"))

server.shutdown()
print("\nALL PASS" if all(results) else "\nSOME FAILED")
sys.exit(0 if all(results) else 1)
