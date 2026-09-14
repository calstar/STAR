"""The one rule Phase 00 exists to enforce: no ``PropsSI`` in library code.

CoolProp offers three ways to ask the same question. Measured on the development
host, nitrogen density at a fixed state point:

===========================================  ==========  ============
call path                                      per call    throughput
===========================================  ==========  ============
``PropsSI('D', 'T', t, 'P', p, 'Nitrogen')``   184.5 us       5.4 k/s
``AbstractState('HEOS', ...)``, reused           3.18 us       315 k/s
``AbstractState('BICUBIC&HEOS', ...)``           0.14 us       7.1 M/s
===========================================  ==========  ============

That is a 1300x spread across three spellings of one line. ``PropsSI`` parses
its fluid name and rebuilds the backend on *every call*; the low-level interface
does that once. A stiff transient on a sixty-node network evaluates properties
millions of times over Jacobian assembly, so the choice is the difference
between a run that finishes in seconds and one that finishes overnight.

The failure mode this guards against is not someone deciding ``PropsSI`` is
fine. It is someone reaching for the convenient one-liner while debugging, in a
branch that only runs on the cold path, and it never being noticed -- because
nothing about it is wrong except how long it takes, and the profile of a slow
solve rarely names the line that caused it.

Tests are exempt. Comparing the two paths is exactly how the numbers above were
obtained, and the property layer's regression suite (Phase 01) will want the
reference implementation to check the tabulated one against.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

PACKAGE_ROOT = Path(__file__).resolve().parents[1] / "feedtwin"

#: The convenience wrappers. Each rebuilds its backend per call.
#:
#: Matched on a word boundary so ``_PropsSI_is_banned`` or a mention inside a
#: sentence in a docstring does not trip the check -- only something that reads
#: as a call does.
BANNED = re.compile(r"\b(PropsSI|Props1SI|HAPropsSI|PhaseSI)\s*\(")

GUIDANCE = (
    "Use a cached feedtwin.props.Fluid (CoolProp AbstractState, BICUBIC&HEOS) "
    "instead -- it is ~1300x faster per call. See this module's docstring."
)


def _library_sources() -> list[Path]:
    return sorted(PACKAGE_ROOT.rglob("*.py"))


def test_package_root_exists() -> None:
    """A moved package would make the scan below silently vacuous."""
    assert PACKAGE_ROOT.is_dir(), f"expected the feedtwin package at {PACKAGE_ROOT}"
    assert _library_sources(), f"no Python sources found under {PACKAGE_ROOT}"


@pytest.mark.parametrize("source", _library_sources(), ids=lambda p: p.name)
def test_no_propssi_in_library_code(source: Path) -> None:
    """No convenience CoolProp call anywhere under ``feedtwin/``."""
    offenders = [
        (n, line.strip())
        for n, line in enumerate(source.read_text().splitlines(), start=1)
        if BANNED.search(line)
    ]

    if offenders:
        listed = "\n".join(f"  {source.name}:{n}  {text}" for n, text in offenders)
        pytest.fail(f"banned CoolProp convenience call:\n{listed}\n\n{GUIDANCE}")
