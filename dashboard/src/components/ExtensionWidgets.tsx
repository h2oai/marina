// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { useQuery } from "@tanstack/react-query";
import { useChatState } from "../hooks/use-chat-state";
import { fetchApi } from "../lib/api";

interface Widget {
  id: string;
  title: string;
  slot: "sidebar" | "admin-tab";
  source: "readiness" | "world";
}
const SOURCES = { readiness: "/api/readiness", world: "/api/world" } as const;

function WidgetContent({ widget }: { widget: Widget }) {
  const name = useChatState((s) => s.entityName);
  const source = Object.hasOwn(SOURCES, widget.source) ? SOURCES[widget.source] : undefined;
  const query = useQuery({
    queryKey: ["extension-data", name, source],
    queryFn: () => fetchApi<unknown>(source!),
    enabled: !!source,
    refetchInterval: 15000,
  });
  return (
    <section className="border-t border-border p-3" aria-label={widget.title}>
      <h3 className="mb-2 text-sm font-medium">{widget.title}</h3>
      {query.isError ? (
        <p role="status">This information is unavailable for this session.</p>
      ) : (
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap text-xs">
          {query.isPending ? "Loading…" : JSON.stringify(query.data, null, 2)}
        </pre>
      )}
    </section>
  );
}

/** Declarative, escaped rendering. Data uses existing authenticated API routes. */
export function ExtensionWidgets({ slot }: { slot: Widget["slot"] }) {
  const name = useChatState((s) => s.entityName);
  const { data } = useQuery({
    queryKey: ["extension-widgets", name],
    queryFn: () => fetchApi<{ widgets: Widget[] }>("/api/extensions/widgets"),
    staleTime: 60000,
  });
  return (
    <>
      {data?.widgets
        .filter((widget) => widget.slot === slot)
        .map((widget) => (
          <WidgetContent key={widget.id} widget={widget} />
        ))}
    </>
  );
}
