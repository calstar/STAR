"""Version storage for P&ID diagrams: microversions + immutable releases.

Two backends, chosen at import time by environment:

* **S3Backend** when ``PID_S3_BUCKET`` is set. Microversions ride on S3 object
  *versioning* of a per-diagram HEAD key (``<prefix>/<user>/<id>/current.json``):
  every snapshot is a plain ``put_object`` that S3 keeps as a new version, and a
  lifecycle rule prunes old ones. Releases are separate immutable keys under
  ``.../releases/<label>.json``. Credentials come from the standard ``AWS_*``
  env vars (the apps machine is not on EC2, so IAM access keys, not a role).

* **LocalBackend** otherwise (dev). Microversions and releases are files on disk
  under the same ``USERDATA_DIR`` tree, so history works with no AWS and no git.

Both expose the same methods and return the diagram dict (``{"nodes", "edges"}``)
unchanged. The *working copy* (``current.json`` on the volume) is owned by the
router, not this module -- here we only keep version history.
"""

from __future__ import annotations

import json
import os
import secrets
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from backend import userdata

Diagram = dict[str, Any]


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ── Local (dev) backend ──────────────────────────────────────────────────────

def _atomic_write(path: Path, data: Diagram) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".tmp-", suffix=".json")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(data, fh, indent=2)
            fh.write("\n")
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def _read_json(path: Path) -> Diagram | None:
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text("utf-8"))
    except (OSError, ValueError):
        return None


class LocalBackend:
    """Filesystem version history under ``<root>/<user>/pid/<id>/``."""

    def _diagram_dir(self, user: str, diagram_id: str) -> Path:
        return userdata.user_dir(user) / diagram_id

    def _sub(self, user: str, diagram_id: str, name: str) -> Path:
        d = self._diagram_dir(user, diagram_id) / name
        d.mkdir(parents=True, exist_ok=True)
        return d

    def snapshot_micro(self, user: str, diagram_id: str, data: Diagram) -> dict:
        # Opaque, lowercase-hex id so it survives userdata.slugify on read-back.
        vid = secrets.token_hex(8)
        _atomic_write(self._sub(user, diagram_id, "versions") / f"{vid}.json", data)
        return {"versionId": vid, "savedAt": _now_iso()}

    def list_micro(self, user: str, diagram_id: str, limit: int = 50) -> list[dict]:
        out: list[dict] = []
        for p in self._sub(user, diagram_id, "versions").glob("*.json"):
            if p.name.startswith("."):
                continue
            st = p.stat()
            out.append({
                "versionId": p.stem,
                "savedAt": datetime.fromtimestamp(st.st_mtime, timezone.utc).isoformat(),
                "size": st.st_size,
            })
        out.sort(key=lambda v: v["savedAt"], reverse=True)
        return out[:limit]

    def get_micro(self, user: str, diagram_id: str, version_id: str) -> Diagram | None:
        safe = userdata.slugify(version_id)
        if not safe:
            return None
        return _read_json(self._sub(user, diagram_id, "versions") / f"{safe}.json")

    def latest_micro(self, user: str, diagram_id: str) -> Diagram | None:
        recent = self.list_micro(user, diagram_id, limit=1)
        return self.get_micro(user, diagram_id, recent[0]["versionId"]) if recent else None

    def create_release(self, user: str, diagram_id: str, label: str, data: Diagram) -> dict:
        p = self._sub(user, diagram_id, "releases") / f"{label}.json"
        if p.exists():
            raise FileExistsError(label)
        _atomic_write(p, data)
        return {"label": label, "savedAt": _now_iso()}

    def list_releases(self, user: str, diagram_id: str) -> list[dict]:
        out: list[dict] = []
        for p in self._sub(user, diagram_id, "releases").glob("*.json"):
            if p.name.startswith("."):
                continue
            st = p.stat()
            out.append({
                "label": p.stem,
                "savedAt": datetime.fromtimestamp(st.st_mtime, timezone.utc).isoformat(),
                "size": st.st_size,
            })
        out.sort(key=lambda r: r["savedAt"], reverse=True)
        return out

    def get_release(self, user: str, diagram_id: str, label: str) -> Diagram | None:
        safe = userdata.slugify(label)
        if not safe:
            return None
        return _read_json(self._sub(user, diagram_id, "releases") / f"{safe}.json")


