// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { Check, ChevronRight, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import { useChatState } from "../hooks/use-chat-state";

const STORAGE_KEY = "marina:first-run-guide:v2";
const ORIENTATION_COMMANDS = ["look", "brief", "next"] as const;

function readDismissed(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "dismissed";
  } catch {
    return false;
  }
}

export interface FirstRunGuideProps {
  onFocusChat: () => void;
  onOpenKeys: () => void;
}

export function FirstRunGuide({ onFocusChat, onOpenKeys }: FirstRunGuideProps) {
  const loggedIn = useChatState((state) => state.loggedIn);
  const entityName = useChatState((state) => state.entityName);
  const commandHistory = useChatState((state) => state.commandHistory);
  const sendCommand = useChatState((state) => state.sendCommand);
  const [open, setOpen] = useState(() => !readDismissed());
  const [desire, setDesire] = useState("");

  const commandsSent = ORIENTATION_COMMANDS.filter((command) => commandHistory.includes(command));

  const close = () => {
    try {
      localStorage.setItem(STORAGE_KEY, "dismissed");
    } catch {
      // Storage can be unavailable in private browsing; closing still works.
    }
    setOpen(false);
  };

  const run = (command: (typeof ORIENTATION_COMMANDS)[number]) => {
    onFocusChat();
    sendCommand(command);
  };

  const beginJourney = () => {
    const expression = desire.trim();
    if (!expression) return;
    onFocusChat();
    sendCommand(`desire ${expression}`);
    setDesire("");
  };

  return (
    <>
      <AnimatePresence>
        {open && (
          <motion.aside
            aria-label="Getting started"
            initial={{ opacity: 1, y: 0 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -12 }}
            className="fixed top-14 left-1/2 z-50 w-[min(420px,calc(100vw-24px))] -translate-x-1/2 rounded border border-primary/50 bg-bg/95 p-3 font-mono text-text shadow-2xl backdrop-blur"
          >
            <div className="mb-2 flex items-center gap-2">
              <span className="text-[10px] font-bold tracking-[0.18em] text-primary">
                START HERE
              </span>
              <span className="flex-1 text-right text-[10px] text-text-muted">
                {loggedIn ? `${commandsSent.length}/3 orientation commands sent` : "Step 1 of 2"}
              </span>
              <button
                type="button"
                onClick={close}
                aria-label="Dismiss getting-started guide"
                className="rounded p-1 text-text-muted hover:bg-white/5 hover:text-text"
              >
                <X size={14} />
              </button>
            </div>

            {!loggedIn ? (
              <>
                <h2 className="mb-1 text-sm font-semibold text-text-bright">Enter the world</h2>
                <p className="mb-3 text-xs leading-relaxed text-text-muted">
                  On the default local setup, choose a name in Web Chat and connect. Authenticated
                  deployments show their sign-in screen before this dashboard.
                </p>
                <GuideButton label="Choose a name" onClick={onFocusChat} />
              </>
            ) : (
              <>
                <h2 className="mb-1 text-sm font-semibold text-text-bright">
                  Welcome{entityName ? `, ${entityName}` : ""}
                </h2>
                <p className="mb-3 text-xs leading-relaxed text-text-muted">
                  Tell Marina what matters in one sentence, or explore the existing command world
                  directly. Both paths use the same durable records.
                </p>
                <form
                  className="mb-3 flex gap-1.5"
                  onSubmit={(event) => {
                    event.preventDefault();
                    beginJourney();
                  }}
                >
                  <label htmlFor="first-run-desire" className="sr-only">
                    What would you like to explore, understand, decide, improve, or create?
                  </label>
                  <input
                    id="first-run-desire"
                    value={desire}
                    onChange={(event) => setDesire(event.target.value)}
                    maxLength={4000}
                    placeholder="What would you like to explore, decide, or create?"
                    className="min-w-0 flex-1 rounded border border-border bg-bg px-2 py-1.5 text-xs text-text-bright outline-none focus:border-primary"
                  />
                  <button
                    type="submit"
                    disabled={!desire.trim()}
                    className="rounded bg-primary px-2.5 py-1.5 text-[11px] font-bold text-bg disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Begin
                  </button>
                </form>
                <div className="mb-1 text-[10px] font-bold tracking-wide text-text-muted">
                  EXPLORE MARINA
                </div>
                <div className="grid gap-1.5">
                  <GuideButton
                    label="Look around"
                    detail="See your room, neighbors, and exits"
                    sent={commandsSent.includes("look")}
                    onClick={() => run("look")}
                  />
                  <GuideButton
                    label="Read your brief"
                    detail="See current context and available work"
                    sent={commandsSent.includes("brief")}
                    onClick={() => run("brief")}
                  />
                  <GuideButton
                    label="Find the next action"
                    detail="Ask Marina for one concrete next step"
                    sent={commandsSent.includes("next")}
                    onClick={() => run("next")}
                  />
                  <GuideButton
                    label="Connect an AI provider"
                    detail="Open Admin → Keys, choose a provider, and paste a key"
                    onClick={onOpenKeys}
                  />
                </div>
              </>
            )}
          </motion.aside>
        )}
      </AnimatePresence>

      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="fixed right-3 bottom-3 z-40 rounded border border-primary/40 bg-bg/90 px-2 py-1 font-mono text-[10px] text-primary shadow-lg backdrop-blur hover:border-primary"
        >
          START HERE
        </button>
      )}
    </>
  );
}

function GuideButton({
  label,
  detail,
  sent,
  onClick,
}: {
  label: string;
  detail?: string;
  sent?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded border border-primary/30 bg-primary/5 px-2.5 py-2 text-left hover:border-primary/70 hover:bg-primary/10"
    >
      {sent ? <Check size={14} className="text-success" /> : <ChevronRight size={14} />}
      <span className="min-w-0 flex-1">
        <span className="block text-xs font-semibold text-text-bright">{label}</span>
        {detail && <span className="block text-[10px] text-text-muted">{detail}</span>}
      </span>
      {sent && <span className="text-[9px] uppercase tracking-wide text-success">Sent</span>}
    </button>
  );
}
