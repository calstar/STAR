"""Recovery calculator physics core. See PLAN.md.

**This module deliberately imports nothing.**

`atmosphere` and `pad_state` are stdlib-only: scalar ISA evaluation is `exp`,
`log` and `pow`, so it needs no numpy. That lets `site-climatology/` import the
one canonical copy of equations (1)-(7b) while staying dependency-free and
offline, instead of keeping a second copy to get wrong.

That property only holds while this file stays empty. An import here -- even a
convenience re-export of `Config` or `simulate` -- would pull pydantic and scipy
into every consumer of `physics.atmosphere`, and the tools tree would
silently start needing a venv. `tests/test_imports.py` asserts it.

Import submodules directly:

    from physics.atmosphere import Atmosphere   # stdlib only
    from physics.solver import simulate         # numpy + scipy
"""
