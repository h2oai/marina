// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * A preview of what a reference in a message names — a task, a channel, a
 * board, one post, one tell, or every thing a bare `#12` could be. One
 * instance serves the whole dashboard: any element carrying
 * `data-ref-preview="<key>"` (see `lib/reference-key.ts`) shows it after a
 * short hover or on keyboard focus. Clicking a reference that has no page of
 * its own (a post, a tell, a bare `#12`) pins the card open, with links to
 * where each thing lives; a reference with a page opens it in the inspector.
 *
 * Every read goes through the dashboard API with the viewer's own session:
 * a tell previews only for its sender and recipient, and anything the viewer
 * cannot read shows as unavailable.
 */

import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { excerpt } from "../../../src/sdk/message-format";
import { fetchApi } from "../lib/api";
import { parseReferenceKey, type ReferenceTarget, referenceTargetHref } from "../lib/reference-key";
import type { BoardDetail, ChannelDetail, TaskDetail } from "../lib/types";

interface PostDetail {
  id: number;
  channel: string;
  sender_name: string;
  content: string;
  created_at: number;
  cause?: string;
}

interface TellDetail {
  id: number;
  sender_name: string;
  target_name: string;
  content: string;
  created_at: number;
  status: string;
}

const SHOW_DELAY_MS = 300;
const WIDTH = 320;

function when(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function useDetail<T>(path: string | undefined) {
  return useQuery({
    queryKey: ["reference-preview", path],
    queryFn: () => fetchApi<T>(path!),
    enabled: !!path,
    staleTime: 15_000,
    retry: false,
  });
}

function Status({
  loading,
  error,
  children,
}: {
  loading: boolean;
  error: boolean;
  children: ReactNode;
}) {
  if (loading) return <p className="text-text-dim">Loading…</p>;
  if (error) return <p className="text-text-dim">Not found, or not visible to you.</p>;
  return <>{children}</>;
}

function Body({ text, lines = 6 }: { text: string; lines?: number }) {
  return (
    <p
      className="mt-1 whitespace-pre-wrap break-words text-text"
      style={{
        display: "-webkit-box",
        WebkitLineClamp: lines,
        WebkitBoxOrient: "vertical",
        overflow: "hidden",
      }}
    >
      {text}
    </p>
  );
}

function OpenLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} className="mt-2 inline-block font-semibold text-primary hover:underline">
      {children}
    </a>
  );
}

function TaskCard({ id, pinned }: { id: number; pinned: boolean }) {
  const q = useDetail<TaskDetail>(`/api/coordination/tasks/${id}`);
  const t = q.data;
  const holder = t?.assignee_name ?? t?.claims?.find((c) => c.status !== "released")?.entity_name;
  return (
    <Status loading={q.isLoading} error={q.isError}>
      {t && (
        <>
          <p className="font-semibold text-text-bright">
            Task {t.id} <span className="font-normal text-text-dim">· {t.status}</span>
          </p>
          <p className="mt-0.5 font-medium">{t.title}</p>
          <p className="mt-0.5 text-text-dim">
            by {t.creator_name}
            {holder ? ` · held by ${holder}` : ""}
          </p>
          {t.description && <Body text={excerpt(t.description, 360)} lines={4} />}
          {pinned && <OpenLink href={`/dashboard?inspect=task:${t.id}`}>Open task</OpenLink>}
        </>
      )}
    </Status>
  );
}

function ChannelCard({ name, pinned }: { name: string; pinned: boolean }) {
  const q = useDetail<ChannelDetail>(`/api/coordination/channels/${encodeURIComponent(name)}`);
  const c = q.data;
  const last = c?.messages.at(-1);
  return (
    <Status loading={q.isLoading} error={q.isError}>
      {c && (
        <>
          <p className="font-semibold text-text-bright">
            #{c.name} <span className="font-normal text-text-dim">· {c.messageCount} messages</span>
          </p>
          {last && (
            <p className="mt-1 text-text-dim">
              <span className="font-medium text-text">{last.sender_name}:</span>{" "}
              {excerpt(last.content, 160)}
            </p>
          )}
          {pinned && (
            <OpenLink href={`/dashboard?inspect=channel:${encodeURIComponent(c.name)}`}>
              Open #{c.name}
            </OpenLink>
          )}
        </>
      )}
    </Status>
  );
}

