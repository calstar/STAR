"""Refuse writes to the live config from someone who does not hold the design.

The design bar already refuses to autosave without the checkout, and
``/api/engine/documents/{id}/autosave`` already 423s a non-holder
(``stardesign.documents``). So why gate the config routes too?

Because between those two points sits the session config, and *that* is what the
UI shows you. Without this, a read-only viewer's edits land in their own session,
the screen updates, and nothing ever tells them the design did not change --
the edit simply evaporates at the next reload. Refusing at the point of the edit
is what turns a silent loss into an error.

This is a correctness guard, not a security boundary. The session config is
per-user, so a write here can only ever affect the caller's own view; the
boundary that protects the shared design is the checkout on /autosave.

Which design the caller has open is not something the backend tracks -- the bar
owns that -- so the client names it, either in the ``X-Design-Owner`` /
``X-Design-Id`` headers or, for the optimizer layers, in ``design_owner`` /
``design_id`` query parameters. Both spellings exist because the layer runs are
consumed with ``EventSource``, which cannot set request headers at all.

When no design is named there is nothing to protect and the write is allowed:
the config routes long predate designs, and the file-upload and scripted paths
still use them with no design open at all.
"""

from __future__ import annotations

from fastapi import Depends, Request

from backend import userdata
from backend.routers.documents import store

DESIGN_OWNER_HEADER = "X-Design-Owner"
DESIGN_ID_HEADER = "X-Design-Id"
DESIGN_OWNER_PARAM = "design_owner"
DESIGN_ID_PARAM = "design_id"


def require_design_checkout(request: Request) -> None:
    """423 unless the caller holds the checkout on the design they name.

    A no-op when no design is named, or when the named design cannot be found
    (it was deleted, or the header is stale) -- an unknown design is not
    somebody else's to protect, and 404-ing a config write on a stale header
    would be a worse failure than allowing it.
    """
    doc_id = request.headers.get(DESIGN_ID_HEADER) or request.query_params.get(DESIGN_ID_PARAM)
    if not doc_id:
        return

    viewer = userdata.current_user(request)
    named_owner = (
        request.headers.get(DESIGN_OWNER_HEADER)
        or request.query_params.get(DESIGN_OWNER_PARAM)
    )
    owner = userdata.slug_user(named_owner) if named_owner else viewer

    record = store.find_record(owner, doc_id)
    if record is None:
        return
    store.require_lock_on(record, doc_id, viewer)


#: Spelled once so the route decorators read as a statement of intent.
DesignCheckout = Depends(require_design_checkout)
