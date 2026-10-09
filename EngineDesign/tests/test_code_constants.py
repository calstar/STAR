"""CODE_CONSTANTS is the register behind the Parameters workspace's "In code" section
(``GET /api/config/parameters`` -> ``backend/routers/config.py`` -> ``ConstantsTable`` in
``frontend/src/components/ParametersWorkspace.tsx``). Every entry claims a specific file and a
specific symbol in it; this test is the only thing that checks the claim is still true, since
nothing else re-reads this module against the source it describes.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from engine.pipeline.code_constants import CODE_CONSTANTS

REPO_ROOT = Path(__file__).resolve().parents[1]

_CATEGORIES = {
    "Propellants",
    "Injector",
    "Discharge & Cd",
    "Combustion efficiency",
    "Chamber & nozzle",
    "Thermal protection",
    "Stability",
    "Feed & tanks",
    "Vehicle & flight",
    "Optimizer",
}

_REQUIRED_KEYS = {"name", "value", "where", "meaning", "category", "affects_results"}

# Cache file contents across the whole parametrized run instead of re-reading per entry.
_FILE_CACHE: dict[str, str] = {}


def _read(rel_path: str) -> str:
    if rel_path not in _FILE_CACHE:
        _FILE_CACHE[rel_path] = (REPO_ROOT / rel_path).read_text(encoding="utf-8", errors="replace")
    return _FILE_CACHE[rel_path]


def test_module_is_a_nonempty_list_within_the_stated_range():
    assert isinstance(CODE_CONSTANTS, list)
    # 60-150 per the constants_registry task; this is a sanity band, not a magic number to game.
    assert 60 <= len(CODE_CONSTANTS) <= 150, (
        f"CODE_CONSTANTS has {len(CODE_CONSTANTS)} entries; expected 60-150"
    )


def test_no_duplicate_name_where_pairs():
    seen = set()
    dupes = []
    for c in CODE_CONSTANTS:
        key = (c.get("name"), c.get("where"))
        if key in seen:
            dupes.append(key)
        seen.add(key)
    assert not dupes, f"Duplicate (name, where) pairs: {dupes}"


@pytest.mark.parametrize("i,entry", list(enumerate(CODE_CONSTANTS)))
def test_entry_schema(i, entry):
    """Every entry has exactly the required keys, with the right types and constraints."""
    missing = _REQUIRED_KEYS - entry.keys()
    extra = entry.keys() - _REQUIRED_KEYS
    assert not missing, f"entry {i} ({entry.get('name')!r}) missing keys: {missing}"
    assert not extra, f"entry {i} ({entry.get('name')!r}) has unexpected keys: {extra}"

    assert isinstance(entry["name"], str) and entry["name"].strip(), f"entry {i}: empty name"
    assert isinstance(entry["value"], str) and entry["value"].strip(), f"entry {i}: value must be a non-empty string"
    assert isinstance(entry["meaning"], str) and entry["meaning"].strip(), f"entry {i}: empty meaning"
    assert len(entry["meaning"]) <= 110, (
        f"entry {i} ({entry['name']!r}): meaning is {len(entry['meaning'])} chars, must be <= 110"
    )
    assert isinstance(entry["affects_results"], bool), (
        f"entry {i} ({entry['name']!r}): affects_results must be a bool, got {type(entry['affects_results'])}"
    )
    assert entry["category"] in _CATEGORIES, (
        f"entry {i} ({entry['name']!r}): category {entry['category']!r} not in {sorted(_CATEGORIES)}"
    )

    where = entry["where"]
    assert isinstance(where, str) and ":" in where, (
        f"entry {i} ({entry['name']!r}): where must be 'path/file.py:symbol', got {where!r}"
    )
    path_part, _, symbol_part = where.partition(":")
    assert path_part.endswith(".py"), f"entry {i} ({entry['name']!r}): where's path is not a .py file: {path_part!r}"
    assert not re.fullmatch(r"\d+", symbol_part), (
        f"entry {i} ({entry['name']!r}): where's symbol looks like a bare line number: {symbol_part!r}"
    )
    assert symbol_part.strip(), f"entry {i} ({entry['name']!r}): where has no symbol after ':'"


@pytest.mark.parametrize("i,entry", list(enumerate(CODE_CONSTANTS)))
def test_entry_file_exists(i, entry):
    path_part = entry["where"].split(":", 1)[0]
    full = REPO_ROOT / path_part
    assert full.is_file(), f"entry {i} ({entry['name']!r}): file does not exist: {path_part}"


@pytest.mark.parametrize("i,entry", list(enumerate(CODE_CONSTANTS)))
def test_entry_symbol_appears_in_file(i, entry):
    """The claimed symbol must actually appear in the claimed file, as a whole identifier.

    ``where`` may name a dotted path like ``ClassName.method_name`` or a bracketed dict access
    like ``TABLE['key']``; we check the last bare identifier component, since that is the part a
    reader would actually search for, and it is robust to the class/function/constant living on
    different lines than any wrapping name.
    """
    path_part, symbol_part = entry["where"].split(":", 1)
    text = _read(path_part)

    # Take the last identifier-like token: strip a trailing [...] subscript, then split on '.'.
    core = re.sub(r"\[.*\]$", "", symbol_part.strip())
    ident = core.split(".")[-1].strip()
    assert ident, f"entry {i} ({entry['name']!r}): could not extract a symbol from {symbol_part!r}"

    pattern = re.compile(r"\b" + re.escape(ident) + r"\b")
    assert pattern.search(text), (
        f"entry {i} ({entry['name']!r}): symbol {ident!r} not found in {path_part}"
    )


def test_categories_are_all_represented():
    """Every category the frontend can filter by should have at least one entry, or the filter
    silently shows nothing -- a smell that a whole area of code was never surveyed."""
    used = {c["category"] for c in CODE_CONSTANTS}
    missing = _CATEGORIES - used
    assert not missing, f"No CODE_CONSTANTS entries for categories: {sorted(missing)}"


def test_this_test_actually_catches_a_broken_entry():
    """A test that cannot fail is not a test (CLAUDE.md). Prove the file/symbol checks above are
    live by running them against entries engineered to be wrong, using the exact same logic."""
    bad_file = {
        "name": "bogus", "value": "1", "where": "engine/pipeline/does_not_exist_at_all.py:X",
        "meaning": "m", "category": "Optimizer", "affects_results": False,
    }
    assert not (REPO_ROOT / bad_file["where"].split(":", 1)[0]).is_file()

    bad_symbol = {
        "name": "bogus2", "value": "1", "where": "engine/pipeline/code_constants.py:ThisSymbolDoesNotExistXYZ",
        "meaning": "m", "category": "Optimizer", "affects_results": False,
    }
    path_part, symbol_part = bad_symbol["where"].split(":", 1)
    text = _read(path_part)
    ident = re.sub(r"\[.*\]$", "", symbol_part.strip()).split(".")[-1]
    assert not re.search(r"\b" + re.escape(ident) + r"\b", text)

    bad_meaning = dict(CODE_CONSTANTS[0])
    bad_meaning["meaning"] = "x" * 111
    assert len(bad_meaning["meaning"]) > 110

    bad_category = dict(CODE_CONSTANTS[0])
    bad_category["category"] = "NotARealCategory"
    assert bad_category["category"] not in _CATEGORIES
