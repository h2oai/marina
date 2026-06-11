import { create } from "zustand";

export interface StoredPerception {
  kind: string;
  timestamp?: number;
  tag?: string;
  data?: Record<string, unknown>;
}

export interface ChatMessage {
  html: string;
  /** Plain-text form (ANSI stripped) for clipboard copy. Falls back to the
   * text extracted from `html` when absent. */
  text?: string;
  kind: string;
  tag?: string;
  timestamp?: number;
  perception?: StoredPerception;
}

const MAX_MESSAGES = 500;

interface ChatState {
  messages: ChatMessage[];
  loggedIn: boolean;
  connected: boolean;
  entityName: string | null;
  commandHistory: string[];

  appendMessage: (msg: ChatMessage) => void;
  setLoggedIn: (v: boolean, name?: string) => void;
  setConnected: (v: boolean) => void;
  pushCommand: (cmd: string) => void;
  sendCommand: (cmd: string, recordHistory?: boolean) => boolean;
}

export const useChatState = create<ChatState>((set) => ({
  messages: [],
  loggedIn: false,
  connected: false,
  entityName: null,
  commandHistory: [],

  appendMessage: (msg) =>
    set((s) => ({ messages: [...s.messages.slice(-(MAX_MESSAGES - 1)), msg] })),
  setLoggedIn: (v, name) => set({ loggedIn: v, entityName: name ?? null }),
  setConnected: (v) =>
    set((_s) => (v ? { connected: v } : { connected: v, loggedIn: false, entityName: null })),
  pushCommand: (cmd) => set((s) => ({ commandHistory: [cmd, ...s.commandHistory.slice(0, 99)] })),
  sendCommand: (cmd, recordHistory = true) => {
    const trimmed = cmd.trim();
    if (!trimmed) return false;
    const ws = getChatWs();
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify({ type: "command", command: trimmed }));
    if (recordHistory) {
      set((s) => ({
        commandHistory: [trimmed, ...s.commandHistory.filter((c) => c !== trimmed).slice(0, 99)],
      }));
    }
    return true;
  },
}));

// ─── Singleton WebSocket (survives component unmount) ───────────────────────
// Supports multiple perception listeners — every call to ensureChatWs adds the
// handler to the listener set, and all are called on each incoming message.

let ws: WebSocket | null = null;
let reconnecting = false;
const perceptionListeners = new Set<(data: unknown) => void>();

export function getChatWs(): WebSocket | null {
  return ws;
}

export function ensureChatWs(onPerception: (data: unknown) => void): WebSocket {
  // Always register the listener (even if WS already exists)
  perceptionListeners.add(onPerception);

  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return ws;
  }

  if (reconnecting) return ws!;
  reconnecting = true;

  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const sock = new WebSocket(`${proto}//${window.location.host}/ws`);

  sock.onopen = () => {
    reconnecting = false;
    useChatState.getState().setConnected(true);
    const token = localStorage.getItem("marina_chat_token");
    if (token) {
      sock.send(JSON.stringify({ type: "auth", token }));
    }
  };

  sock.onmessage = (e) => {
    try {
      const parsed = JSON.parse(e.data as string);
      for (const listener of perceptionListeners) {
        listener(parsed);
      }
    } catch {
      const raw = e.data as string;
      useChatState
        .getState()
        // biome-ignore lint/suspicious/noControlCharactersInRegex: strip ANSI SGR codes for clean clipboard text
        .appendMessage({ html: raw, text: raw.replace(/\x1b\[[0-9;]*m/g, ""), kind: "message" });
    }
  };

  sock.onclose = () => {
    reconnecting = false;
    useChatState.getState().setConnected(false);
    ws = null;
    // Auto-reconnect after 3 seconds
    if (perceptionListeners.size > 0) {
      setTimeout(() => {
        if (!ws && perceptionListeners.size > 0) {
          const dummyListener = [...perceptionListeners][0]!;
          ensureChatWs(dummyListener);
        }
      }, 3000);
    }
  };

  ws = sock;
  return sock;
}
