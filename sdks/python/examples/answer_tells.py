# Copyright 2025-2026 H2O.ai, Inc.
# SPDX-License-Identifier: Apache-2.0
"""An agent that answers whoever tells it something.

    python3 answer_tells.py ws://localhost:3300 helper

Others ask it with `tell helper <question>` (or `tell_and_await` from an SDK); it answers each
question with a tell, echoing the question's `[re:<id>]` tag so the asker knows which question
the answer is for. A dropped connection resumes on its own.
"""

from __future__ import annotations

import os
import queue
import re
import sys
from typing import Callable, Optional

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))

from marina import Marina  # noqa: E402
from marina.agent import tell_of  # noqa: E402

TAG = re.compile(r"\s*\[re:[a-z0-9]+\]")


def answer(question: str) -> str:
    """The answer to one question. Replace this with your agent's thinking."""
    if question.strip().rstrip("?").lower() == "ping":
        return "pong"
    return f"you asked: {question.strip()}"


def reply_to(sender: str, text: str, think: Callable[[str], str] = answer) -> str:
    """The tell that answers `text` from `sender`, carrying its correlation tag back."""
    tag = TAG.search(text)
    reply = think(TAG.sub("", text))
    return f"tell {sender} {reply}{tag.group(0) if tag else ''}"


def serve(marina: Marina, rounds: Optional[int] = None, idle: float = 60.0) -> int:
    """Answer tells until `rounds` were answered (forever when None); returns how many."""
    inbox: queue.Queue[tuple[str, str]] = queue.Queue()
    marina.on_event(lambda frame: inbox.put(tell) if (tell := tell_of(frame)) else None)
    marina.on_reconnect(lambda session: print(f"back as {session.name}", file=sys.stderr))
    answered = 0
    while rounds is None or answered < rounds:
        try:
            sender, text = inbox.get(timeout=idle)
        except queue.Empty:
            continue
        marina.command(reply_to(sender, text))
        answered += 1
    return answered


def main() -> int:
    url, name = (sys.argv[1:] + ["ws://localhost:3300", "helper"][len(sys.argv[1:]) :])[:2]
    with Marina.connect(url, name=name) as marina:
        print(f"listening as {marina.session.name}", file=sys.stderr)
        serve(marina)
    return 0


if __name__ == "__main__":
    sys.exit(main())
