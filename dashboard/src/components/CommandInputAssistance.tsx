// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { type RefObject, useEffect, useState } from "react";
import type { CapabilityManifest, CommandCatalogEntry } from "../../../src/sdk/capabilities";
import { useChatState } from "../hooks/use-chat-state";
import { draftCommand, matchCommands } from "../lib/command-discovery";
import { requestParticipant } from "../lib/memory-service";
import { CommandFields } from "./CommandFields";

/** Selection only fills a draft. Enter retains send semantics until an option is selected. */
export function CommandInputAssistance({
  input,
  codeMode,
}: {
  input: RefObject<HTMLTextAreaElement | null>;
  codeMode: boolean;
}) {
  const [catalog, setCatalog] = useState<CommandCatalogEntry[]>([]);
  const [value, setValue] = useState("");
  const [selected, setSelected] = useState(-1);
  const [dismissed, setDismissed] = useState(false);
  const [error, setError] = useState("");
  const identity = useChatState((s) => s.entityName);
  const history = useChatState((s) => s.commandHistory);
  const options =
    codeMode || dismissed || !value || value.includes("\n")
      ? []
      : value === "?"
        ? [...new Set(history)]
            .slice(0, 6)
            .map((command) => ({ name: command, help: "Recent command" }))
        : !value.includes(" ")
          ? matchCommands(catalog, value).slice(0, 6)
          : [];
  const current = codeMode
    ? undefined
    : catalog.find(
        (c) => c.name === value.split(" ")[0] || c.aliases.includes(value.split(" ")[0]!),
      );
  const insert = (command: string) => {
    draftCommand(`${command} `);
    setValue(`${command} `);
    setSelected(-1);
  };
  useEffect(() => {
    if (!identity) return;
    const controller = new AbortController();
    const refresh = () => {
      void requestParticipant<CapabilityManifest>("capabilities", {}, controller.signal)
        .then((result) => {
          setCatalog(result.commands);
          setError("");
        })
        .catch((e) => {
          if (!controller.signal.aborted)
            setError(e instanceof Error ? e.message : "Discovery unavailable");
        });
    };
    refresh();
    const element = input.current;
    const changed = () => {
      setValue(element?.value ?? "");
      setSelected(-1);
      setDismissed(false);
    };
    const drafted = (event: Event) => {
      setValue((event as CustomEvent<{ command: string }>).detail.command);
      setSelected(-1);
    };
    const keyup = () => {
      setValue((current) => (element?.value === current ? current : (element?.value ?? "")));
    };
    window.addEventListener("marina:draft-command", drafted);
    element?.addEventListener("keyup", keyup);
    element?.addEventListener("input", changed);
    element?.addEventListener("focus", refresh);
    return () => {
      controller.abort();
      window.removeEventListener("marina:draft-command", drafted);
      element?.removeEventListener("keyup", keyup);
      element?.removeEventListener("input", changed);
      element?.removeEventListener("focus", refresh);
    };
  }, [identity, input]);
  useEffect(() => {
    const element = input.current;
    if (!element) return;
    element.setAttribute("aria-controls", "chat-command-options");
    element.setAttribute("aria-expanded", String(options.length > 0));
    if (selected >= 0) element.setAttribute("aria-activedescendant", `chat-command-${selected}`);
    else element.removeAttribute("aria-activedescendant");
    const key = (event: KeyboardEvent) => {
      if (event.isComposing || !options.length || event.shiftKey || event.ctrlKey || event.metaKey)
        return;
      if (event.key === "Escape") {
        setDismissed(true);
        setSelected(-1);
      } else if (event.key === "ArrowDown") setSelected((i) => (i + 1) % options.length);
      else if (event.key === "ArrowUp" && selected >= 0)
        setSelected((i) => (i - 1 + options.length) % options.length);
      else if (event.key === "Tab" || (event.key === "Enter" && selected >= 0))
        insert(options[Math.max(0, selected)]!.name);
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
        <span>{codeMode ? "Code Mode input" : "Tab completes · ? recent commands"}</span>
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
              aria-selected={selected === i}
              className={`block w-full px-2 py-1 text-left ${selected === i ? "bg-primary/20" : ""}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => insert(option.name)}
            >
              <strong>{option.name}</strong> · {option.help.split(/Usage:|\n/)[0]}
            </button>
          ))}
        </div>
      )}
      {current && value.includes(" ") && (
        <details>
          <summary className="cursor-pointer text-text-dim">
            {current.forms?.[0]?.syntax ?? `help ${current.name}`} · Parameter helper
          </summary>
          <CommandFields
            name={current.name}
            help={current.help}
            forms={current.forms}
            onCompose={(args) => insert(`${current.name} ${args}`)}
          />
        </details>
      )}
    </div>
  );
}
