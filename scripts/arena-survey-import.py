#!/usr/bin/env python3
# Copyright 2025-2026 H2O.ai, Inc.
# SPDX-License-Identifier: Apache-2.0
"""Read an already acquired YouGov tracker workbook. No network access.

The provider's workbook schema uses sheet names as survey populations/crosstabs,
one column per wave and labelled rows for responses and bases. Relationship IDs,
not sheet order, bind names to values. Output is the shared survey-wave contract.
"""
import argparse
import hashlib
import json
import math
import pathlib
import posixpath
import sys
import zipfile
from datetime import datetime
from xml.etree import ElementTree as ET

NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
REL = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"


def parse(path, source_url, available_at, measure):
    available = datetime.fromisoformat(available_at.replace("Z", "+00:00"))
    if not measure.strip() or not source_url.startswith(("https://", "http://")):
        raise ValueError("missing measure or source URL")
    raw = pathlib.Path(path).read_bytes()
    if len(raw) > 32_000_000:
        raise ValueError("workbook exceeds 32 MB")
    with zipfile.ZipFile(path) as book:
        names = book.namelist()
        if len(names) != len(set(names)) or sum(i.file_size for i in book.infolist()) > 64_000_000:
            raise ValueError("duplicate entries or expanded workbook exceeds 64 MB")
        def xml(name):
            content = book.read(name)
            if b"<!DOCTYPE" in content.upper() or b"<!ENTITY" in content.upper():
                raise ValueError("XML entities are not supported")
            return ET.fromstring(content)
        strings = []
        if "xl/sharedStrings.xml" in names:
            strings = ["".join(x.itertext()) for x in xml("xl/sharedStrings.xml").findall(NS + "si")]
        relations = {}
        for r in xml("xl/_rels/workbook.xml.rels"):
            if r.get("Id") in relations:
                raise ValueError("duplicate workbook relationship")
            relations[r.get("Id")] = r
        sheets = {}
        targets = set()
        axis = None
        question = None
        for sheet in xml("xl/workbook.xml").iter(NS + "sheet"):
            name = sheet.get("name")
            relationship = relations.get(sheet.get(REL + "id"))
            if not name or name in sheets or relationship is None or relationship.get("TargetMode") == "External" or not relationship.get("Type", "").endswith("/worksheet"):
                raise ValueError("ambiguous sheet identity")
            target = relationship.get("Target", "")
            location = posixpath.normpath(target.lstrip("/") if target.startswith("/") else "xl/" + target)
            if "\\" in target or not location.startswith("xl/worksheets/") or location in targets:
                raise ValueError("invalid worksheet relationship")
            targets.add(location)
            rows = []
            for row in xml(location).iter(NS + "row"):
                cells = {}
                for cell in row.findall(NS + "c"):
                    address = cell.get("r", "")
                    column = "".join(c for c in address if c.isalpha())
                    if not column or column in cells or cell.find(NS + "f") is not None:
                        raise ValueError("invalid/duplicate cell or unsupported formula")
                    v = cell.find(NS + "v")
                    value = "" if v is None else v.text or ""
                    if cell.get("t") == "inlineStr":
                        value = "".join(t.text or "" for t in cell.iter(NS + "t"))
                    elif cell.get("t") == "s":
                        value = strings[int(value)]
                    cells[column] = value
                if cells:
                    rows.append(cells)
            if not rows or "A" not in rows[0]:
                raise ValueError("missing question header")
            dates = {k: v for k, v in rows[0].items() if k != "A" and v}
            if len(set(dates.values())) != len(dates):
                raise ValueError("duplicate wave dates")
            if axis is None:
                axis, question = dates, rows[0]["A"]
            elif dates != axis or rows[0]["A"] != question:
                raise ValueError("different wave dates or question across subgroups")
            labels = {}
            for row in rows[1:]:
                if row.get("A") in labels:
                    raise ValueError("duplicate response row")
                labels[row.get("A")] = row
            sheets[name] = labels
        if "US Registered Voters" not in sheets or not axis:
            raise ValueError("workbook lacks registered-voter population/axis")
        waves = []
        for column, day in axis.items():
            datetime.strptime(day, "%Y-%m-%d")
            if day > available.date().isoformat():
                raise ValueError("survey observation after artifact availability")
            cells = []
            for name, rows in sheets.items():
                for label, response in [("Approve", "total approval"), ("Disapprove", "total disapproval"), ("Not sure", "not sure")]:
                    if label not in rows or not rows[label].get(column):
                        raise ValueError("missing response; refusing incomplete wave")
                    value = float(rows[label][column]) * 100
                    if not 0 <= value <= 100:
                        raise ValueError("invalid survey fraction")
                    cell = {"subgroup": "all" if name == "US Registered Voters" else name, "population": "registered voters", "response": response, "value": round(value, 4)}
                    for label, key in [("Base", "weightedBase"), ("Unweighted base", "unweightedBase")]:
                        if rows.get(label, {}).get(column):
                            cell[key] = float(rows[label][column])
                            if not math.isfinite(cell[key]) or not cell[key] > 0:
                                raise ValueError("invalid survey base")
                    cells.append(cell)
            waves.append({"schema": "marina.survey-wave.v1", "source": "yougov_xtab", "url": source_url, "measure": measure, "question": question, "unit": "percent", "observedFrom": day, "availableAt": available_at, "documentHash": hashlib.sha256(raw).hexdigest(), "cells": cells})
        return sorted(waves, key=lambda w: w["observedFrom"])


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("workbook")
    parser.add_argument("--source-url", required=True)
    parser.add_argument("--available-at", required=True)
    parser.add_argument("--measure", required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(parse(args.workbook, args.source_url, args.available_at, args.measure), indent=2, allow_nan=False))
    except (ValueError, KeyError, IndexError, ET.ParseError, zipfile.BadZipFile) as error:
        print(f"Survey import refused: {error}", file=sys.stderr)
        sys.exit(1)
