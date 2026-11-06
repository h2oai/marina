// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * A message body as people read it in the dashboard: the shared grammar
 * (`src/sdk/message-format.ts`) rendered as React, the same parse the
 * terminal renders as colours. Lists, labelled lead-ins, code, links,
 * mentions (yours highlighted), references that open the inspector, verdict
 * chips, quiet asides, quoted output and ids. No HTML is injected: every span
 * is a React element, so a message cannot carry markup.
 *
 * Long messages fold behind "Read more". The original text is untouched; copy
 * copies it as written.
 */

import { type ReactNode, useMemo, useState } from "react";
import {
  type Block,
  type ParsedMessage,
  parseMessage,
  type Span,
} from "../../../src/sdk/message-format";

export interface MessageBodyProps {
  text: string;
  /** Your name: an @mention of you is highlighted. */
  viewer?: string | null;
  /** Fold long messages behind "Read more" (default true). */
  fold?: boolean;
  /** Smaller type for dense lists (inspector cards). */
  dense?: boolean;
  className?: string;
  /** A parsed message, when the caller already has one (avoids a second parse). */
  parsed?: ParsedMessage;
}

const TONE: Record<"good" | "bad" | "warn", string> = {
  good: "bg-success/15 text-success",
  bad: "bg-danger/15 text-danger",
  warn: "bg-warning/15 text-warning",
};

/** Where a reference opens, when the text says what it is. */
export function referenceHref(
  span: Extract<Span, { kind: "ref" | "channel" }>,
): string | undefined {
  if (span.kind === "channel") return `/dashboard?inspect=channel:${encodeURIComponent(span.name)}`;
  const kind = span.refKind?.split(" ")[0];
  if (kind === "task" || kind === "tasks")
    return `/dashboard?inspect=task:${encodeURIComponent(span.id)}`;
  if (kind === "board") {
    const name = span.refKind?.split(" ")[1];
    if (name) return `/dashboard?inspect=board:${encodeURIComponent(name)}`;
  }
  return undefined;
}

function SpanView({ span, viewer }: { span: Span; viewer?: string | null }): ReactNode {
  switch (span.kind) {
    case "text":
      return span.raw;
    case "code":
      return (
        <code className="rounded bg-bg-hover px-1 py-px font-mono text-[0.9em] text-text-bright break-words">
          {span.text}
        </code>
      );
    case "url":
      return (
        <a
          href={span.href}
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary underline decoration-primary/40 underline-offset-2 break-all hover:decoration-primary"
        >
          {span.raw}
        </a>
      );
    case "mention": {
      const you = !!viewer && span.name.toLowerCase() === viewer.toLowerCase();
      return (
        <span
          className={
            you
              ? "rounded bg-warning/25 px-1 font-semibold text-text-bright"
              : "font-semibold text-primary"
          }
        >
          {span.raw}
        </span>
      );
    }
    case "ref":
    case "channel": {
      const href = referenceHref(span);
      const cls =
        "inline-block whitespace-nowrap rounded bg-primary/10 px-1 font-medium text-primary leading-snug";
      return href ? (
        <a href={href} className={`${cls} hover:bg-primary/20`} title={`Open ${span.raw}`}>
          {span.raw}
        </a>
      ) : (
        <span className={cls}>{span.raw}</span>
      );
    }
    case "verdict":
      return (
        <span
          className={`inline-block whitespace-nowrap rounded px-1.5 text-[0.75em] font-bold tracking-wide align-[0.08em] ${TONE[span.tone]}`}
        >
          {span.raw}
        </span>
      );
    case "caps":
      return <span className="font-semibold [font-variant-caps:all-small-caps]">{span.raw}</span>;
    case "strong":
      return (
        <strong className="font-semibold text-text-bright">{spans(span.children, viewer)}</strong>
      );
    case "em":
      return <em>{spans(span.children, viewer)}</em>;
    case "aside":
      return <span className="text-text-dim">({spans(span.children, viewer)})</span>;
    case "quote":
      return (
        <q className="font-mono text-[0.9em] text-text-bright/85 [quotes:none]">
          <span className="text-text-dim">“</span>
          {spans(span.children, viewer)}
          <span className="text-text-dim">”</span>
        </q>
      );
    case "id":
      return (
        <span className="font-mono text-[0.85em] text-text-dim" title={span.raw}>
          {span.raw}
        </span>
      );
    case "kv":
      return (
        <span className="font-mono text-[0.9em]">
          <span className="text-text-dim">
            {span.key}
            {span.sep}
          </span>
          <span className="text-text-bright">{span.value}</span>
        </span>
      );
    case "arrow":
      return <span className="font-bold text-primary">{span.raw}</span>;
  }
}

