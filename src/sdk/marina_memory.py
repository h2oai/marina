# Copyright 2025-2026 H2O.ai, Inc.
# SPDX-License-Identifier: Apache-2.0
"""Dependency-free HTTP client for Marina Memory v1. No world runtime required."""
import json
import time
import uuid
from urllib.error import HTTPError
from urllib.parse import quote, urlencode
from urllib.request import HTTPRedirectHandler, Request, build_opener


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class MemoryError(Exception):
    def __init__(self, status, code, message):
        super().__init__(message)
        self.status, self.code = status, code


class MarinaMemory:
    def __init__(self, url, token, space_id, timeout=35):
        self.url, self.token, self.space_id, self.timeout = url.rstrip("/"), token, space_id, timeout
        self._http = build_opener(_NoRedirect)

    def request(self, path, method="GET", body=None, key=None):
        request = Request(self.url + "/v1/memory" + path, method=method,
                          data=None if body is None else json.dumps(body).encode(),
                          headers={"Authorization": "Bearer " + self.token,
                                   "Content-Type": "application/json",
                                   "Idempotency-Key": key or str(uuid.uuid4())})
        try:
            with self._http.open(request, timeout=self.timeout) as response:
                return json.load(response)
        except HTTPError as error:
            try:
                detail = json.load(error).get("error", {})
            except (ValueError, AttributeError):
                detail = {}
            raise MemoryError(error.code, detail.get("code", "request_failed"),
                              detail.get("message", "Memory request failed")) from None

    def _path(self, suffix=""):
        return "/spaces/" + quote(self.space_id, safe="") + suffix

    def remember(self, content, key=None, **attributes):
        return self.request(self._path("/records"), "POST", {"content": content, **attributes}, key)

    def get(self, record_id, version=None):
        suffix = "" if version is None else "?version=" + str(version)
        return self.request(self._path("/records/" + quote(record_id, safe="") + suffix))

    def revise(self, record_id, expected_version, content, key=None, **attributes):
        return self.request(self._path("/records/" + quote(record_id, safe="")), "PATCH",
                            {"content": content, "expected_version": expected_version, **attributes}, key)

    def query(self, **filters):
        return self.request(self._path("/query"), "POST", filters)

    def graph(self, subject, **options):
        return self.request(self._path("/graph"), "POST", {"subject": subject, **options})

    def search(self, query, **options):
        return self.request(self._path("/search"), "POST", {"query": query, **options})

    def context(self, query, budget_tokens=2048, **options):
        return self.request(self._path("/context"), "POST", {"query": query, "budget_tokens": budget_tokens, **options})

    def reindex(self, expected_generation, key=None):
        return self.request(self._path("/reindex"), "POST", {"expected_generation": expected_generation}, key)

    def capture(self, content, session_id=None, key=None):
        return self.request(self._path("/sources"), "POST", {"content": content, "session_id": session_id} if session_id is not None else {"content": content}, key)

    def sources(self, after=0, limit=100):
        return self.request(self._path("/sources?after=" + str(after) + "&limit=" + str(limit)))

    def source_search(self, query, **options):
        return self.request(self._path("/source_search"), "POST", {"query": query, **options})

    def source_range(self, source_id, **bounds):
        return self.request(self._path("/sources/" + quote(source_id, safe="") + "?" + urlencode(bounds)))

    def vocabulary(self, version=None):
        return self.request(self._path("/vocabulary" + ("" if version is None else "?version=" + str(version))))

    def save_vocabulary(self, definition, expected_version=0, key=None):
        return self.request(self._path("/vocabulary"), "POST", {"definition": definition, "expected_version": expected_version}, key)

    def plan(self, task, **options):
        return self.request(self._path("/plan"), "POST", {"task": task, **options})

    def execute_plan(self, plan):
        return self.request(self._path("/execute_plan"), "POST", plan)

    def checkpoint(self, name="work"):
        return self.request(self._path("/checkpoints/" + quote(name, safe="")))

    def save_checkpoint(self, data, expected_version=0, source_cursor=0, name="work", key=None, source_ids=None):
        return self.request(self._path("/checkpoints/" + quote(name, safe="")), "POST",
                            {"data": data, "expected_version": expected_version, "source_cursor": source_cursor,
                             "source_ids": source_ids or []}, key)

    def forget(self, key=None, **selection):
        return self.request(self._path("/forget"), "POST", selection, key)

    def export(self):
        return self.request(self._path("/export"))

    def wait_for_index(self, receipt, timeout=30):
        if not receipt.get("job_id"):
            return
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            job = self.request(self._path("/jobs/" + quote(receipt["job_id"], safe="")))
            if job["state"] == "ready":
                return
            if job["state"] in ("failed", "cancelled"):
                raise MemoryError(409, "index_job_failed", "Index job is " + job["state"])
            time.sleep(0.2)
        raise MemoryError(408, "index_timeout", "Index wait timed out")
