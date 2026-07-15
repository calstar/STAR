"""Native physics kernel package marker.

Makes engine.native.python importable from the engine package. Importing this
module has no side effects and does NOT build or load the native library; that
happens lazily in engine.native.python.autobuild when the native path is first
requested (ED_USE_NATIVE=1).
"""
