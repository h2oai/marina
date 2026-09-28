// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { type RefObject, useEffect, useLayoutEffect, useState } from "react";
import type { CapabilityManifest, CommandCatalogEntry } from "../../../src/sdk/capabilities";
import { commandFormPrefix, matchCommandForm } from "../../../src/sdk/command-forms";
import { ORIENTATION_COMMANDS } from "../../../src/sdk/onboarding";
import { useChatState } from "../hooks/use-chat-state";
import { useWorldState } from "../hooks/use-world-state";
import { draftCommand, matchCommands } from "../lib/command-discovery";
import { requestParticipant } from "../lib/memory-service";
import { CommandFields } from "./CommandFields";

function discoveryContextKey(
  state: ReturnType<typeof useWorldState.getState>,
  name: string | null,
) {
  const self = state.entities.find((entity) => entity.name === name);
  return JSON.stringify([
    state.capabilityRevision,
    self?.room,
    self?.properties?.rank,
    self?.properties?.active_modal,
  ]);
}

/** Selection only fills a draft. Enter retains send semantics until an option is selected. */
export function CommandInputAssistance({
  input,
  codeMode,
}: {
  input: RefObject<HTMLTextAreaElement | null>;
  codeMode: boolean;
}) {
  const [catalog, setCatalog] = useState<CommandCatalogEntry[]>([]);
  const [catalogBinding, setCatalogBinding] = useState({ identity: "", context: "" });
  const [value, setValue] = useState("");
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [error, setError] = useState("");
  const identity = useChatState((s) => s.entityName);
  const discoveryContext = useWorldState((state) => discoveryContextKey(state, identity));
  const catalogReady =
    catalogBinding.identity === identity && catalogBinding.context === discoveryContext;
  const history = useChatState((s) => s.commandHistory);
  const query = value.replace(/^\//, "").trimStart();
  const current =
    codeMode || catalogBinding.identity !== identity
      ? undefined
      : catalog.find(
          (c) => c.name === query.split(/\s/)[0] || c.aliases.includes(query.split(/\s/)[0]!),
        );
  const canonical = current ? current.name + query.slice(query.split(/\s/)[0]!.length) : query;
  const matchingForm = current ? matchCommandForm(current.forms ?? [], canonical) : undefined;
  const actionOptions =
    current?.forms
      ?.map((form) => ({ name: commandFormPrefix(form), help: form.description ?? form.syntax }))
      .filter(
        (option, i, all) =>
          option.name.length > canonical.trimEnd().length &&
          option.name.startsWith(canonical) &&
          all.findIndex((other) => other.name === option.name) === i,
      ) ?? [];
  const starters = [...ORIENTATION_COMMANDS, "memory", "context", "help"];
  const options =
    !catalogReady || codeMode || dismissed || !value || value.includes("\n")
      ? []
      : value === "?"
        ? [...new Set(history)]
            .slice(0, 6)
            .map((command) => ({ name: command, help: "Recent command" }))
        : query.includes(" ")
          ? actionOptions.slice(0, 6)
          : query.length >= 2 || value.startsWith("/")
            ? (query
                ? matchCommands(catalog, query)
                : starters.flatMap((name) => catalog.filter((entry) => entry.name === name))
              ).slice(0, 6)
            : [];
  const activeSelection = options.findIndex((option) => option.name === selectedName);
  const insert = (command: string) => {
    draftCommand(`${command} `);
    setValue(`${command} `);
    setSelectedName(null);
  };
  useEffect(() => {
    setError("");
    if (!identity) {
      setCatalog([]);
      return;
    }
    let active: AbortController | undefined;
    let focusRefresh: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      active?.abort();
      const controller = new AbortController();
      active = controller;
      void requestParticipant<CapabilityManifest>(
        "capabilities",
        {},
        controller.signal,
        "prefer-cache",
      )
        .then((result) => {
          if (
            controller.signal.aborted ||
            discoveryContextKey(useWorldState.getState(), identity) !== discoveryContext
          )
            return;
          setCatalog(result.commands);
          setCatalogBinding({ identity, context: discoveryContext });
          setError("");
        })
        .catch((e) => {
          if (!controller.signal.aborted)
            setError(e instanceof Error ? e.message : "Discovery unavailable");
        });
    };
    refresh();
    const refreshOnFocus = () => {
      clearTimeout(focusRefresh);
      focusRefresh = setTimeout(refresh, 150);
    };
    const element = input.current;
    const changed = () => {
      setValue(element?.value ?? "");
      setSelectedName(null);
      setDismissed(false);
    };
    const drafted = (event: Event) => {
      setValue((event as CustomEvent<{ command: string }>).detail.command);
      setSelectedName(null);
    };
    const keyup = () => {
      setValue((current) => (element?.value === current ? current : (element?.value ?? "")));
    };
    window.addEventListener("marina:draft-command", drafted);
    element?.addEventListener("keyup", keyup);
    element?.addEventListener("input", changed);
    element?.addEventListener("focus", refreshOnFocus);
    return () => {
      active?.abort();
      clearTimeout(focusRefresh);
      window.removeEventListener("marina:draft-command", drafted);
      element?.removeEventListener("keyup", keyup);
      element?.removeEventListener("input", changed);
      element?.removeEventListener("focus", refreshOnFocus);
    };
  }, [identity, input, discoveryContext]);
  useLayoutEffect(() => {
    const element = input.current;
    if (!element) return;
    // Keep the native key handler and ARIA state in the same commit as the visible
    // suggestions. A passive effect can leave Tab using the previous catalog.
    element.setAttribute("aria-controls", "chat-command-options");
    element.setAttribute("aria-expanded", String(options.length > 0));
    if (activeSelection >= 0)
      element.setAttribute("aria-activedescendant", `chat-command-${activeSelection}`);
    else element.removeAttribute("aria-activedescendant");
    const key = (event: KeyboardEvent) => {
      if (event.isComposing || !options.length || event.shiftKey || event.ctrlKey || event.metaKey)
        return;
      if (event.key === "Escape") {
        setDismissed(true);
        setSelectedName(null);
      } else if (event.key === "ArrowDown")
        setSelectedName(options[(activeSelection + 1) % options.length]!.name);
      else if (event.key === "ArrowUp" && activeSelection >= 0)
        setSelectedName(options[(activeSelection - 1 + options.length) % options.length]!.name);
      else if (event.key === "Tab" || (event.key === "Enter" && activeSelection >= 0))
        insert(options[Math.max(0, activeSelection)]!.name);
      else return;
      event.preventDefault();
      event.stopPropagation();
    };
    element.addEventListener("keydown", key);
    return () => element.removeEventListener("keydown", key);
  });
  return (
    <div className="space-y-1 text-xs">
      <div className="flex justify-between gap-2 text-text-dim">
        <span>{codeMode ? "Code Mode input" : "/ commands · Tab completes · ? recent"}</span>
        <button
          type="button"
          className="text-primary"
          onClick={() =>
            window.dispatchEvent(
              new CustomEvent("marina:open-memory", { detail: { context: true } }),
            )
          }
        >
          Memory context
        </button>
      </div>
      {error && <p role="status">Command discovery unavailable. Use help.</p>}
      {options.length > 0 && (
        <div
          id="chat-command-options"
          role="listbox"
          aria-label="Command suggestions"
          className="max-h-40 overflow-auto rounded border border-border bg-bg-card"
        >
          {options.map((option, i) => (
            <button
              key={option.name}
              id={`chat-command-${i}`}
              type="button"
              role="option"
              aria-selected={activeSelection === i}
              className={`block w-full px-2 py-1 text-left ${activeSelection === i ? "bg-primary/20" : ""}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => insert(option.name)}
            >
              <strong>{option.name}</strong> · {option.help.split(/Usage:|\n/)[0]}
            </button>
          ))}
        </div>
      )}
      {current && query.includes(" ") && (
        <details
          key={`${current.name}:${matchingForm?.syntax}`}
          className="max-h-[40vh] overflow-auto"
          open={!!matchingForm && commandFormPrefix(matchingForm).includes(" ")}
        >
          <summary className="cursor-pointer text-text-dim">
            {matchingForm?.syntax ?? `help ${current.name}`} · Parameter helper
          </summary>
          {/* Keep the draft mounted during a room/rank refresh, but don't compose
              against the previous context until the server confirms the contract. */}
          <fieldset disabled={!catalogReady}>
            <CommandFields
              name={current.name}
              help={current.help}
              forms={current.forms}
              initialSyntax={matchingForm?.syntax}
              onCompose={(args) => insert(`${current.name} ${args}`)}
            />
          </fieldset>
        </details>
      )}
    </div>
  );
}
