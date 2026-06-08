import { MessageSquareText, Send } from "lucide-react";
import { useCallback, useEffect, useRef } from "react";
import { ensureChatWs, getChatWs, useChatState } from "../hooks/use-chat-state";
import { clearToken, setToken } from "../lib/api";
import { linkifyHtml } from "../lib/linkify";
import { sanitizeChatHtml } from "../lib/sanitize";
import { GlassPanel } from "./GlassPanel";

const ANSI_COLORS: Record<string, string> = {
  "30": "#4d4d4d",
  "31": "#f44",
  "32": "#4e4",
  "33": "#fd0",
  "34": "#69f",
  "35": "#f6f",
  "36": "#0ff",
  "37": "#d4d4d4",
  "90": "#888",
  "91": "#f66",
  "92": "#8f8",
  "93": "#ff5",
  "94": "#8af",
  "95": "#f8f",
  "96": "#5ff",
  "97": "#fff",
};

function escHtml(ch: string): string {
  if (ch === "&") return "&amp;";
  if (ch === "<") return "&lt;";
  if (ch === ">") return "&gt;";
  if (ch === '"') return "&quot;";
  return ch;
}

function ansiToHtml(text: string): string {
  let result = "";
  let i = 0;
  let openSpans = 0;
  while (i < text.length) {
    if (text[i] === "\x1b" && text[i + 1] === "[") {
      const end = text.indexOf("m", i + 2);
      if (end === -1) {
        result += escHtml(text[i]!);
        i++;
        continue;
      }
      const codes = text.substring(i + 2, end).split(";");
      i = end + 1;
      const styles: string[] = [];
      for (const code of codes) {
        if (code === "0" || code === "") {
          while (openSpans > 0) {
            result += "</span>";
            openSpans--;
          }
        } else if (code === "1") {
          styles.push("font-weight:bold");
        } else if (code === "3") {
          styles.push("font-style:italic");
        } else if (code === "4") {
          styles.push("text-decoration:underline");
        } else if (ANSI_COLORS[code]) {
          styles.push(`color:${ANSI_COLORS[code]}`);
        }
      }
      if (styles.length > 0) {
        result += `<span style="${styles.join(";")}">`;
        openSpans++;
      }
    } else {
      result += escHtml(text[i]!);
      i++;
    }
  }
  while (openSpans > 0) {
    result += "</span>";
    openSpans--;
  }
  return result;
}

function appendMsg(text: string, kind: string, tag?: string) {
  useChatState.getState().appendMessage({ html: ansiToHtml(text), kind, tag });
}

interface Perception {
  kind?: string;
  tag?: string;
  data?: {
    token?: string;
    entityId?: string;
    name?: string;
    short?: string;
    long?: string;
    items?: Record<string, unknown>;
    entities?: { name: string }[];
    exits?: string[];
    text?: string;
    entity?: string;
    direction?: string;
    exit?: string;
  };
}

function handlePerception(raw: unknown) {
  const p = raw as Perception;
  if (p.kind === "auth_error") {
    clearToken();
    useChatState.getState().setLoggedIn(false);
    appendMsg(p.data?.text ?? "Authentication failed.", "system");
    return;
  }
  if (p.data?.token) {
    setToken(p.data.token);
  }

  if (p.data?.entityId) {
    useChatState.getState().setLoggedIn(true, p.data.name);
  }

  const kind = p.kind || "message";
  const tag = p.tag;
  if (kind === "room") {
    const d = p.data!;
    let text = "";
    if (d.short) text += `${d.short}\n`;
    if (d.long) text += `${d.long}\n`;
    if (d.items && Object.keys(d.items).length > 0) {
      text += `\nObjects: ${Object.keys(d.items).join(", ")}\n`;
    }
    if (d.entities && d.entities.length > 0) {
      text += `Present: ${d.entities.map((e) => e.name).join(", ")}\n`;
    }
    if (d.exits && d.exits.length > 0) {
      text += `Exits: ${d.exits.join(", ")}\n`;
    }
    appendMsg(text, "room", tag);
  } else if (kind === "movement") {
    const d = p.data!;
    const name = d.entity ?? "Someone";
    const action =
      d.direction === "arrive"
        ? `${name} arrives.`
        : `${name} leaves${d.exit ? ` ${d.exit}` : ""}.`;
    appendMsg(action, "movement", tag);
  } else {
    appendMsg(p.data?.text || JSON.stringify(p.data), kind, tag);
  }
}

// Initialize WebSocket once at module level (survives component unmount)
ensureChatWs(handlePerception);

