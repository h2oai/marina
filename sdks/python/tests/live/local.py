# Copyright 2025-2026 H2O.ai, Inc.
# SPDX-License-Identifier: Apache-2.0
"""Live: Marina.local from Python. Driven by test/python-sdk.test.ts.

argv: <folder> <marina command as JSON>. The test sets HOME and blank provider keys.
"""

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "src"))

from marina import CommandError, Marina, MarinaError  # noqa: E402

folder, command = sys.argv[1], json.loads(sys.argv[2])
report = {}
with Marina.local(folder, fresh=True, command=command) as marina:
    report["name"] = marina.session.name
    report["pid"] = marina._server.pid  # type: ignore[union-attr]
    try:
        marina.code.run("Add a README")
    except CommandError as error:
        report["refused"] = str(error)
    report["look"] = bool(marina.command("look"))
try:
    os.kill(report["pid"], 0)
    report["stopped"] = False
except ProcessLookupError:
    report["stopped"] = True
try:
    Marina.local(os.path.join(folder, "missing"), command=command)
except MarinaError as error:
    report["missing"] = str(error)
print(json.dumps(report), flush=True)
