import { BrainCircuit, Hourglass, MessageCircleQuestion, Users2 } from "lucide-react";
import { useMemo } from "react";
import { useChatState } from "../hooks/use-chat-state";
import { useWorldState } from "../hooks/use-world-state";
import { GlassPanel } from "./GlassPanel";

interface SpeakerInsight {
  name: string;
  count: number;
}

function parseSpeaker(text: string | undefined, tag: string | undefined): string | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (!trimmed) return null;

  if (tag === "say") {
    const otherMatch = trimmed.match(/^(.+?) says:/);
    const selfMatch = trimmed.match(/^You say:/);
    if (selfMatch) return "You";
    if (otherMatch) return otherMatch[1] ?? null;
  }
  if (tag === "tell") {
    const fromMatch = trimmed.match(/^>\s+(.+?) tells you:/);
    const toMatch = trimmed.match(/^>\s+You tell (.+?):/);
    if (toMatch) return "You";
    if (fromMatch) return fromMatch[1] ?? null;
  }
  if (tag === "shout") {
    const otherMatch = trimmed.match(/^(.+?) shouts:/i);
    if (otherMatch) return otherMatch[1] ?? null;
    if (/^You shout:/i.test(trimmed)) return "You";
  }
  if (tag === "emote") {
    const emoteMatch = trimmed.match(/^\*\s*(.+?)\b/);
    if (emoteMatch) return emoteMatch[1] ?? null;
  }
  if (tag === "say-self") return "You";
  if (tag === "broadcast") return "System";
  return null;
}

export function ConversationInsights() {
  const messages = useChatState((s) => s.messages);
  const entities = useWorldState((s) => s.entities);
  const roleLookup = useMemo(() => {
    const map = new Map<string, string>();
    for (const ent of entities) {
      map.set(ent.name, ent.kind);
    }
    return map;
  }, [entities]);

  const stats = useMemo(() => {
    const recent = messages.slice(-80);
    const now = Date.now();
    const windowMs = 10 * 60 * 1000;
    const windowStart = now - windowMs;

    const speakerCounts = new Map<string, number>();
    let humanLines = 0;
    let agentLines = 0;
    let lastQuestion: { from: string; text: string } | null = null;
    let latestTimestamp = 0;

    for (const msg of recent) {
      const ts = msg.timestamp ?? now;
      if (ts > latestTimestamp) latestTimestamp = ts;
      const speaker = parseSpeaker(msg.text, msg.tag);
      if (speaker) {
        const kind = roleLookup.get(speaker);
        if (kind === "agent") agentLines += 1;
        else if (kind === "npc") agentLines += 1;
        else if (speaker === "You" || kind === "human") humanLines += 1;
        else if (!kind) humanLines += 1;

        const prev = speakerCounts.get(speaker) ?? 0;
        speakerCounts.set(speaker, prev + 1);

        if (!lastQuestion && speaker !== "You" && msg.text?.includes("?")) {
          lastQuestion = { from: speaker, text: msg.text };
        }
      }
    }

    const windowMessages = recent.filter(
      (m) => (m.timestamp ?? now) >= windowStart && (m.timestamp ?? now) <= now,
    ).length;
    const minutes = windowMs / 60_000;
    const tempo = minutes > 0 ? windowMessages / minutes : windowMessages;

    const topSpeakers: SpeakerInsight[] = [...speakerCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([name, count]) => ({ name, count }));

    const totalLines = humanLines + agentLines || 1;
    const humanShare = Math.round((humanLines / totalLines) * 100);
    const agentShare = Math.round((agentLines / totalLines) * 100);

    return {
      tempo,
      topSpeakers,
      humanShare,
      agentShare,
      lastQuestion,
      recentCount: windowMessages,
      lastUpdated: latestTimestamp,
    };
  }, [messages, roleLookup]);

  return (
    <GlassPanel title="Conversation Intelligence" icon={<BrainCircuit size={14} />}>
      <div className="flex flex-1 flex-col gap-2 overflow-y-auto px-3 py-2 text-[11px] text-text">
        <div className="flex items-center gap-2 text-text-dim">
          <Hourglass size={12} className="text-primary" />
          <span>
            Tempo:&nbsp;
            <span className="text-text-bright">{stats.tempo.toFixed(1)} msg/min</span> (last 10 min)
          </span>
        </div>

        <div>
          <div className="flex items-center gap-2 text-text-dim">
            <Users2 size={12} className="text-secondary" />
            <span>Lead voices</span>
          </div>
          <ul className="mt-1 space-y-0.5 text-text">
            {stats.topSpeakers.length === 0 && <li className="text-text-dim">No dialogue yet.</li>}
            {stats.topSpeakers.map((speaker) => (
              <li key={speaker.name} className="flex items-center justify-between">
                <span className="truncate">{speaker.name}</span>
                <span className="text-text-dim tabular-nums">×{speaker.count}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="grid grid-cols-2 gap-2 text-text">
          <div className="rounded border border-border bg-bg/60 px-2 py-1 text-[10px]">
            <div className="text-text-dim">Human lines</div>
            <div className="text-text-bright text-[12px] font-semibold">{stats.humanShare}%</div>
          </div>
          <div className="rounded border border-border bg-bg/60 px-2 py-1 text-[10px]">
            <div className="text-text-dim">Agent lines</div>
            <div className="text-text-bright text-[12px] font-semibold">{stats.agentShare}%</div>
          </div>
        </div>

        {stats.lastQuestion && (
          <div className="rounded border border-border bg-bg/40 px-2 py-1">
            <div className="flex items-center gap-1 text-text-dim">
              <MessageCircleQuestion size={11} className="text-accent" />
              <span>Open question from {stats.lastQuestion.from}</span>
            </div>
            <div className="mt-1 text-[11px] text-text">
              {stats.lastQuestion.text.length > 120
                ? `${stats.lastQuestion.text.slice(0, 117)}…`
                : stats.lastQuestion.text}
            </div>
          </div>
        )}

        <div className="text-[10px] text-text-dim">
          Updated:{" "}
          <span className="text-text-bright">
            {new Date(stats.lastUpdated || Date.now()).toLocaleTimeString()}
          </span>
        </div>
      </div>
    </GlassPanel>
  );
}
