// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { clearToken, setToken } from "../lib/api";
import { reduceChatPerception } from "../lib/chat-state-reducer";
import { useChatState } from "./use-chat-state";

/** Transport side effects stay outside the pure perception reducer. */
export function handleChatPerception(raw: unknown) {
  const transition = reduceChatPerception(raw);
  if (transition.orientation) useChatState.setState({ orientation: transition.orientation });
  if (transition.token === null) clearToken();
  else if (transition.token) setToken(transition.token);
  if (transition.login)
    useChatState.getState().setLoggedIn(transition.login.loggedIn, transition.login.name);
  if (transition.message) useChatState.getState().appendMessage(transition.message);
}
