"""The design's identity: a hash of its validated contents, the same wherever it is taken."""

from __future__ import annotations

import hashlib
import json
from typing import Any


def config_fingerprint(config: Any) -> str:
    raw = json.dumps(config.model_dump(mode="json"), sort_keys=True, default=str).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()
