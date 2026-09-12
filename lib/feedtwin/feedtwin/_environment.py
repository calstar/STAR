"""Which versions of the physics stack produced a result.

Correlations and equations of state are not frozen. CoolProp revises a fluid's
EOS between releases; ``fluids`` corrects a fitting coefficient. When a number
that was right last month is wrong today and nothing in this repo changed, the
stack version is the first thing you want and the last thing anyone records.

So every run stamps this. It costs one dict and it is the difference between
"the model drifted" and "CoolProp 7.3 revised the nitrogen EOS".

A missing package reports ``None`` rather than raising: this is diagnostic
plumbing, and it must never be the reason an import fails.
"""

from __future__ import annotations

import functools
import importlib.metadata
import platform
import sys

#: Everything whose version can change a computed answer. Keys are the import
#: name; values are the distribution name, where the two differ.
_PHYSICS_STACK: dict[str, str] = {
    "numpy": "numpy",
    "scipy": "scipy",
    "CoolProp": "CoolProp",
    "fluids": "fluids",
    "ht": "ht",
}


@functools.lru_cache(maxsize=1)
def _stack_versions() -> tuple[tuple[str, str | None], ...]:
    """The uncached scan, memoised. See :func:`stack_versions`."""
    return tuple(_collect().items())


def stack_versions() -> dict[str, str | None]:
    """Versions of feedtwin and every dependency that can move a number.

    Cached for the life of the process. Reading distribution metadata means
    parsing an email-format file per package, which took about 4 ms -- half the
    cost of a small steady solve, on every solve, for an answer that cannot
    change while the interpreter is running. A fresh dict is returned each call
    so a caller cannot mutate the cache.

    Returns a mapping of package name to version string, with ``None`` for
    anything not installed. ``python`` and ``platform`` are included because a
    LAPACK or libm difference across platforms is a real, if rare, source of
    divergence in a Newton solve.
    """
    return dict(_stack_versions())


def _collect() -> dict[str, str | None]:
    from feedtwin import __version__

    versions: dict[str, str | None] = {
        "feedtwin": __version__,
        "python": platform.python_version(),
        "platform": f"{platform.system().lower()}-{platform.machine()}",
    }

    for import_name, dist_name in _PHYSICS_STACK.items():
        versions[import_name] = _version_of(import_name, dist_name)

    return versions


def _version_of(import_name: str, dist_name: str) -> str | None:
    """Version of one dependency, or ``None`` if it is not installed.

    Prefers the installed distribution's metadata over the module's own
    ``__version__``: the metadata is what pip resolved, and a module attribute
    can lag it. Falls back to the attribute for packages that ship no metadata,
    and imports only as a last resort so this stays cheap on a warm interpreter.
    """
    try:
        return importlib.metadata.version(dist_name)
    except importlib.metadata.PackageNotFoundError:
        pass

    module = sys.modules.get(import_name)
    if module is None:
        return None

    version = getattr(module, "__version__", None)
    return str(version) if version is not None else None
