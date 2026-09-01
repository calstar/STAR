"""Version storage for designs: microversions + immutable releases.

A thin binding of :mod:`stardesign.storage` to this app's S3 environment. The
module-level ``backend`` and ``IS_S3`` names are what the rest of this backend
imports, so they stay.

Design version history in S3 when ``OPENROCKET_S3_BUCKET`` is set; files on the
``USERDATA_DIR`` volume otherwise (dev, and prod with no bucket).
"""

from stardesign.storage import LocalBackend, S3Backend, Snapshot, make_backend  # noqa: F401

from backend import userdata

backend = make_backend(
    userdata.store,
    bucket_env="OPENROCKET_S3_BUCKET",
    prefix_env="OPENROCKET_S3_PREFIX",
    default_prefix="openrocket",
)
IS_S3 = isinstance(backend, S3Backend)
