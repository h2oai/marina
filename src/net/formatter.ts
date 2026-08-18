// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

import type { Perception } from "../types";
import type { Medium } from "./adapter";
import { A, stripAnsi } from "./ansi";

// ─── Unified Perception Formatter ────────────────────────────────────────────

export function formatPerception(p: Perception, medium: Medium): string {
  switch (medium) {
    case "json":
      return formatJson(p);
    case "ansi":
      return formatAnsi(p);
    case "markdown":
      return formatMarkdown(p);
    case "plaintext":
      return formatPlaintext(p);
    case "html":
      return formatHtml(p);
  }
}

// ─── JSON (WebSocket) ────────────────────────────────────────────────────────

function formatJson(p: Perception): string {
  return JSON.stringify(p);
}

// ─── ANSI (Telnet) ───────────────────────────────────────────────────────────

/** Tag → bracket color for ANSI output */
const TAG_COLOR: Record<string, string> = {
  tell: `${A.bold}${A.magenta}`,
  say: `${A.bold}${A.white}`,
  shout: `${A.bold}${A.brightYellow}`,
  emote: `${A.italic}${A.cyan}`,
  broadcast: `${A.bold}${A.blue}`,
  move: A.dim,
  connect: `${A.dim}${A.green}`,
  disconnect: `${A.dim}${A.red}`,
  leave: A.dim,
};

function tagPrefix(tag: string): string {
  const c = TAG_COLOR[tag] ?? `${A.bold}${A.green}`;
  return `${c}[${tag}]${A.reset} `;
}

function formatAnsi(p: Perception): string {
  if (p.kind === "room") {
    return formatRoomAnsi(p);
  }
  if (p.kind === "error") {
    const text = (p.data?.text as string) ?? "";
    return `${A.bold}${A.red}[error]${A.reset} ${A.red}${text}${A.reset}`;
  }
  if (p.kind === "system") {
    const text = (p.data?.text as string) ?? "";
    return `${A.cyan}[system]${A.reset} ${A.cyan}${text}${A.reset}`;
  }
  if (p.kind === "movement") {
    const d = p.data as { entity?: string; direction?: string; exit?: string };
    const name = d.entity ?? "Someone";
    if (d.direction === "arrive") {
      return `${A.dim}[move]${A.reset} ${A.dim}${A.italic}${name} arrives.${A.reset}`;
    }
    const dir = d.exit ? ` ${d.exit}` : "";
    return `${A.dim}[move]${A.reset} ${A.dim}${A.italic}${name} leaves${dir}.${A.reset}`;
  }
  const text = (p.data?.text as string) ?? "";
  const prefix = p.tag ? tagPrefix(p.tag) : "";
  if (text) return `${prefix}${text}`;
  return `${prefix}${JSON.stringify(p.data)}`;
}

function formatRoomAnsi(p: Perception): string {
  const d = p.data as {
    short?: string;
    long?: string;
    exits?: string[];
    entities?: { name: string; short: string }[];
    items?: Record<string, string>;
  };
  const lines: string[] = [];
  if (d.short) lines.push(`${A.bold}${A.cyan}${d.short}${A.reset}`);
  if (d.long) lines.push(d.long);
  if (d.items && Object.keys(d.items).length > 0) {
    lines.push("");
    lines.push(`${A.yellow}Objects:${A.reset}`);
    for (const key of Object.keys(d.items)) {
      lines.push(`  ${key}`);
    }
  }
  if (d.entities && d.entities.length > 0) {
    lines.push("");
    lines.push(`${A.green}Present:${A.reset}`);
    for (const e of d.entities) {
      lines.push(`  ${e.short || e.name}`);
    }
  }
  if (d.exits && d.exits.length > 0) {
    lines.push("");
    lines.push(`${A.dim}Exits: ${d.exits.join(", ")}${A.reset}`);
  }
  return lines.join("\n");
}

// ─── Markdown (MCP / Discord / Telegram) ─────────────────────────────────────

function formatMarkdown(p: Perception): string {
  if (p.kind === "room") {
    return formatRoomMarkdown(p);
  }
  if (p.kind === "error") {
    const text = stripAnsi((p.data?.text as string) ?? "");
    return `> **[error]** ${text}`;
  }
  if (p.kind === "system") {
    const text = stripAnsi((p.data?.text as string) ?? "");
    return `*[system] ${text}*`;
  }
  if (p.kind === "movement") {
    const d = p.data as { entity?: string; direction?: string; exit?: string };
    const name = d.entity ?? "Someone";
    if (d.direction === "arrive") return `*[move] ${name} arrives.*`;
    const dir = d.exit ? ` ${d.exit}` : "";
    return `*[move] ${name} leaves${dir}.*`;
  }
  const text = stripAnsi((p.data?.text as string) ?? "");
  const prefix = p.tag ? `**[${p.tag}]** ` : "";
  if (text) return `${prefix}${text}`;
  return `${prefix}${JSON.stringify(p.data)}`;
}