function BoardCard({ name, pinned }: { name: string; pinned: boolean }) {
  const q = useDetail<BoardDetail>(`/api/coordination/boards/${encodeURIComponent(name)}`);
  const b = q.data;
  return (
    <Status loading={q.isLoading} error={q.isError}>
      {b && (
        <>
          <p className="font-semibold text-text-bright">
            Board {b.name} <span className="font-normal text-text-dim">· {b.postCount} posts</span>
          </p>
          <ul className="mt-1 space-y-0.5">
            {b.posts.slice(0, 3).map((p) => (
              <li key={p.id} className="truncate">
                {p.title}
              </li>
            ))}
          </ul>
          {pinned && (
            <OpenLink href={`/dashboard?inspect=board:${encodeURIComponent(b.name)}`}>
              Open board
            </OpenLink>
          )}
        </>
      )}
    </Status>
  );
}

function PostCard({ channel, id, pinned }: { channel: string; id: number; pinned: boolean }) {
  const q = useDetail<PostDetail>(
    `/api/coordination/channels/${encodeURIComponent(channel)}/messages/${id}`,
  );
  const p = q.data;
  return (
    <Status loading={q.isLoading} error={q.isError}>
      {p && (
        <>
          <p className="font-semibold text-text-bright">
            {p.sender_name}{" "}
            <span className="font-normal text-text-dim">
              · post {p.id} in #{p.channel} · {when(p.created_at)}
            </span>
          </p>
          <Body text={p.content} lines={pinned ? 14 : 6} />
          {pinned && (
            <OpenLink href={`/dashboard?inspect=channel:${encodeURIComponent(p.channel)}`}>
              Open #{p.channel}
            </OpenLink>
          )}
        </>
      )}
    </Status>
  );
}

function TellCard({ id, pinned }: { id: number; pinned: boolean }) {
  const q = useDetail<TellDetail>(`/api/coordination/tells/${id}`);
  const t = q.data;
  return (
    <Status loading={q.isLoading} error={q.isError}>
      {t && (
        <>
          <p className="font-semibold text-text-bright">
            {t.sender_name} → {t.target_name}{" "}
            <span className="font-normal text-text-dim">
              · tell {t.id} · {when(t.created_at)}
            </span>
          </p>
          <Body text={t.content} lines={pinned ? 14 : 6} />
        </>
      )}
    </Status>
  );
}

/** A bare `#12`: every thing it could name that exists, each one a choice. */
function AnyCard({
  id,
  channel,
  onChoose,
}: {
  id: number;
  channel?: string;
  onChoose: (key: string) => void;
}) {
  const task = useDetail<TaskDetail>(`/api/coordination/tasks/${id}`);
  const post = useDetail<PostDetail>(
    channel
      ? `/api/coordination/channels/${encodeURIComponent(channel)}/messages/${id}`
      : undefined,
  );
  if (task.isLoading || (channel && post.isLoading))
    return <p className="text-text-dim">Looking up #{id}…</p>;
  const choices: ReactNode[] = [];
  if (task.data)
    choices.push(
      <li key="task">
        <a
          href={`/dashboard?inspect=task:${id}`}
          className="block rounded px-1 py-0.5 hover:bg-bg-hover"
        >
          <span className="font-semibold text-primary">Task {id}</span>{" "}
          <span className="text-text-dim">· {task.data.status}</span>
          <span className="block truncate">{task.data.title}</span>
        </a>
      </li>,
    );
  if (post.data)
    choices.push(
      <li key="post">
        <button
          type="button"
          onClick={() => onChoose(`post:${channel}:${id}`)}
          className="block w-full rounded px-1 py-0.5 text-left hover:bg-bg-hover"
        >
          <span className="font-semibold text-primary">Post {id}</span>{" "}
          <span className="text-text-dim">in #{channel}</span>
          <span className="block truncate">
            {post.data.sender_name}: {excerpt(post.data.content, 120)}
          </span>
        </button>
      </li>,
    );
  if (!choices.length)
    return <p className="text-text-dim">Nothing named #{id} that you can see.</p>;
  return (
    <>
      <p className="font-semibold text-text-bright">
        #{id} {choices.length > 1 ? "could be" : "is"}
      </p>
      <ul className="mt-1 space-y-1">{choices}</ul>
    </>
  );
}

function Card({
  target,
  pinned,
  onChoose,
}: {
  target: ReferenceTarget;
  pinned: boolean;
  onChoose: (key: string) => void;
}) {
  switch (target.kind) {
    case "task":
      return <TaskCard id={target.id} pinned={pinned} />;
    case "channel":
      return <ChannelCard name={target.name} pinned={pinned} />;
    case "board":
      return <BoardCard name={target.name} pinned={pinned} />;
    case "post":
      return <PostCard channel={target.channel} id={target.id} pinned={pinned} />;
    case "tell":
      return <TellCard id={target.id} pinned={pinned} />;
    case "any":
      return <AnyCard id={target.id} channel={target.channel} onChoose={onChoose} />;
  }
}

