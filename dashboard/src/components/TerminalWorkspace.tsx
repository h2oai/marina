// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { ParticipantStreamWorkspace } from "./ParticipantStreams";

const KEY = "marina_terminal_workspace_token";
/** HTTP observer/control credential, isolated from Chat's single WebSocket connection. */
export function terminalWorkspaceToken(): string | null {
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  const token = fragment.get("marina-token");
  // Remove credentials before rendering, navigation, or any fetch. Fragments never reach HTTP logs.
  if (fragment.has("marina-token")) {
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
    if (token && token.length <= 4096) sessionStorage.setItem(KEY, token);
  }
  return sessionStorage.getItem(KEY);
}
export function TerminalWorkspace() {
  const [token, setToken] = useState(terminalWorkspaceToken);
  return (
    <main className="flex h-screen flex-col bg-surface text-text" aria-label="Terminal workspace">
      <header className="flex items-center justify-between border-b border-border p-4">
        <div>
          <h1 className="font-semibold">Marina · Terminal workspace</h1>
          <p className="text-sm text-text-dim">
            Agent output, permissions and delivery history. Your terminal stays connected.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            sessionStorage.removeItem(KEY);
            setToken(null);
          }}
        >
          Disconnect this view
        </button>
      </header>
      {token ? (
        <ParticipantStreamWorkspace key={token} token={token} autoSelect />
      ) : (
        <p className="p-4">Run /dashboard in your Marina terminal to connect this view.</p>
      )}
    </main>
  );
}
