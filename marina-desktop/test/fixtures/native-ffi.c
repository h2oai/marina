// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

const char *invoke_mime(const char *(*callback)(const char *)) {
  return callback("/tmp/notes.txt");
}

void invoke_tray(void (*callback)(unsigned int, const char *), const char *action) {
  callback(7, action);
}
