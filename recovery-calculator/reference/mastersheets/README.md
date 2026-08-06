# Recovery mastersheets

Two Google Sheets workbooks that have actually sized flight hardware, exported to `.xlsx`
and committed here as the provenance for `physics/mastersheet.py`. They are **reference
material, not inputs** — nothing in `physics/` reads these files at runtime.

| File | Vehicle |
|---|---|
| `Camelot_Recovery_Mastersheet.xlsx` | Camelot, plus an LE3 section |
| `LE3 Recovery Mastersheet 25-26.xlsx` | LE3, 25-26 |

## Where the math lives

The descent and shock-load math is in Google Sheets **Named Functions** (Data → Named
functions), not Apps Script. That distinction matters: Apps Script is bound to the
document and does **not** survive an `.xlsx` export, but Named Functions do, as
`<definedName>` LAMBDA entries in `xl/workbook.xml`. Both workbooks carry an identical
copy of the set, so `physics/mastersheet.py` is a transcription with no fitted constants.

To re-read them without a spreadsheet program:

```bash
python3 -c "
import zipfile, re, html
wb = zipfile.ZipFile('Camelot_Recovery_Mastersheet.xlsx').read('xl/workbook.xml').decode()
for m in re.finditer(r'<definedName name=\"([^\"]+)\">(.*?)</definedName>', wb, re.S):
    print('###', m.group(1)); print(html.unescape(m.group(2)), end='\n\n')
"
```

The eight functions, verbatim:

```
POUND_SLUG(x)             = x/32.174
DIAMIN_AREAFT(d_in)       = ((d_in/24)^2)*3.14159
TROP_DENSITY(h_ft)        = 0.002377*((288.15 - h_ft*0.0019812)/288.15)^4.2558
SHOCK_LOAD(rho,v,S,Cd,Cx,X) = 0.5*rho*v^2*S*Cd*Cx*X
TROP_DESCENT_TIME(S,Cd,W,top,bot,L,rho_ref,T_ref)
DESCENT_WITH_LAPSE(S,Cd,W,L,T_ref,rho_ref,z_ref,top,bot)
DESCENT_0_LAPSE(S,Cd,W,T_ref,rho_ref,z_ref,top,bot)
DESCENT_TIME(S,Cd,W,max_alt,min_alt)
```

`0.010413` throughout is `g/R` in K/ft. `4.2558 = g/(R·L) − 1` and `6.2558 = g/(R·L) + 1`
for the tropospheric lapse rate `L = 0.0019812 K/ft`. `π` is hard-coded as `3.14159`.

## Which sheets call them

| Workbook | Sheet |
|---|---|
| Camelot | `2) Shockloading`, `b) LE3 Shockloading` |
| LE3 | `2) 3 Parachute Shockloading` |

LE3's `1) Shockloading Calc` contains **no formulas at all** — it is pasted narrative
results ("Maximum shock loading: 477 lbf") with no derivation behind them. Do not treat it
as a calculation.

## Two things worth knowing before trusting the outputs

**The descent-time call is pinned to sea level.** `TROP_DESCENT_TIME` is algebraically
`DESCENT_WITH_LAPSE` with `ref_alt = 0` — the exponent `0.5·6.2558` is `g/(2RL) + 0.5` and
the denominator `6.2558·L` is `L + g/R`, agreeing to 2e-6 (the sheet rounds the two
constants independently) — so it has no reference-altitude parameter. The sheets pass it
**AGL** altitudes while passing `TROP_DENSITY` **AMSL** ones, so descent time is integrated
through air the vehicle never flies (4600 ft of it at Camelot's field).

It runs **high** — 7.4% on the Camelot drogue leg. The real descent is higher up in thinner
air, so the vehicle falls faster and lands sooner than the sheet says, and the drift
computed from that time is overstated with it. Conservative for sizing a recovery area,
wrong for predicting where the vehicle actually lands.

**`DESCENT_TIME` is defined and never called.** It is the correct 7-layer standard
atmosphere version, chaining `DESCENT_WITH_LAPSE`/`DESCENT_0_LAPSE` with proper per-layer
reference altitudes over 0 → 232,940 ft. The shockloading sheets use the single-layer
sea-level-anchored `TROP_DESCENT_TIME` instead. `physics/mastersheet.py` ports both and
the Cross-check tab reports each, so the gap between what the sheet said and what its own
unused function would have said is visible.
