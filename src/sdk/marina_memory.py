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

    def review(self, **filters):
        return self.request(self._path("/review"), "POST", filters)

    def reaffirm(self, record_id, expected_version, dependency_versions, content=None, key=None):
        body = {"id": record_id, "expected_version": expected_version,
                "dependency_versions": dependency_versions}
        if content is not None:
            body["content"] = content
        return self.request(self._path("/reaffirm"), "POST", body, key)

    def resolve(self, record_id, policy, competing, rationale, key=None, **options):
        """Resolve competing assertions: policy is last_writer_wins, evidence_weighted,
        await_confirmation or keep_both; options may carry valid_time / deadline_ms."""
        body = {"id": record_id, "policy": policy, "competing": list(competing),
                "rationale": rationale, **options}
        return self.request(self._path("/resolve"), "POST", body, key)

    def adopt(self, job_id, target_space_id=None, rationale=None, key=None, **options):
        """Adopt an answered assistance proposal as a record. With no target the job's own
        space is used; naming an institutional space is a standing-gated ratification.
        ``confirm_abstention=True`` credits an honest abstention instead of writing."""
        body = {"job_id": job_id, **options}
        if rationale is not None:
            body["rationale"] = rationale
        if target_space_id is None:
            return self.request("/assistance/" + quote(job_id, safe="") + "/adopt", "POST", body, key)
        return self.request("/spaces/" + quote(target_space_id, safe="") + "/adopt", "POST", body, key)

    def cache_delete(self, inputs, model, policy, key=None):
        return self.request(self._path("/cache/delete"), "POST",
                            {"inputs": inputs, "model": model, "policy": policy}, key)

    def cache_get(self, inputs, model, policy):
        return self.request(self._path("/cache/get"), "POST",
                            {"inputs": inputs, "model": model, "policy": policy})

    def cache_put(self, inputs, model, policy, value, expires_at, records=None, sources=None, key=None, federated=None):
        return self.request(self._path("/cache/put"), "POST",
                            {"inputs": inputs, "model": model, "policy": policy, "value": value,
                             "expires_at": expires_at, "records": records or [], "sources": sources or [],
                             "federated": federated or []}, key)

    def acknowledge(self, keys):
        return self.request(self._path("/acknowledge"), "POST", {"keys": keys})

    def export_bundle(self):
        return self.request(self._path("/bundle"))

    def import_bundle(self, bundle, key=None):
        return self.request(self._path("/bundle"), "POST", bundle, key)

    def knowledge_graph(self, action, key=None, **arguments):
        return self.request(self._path("/knowledge_graph"), "POST", {**arguments, "action": action}, key)

    def export_page(self, cursor=None):
        return self.request(self._path("/transfer" + ("?cursor=" + quote(cursor, safe="") if cursor else "")))

    def export_pages(self, cursor=None):
        while True:
            page = self.export_page(cursor)
            yield page
            if page["done"]:
                return
            next_cursor = page["next_cursor"]
            if not next_cursor or next_cursor == cursor:
                raise ValueError("Export cursor did not advance")
            cursor = next_cursor

    def begin_transfer(self, header, key=None):
        return self.request(self._path("/transfers"), "POST", header, key)

    def transfer_status(self, transfer_id):
        return self.request(self._path("/transfers/" + quote(transfer_id, safe="")))

    def transfers(self, **filters):
        values = {key: str(value).lower() if isinstance(value, bool) else value
                  for key, value in filters.items() if value is not None}
        return self.request(self._path("/transfers?" + urlencode(values)))

    def append_transfer(self, transfer_id, page, key=None):
        return self.request(self._path("/transfers/" + quote(transfer_id, safe="") + "/pages"), "POST", page, key)

    def commit_transfer(self, transfer_id, sha256, key=None):
        return self.request(self._path("/transfers/" + quote(transfer_id, safe="") + "/commit"), "POST", {"sha256": sha256}, key)

    def abort_transfer(self, transfer_id, key=None):
        return self.request(self._path("/transfers/" + quote(transfer_id, safe="") + "/abort"), "POST", {}, key)

    def federation_mounts(self):
        return self.request(self._path("/federation_mounts"))

    def federated_search(self, mounts, query, **options):
        return self.request(self._path("/federated_search"), "POST",
                            {"mounts": mounts, "query": query, **options})

    def federated_read(self, mount, record_id, kind="record", **options):
        return self.request(self._path("/federated_read"), "POST",
                            {"mount": mount, "id": record_id, "kind": kind, **options})

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

    def join(self, patterns, **options):
        return self.request(self._path("/join"), "POST", {"patterns": patterns, **options})

    def save_rule(self, rule, key=None, **options):
        return self.request(self._path("/rules"), "POST", {"rule": rule, **options}, key)

    def run_rule(self, record_id, expected_version, **options):
        return self.request(self._path("/rules/run"), "POST", {"id": record_id, "expected_version": expected_version, **options})

    def materialize_rule(self, record_id, expected_version, key=None, **options):
        return self.request(self._path("/rules/materialize"), "POST", {"id": record_id, "expected_version": expected_version, **options}, key)

    def graph(self, subject, **options):
        return self.request(self._path("/graph"), "POST", {"subject": subject, **options})

    def search(self, query, **options):
        return self.request(self._path("/search"), "POST", {"query": query, **options})

    def context(self, query, budget_tokens=2048, **options):
        return self.request(self._path("/context"), "POST", {"query": query, "budget_tokens": budget_tokens, **options})

    def reindex(self, expected_generation, key=None, **page):
        return self.request(self._path("/reindex"), "POST", {"expected_generation": expected_generation, **page}, key)

    def usage(self):
        return self.request("/usage")

    def capture(self, content, session_id=None, key=None):
        return self.request(self._path("/sources"), "POST", {"content": content, "session_id": session_id} if session_id is not None else {"content": content}, key)

    def capture_batch(self, items, key=None):
        return self.request(self._path("/sources/batch"), "POST", {"items": items}, key)

    def sources(self, after=0, limit=100):
        return self.request(self._path("/sources?after=" + str(after) + "&limit=" + str(limit)))

    def source_headers(self, after=0, limit=20):
        return self.request(self._path("/source_headers?" + urlencode({"after": after, "limit": limit})))

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
