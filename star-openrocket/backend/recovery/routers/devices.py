"""GET /api/devices. PLAN.md §11.3.

The device picker is the highest-value control in the application, because it
removes the §4.1 trap **by construction**: nobody who picks a row from the
catalogue can recompute S_p as pi*D^2/4 and silently overstate CdS by 3.2%.
Fruity Chutes' `area_projected` excludes the spill hole -- the opposite of the
Knacke convention -- and that error is invisible in testing.

So this endpoint's job is to serve numbers already converted by eqs (A1)-(A3),
never raw diameters the UI might be tempted to square.
"""

from fastapi import APIRouter, Query, Request

router = APIRouter(prefix="/api", tags=["devices"])

# Non-Fruity rows are transcriptions of competitors' specs. The spill-hole
# convention was verified to hold across all six manufacturers (120 of 121
# rows satisfy area_projected + area_spill == pi*d^2/4), so they are safe to
# serve -- but the vendor is surfaced so a user can weigh it.
MAX_RESULTS = 60


def _entry_payload(entry, manual=False):
    return {
        "sku": entry.sku,
        "vendor": entry.manufacturer,
        "name": entry.row.get("description") or entry.sku,
        "CdS": entry.CdS,      # eq (A1), already SI
        "D0": entry.D0,        # eq (A2)
        "m_c": entry.m_c,      # eq (A3)
        "j": entry.j,
        "manual": manual,
        # Sizing context the picker shows alongside the physics inputs.
        "rating_20fps_kg": entry.rating_20fps_kg,
        "canopy_style": entry.canopy_style,
    }


@router.get("/devices")
def search_devices(
    request: Request,
    q: str = Query("", description="Substring match on SKU, model or vendor"),
    vendor: str = Query("", description="Exact vendor filter"),
    limit: int = Query(MAX_RESULTS, ge=1, le=500),
):
    """Substring search over the committed device table.

    An in-memory scan over 121 rows is ~0.06 ms, so there is no index and no
    database -- §11.2 measured SQLite's connect-and-query at 0.35 ms for the
    same work, where connection overhead dominates any indexing benefit.
    """
    catalogue = getattr(request.app.state, "catalogue", {}) or {}

    # Match on all tokens rather than the raw substring. "iris 48" must find
    # the IFC-48, whose description reads "IFC-48 - 48 in diameter Iris Ultra
    # Standard..." -- the words are present but not adjacent, so a substring
    # test finds nothing and the picker looks broken for the most obvious
    # query anyone will type.
    tokens = [t for t in q.strip().lower().split() if t]

    hits = []
    for entry in catalogue.values():
        if vendor and entry.manufacturer != vendor:
            continue
        if tokens:
            haystack = " ".join((
                entry.sku, entry.model, entry.manufacturer,
                entry.row.get("description") or "", entry.canopy_style,
            )).lower()
            if not all(token in haystack for token in tokens):
                continue
        hits.append(_entry_payload(entry))

    # Smallest first: a picker is nearly always used to find a drogue or to
    # step up one size, and ordering by drag area makes that a scan rather
    # than a search.
    hits.sort(key=lambda d: d["CdS"])
    return hits[:limit]


@router.get("/devices/vendors")
def list_vendors(request: Request):
    """Vendor facets for the picker. The catalogue is multi-vendor: only 68 of
    121 rows are Fruity Chutes."""
    catalogue = getattr(request.app.state, "catalogue", {}) or {}
    counts = {}
    for entry in catalogue.values():
        counts[entry.manufacturer] = counts.get(entry.manufacturer, 0) + 1
    return [{"vendor": v, "count": n}
            for v, n in sorted(counts.items(), key=lambda kv: -kv[1])]


@router.get("/devices/{sku}")
def get_device(sku: str, request: Request):
    from fastapi import HTTPException

    catalogue = getattr(request.app.state, "catalogue", {}) or {}
    entry = catalogue.get(sku)
    if entry is None:
        raise HTTPException(status_code=404, detail="no device %r" % sku)
    return _entry_payload(entry)
