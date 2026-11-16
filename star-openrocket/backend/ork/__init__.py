"""OpenRocket .ork import: an .ork becomes a model like any Onshape build.

``document`` reads the file into placed, weighed components (OpenRocket's own
positioning and mass rules); ``mesh`` turns them into geometry with the surface
types the CAD analysis reads; ``importer`` writes the GLB, the geometry sidecar and
the manifest into ``cache/`` so every tab -- stability, flight, export -- runs on it
unchanged; ``compare`` lines two models up side by side.
"""