export function WebChat() {
  const messages = useChatState((s) => s.messages);
  const loggedIn = useChatState((s) => s.loggedIn);
  const connected = useChatState((s) => s.connected);
  const commandHistory = useChatState((s) => s.commandHistory);
  const pushCommand = useChatState((s) => s.pushCommand);

  const outputRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const historyIdxRef = useRef(-1);
  const cmdValueRef = useRef("");

  // Ensure WebSocket is alive when component mounts (reconnect if closed)
  useEffect(() => {
    ensureChatWs(handlePerception);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: only the messages length should retrigger autoscroll
  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [messages]);

  const doLogin = useCallback(() => {
    const name = nameRef.current?.value.trim();
    if (!name) return;
    const ws = getChatWs();
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "login", name }));
    }
  }, []);

  const doSend = useCallback(() => {
    const cmd = cmdValueRef.current.trim();
    if (!cmd) return;
    const ws = getChatWs();
    if (ws?.readyState === WebSocket.OPEN) {
      pushCommand(cmd);
      historyIdxRef.current = -1;
      ws.send(JSON.stringify({ type: "command", command: cmd }));
      if (inputRef.current) {
        inputRef.current.value = "";
        cmdValueRef.current = "";
      }
    }
  }, [pushCommand]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        doSend();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        if (historyIdxRef.current < commandHistory.length - 1) {
          historyIdxRef.current++;
          const val = commandHistory[historyIdxRef.current]!;
          cmdValueRef.current = val;
          if (inputRef.current) inputRef.current.value = val;
        }
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        if (historyIdxRef.current > 0) {
          historyIdxRef.current--;
          const val = commandHistory[historyIdxRef.current]!;
          cmdValueRef.current = val;
          if (inputRef.current) inputRef.current.value = val;
        } else {
          historyIdxRef.current = -1;
          cmdValueRef.current = "";
          if (inputRef.current) inputRef.current.value = "";
        }
      }
    },
    [commandHistory, doSend],
  );

  const msgStyle = (kind: string, tag?: string) => {
    if (tag === "tell") return "border-l-2 border-fuchsia-500 pl-2 bg-fuchsia-950/20";
    if (tag === "shout") return "border-l-2 border-yellow-400 pl-2 bg-yellow-950/20";
    if (tag === "emote") return "border-l-2 border-cyan-400 pl-2 bg-cyan-950/10 italic";
    if (tag === "say") return "border-l-2 border-gray-500 pl-2";
    if (kind === "message" && tag && !["tell", "say", "shout", "emote"].includes(tag))
      return "border-l-2 border-emerald-500 pl-2 bg-emerald-950/10";

    switch (kind) {
      case "system":
        return "border-l-2 border-primary pl-2 text-primary/90 bg-primary/5";
      case "error":
        return "border-l-2 border-red-500 pl-2 text-red-400 bg-red-950/15";
      case "room":
        return "border-l-2 border-green-600 pl-2 text-green-300/90";
      case "movement":
        return "pl-2 text-gray-600 italic text-[11px]";
      case "broadcast":
        return "border-l-2 border-blue-500 pl-2 bg-blue-950/10";
      default:
        return "text-text";
    }
  };

  return (
    <GlassPanel title="Web Chat" icon={<MessageSquareText size={14} />}>
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Output */}
        <div
          ref={outputRef}
          className="flex-1 overflow-y-auto px-2 py-1 font-mono text-[12px] leading-relaxed"
        >
          {messages.map((m, i) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: chat messages are append-only; index is the message identity
              key={i}
              className={`whitespace-pre-wrap break-words rounded-sm my-0.5 py-0.5 ${msgStyle(m.kind, m.tag)}`}
              // biome-ignore lint/security/noDangerouslySetInnerHtml: defense-in-depth via sanitizeChatHtml — strips all but inline span/style + linkified anchors.
              dangerouslySetInnerHTML={{ __html: sanitizeChatHtml(linkifyHtml(m.html)) }}
            />
          ))}
        </div>

        {/* Input area */}
        <div className="border-t border-border px-2 py-1.5">
          {!loggedIn ? (
            <div className="flex items-center gap-2">
              <input
                ref={nameRef}
                type="text"
                onKeyDown={(e) => e.key === "Enter" && doLogin()}
                placeholder="Enter your name..."
                maxLength={20}
                className="flex-1 rounded border border-border bg-bg px-2 py-1 text-[12px] text-text outline-none focus:border-primary"
              />
              <button
                type="button"
                onClick={doLogin}
                className="rounded bg-primary px-2 py-1 text-[11px] font-bold text-bg"
              >
                Connect
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-1.5">
              <span
                className={`h-1.5 w-1.5 rounded-full ${connected ? "bg-success" : "bg-danger"}`}
              />
              <input
                ref={inputRef}
                type="text"
                onChange={(e) => {
                  cmdValueRef.current = e.target.value;
                }}
                onKeyDown={handleKeyDown}
                placeholder="Type a command..."
                className="flex-1 rounded border border-border bg-bg px-2 py-1 text-[12px] text-text outline-none focus:border-primary"
              />
              <button
                type="button"
                onClick={doSend}
                className="text-primary transition-colors hover:text-text-bright"
              >
                <Send size={14} />
              </button>
            </div>
          )}
        </div>
      </div>
    </GlassPanel>
  );
}
