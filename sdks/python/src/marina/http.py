# Copyright 2025-2026 H2O.ai, Inc.
# SPDX-License-Identifier: Apache-2.0
"""`marina.http.v1`: memory, routing, investigations and panels over HTTP.

Every operation in protocol/marina.http.v1.openapi.json is a method, named in snake_case after
its operation id:

>>> marina.routing.discover()
>>> marina.memory(credential).remember(space=space_id, body={"content": "Deploys run from main"})
>>> marina.investigations.call("investigation", id="inv_1")
"""

from __future__ import annotations

import json
import uuid
from typing import Any, Callable, Optional, Union
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode
from urllib.request import HTTPRedirectHandler, Request, build_opener

from ._operations import OPERATIONS, Operation
from .client import MarinaError


class ApiError(MarinaError):
    """An HTTP API refused or failed a request. Branch on `code`; `message` is for people."""

    def __init__(self, status: int, code: str, message: str, retry_after_ms: Optional[int] = None) -> None:
        super().__init__(f"{status} {code}: {message}")
        self.status = status
        self.code = code
        self.message = message
        self.retry_after_ms = retry_after_ms
        """On 429 (and some memory failures): wait this long before retrying."""


class _NoRedirect(HTTPRedirectHandler):
    # A redirect would carry the bearer token somewhere else: refuse it.
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001
        return None


def _error(status: int, body: Any, retry_after: Optional[str]) -> ApiError:
    retry_ms = int(float(retry_after) * 1000) if retry_after and retry_after.replace(".", "", 1).isdigit() else None
    if isinstance(body, dict):
        err = body.get("error")
        if isinstance(err, dict):  # memory: {"error": {"code", "message", "retry_after_ms"?}}
            after = err.get("retry_after_ms")
            return ApiError(
                status,
                str(err.get("code") or "error"),
                str(err.get("message") or ""),
                int(after) if isinstance(after, (int, float)) else retry_ms,
            )
        if isinstance(err, str):  # routing, investigations, panels: {"error", "code"?}
            return ApiError(status, str(body.get("code") or f"http_{status}"), err, retry_ms)
    return ApiError(status, f"http_{status}", str(body or ""), retry_ms)


TokenSource = Union[str, Callable[[], str]]


class HttpApi:
    """The operations of one group (`memory`, `routing`, `investigations`, `panels`), or all."""

    def __init__(self, base_url: str, token: TokenSource, tag: Optional[str] = None, timeout: float = 35.0) -> None:
        self.base_url = base_url.rstrip("/")
        self._token = token
        self.tag = tag
        self.timeout = timeout
        self._http = build_opener(_NoRedirect)

    def operations(self) -> list[str]:
        """The method names this group offers."""
        return sorted(name for name, op in OPERATIONS.items() if self.tag in (None, op.tag))

    def __getattr__(self, name: str) -> Callable[..., Any]:
        op = OPERATIONS.get(name)
        if op is None or (self.tag is not None and op.tag != self.tag):
            raise AttributeError(f"{self.tag or 'HTTP'} API has no operation {name!r}; see .operations()")
        return lambda **kwargs: self._call(op, **kwargs)

    def __dir__(self) -> list[str]:
        return [*super().__dir__(), *self.operations()]

    def call(self, operation: str, **kwargs: Any) -> Any:
        """Call an operation by its id (`joinSession`) or snake_case name (`join_session`)."""
        op = OPERATIONS.get(operation) or next((o for o in OPERATIONS.values() if o.id == operation), None)
        if op is None or (self.tag is not None and op.tag != self.tag):
            raise ValueError(f"No operation {operation!r} here; see .operations()")
        return self._call(op, **kwargs)

    def _call(self, op: Operation, *, body: Any = None, idempotency_key: Optional[str] = None, **params: Any) -> Any:
        path = op.path
        for name in op.path_params:
            if params.get(name) is None:
                raise TypeError(f"{op.id} needs {name}=")
            path = path.replace("{" + name + "}", quote(str(params.pop(name)), safe=""))
        query = {}
        for name in op.query:
            value = params.pop(name, None)
            if value is not None:
                query[name] = ("true" if value else "false") if isinstance(value, bool) else str(value)
        if params:
            raise TypeError(f"{op.id} takes no {', '.join(sorted(params))}")
        if op.body and body is None:
            raise TypeError(f"{op.id} needs body=")
        if body is not None and not op.body:
            raise TypeError(f"{op.id} takes no body")
        token = self._token() if callable(self._token) else self._token
        headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
        data = None
        if body is not None:
            headers["Content-Type"] = "application/json"
            data = json.dumps(body).encode()
        if op.idempotency_key:
            # The same key replays the first result: pass your own to retry a write safely.
            headers["Idempotency-Key"] = idempotency_key or str(uuid.uuid4())
        url = self.base_url + path + (f"?{urlencode(query)}" if query else "")
        request = Request(url, data=data, method=op.method, headers=headers)
        try:
            with self._http.open(request, timeout=self.timeout) as response:
                raw = response.read()
        except HTTPError as error:
            with error:
                raw = error.read()
            try:
                parsed: Any = json.loads(raw) if raw else None
            except ValueError:
                parsed = raw.decode("utf-8", errors="replace")
            raise _error(error.code, parsed, error.headers.get("Retry-After")) from None
        except URLError as error:
            raise MarinaError(f"Could not reach {self.base_url}: {error.reason}") from error
        return json.loads(raw) if raw else None
