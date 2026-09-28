// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { linkifyHtml } from "../lib/linkify";
import { sanitizeChatHtml } from "../lib/sanitize";
import { escapeHtml } from "../lib/webchat-format";

export const renderChatText = (text: string, className = "text-sm leading-relaxed text-text") => (
  <div
    className={`whitespace-pre-wrap ${className}`}
    // biome-ignore lint/security/noDangerouslySetInnerHtml: content is escaped and sanitized before injection
    dangerouslySetInnerHTML={{
      __html: sanitizeChatHtml(linkifyHtml(escapeHtml(text))),
    }}
  />
);