function formatRoomMarkdown(p: Perception): string {
  const d = p.data as {
    short?: string;
    long?: string;
    exits?: string[];
    entities?: { name: string; short: string }[];
    items?: Record<string, string>;
  };
  const lines: string[] = [];
  if (d.short) lines.push(`## ${d.short}`);
  if (d.long) lines.push(d.long);
  if (d.items && Object.keys(d.items).length > 0) {
    lines.push("");
    lines.push("**Objects you can examine:**");
    for (const key of Object.keys(d.items)) {
      lines.push(`- ${key}`);
    }
  }
  if (d.entities && d.entities.length > 0) {
    lines.push("");
    lines.push("**Present:**");
    for (const e of d.entities) {
      lines.push(`- ${e.short || e.name}`);
    }
  }
  if (d.exits && d.exits.length > 0) {
    lines.push("");
    lines.push(`**Exits:** ${d.exits.join(", ")}`);
  }
  return lines.join("\n");
}

// ─── Plaintext ───────────────────────────────────────────────────────────────

function formatPlaintext(p: Perception): string {
  if (p.kind === "room") {
    return formatRoomPlaintext(p);
  }
  const text = stripAnsi((p.data?.text as string) ?? "");
  const prefix = p.tag ? `[${p.tag}] ` : "";
  if (text) return `${prefix}${text}`;
  return `${prefix}${JSON.stringify(p.data)}`;
}

function formatRoomPlaintext(p: Perception): string {
  const d = p.data as {
    short?: string;
    long?: string;
    exits?: string[];
    entities?: { name: string; short: string }[];
    items?: Record<string, string>;
  };
  const lines: string[] = [];
  if (d.short) lines.push(d.short);
  if (d.long) lines.push(d.long);
  if (d.items && Object.keys(d.items).length > 0) {
    lines.push("");
    lines.push("Objects:");
    for (const key of Object.keys(d.items)) {
      lines.push(`  ${key}`);
    }
  }
  if (d.entities && d.entities.length > 0) {
    lines.push("");
    lines.push("Present:");
    for (const e of d.entities) {
      lines.push(`  ${e.short || e.name}`);
    }
  }
  if (d.exits && d.exits.length > 0) {
    lines.push("");
    lines.push(`Exits: ${d.exits.join(", ")}`);
  }
  return lines.join("\n");
}

// ─── HTML ────────────────────────────────────────────────────────────────────

function formatHtml(p: Perception): string {
  if (p.kind === "room") {
    return formatRoomHtml(p);
  }
  if (p.kind === "error") {
    const text = esc(stripAnsi((p.data?.text as string) ?? ""));
    return `<span class="error">${text}</span>`;
  }
  if (p.kind === "system") {
    const text = esc(stripAnsi((p.data?.text as string) ?? ""));
    return `<span class="system">${text}</span>`;
  }
  const prefix = p.tag ? `<span class="tag">[${esc(p.tag)}]</span> ` : "";
  const text = esc(stripAnsi((p.data?.text as string) ?? ""));
  if (text) return `<span>${prefix}${text}</span>`;
  return `<pre>${prefix}${esc(JSON.stringify(p.data))}</pre>`;
}

function formatRoomHtml(p: Perception): string {
  const d = p.data as {
    short?: string;
    long?: string;
    exits?: string[];
    entities?: { name: string; short: string }[];
    items?: Record<string, string>;
  };
  const lines: string[] = [];
  if (d.short) lines.push(`<h3>${esc(d.short)}</h3>`);
  if (d.long) lines.push(`<p>${esc(d.long)}</p>`);
  if (d.items && Object.keys(d.items).length > 0) {
    lines.push("<p><strong>Objects:</strong></p><ul>");
    for (const key of Object.keys(d.items)) {
      lines.push(`<li>${esc(key)}</li>`);
    }
    lines.push("</ul>");
  }
  if (d.entities && d.entities.length > 0) {
    lines.push("<p><strong>Present:</strong></p><ul>");
    for (const e of d.entities) {
      lines.push(`<li>${esc(e.short || e.name)}</li>`);
    }
    lines.push("</ul>");
  }
  if (d.exits && d.exits.length > 0) {
    lines.push(`<p><strong>Exits:</strong> ${d.exits.map(esc).join(", ")}</p>`);
  }
  return lines.join("\n");
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
