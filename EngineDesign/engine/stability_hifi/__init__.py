"""High-fidelity combustion stability suite (thermoacoustic global modes).

New, self-contained package implementing the formulation of
``docs/stability/thermoacoustic_global_stability_paper.md``. Does not import from or
modify ``engine/pipeline/stability/`` (the lumped model), which remains the in-loop
screen and the authoritative chug/feed-coupled analysis.

Phasing (paper Section IX):
    P0  eigensolver core on synthetic mean flows          <- current
    P1  real chamber geometry + parametric mean flow
    P2  CFD-anchored (SU2) mean flow
    P3  hardening (Beyn audit, SLEPc NEP, validation cases)
"""
