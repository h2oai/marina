// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/** Electrobun's before-quit event is synchronous. Veto while Marina drains,
 * then re-enter native quit only after persistence has closed safely. */
export function createQuitHandler(
  shutdown: () => Promise<void>,
  quit: () => void,
  onError: (error: unknown) => void,
): (event: { response: { allow: boolean } | undefined }) => void {
  let pending: Promise<void> | undefined;
  let drained = false;
  return (event) => {
    if (drained) return;
    event.response = { allow: false };
    if (pending) return;
    pending = Promise.resolve()
      .then(shutdown)
      .then(() => {
        drained = true;
        quit();
      })
      .catch((error: unknown) => {
        pending = undefined;
        onError(error);
      });
  };
}
