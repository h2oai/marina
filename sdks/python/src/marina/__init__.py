# Copyright 2025-2026 H2O.ai, Inc.
# SPDX-License-Identifier: Apache-2.0
"""Marina for Python: run coding tasks, send commands and use the HTTP APIs from your code.

>>> from marina import Marina
>>> with Marina.local("./my-project") as marina:
...     run = marina.code.run("Fix the failing test", budget="10m")
...     for step in run.steps():
...         print(step.label)
...     result = run.result()

No dependencies: the standard library only. The protocols are `marina.wire.v1` (WebSocket) and
`marina.http.v1` (HTTP), in the Marina repository's `protocol/` folder.
"""

from ._operations import HTTP_API_VERSION
from .client import (
    CommandError,
    CommandResult,
    Connection,
    ConnectionLost,
    LoginRefused,
    MarinaError,
    Session,
)
from .coding import Coding, CodingRun, CodingTimeout, budget_argument
from .front import LOCAL_PROTOCOL, LocalServer, Marina, start_local_server
from .http import ApiError, HttpApi
from .wire import (
    CODING_ACTIVITY_KINDS,
    RUN_OUTCOMES,
    VERIFICATIONS,
    WIRE_PROTOCOL,
    BudgetForced,
    CodeEvent,
    CodingActivity,
    ExecApprovalRequest,
    RunResult,
    classify_frame,
    code_event_of,
    exec_approval_of,
)

__version__ = "0.8.0"

__all__ = [
    "ApiError",
    "BudgetForced",
    "CODING_ACTIVITY_KINDS",
    "CodeEvent",
    "Coding",
    "CodingActivity",
    "CodingRun",
    "CodingTimeout",
    "CommandError",
    "CommandResult",
    "Connection",
    "ConnectionLost",
    "ExecApprovalRequest",
    "HTTP_API_VERSION",
    "HttpApi",
    "LOCAL_PROTOCOL",
    "LocalServer",
    "LoginRefused",
    "Marina",
    "MarinaError",
    "RUN_OUTCOMES",
    "RunResult",
    "Session",
    "VERIFICATIONS",
    "WIRE_PROTOCOL",
    "budget_argument",
    "classify_frame",
    "code_event_of",
    "exec_approval_of",
    "start_local_server",
]
