"""The unit-preference schema must cover every `Kind` the frontend can send.

`UnitPrefs` sets ``extra="forbid"`` and the Units tab writes the *whole* prefs
object at once (``setAll`` spreads every kind), so one missing field does not
degrade to "that one preference is ignored" -- it 422s the entire save. That is
exactly what happened: ``volume`` and ``torque`` were in the TypeScript union
and never declared here, so no unit preference ever reached the volume. They
survived only in the browser's localStorage mirror, which is why it looked fine
on the machine that set them and followed nobody to a second one.

The list is parsed out of the TypeScript rather than duplicated here, so this
fails when the two drift rather than when someone forgets to update a copy.
"""

import os
import re
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

pytest.importorskip("fastapi", reason="the settings model imports pydantic via fastapi")

from backend.recovery.routers.settings import UnitPrefs  # noqa: E402

_QUANTITIES = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "frontend", "src", "lib", "units", "quantities.ts",
)


def _frontend_kinds() -> set[str]:
    """The `Kind` union from quantities.ts, as a set of names."""
    src = open(_QUANTITIES, encoding="utf-8").read()
    m = re.search(r"export type Kind =\s*(.+?)\n\n", src, re.S)
    assert m, "could not find the Kind union in quantities.ts"
    return set(re.findall(r"'([a-zA-Z]+)'", m.group(1)))


def test_every_frontend_kind_has_a_field():
    missing = _frontend_kinds() - set(UnitPrefs.model_fields)
    assert not missing, (
        f"quantities.ts can send {sorted(missing)}, which UnitPrefs does not declare. "
        "extra=forbid means the whole PUT /api/settings 422s, so no preference saves."
    )


def test_no_field_the_frontend_cannot_send():
    """The other direction: a stale field here is dead weight, and a sign the
    two drifted. Not fatal like the above, but it should not go unnoticed."""
    extra = set(UnitPrefs.model_fields) - _frontend_kinds()
    assert not extra, f"UnitPrefs declares {sorted(extra)}, absent from the TS Kind union"
