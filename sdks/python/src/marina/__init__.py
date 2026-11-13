# Copyright 2025-2026 H2O.ai, Inc.
# SPDX-License-Identifier: Apache-2.0
"""Marina for Python: run coding tasks, send commands and use the HTTP APIs from your code.

>>> from marina import Marina
>>> with Marina.local("./my-project") as marina:
...     run = marina.code.run("Fix the failing test", budget="10m")
...     for step in run.steps():
...         print(step.label)
...     result = run.result()

Agents talk with `tell_and_await` / `wait_for_tell`; a dropped connection resumes on its own;
`compose_command` fills in a command's typed form; `marina.models` types every HTTP call.

No dependencies: the standard library only. The protocols are `marina.wire.v1` (WebSocket) and
`marina.http.v1` (HTTP), in the Marina repository's `protocol/` folder.
"""

from ._operations import HTTP_API_VERSION
from .agent import (
    TellTimeout,
    correlation_tag,
    is_tell_notice,
    strip_correlation_tag,
)
from .client import (
    CommandError,
    CommandResult,
    Connection,
    ConnectionLost,
    LoginRefused,
    MarinaError,
    Session,
    reconnect_delay,
)
from .coding import Coding, CodingRun, CodingTimeout, budget_argument
from .front import LOCAL_PROTOCOL, LocalServer, Marina, start_local_server
from .forms import CommandField, CommandForm, ComposedCommand, compose_command, find_form, forms_of
from .http import ApiError, HttpApi, NetworkError
from .models import InvestigationsApi, MemoryApi, RoutingApi
from .panels import PanelChangeEvent, Panels
from .retry import retry_memory
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
    "CommandField",
    "CommandForm",
    "CommandResult",
    "ComposedCommand",
    "Connection",
    "ConnectionLost",
    "ExecApprovalRequest",
    "HTTP_API_VERSION",
    "HttpApi",
    "InvestigationsApi",
    "LOCAL_PROTOCOL",
    "LocalServer",
    "LoginRefused",
    "Marina",
    "MarinaError",
    "MemoryApi",
    "NetworkError",
    "PanelChangeEvent",
    "Panels",
    "RUN_OUTCOMES",
    "RoutingApi",
    "RunResult",
    "Session",
    "TellTimeout",
    "VERIFICATIONS",
    "WIRE_PROTOCOL",
    "budget_argument",
    "classify_frame",
    "code_event_of",
    "compose_command",
    "correlation_tag",
    "exec_approval_of",
    "find_form",
    "forms_of",
    "is_tell_notice",
    "reconnect_delay",
    "retry_memory",
    "start_local_server",
    "strip_correlation_tag",
]
