import { memo } from "react";
import { sanitizeChatHtml } from "../../lib/sanitize";
import type { CommandMessage, PerceptionTag } from "./CommandBar";

/** Map perception tags to CSS class suffixes for message styling. */
function tagStyleClass(tag?: PerceptionTag): string {
  switch (tag) {
    case "tell":
      return " uc-msg-tell";
    case "shout":
      return " uc-msg-shout";
    case "emote":
      return " uc-msg-emote";
    case "broadcast":
      return " uc-msg-broadcast";
    case "movement":
      return " uc-msg-movement";
    default:
      return "";
  }
}

const TAG_BADGE_COLORS: Record<string, string> = {
  tell: "#d946ef",
  emote: "#22d3ee",
  shout: "#facc15",
  say: "var(--color-primary)",
  broadcast: "#3b82f6",
  system: "#6b7280",
};

const TAG_BADGE_LABELS: Record<string, string> = {
  tell: "TELL",
  emote: "EMOTE",
  shout: "SHOUT",
  say: "SAY",
  broadcast: "BCAST",
};

const BADGE_STYLE_BASE = {
  fontSize: "clamp(8px, 0.56vw, 11px)",
  padding: "0px 4px",
  letterSpacing: "0.5px",
  fontFamily: "'Press Start 2P', monospace",
  marginRight: "4px",
  verticalAlign: "middle" as const,
  whiteSpace: "nowrap" as const,
  flexShrink: 0,
};

/** Small colored badge indicating message type. */
export const TagBadge = memo(function TagBadge({ tag }: { tag: PerceptionTag | undefined }) {
  if (!tag || tag === "movement") return null;
  const color = TAG_BADGE_COLORS[tag] ?? "#555";
  const label = TAG_BADGE_LABELS[tag] ?? tag.toUpperCase();
  return (
    <span
      className="uc-tag-badge"
      style={{ ...BADGE_STYLE_BASE, border: `1px solid ${color}`, color }}
    >
      {label}
    </span>
  );
});

/** System message badge. */
export const SysBadge = memo(function SysBadge() {
  return (
    <span
      className="uc-tag-badge"
      style={{ ...BADGE_STYLE_BASE, border: "1px solid #6b7280", color: "#6b7280" }}
    >
      SYS
    </span>
  );
});

export const MessageRow = memo(function MessageRow({
  msg,
  onEntityClick,
}: {
  msg: CommandMessage;
  onEntityClick?: (name: string) => void;
}) {
  if (msg.tell) {
    return (
      <div className="uc-cmd-message uc-cmd-message-tell">
        <TagBadge tag="tell" />
        <button
          type="button"
          className="uc-tell-from"
          style={{ background: "none", border: "none", cursor: "pointer", fontFamily: "inherit" }}
          onClick={() => onEntityClick?.(msg.tell!.from)}
        >
          {msg.tell.from}
        </button>
        <span className="uc-tell-arrow">&rarr;</span>
        <button
          type="button"
          className="uc-tell-to"
          style={{ background: "none", border: "none", cursor: "pointer", fontFamily: "inherit" }}
          onClick={() => onEntityClick?.(msg.tell!.to)}
        >
          {msg.tell.to}
        </button>
        <span className="uc-cm-text" style={{ display: "block", marginTop: "2px" }}>
          {msg.text}
        </span>
      </div>
    );
  }

  if (msg.type === "cmd") {
    return (
      <div className="uc-cmd-message">
        <span className="uc-cm-cmd">
          <span>&gt;</span> {msg.text}
        </span>
      </div>
    );
  }

  if (msg.tag === "movement") {
    return (
      <div className="uc-cmd-message uc-msg-movement">
        <span className="uc-cm-text">{msg.text}</span>
      </div>
    );
  }

  if (msg.isSys) {
    return (
      <div className="uc-cmd-message">
        <SysBadge />
        {msg.html ? (
          <span
            className="uc-cm-sys"
            // biome-ignore lint/security/noDangerouslySetInnerHtml: defense-in-depth via sanitizeChatHtml — strips anything but inline span/style.
            dangerouslySetInnerHTML={{ __html: sanitizeChatHtml(msg.html) }}
          />
        ) : (
          <span className="uc-cm-sys">{msg.text}</span>
        )}
      </div>
    );
  }

  const tagClass = tagStyleClass(msg.tag);

  return (
    <div className={`uc-cmd-message${tagClass}`}>
      <TagBadge tag={msg.tag} />
      {msg.name && (
        <button
          type="button"
          className="uc-cm-name"
          style={{ background: "none", border: "none", fontFamily: "inherit" }}
          onClick={() => msg.name && onEntityClick?.(msg.name)}
        >
          {msg.name}
        </button>
      )}{" "}
      {msg.html ? (
        <span
          className="uc-cm-text"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: defense-in-depth via sanitizeChatHtml — strips anything but inline span/style.
          dangerouslySetInnerHTML={{ __html: sanitizeChatHtml(msg.html) }}
        />
      ) : (
        <span className="uc-cm-text">{msg.text}</span>
      )}
    </div>
  );
});
