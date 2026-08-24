// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { BriefcaseBusiness, Code2, FolderKanban, RefreshCw, SquareCheckBig, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useProjects, useTasks } from "../hooks/use-api";
import { useCodingSessionsSnapshot } from "../hooks/use-coding";

const TERMINAL_TASKS = new Set(["completed", "cancelled", "failed"]);
const TERMINAL_PROJECTS = new Set(["completed", "archived", "cancelled"]);
const TERMINAL_CODING = new Set(["completed", "closed", "cancelled", "failed"]);

export function WorkDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const tasks = useTasks();
  const projects = useProjects();
  const coding = useCodingSessionsSnapshot(open);
  const activeTasks = (tasks.data ?? []).filter((task) => !TERMINAL_TASKS.has(task.status));
  const activeProjects = (projects.data ?? []).filter(
    (project) => !TERMINAL_PROJECTS.has(project.status),
  );
  const activeCoding = (coding.data?.items ?? []).filter(
    (session) => !TERMINAL_CODING.has(session.status),
  );
  const loading = tasks.isLoading || projects.isLoading || coding.isLoading;
  const failed = tasks.isError || projects.isError || coding.isError;
  const total = activeTasks.length + activeProjects.length + activeCoding.length;

  const refresh = () => {
    void tasks.refetch();
    void projects.refetch();
    void coding.refetch();
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.aside
          initial={{ opacity: 1, x: 8 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: 24 }}
          transition={{ duration: 0.16 }}
          aria-label="Work overview"
          className="fixed right-2 top-12 z-[100] flex max-h-[calc(100vh-4rem)] w-[min(460px,calc(100vw-1rem))] flex-col overflow-hidden rounded-lg border border-border bg-bg-card/98 shadow-2xl backdrop-blur"
        >
          <div className="flex items-center gap-2 border-b border-border px-3 py-2">
            <BriefcaseBusiness size={14} className="text-primary" />
            <h2 className="font-semibold text-text-bright">Work</h2>
            <span className="rounded bg-primary/10 px-1.5 text-primary">{total}</span>
            <button
              type="button"
              onClick={refresh}
              className="ml-auto text-text-dim hover:text-primary"
              aria-label="Refresh work"
            >
              <RefreshCw size={13} />
            </button>
            <button
              type="button"
              onClick={onClose}
              className="text-text-dim hover:text-text"
              aria-label="Close work overview"
            >
              <X size={14} />
            </button>
          </div>
          <div className="overflow-y-auto p-2 text-[11px]">
            {loading && <div className="p-4 text-center text-text-dim">Loading work…</div>}
            {failed && (
              <div role="alert" className="p-4 text-center text-danger">
                Some work could not be loaded. Retry to reconcile this view.
              </div>
            )}
            {!loading && !failed && total === 0 && (
              <div className="p-5 text-center text-text-dim">No active work.</div>
            )}

            {activeTasks.length > 0 && (
              <section aria-labelledby="work-tasks" className="mb-3">
                <h3 id="work-tasks" className="mb-1 flex items-center gap-1 text-text-bright">
                  <SquareCheckBig size={11} /> Tasks · {activeTasks.length}
                </h3>
                {activeTasks.map((task) => (
                  <a
                    key={task.id}
                    href={`/dashboard?inspect=task:${task.id}`}
                    className="mb-1 flex items-center justify-between gap-3 rounded border border-border bg-bg/70 p-2 hover:border-primary/50"
                  >
                    <span className="min-w-0 truncate text-text">{task.title}</span>
                    <span className="shrink-0 text-primary">{task.status}</span>
                  </a>
                ))}
              </section>
            )}

            {activeProjects.length > 0 && (
              <section aria-labelledby="work-projects" className="mb-3">
                <h3 id="work-projects" className="mb-1 flex items-center gap-1 text-text-bright">
                  <FolderKanban size={11} /> Projects · {activeProjects.length}
                </h3>
                {activeProjects.map((project) => (
                  <a
                    key={project.id}
                    href={`/dashboard?inspect=project:${encodeURIComponent(project.id)}`}
                    className="mb-1 flex items-center justify-between gap-3 rounded border border-border bg-bg/70 p-2 hover:border-primary/50"
                  >
                    <span className="min-w-0 truncate text-text">{project.name}</span>
                    <span className="shrink-0 text-primary">{project.status}</span>
                  </a>
                ))}
              </section>
            )}

            {activeCoding.length > 0 && (
              <section aria-labelledby="work-coding">
                <h3 id="work-coding" className="mb-1 flex items-center gap-1 text-text-bright">
                  <Code2 size={11} /> Coding sessions · {activeCoding.length}
                </h3>
                {activeCoding.map((session) => (
                  <button
                    type="button"
                    key={session.id}
                    onClick={() => {
                      window.dispatchEvent(
                        new CustomEvent("marina:open-coding", {
                          detail: { sessionId: session.id },
                        }),
                      );
                      onClose();
                    }}
                    className="mb-1 flex w-full items-center justify-between gap-3 rounded border border-border bg-bg/70 p-2 text-left hover:border-primary/50"
                  >
                    <span className="min-w-0 truncate text-text">{session.title}</span>
                    <span className="shrink-0 text-primary">{session.status}</span>
                  </button>
                ))}
              </section>
            )}
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  );
}
