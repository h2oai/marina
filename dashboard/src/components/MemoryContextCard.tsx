// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { useChatState } from "../hooks/use-chat-state";
import { MemoryContextPreview } from "./MemoryContextPreview";

/** The sidebar and full memory workspace share the same resident-bound preview. */
export function MemoryContextCard() {
  const identity = useChatState((state) => state.entityName);
  const loggedIn = useChatState((state) => state.loggedIn);
  const goal = useChatState((state) => state.orientation?.objective);
  return (
    <section
      aria-label="My memory context"
      className="max-h-[50%] shrink-0 overflow-auto border-b border-border"
    >
      <details>
        <summary className="cursor-pointer p-2 text-sm font-semibold text-primary">
          My memory context
        </summary>
        {loggedIn && identity ? (
          <MemoryContextPreview key={identity} initialQuery={goal ?? ""} compact />
        ) : (
          <p className="px-2 pb-2 text-sm text-text-dim">
            Sign in to world chat to inspect your memory for a task or question.
          </p>
        )}
      </details>
    </section>
  );
}
