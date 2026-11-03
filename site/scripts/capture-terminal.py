#!/usr/bin/env python3
# Copyright 2025-2026 H2O.ai, Inc.
# SPDX-License-Identifier: Apache-2.0
"""Record the `marina connect` terminal for the docs.

Runs the REPL in a pseudo-terminal (the themed page needs a TTY), types a
few commands the way a person would, and writes the raw bytes the terminal
received to a file. `capture-terminal.mjs` renders that file to a picture.

  MARINA_CAPTURE_PORT=3500 python3 site/scripts/capture-terminal.py <name> <out.raw> [cols rows]
"""
import fcntl, os, pty, select, struct, sys, termios, time

name = sys.argv[1] if len(sys.argv) > 1 else "Lee"
out = sys.argv[2] if len(sys.argv) > 2 else "term.raw"
cols = int(sys.argv[3]) if len(sys.argv) > 3 else 108
rows = int(sys.argv[4]) if len(sys.argv) > 4 else 34
port = os.environ.get("MARINA_CAPTURE_PORT", "3500")
root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

script = [  # (delay before, keys)
    (5.0, "look\r"),
    (3.0, "task list completed\r"),
    (3.0, "pool guide recall launch plan\r"),
    (4.0, "chronicle\r"),
    (4.0, None),
]

pid, fd = pty.fork()
if pid == 0:
    os.environ.update({"TERM": "xterm-256color", "COLORTERM": "truecolor", "FORCE_COLOR": "3",
                       "LINES": str(rows), "COLUMNS": str(cols)})
    os.chdir(root)
    os.execvp("bun", ["bun", "--no-env-file", "scripts/connect.ts", name, "--port", port])

fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
buf = bytearray()

def pump(seconds):
    end = time.time() + seconds
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.05)
        if fd in r:
            try:
                data = os.read(fd, 65536)
            except OSError:
                return False
            if not data:
                return False
            buf.extend(data)
    return True

for delay, keys in script:
    if not pump(delay):
        break
    if keys:
        for ch in keys:
            os.write(fd, ch.encode())
            pump(0.04)
pump(1.0)
try:
    os.write(fd, b"\x04")  # ctrl-D: leave
    pump(1.0)
    os.kill(pid, 15)
except OSError:
    pass
with open(out, "wb") as f:
    f.write(buf)
print(f"wrote {len(buf)} bytes to {out}")
