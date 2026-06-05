const HIDDEN_KEYS = new Set([
  "url",
  "content",
  "body",
  "text",
  "filename",
  "label",
  "title",
  "canvas_id",
  "color",
  "components",
  "rootId",
  "dataModel",
  "creator_name",
  "created_at",
  "updated_at",
  "asset_id",
  "lastAction",
  "scores",
]);

function formatTimestamp(ts: unknown): string {
  if (!ts) return "";
  const d = new Date(typeof ts === "number" ? ts : Number(ts));
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

interface NodeMetaProps {
  filename: string;
  data: Record<string, unknown>;
  className?: string;
}

export function NodeMeta({ filename, data, className }: NodeMetaProps) {
  const creator = (data.creator_name as string) ?? (data.author as string) ?? "";
  const createdAt = formatTimestamp(data.created_at);

  const meta = Object.entries(data).filter(
    ([k, v]) =>
      !HIDDEN_KEYS.has(k) && k !== "author" && v != null && v !== "" && typeof v !== "object",
  );

  return (
    <div className={`bg-black/70 px-2 py-1.5 rounded text-xs text-text ${className ?? ""}`}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-medium truncate">{filename}</span>
        {createdAt && <span className="text-[10px] text-text-dim shrink-0">{createdAt}</span>}
      </div>
      {creator && <div className="text-[10px] text-text-dim mt-0.5">Creator: {creator}</div>}
      {meta.length > 0 && (
        <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0 text-[10px] text-text-dim">
          {meta.map(([k, v]) => (
            <span key={k}>
              {k}: {String(v)}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
