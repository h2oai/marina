interface IntentData {
  prompt: string;
  status: "pending" | "active" | "done" | "failed";
  claimedBy?: string;
}

const BADGE: Record<string, { dot: string; ring: string; label: string }> = {
  pending: {
    dot: "bg-amber-400 animate-pulse",
    ring: "ring-amber-400/30",
    label: "Intent pending",
  },
  active: {
    dot: "bg-blue-400 animate-pulse",
    ring: "ring-blue-400/30",
    label: "Agent working",
  },
  done: {
    dot: "bg-green-400",
    ring: "ring-green-400/30",
    label: "Intent done",
  },
  failed: {
    dot: "bg-red-400",
    ring: "ring-red-400/30",
    label: "Intent failed",
  },
};

/**
 * Small visual badge overlaid on canvas nodes that have an intent set.
 * Positioned absolute — parent must have relative positioning.
 */
export function IntentBadge({ data }: { data: Record<string, unknown> }) {
  const intent = data.intent as IntentData | undefined;
  if (!intent?.status) return null;

  const style = BADGE[intent.status];
  if (!style) return null;

  return (
    <div
      className={`absolute -top-1.5 -right-1.5 z-10 flex items-center gap-1 rounded-full px-1.5 py-0.5 bg-gray-900/90 ring-1 ${style.ring}`}
      title={`${style.label}: ${intent.prompt}`}
    >
      <span className={`inline-block w-2 h-2 rounded-full ${style.dot}`} />
      <span className="text-[9px] text-gray-400 font-medium max-w-[80px] truncate">
        {intent.status}
      </span>
    </div>
  );
}
