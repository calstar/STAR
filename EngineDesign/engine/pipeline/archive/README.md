# Archived (unused) modules

Superseded scratch/duplicate variants kept for reference only. These have **zero
references** anywhere in the codebase. The live ablative-recession code is
`engine/pipeline/recession_animation.py` (still in use); these `_fixed`/`_simple`/
`_stable`/`_working` copies are earlier iterations.

NOTE: This is NOT the physics that the native C kernel (`engine/native/`)
accelerates — that physics (chamber_solver, combustion_physics, closure,
injectors, cooling, nozzle, stability) is the live reference/fallback and remains
in place.
