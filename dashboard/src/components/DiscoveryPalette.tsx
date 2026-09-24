// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useQuery } from "@tanstack/react-query";
import { Search, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { CommandCatalogEntry, DiscoveryResult } from "../../../src/net/discovery-types";
import { useChatState } from "../hooks/use-chat-state";
import { useWorkspaceState } from "../hooks/use-workspace-state";
import { useWorldState } from "../hooks/use-world-state";
import { describeApiError, fetchApi } from "../lib/api";
import { draftCommand, matchCommands } from "../lib/command-discovery";

import { FavoriteCommandButton } from "./CommandFavorites";
import { CommandFields } from "./CommandFields";

export function DiscoveryPalette({ onClose }: { onClose: () => void }) {
  const searchInput = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [category, setCategory] = useState("");
  const [selected, setSelected] = useState<CommandCatalogEntry | null>(null);
  const [args, setArgs] = useState("");
  const [index, setIndex] = useState(0);
  const [sendError, setSendError] = useState("");
  const loggedIn = useChatState((s) => s.loggedIn);
  const entityName = useChatState((s) => s.entityName);
  const codeMode = useWorldState(
    (s) =>
      s.entities.find((entity) => entity.name === entityName)?.properties?.active_modal === "code",
  );
  const connected = useChatState((s) => s.connected);
  const commands = useQuery({
    queryKey: ["command-catalog"],
    queryFn: () => fetchApi<CommandCatalogEntry[]>("/api/command-catalog"),
    staleTime: 60_000,
  });
  const results = useQuery({
    queryKey: ["discovery", entityName, debounced],
    queryFn: () => fetchApi<DiscoveryResult[]>(`/api/search?q=${encodeURIComponent(debounced)}`),
    enabled: debounced.length >= 2,
    staleTime: 10_000,
  });
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    searchInput.current?.focus();
    return () => previous?.focus();
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 200);
    return () => clearTimeout(timer);
  }, [query]);
  const matched = matchCommands(commands.data ?? [], query, category).slice(0, 30);
  const hits = category || query.trim() !== debounced ? [] : (results.data ?? []);
  const count = matched.length + hits.length;
  const active = Math.min(index, Math.max(0, count - 1));
  useEffect(() => {
    document.getElementById(`discovery-result-${active}`)?.scrollIntoView?.({ block: "nearest" });
  }, [active]);
  const command = selected ? `${selected.name}${args.trim() ? ` ${args.trim()}` : ""}` : "";

  const chooseHit = (hit: DiscoveryResult) => {
    onClose();
    if (hit.kind === "entity") {
      useWorldState.getState().selectEntity(hit.id);
      useWorkspaceState.getState().inspect({ type: "entity", name: hit.id });
    } else if (hit.kind === "room") {
      useWorldState.getState().selectRoom(hit.id);
      useWorkspaceState.getState().inspect({ type: "room", id: hit.id });
    } else if (hit.kind === "task")
      useWorkspaceState.getState().inspect({ type: "task", id: Number(hit.id) });
    else if (hit.kind === "note")
      useWorkspaceState
        .getState()
        .inspect({ type: "reference", reference: { kind: "note", id: hit.id } });
    else if (hit.kind === "board" || hit.kind === "channel")
      useWorkspaceState.getState().inspect({ type: hit.kind, name: hit.title });
    else if (hit.command) draftCommand(hit.command);
  };
  const choose = (position: number) => {
    const cmd = matched[position];
    if (cmd) {
      setSelected(cmd);
      setArgs("");
      setSendError("");
    } else if (hits[position - matched.length]) chooseHit(hits[position - matched.length]!);
  };
  const insert = () => {
    onClose();
    draftCommand(command);
  };

  return (
    <dialog
      ref={dialog}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      aria-label="Search and compose commands"
      className="fixed inset-0 m-auto w-[min(760px,calc(100vw-24px))] max-h-[85vh] overflow-auto rounded-lg border border-primary/40 bg-bg p-4 text-text shadow-2xl backdrop:bg-black/60"
    >
      <div className="mb-3 flex items-center gap-2">
        <Search size={18} className="text-primary" />
        <h2 className="flex-1 font-semibold">Search Marina</h2>
        <button type="button" onClick={onClose} aria-label="Close search">
          <X size={18} />
        </button>
      </div>
      {selected ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            insert();
          }}
          className="space-y-3"
        >
          <button type="button" onClick={() => setSelected(null)} className="text-sm text-primary">
            ← Back to results
          </button>
          <h3 className="font-semibold">Compose: {selected.name}</h3>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded border border-border p-3 text-xs">
            {selected.help}
          </pre>
          <p className="text-xs text-text-dim">
            {selected.category} · Rank {selected.minRank}
            {selected.gate ? ` · Requires ${selected.gate}` : ""}
            {selected.aliases.length ? ` · Aliases: ${selected.aliases.join(", ")}` : ""}
          </p>
          <CommandFields
            key={selected.name}
            name={selected.name}
            help={selected.help}
            onCompose={setArgs}
          />
          {codeMode && selected.name !== "code" && (
            <p role="status" className="text-xs text-warning">
              Chat is in Code Mode. Run code exit before sending a world command.
            </p>
          )}
          <label className="block text-sm">
            Arguments and parameters
            <textarea
              value={args}
              rows={Math.min(6, args.split("\n").length)}
              onChange={(e) => setArgs(e.target.value)}
              placeholder="Enter subcommand and parameters using the syntax above"
              className="mt-1 w-full rounded border border-border bg-bg p-2"
            />
          </label>
          <pre className="overflow-auto rounded bg-bg-hover p-2 text-sm">{command}</pre>
          <FavoriteCommandButton command={command} />
          {sendError && (
            <p role="alert" className="text-danger">
              {sendError}
            </p>
          )}
          <div className="flex gap-2">
            <button
              type="submit"
              className="rounded border border-primary px-3 py-2 text-sm text-primary"
            >
              Insert into chat
            </button>
            <button
              type="button"
              disabled={!loggedIn || !connected || (codeMode && selected.name !== "code")}
              onClick={() => {
                if (useChatState.getState().sendCommand(command)) onClose();
                else setSendError("Command was not sent. Reconnect and try again.");
              }}
              className="rounded bg-primary px-3 py-2 text-sm text-bg disabled:opacity-40"
            >
              Send command
            </button>
          </div>
          {!loggedIn && (
            <p className="text-xs text-text-dim">Connect in Web Chat to send commands.</p>
          )}
        </form>
      ) : (
        <>
          <input
            ref={searchInput}
            aria-label="Search commands and world"
            role="combobox"
            aria-expanded={count > 0}
            aria-controls="discovery-results"
            aria-activedescendant={count ? `discovery-result-${active}` : undefined}
            value={query}
            maxLength={200}
            onChange={(e) => {
              setQuery(e.target.value);
              setIndex(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                setIndex((active + (event.key === "ArrowDown" ? 1 : -1) + count) % (count || 1));
              }
              if (event.key === "Enter" && count) {
                event.preventDefault();
                choose(active);
              }
            }}
            placeholder="Commands, agents, rooms, tasks, notes, boards, channels…"
            className="w-full rounded border border-border bg-bg p-2 text-sm"
          />
          <label className="my-3 flex items-center gap-2 text-xs">
            Category
            <select
              value={category}
              onChange={(e) => {
                setCategory(e.target.value);
                setIndex(0);
              }}
              className="rounded border border-border bg-bg p-1"
            >
              <option value="">All commands and world</option>
              {[...new Set((commands.data ?? []).map((cmd) => cmd.category))].sort().map((cat) => (
                <option key={cat}>{cat}</option>
              ))}
            </select>
          </label>
          {commands.isLoading && <p role="status">Loading commands…</p>}
          {(commands.isError || results.isError) && (
            <div role="alert" className="mb-2 text-sm text-danger">
              {describeApiError(commands.error ?? results.error)}{" "}
              <button
                type="button"
                onClick={() => {
                  if (commands.isError) void commands.refetch();
                  if (results.isError) void results.refetch();
                }}
              >
                Retry
              </button>
            </div>
          )}
          {results.isFetching && (
            <p role="status" className="text-xs text-text-dim">
              Searching the world…
            </p>
          )}
          <div
            id="discovery-results"
            role="listbox"
            aria-label="Search results"
            className="max-h-[45vh] overflow-auto"
          >
            {matched.map((cmd, i) => (
              <button
                key={`command:${cmd.name}`}
                aria-label={`Compose ${cmd.name}, ${cmd.category}`}
                id={`discovery-result-${i}`}
                role="option"
                aria-selected={active === i}
                type="button"
                onClick={() => choose(i)}
                className={`block w-full rounded p-2 text-left hover:bg-bg-hover ${active === i ? "bg-bg-hover" : ""}`}
              >
                <span className="font-mono text-sm text-primary">{cmd.name}</span>
                <span className="ml-2 text-xs text-text-dim">
                  {cmd.category}
                  {cmd.aliases.length ? ` · ${cmd.aliases.join(", ")}` : ""}
                </span>
                <span className="block truncate text-xs">{cmd.help.split("\n")[0]}</span>
              </button>
            ))}
            {hits.map((hit, i) => (
              <button
                key={`${hit.kind}:${hit.id}`}
                id={`discovery-result-${matched.length + i}`}
                role="option"
                aria-selected={active === matched.length + i}
                type="button"
                onClick={() => chooseHit(hit)}
                className={`block w-full rounded p-2 text-left hover:bg-bg-hover ${active === matched.length + i ? "bg-bg-hover" : ""}`}
              >
                <span className="text-sm">{hit.title}</span>
                <span className="ml-2 text-xs text-primary">{hit.kind}</span>
                <span className="block text-xs text-text-dim">{hit.detail}</span>
              </button>
            ))}
          </div>
          {!count && !commands.isLoading && !results.isFetching && (
            <p className="py-4 text-sm text-text-dim">
              No matches. Try another name or description.
            </p>
          )}
          <p className="mt-3 text-xs text-text-dim">
            ↑ ↓ to select · Enter to compose or inspect · Esc to close
          </p>
        </>
      )}
    </dialog>
  );
}
