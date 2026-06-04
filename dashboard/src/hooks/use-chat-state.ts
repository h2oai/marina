import { create } from "zustand";

export interface ChatMessage {
  html: string;
  kind: string;
  tag?: string;
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
      useChatState.getState().appendMessage({ html: e.data as string, kind: "message" });
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