# ── S3 backend ───────────────────────────────────────────────────────────────

class S3Backend:
    """Version history in a versioned S3 bucket. Microversions == object versions."""

    def __init__(self, bucket: str, prefix: str) -> None:
        import boto3  # imported lazily so dev never needs the dependency

        self._s3 = boto3.client("s3")
        self.bucket = bucket
        self.prefix = prefix.strip("/")

    def _head_key(self, user: str, diagram_id: str) -> str:
        return f"{self.prefix}/{user}/{diagram_id}/current.json"

    def _releases_prefix(self, user: str, diagram_id: str) -> str:
        return f"{self.prefix}/{user}/{diagram_id}/releases/"

    def _put(self, key: str, data: Diagram) -> None:
        self._s3.put_object(
            Bucket=self.bucket, Key=key,
            Body=json.dumps(data, indent=2).encode("utf-8"),
            ContentType="application/json",
        )

    def _get(self, key: str, **kw) -> Diagram | None:
        from botocore.exceptions import ClientError
        try:
            obj = self._s3.get_object(Bucket=self.bucket, Key=key, **kw)
        except ClientError:
            return None
        return json.loads(obj["Body"].read())

    def snapshot_micro(self, user: str, diagram_id: str, data: Diagram) -> dict:
        self._put(self._head_key(user, diagram_id), data)
        return {"savedAt": _now_iso()}

    def list_micro(self, user: str, diagram_id: str, limit: int = 50) -> list[dict]:
        key = self._head_key(user, diagram_id)
        resp = self._s3.list_object_versions(Bucket=self.bucket, Prefix=key, MaxKeys=limit)
        out = [
            {"versionId": v["VersionId"],
             "savedAt": v["LastModified"].isoformat(),
             "size": v["Size"]}
            for v in resp.get("Versions", []) if v["Key"] == key
        ]
        out.sort(key=lambda v: v["savedAt"], reverse=True)
        return out[:limit]

    def get_micro(self, user: str, diagram_id: str, version_id: str) -> Diagram | None:
        return self._get(self._head_key(user, diagram_id), VersionId=version_id)

    def latest_micro(self, user: str, diagram_id: str) -> Diagram | None:
        return self._get(self._head_key(user, diagram_id))

    def create_release(self, user: str, diagram_id: str, label: str, data: Diagram) -> dict:
        from botocore.exceptions import ClientError
        key = f"{self._releases_prefix(user, diagram_id)}{label}.json"
        try:
            self._s3.head_object(Bucket=self.bucket, Key=key)
        except ClientError as e:
            if e.response.get("Error", {}).get("Code") not in ("404", "NoSuchKey", "NotFound"):
                raise
        else:
            raise FileExistsError(label)  # already exists -> immutable
        self._put(key, data)
        return {"label": label, "savedAt": _now_iso()}

    def list_releases(self, user: str, diagram_id: str) -> list[dict]:
        prefix = self._releases_prefix(user, diagram_id)
        resp = self._s3.list_objects_v2(Bucket=self.bucket, Prefix=prefix)
        out = []
        for o in resp.get("Contents", []):
            name = o["Key"][len(prefix):]
            if name.endswith(".json"):
                name = name[:-5]
            out.append({"label": name, "savedAt": o["LastModified"].isoformat(), "size": o["Size"]})
        out.sort(key=lambda r: r["savedAt"], reverse=True)
        return out

    def get_release(self, user: str, diagram_id: str, label: str) -> Diagram | None:
        return self._get(f"{self._releases_prefix(user, diagram_id)}{label}.json")


# ── selection ────────────────────────────────────────────────────────────────

def _make_backend():
    bucket = os.environ.get("PID_S3_BUCKET")
    if bucket:
        return S3Backend(bucket, os.environ.get("PID_S3_PREFIX", "pid"))
    return LocalBackend()


backend = _make_backend()
IS_S3 = isinstance(backend, S3Backend)