function spans(list: readonly Span[], viewer?: string | null): ReactNode[] {
  return list.map((s, i) => (
    // Spans are a fixed sequence of the message: index keys are stable.
    // biome-ignore lint/suspicious/noArrayIndexKey: spans never reorder
    <SpanView key={i} span={s} viewer={viewer} />
  ));
}

function BlockView({ block, viewer }: { block: Block; viewer?: string | null }): ReactNode {
  switch (block.kind) {
    case "paragraph":
      return (
        <p className="my-1 first:mt-0 last:mb-0 whitespace-pre-wrap">
          {block.label && (
            <strong className="font-semibold text-text-bright">
              {spans(block.label, viewer)}{" "}
            </strong>
          )}
          {spans(block.spans, viewer)}
        </p>
      );
    case "heading":
      return (
        <p className="mt-2 mb-1 font-semibold text-text-bright first:mt-0">
          {spans(block.spans, viewer)}
        </p>
      );
    case "list": {
      const items = block.items.map((item, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: list items never reorder
        <li key={i} className="my-0.5 pl-0.5 whitespace-pre-wrap" value={item.n}>
          {item.label && (
            <strong className="font-semibold text-text-bright">{spans(item.label, viewer)} </strong>
          )}
          {spans(item.spans, viewer)}
        </li>
      ));
      return block.ordered ? (
        <ol className="my-1 list-decimal pl-6 marker:font-semibold marker:text-primary">{items}</ol>
      ) : (
        <ul className="my-1 list-disc pl-5 marker:text-primary">{items}</ul>
      );
    }
    case "quote":
      return (
        <blockquote className="my-1 border-l-2 border-border pl-2 italic text-text-dim whitespace-pre-wrap">
          {spans(block.spans, viewer)}
        </blockquote>
      );
    case "code":
      return (
        <pre className="my-1 overflow-x-auto rounded bg-bg-hover p-2 font-mono text-[0.85em] text-text-bright">
          {block.text}
        </pre>
      );
    case "table":
      return (
        <div className="my-1 overflow-x-auto">
          <table className="border-collapse text-[0.9em]">
            <thead>
              <tr>
                {block.header.map((c, i) => (
                  <th
                    // biome-ignore lint/suspicious/noArrayIndexKey: table cells never reorder
                    key={i}
                    className="border-b border-border px-2 py-0.5 text-left font-semibold"
                  >
                    {spans(c, viewer)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, r) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: table rows never reorder
                <tr key={r}>
                  {row.map((c, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: table cells never reorder
                    <td key={i} className="border-b border-border/50 px-2 py-0.5">
                      {spans(c, viewer)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "rule":
      return <hr className="my-2 border-border" />;
  }
}

export function MessageBody({
  text,
  viewer,
  fold = true,
  dense = false,
  className = "",
  parsed: given,
}: MessageBodyProps) {
  const parsed = useMemo(() => given ?? parseMessage(text), [given, text]);
  const [open, setOpen] = useState(false);
  const folded = fold && parsed.fold && !open;
  return (
    <div
      className={`${dense ? "text-[11px] leading-snug" : "leading-relaxed"} break-words ${className}`}
    >
      <div
        className={
          folded
            ? "max-h-[12em] overflow-hidden [mask-image:linear-gradient(to_bottom,black_65%,transparent)]"
            : ""
        }
      >
        {parsed.blocks.map((b, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: blocks never reorder
          <BlockView key={i} block={b} viewer={viewer} />
        ))}
      </div>
      {fold && parsed.fold && (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="mt-0.5 text-[0.85em] font-semibold text-primary hover:underline"
        >
          {open ? "Show less" : "Read more"}
        </button>
      )}
    </div>
  );
}
