import { Compass, MapPin, MessageCircle, Sparkles, User } from "lucide-react";
import { useMemo } from "react";
import { useEntityDetail } from "../hooks/use-api";
import { useChatState } from "../hooks/use-chat-state";
import { useWorldState } from "../hooks/use-world-state";

export function EntitySymmetryBar() {
  const selected = useWorldState((s) => s.selectedEntity);
  const entities = useWorldState((s) => s.entities);
  const sendCommand = useChatState((s) => s.sendCommand);
  const { data, isFetching } = useEntityDetail(selected ?? null);

  const summary = useMemo(() => {
    if (!selected) return null;
    const snapshot = entities.find((e) => e.name === selected);
    if (!snapshot) return null;
    const rank =
      typeof data?.rank === "number"
        ? data.rank
        : ((snapshot as unknown as { rank?: number })?.rank ?? undefined);
    return {
      name: selected,
      kind: snapshot.kind,
      room: snapshot.room,
      rank,
      model: snapshot.agentStatus?.model ?? null,
      state: snapshot.agentStatus?.state ?? null,
    };
  }, [data?.rank, entities, selected]);

  if (!summary) return null;

  const handleTell = () => {
    const message = window.prompt(`Message to ${summary.name}`, "");
    const trimmed = message?.trim();
    if (!trimmed) return;
    sendCommand(`tell ${summary.name} ${trimmed}`);
  };

  const handleGoto = () => {
    if (summary.room) {
      sendCommand(`goto ${summary.room}`);
    }
  };

  const handleStatus = () => {
    if (summary.kind === "agent") {
      sendCommand(`agent status ${summary.name}`);
    } else {
      sendCommand(`brief ${summary.name}`);
    }
  };

  return (
    <div className="flex flex-col gap-1 border-b border-border bg-bg/60 px-3 py-2 text-[11px] text-text">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1 text-text-bright">
          <User size={12} className="text-primary" />
          <span className="font-semibold">{summary.name}</span>
          <span className="rounded bg-border px-1 py-0.5 text-[10px] uppercase text-text-dim">
            {summary.kind}
          </span>
          {summary.rank != null && (
            <span className="rounded bg-bg px-1 py-0.5 text-[10px] text-text-dim">
              Rank {summary.rank}
            </span>
          )}
        </div>
        {isFetching && <span className="text-text-dim text-[10px] italic">Syncing…</span>}
      </div>

      <div className="flex flex-wrap gap-2 text-text-dim text-[10px]">
        {summary.room && (
          <span className="flex items-center gap-1">
            <MapPin size={10} className="text-accent" />
            {summary.room}
          </span>
        )}
        {summary.model && (
          <span className="flex items-center gap-1">
            <Sparkles size={10} className="text-secondary" />
            {summary.model}
          </span>
        )}
        {summary.state && (
          <span className="flex items-center gap-1">
            <Compass size={10} className="text-primary" />
            {summary.state}
          </span>
        )}
      </div>

      <div className="flex flex-wrap gap-1.5 text-[10px]">
        <button
          type="button"
          onClick={handleTell}
          className="rounded border border-border bg-bg px-2 py-0.5 text-text hover:border-primary hover:text-primary transition-colors"
          title={`Send a tell to ${summary.name}`}
        >
          <MessageCircle size={10} className="mr-1 inline text-primary" />
          Tell
        </button>
        <button
          type="button"
          onClick={handleGoto}
          className="rounded border border-border bg-bg px-2 py-0.5 text-text hover:border-primary hover:text-primary transition-colors disabled:opacity-40"
          disabled={!summary.room}
          title="Move to their room"
        >
          <Compass size={10} className="mr-1 inline text-secondary" />
          Follow
        </button>
        <button
          type="button"
          onClick={handleStatus}
          className="rounded border border-border bg-bg px-2 py-0.5 text-text hover:border-primary hover:text-primary transition-colors"
          title={summary.kind === "agent" ? "View agent status" : "Brief this entity"}
        >
          <Sparkles size={10} className="mr-1 inline text-accent" />
          {summary.kind === "agent" ? "Status" : "Brief"}
        </button>
      </div>
    </div>
  );
}