interface Shown {
  key: string;
  element: HTMLElement;
  x: number;
  y: number;
  pinned: boolean;
}

function placement(el: HTMLElement): { x: number; y: number } {
  const rect = el.getBoundingClientRect();
  const x = Math.max(8, Math.min(rect.left, window.innerWidth - WIDTH - 8));
  const below = rect.bottom + 6;
  const y = below + 220 > window.innerHeight ? Math.max(8, rect.top - 226) : below;
  return { x, y };
}

export function ReferencePreview() {
  const [shown, setShown] = useState<Shown | null>(null);
  const card = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(false);
  pinnedRef.current = !!shown?.pinned;
  const hide = useCallback(() => setShown(null), []);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const source = (event: Event) =>
      event.target instanceof Element
        ? event.target.closest<HTMLElement>("[data-ref-preview]")
        : null;
    const show = (event: Event) => {
      const el = source(event);
      if (!el || pinnedRef.current) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (!el.isConnected || pinnedRef.current) return;
        setShown({ key: el.dataset.refPreview!, element: el, pinned: false, ...placement(el) });
      }, SHOW_DELAY_MS);
    };
    const leave = (event: Event) => {
      const el = source(event);
      if (!el || pinnedRef.current) return;
      const related = (event as MouseEvent).relatedTarget;
      if (related instanceof Node && el.contains(related)) return;
      clearTimeout(timer);
      setShown(null);
    };
    const click = (event: MouseEvent) => {
      const el = source(event);
      if (el && el.tagName === "BUTTON") {
        // A reference with no page of its own: the card is where it opens.
        clearTimeout(timer);
        setShown({ key: el.dataset.refPreview!, element: el, pinned: true, ...placement(el) });
        return;
      }
      if (
        pinnedRef.current &&
        // The path as dispatched: a choice inside the card may already be
        // re-rendered away, and must not read as a click outside it.
        !(card.current && event.composedPath().includes(card.current))
      )
        setShown(null);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        clearTimeout(timer);
        setShown(null);
      }
    };
    const scroll = (event: Event) => {
      if (event.target instanceof Node && card.current?.contains(event.target)) return;
      clearTimeout(timer);
      setShown(null);
    };
    document.addEventListener("mouseover", show);
    document.addEventListener("focusin", show);
    document.addEventListener("mouseout", leave);
    document.addEventListener("focusout", leave);
    document.addEventListener("click", click);
    document.addEventListener("keydown", key);
    window.addEventListener("scroll", scroll, true);
    window.addEventListener("popstate", hide);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("mouseover", show);
      document.removeEventListener("focusin", show);
      document.removeEventListener("mouseout", leave);
      document.removeEventListener("focusout", leave);
      document.removeEventListener("click", click);
      document.removeEventListener("keydown", key);
      window.removeEventListener("scroll", scroll, true);
      window.removeEventListener("popstate", hide);
    };
  }, [hide]);

  useEffect(() => {
    if (!shown || shown.pinned) return;
    const el = shown.element;
    const previous = el.getAttribute("aria-describedby");
    el.setAttribute("aria-describedby", "reference-preview");
    return () => {
      if (previous) el.setAttribute("aria-describedby", previous);
      else el.removeAttribute("aria-describedby");
    };
  }, [shown]);

  if (!shown) return null;
  const target = parseReferenceKey(shown.key);
  if (!target) return null;
  const href = referenceTargetHref(target);
  return createPortal(
    <div
      ref={card}
      id="reference-preview"
      {...(shown.pinned
        ? { role: "dialog", "aria-label": "Reference details" }
        : { role: "tooltip" })}
      className={`fixed z-[100] rounded border border-primary/40 bg-bg p-3 text-xs text-text shadow-xl ${
        shown.pinned ? "" : "pointer-events-none"
      }`}
      style={{ left: shown.x, top: shown.y, width: WIDTH }}
    >
      <Card
        target={target}
        pinned={shown.pinned}
        onChoose={(next) => setShown((s) => (s ? { ...s, key: next } : s))}
      />
      {!shown.pinned && href && <p className="mt-2 text-[10px] text-text-dim">Click to open</p>}
      {!shown.pinned && !href && <p className="mt-2 text-[10px] text-text-dim">Click to pin</p>}
    </div>,
    document.body,
  );
}
