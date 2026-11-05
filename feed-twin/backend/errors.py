"""Every refusal the API sends is one plain sentence in ``{"detail": ...}``.

The cockpit shows ``detail`` as it comes. FastAPI's own refusals did not fit
that: a request it could not read came back as a list of ``{loc, msg, type}``
objects, which the screen printed as "[object Object]", and an unhandled
error came back as the bare text "Internal Server Error". Here every one of
them is made a sentence on the way out: validation lists flattened, the first
word capitalised, a full stop at the end, and an unexpected error said in
words with its traceback in the server log rather than on the screen.
"""

from __future__ import annotations

import logging
import re
from typing import Any, Iterable, Mapping

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

_log = logging.getLogger("feed-twin.errors")

#: Where a validation error points that a person does not need told.
_PLACES = frozenset({"body", "query", "path", "header", "cookie"})


def sentence(text: str) -> str:
    """``text`` as a sentence: its first word capitalised when it is a plain
    lowercase word (a tag like ``node_12`` or ``OV-MOT`` is left as drawn), and
    ending in a full stop unless it already ends a sentence."""
    text = " ".join(str(text).split())
    if not text:
        return ""
    first = text.split(" ", 1)[0]
    if re.fullmatch(r"[a-z]+[,:;]?", first):
        text = text[0].upper() + text[1:]
    return text if text[-1] in ".!?" else f"{text}."


def _where(loc: Iterable[Any]) -> str:
    parts = [str(p) for p in loc if str(p) not in _PLACES]
    return ".".join(parts)


def _one(error: Mapping[str, Any]) -> str:
    """One validation error, said: "dome should be a valid number"."""
    where = _where(error.get("loc") or ())
    message = str(error.get("msg") or "").strip()
    if error.get("type") == "missing":
        return f"{where or 'a value'} is missing"
    if where and message.startswith(("Input should", "Value should")):
        return f"{where} should{message.split('should', 1)[1]}"
    if where and message:
        return f"{where}: {message[0].lower()}{message[1:]}"
    return message or where


def flatten(detail: Any) -> str:
    """Any ``detail`` -- a string, a list of validation errors, an object --
    as one plain sentence."""
    if detail is None:
        return ""
    if isinstance(detail, str):
        return sentence(detail)
    if isinstance(detail, Mapping):
        if "msg" in detail or "loc" in detail:
            return sentence(_one(detail))
        inner = detail.get("detail") or detail.get("message")
        if inner is not None:
            return flatten(inner)
        return sentence("; ".join(f"{k}: {v}" for k, v in detail.items()))
    if isinstance(detail, (list, tuple)):
        parts = [_one(d) if isinstance(d, Mapping) else str(d).strip() for d in detail]
        return sentence("; ".join(p for p in parts if p))
    return sentence(str(detail))


def validation_sentence(errors: Iterable[Mapping[str, Any]]) -> str:
    """A request FastAPI could not read, as one sentence: "That request could
    not be read: diagram is missing; dome should be a valid number." """
    said = "; ".join(p for p in (_one(e) for e in errors) if p)
    if not said:
        return "That request could not be read."
    return sentence(f"That request could not be read: {said}")


async def _http(request: Request, exc: StarletteHTTPException) -> JSONResponse:
    detail = exc.detail
    if exc.status_code == 404 and detail == "Not Found":
        detail = f"Nothing at {request.url.path}"
    elif exc.status_code == 405 and detail == "Method Not Allowed":
        detail = f"{request.method} is not something {request.url.path} answers"
    return JSONResponse(
        {"detail": flatten(detail) or f"Refused ({exc.status_code})."},
        status_code=exc.status_code,
        headers=getattr(exc, "headers", None),
    )


async def _validation(request: Request, exc: RequestValidationError) -> JSONResponse:
    return JSONResponse({"detail": validation_sentence(exc.errors())}, status_code=422)


async def _unexpected(request: Request, exc: Exception) -> JSONResponse:
    _log.error("%s %s failed", request.method, request.url.path, exc_info=exc)
    said = " ".join(str(exc).split())[:300]
    return JSONResponse(
        {
            "detail": sentence(
                f"The twin could not finish that: {said}"
                if said
                else f"The twin could not finish that ({type(exc).__name__})"
            )
        },
        status_code=500,
    )


def install(app: FastAPI) -> None:
    """Make every refusal ``app`` sends one plain sentence."""
    app.add_exception_handler(StarletteHTTPException, _http)  # type: ignore[arg-type]
    app.add_exception_handler(RequestValidationError, _validation)  # type: ignore[arg-type]
    app.add_exception_handler(Exception, _unexpected)
