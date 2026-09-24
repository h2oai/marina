// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useQuery } from "@tanstack/react-query";
import type { QuestProgress } from "../../../src/net/discovery-types";
import { useChatState } from "../hooks/use-chat-state";
import { describeApiError, fetchApi } from "../lib/api";

export function QuestProgressCard({
  name,
  onFocusChat,
}: {
  name: string;
  onFocusChat: () => void;
}) {
  const history = useChatState((s) => s.commandHistory);
  const query = useQuery({
    queryKey: ["quest-progress", name],
    queryFn: () => fetchApi<QuestProgress[]>(`/api/entities/${encodeURIComponent(name)}/quests`),
    refetchInterval: 5000,
  });
  // Poll actual quest checks; sending a command alone does not imply completion.
  const quest =
    query.data?.find((item) => item.active) ??
    query.data?.find((item) => !item.completed) ??
    query.data?.[0];
  const run = (command: string) => {
    onFocusChat();
    useChatState.getState().sendCommand(command);
  };
  if (query.isError)
    return (
      <div role="alert" className="mt-3 text-xs text-danger">
        {describeApiError(query.error)}{" "}
        <button type="button" onClick={() => void query.refetch()}>
          Retry quests
        </button>
      </div>
    );
  if (!quest) return null;
  const done = quest.steps.filter((step) => step.done).length;
  const next = quest.steps.find((step) => !step.done);
  return (
    <section aria-label="Quest progress" className="mt-3 rounded border border-primary/30 p-2">
      <div className="flex justify-between text-xs">
        <strong>{quest.name}</strong>
        <span>
          {done}/{quest.steps.length} steps
        </span>
      </div>
      <progress
        aria-label={`${quest.name} progress`}
        max={quest.steps.length || 1}
        value={done}
        className="my-2 h-2 w-full accent-primary"
      />
      {quest.completed ? (
        <p className="text-xs text-success">Quest completed</p>
      ) : quest.active ? (
        <>
          {next && (
            <p className="mb-2 text-xs">
              {next.description}
              <span className="block text-text-dim">{next.hint}</span>
            </p>
          )}
          <button
            type="button"
            className="text-xs text-primary"
            onClick={() => run(next ? "quest status" : "quest complete")}
          >
            {next ? "View quest steps" : "Complete quest"}
          </button>
        </>
      ) : (
        <button
          type="button"
          className="text-xs text-primary"
          onClick={() => run(`quest start ${quest.name}`)}
        >
          Start quest
        </button>
      )}
      {history.length > 0 && (
        <button
          type="button"
          className="ml-3 text-xs text-text-dim"
          onClick={() => void query.refetch()}
        >
          Refresh progress
        </button>
      )}
    </section>
  );
}
