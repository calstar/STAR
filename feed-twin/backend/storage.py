"""Version storage for stands: microversions and immutable releases.

A thin binding of :mod:`stardesign.storage`: S3 when ``FEEDTWIN_S3_BUCKET`` is
set, files on the ``USERDATA_DIR`` volume otherwise.
"""

from __future__ import annotations

from stardesign.storage import make_backend

from backend import userdata

backend = make_backend(
    userdata.store,
    bucket_env="FEEDTWIN_S3_BUCKET",
    prefix_env="FEEDTWIN_S3_PREFIX",
    default_prefix="stand",
)
