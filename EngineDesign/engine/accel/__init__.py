"""Numba-backed physics accelerator for the Layer-1 optimizer inner loop.

Replaces the hand-written C port at engine/native. During the migration both
backends exist and must be *simultaneously* callable -- the parity suite, the
benchmark and CI all compare them -- so selection lives here rather than being
baked into either implementation.

Today this package holds only the pure-Python parameter extraction (params.py),
which is what frees the Numba kernels from depending on the C EdEngineState.
The dispatcher and the evaluate/solve/chamber_solve surface land with the
call-site switch.
"""
