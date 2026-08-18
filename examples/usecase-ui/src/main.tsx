// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import {
  LoaderCircle,
  Search as SearchIcon,
  Send,
  Telescope,
  Terminal,
  TrendingUp,
} from "lucide-react";
import React, { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

type Mode = "search" | "research" | "predict";

interface ApiResponse {
  entityId?: string;
  name?: string;
  token?: string;
  command?: string;
  text?: string;
  perceptions?: unknown[];
  error?: string;
}

interface ModeConfig {
  id: Mode;
  label: string;
  eyebrow: string;
  title: string;
  placeholder: string;
  button: string;
  icon: React.ComponentType<{ size?: number; strokeWidth?: number }>;
  commandPreview: (input: string) => string;
  run: (input: string, session: SessionPayload) => Promise<ApiResponse>;
}

interface SessionPayload {
  token?: string;
  name?: string;
}

const TOKEN_KEY = "marina.usecase.token";
const NAME_KEY = "marina.usecase.name";

function getName(): string {
  const stored = localStorage.getItem(NAME_KEY);
  if (stored) return stored;
  const name = `Usecase_${Math.random().toString(36).slice(2, 10)}`;
  localStorage.setItem(NAME_KEY, name);
  return name;
}

function sessionPayload(): SessionPayload {
  const token = localStorage.getItem(TOKEN_KEY) ?? undefined;
  return token ? { token } : { name: getName() };
}

async function postJson(path: string, body: Record<string, unknown>): Promise<ApiResponse> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (typeof body.token === "string") headers.Authorization = `Bearer ${body.token}`;

  const resp = await fetch(path, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const data = (await resp.json().catch(() => ({}))) as ApiResponse;
  if (!resp.ok) {
    if (resp.status === 401) localStorage.removeItem(TOKEN_KEY);
    throw new Error(data.error || `Request failed (${resp.status})`);
  }
  if (data.token) localStorage.setItem(TOKEN_KEY, data.token);
  return data;
}

async function commandRequest(command: string, session: SessionPayload): Promise<ApiResponse> {
  return postJson("/api/command", { ...session, command, render: "text" });
}

async function askRequest(query: string, session: SessionPayload): Promise<ApiResponse> {
  return postJson("/api/ask", { ...session, query, render: "text" });
}

const modes: ModeConfig[] = [
  {
    id: "search",
    label: "Search",
    eyebrow: "Fast context",
    title: "Search the living world",
    placeholder: "Ask a direct question...",
    button: "Search",
    icon: SearchIcon,
    commandPreview: (input) => `ask ${input}`,
    run: askRequest,
  },
  {
    id: "research",
    label: "Deep Research",
    eyebrow: "Autonomous workflow",
    title: "Launch a research run",
    placeholder: "Topic, question, or research objective...",
    button: "Research",
    icon: Telescope,
    commandPreview: (input) => `usecase research ${input}`,
    run: (input, session) => commandRequest(`usecase research ${input}`, session),
  },
  {
    id: "predict",
    label: "Predict",
    eyebrow: "Forecasting",
    title: "Streamline a prediction",
    placeholder: "Will this happen? Include timeframe if it matters...",
    button: "Predict",
    icon: TrendingUp,
    commandPreview: (input) => `usecase predict ${input}`,
    run: (input, session) => commandRequest(`usecase predict ${input}`, session),
  },
];

function App() {
  const [mode, setMode] = useState<Mode>("search");
  const [input, setInput] = useState("");
  const [response, setResponse] = useState<ApiResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const config = useMemo(() => modes.find((m) => m.id === mode) ?? modes[0]!, [mode]);
  const preview = input.trim() ? config.commandPreview(input.trim()) : config.commandPreview("...");
  const ActiveIcon = config.icon;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const value = input.trim();
    if (!value || loading) return;

    setLoading(true);
    setError(null);
    setResponse({ command: config.commandPreview(value), text: "Working..." });

    try {
      let session = sessionPayload();
      let result: ApiResponse;
      try {
        result = await config.run(value, session);
      } catch (err) {
        if (err instanceof Error && err.message.includes("Invalid or expired session")) {
          localStorage.removeItem(TOKEN_KEY);
          session = sessionPayload();
          result = await config.run(value, session);
        } else {
          throw err;
        }
      }
      setResponse(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setResponse(null);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="shell">
      <section className="intro">
        <div>
          <p className="kicker">Marina</p>
          <h1>Command surfaces.</h1>
        </div>
        <div className="status-strip" aria-label="Session status">
          <span className="live-dot" />
          <span>world online</span>
          <span>{localStorage.getItem(NAME_KEY) ?? "new session"}</span>
        </div>
      </section>

      <nav className="tabs" aria-label="Use cases">
        {modes.map((item) => (
          <button
            type="button"
            key={item.id}
            className={item.id === mode ? "tab active" : "tab"}
            onClick={() => {
              setMode(item.id);
              setResponse(null);
              setError(null);
            }}
          >
            <item.icon size={18} strokeWidth={1.8} />
            <span>{item.label}</span>
            <small>{item.eyebrow}</small>
          </button>
        ))}
      </nav>

      <section className="workbench">
        <form onSubmit={submit} className="prompt">
          <div className="prompt-head">
            <div>
              <p className="kicker">{config.eyebrow}</p>
              <h2>
                <ActiveIcon size={21} strokeWidth={1.7} />
                {config.title}
              </h2>
            </div>
            <code>{preview}</code>
          </div>
          <textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder={config.placeholder}
            aria-label={config.title}
          />
          <div className="actions">
            <button type="submit" disabled={loading || !input.trim()}>
              {loading ? <LoaderCircle className="spin" size={16} /> : <Send size={16} />}
              {loading ? "Running" : config.button}
            </button>
          </div>
        </form>

        <ResultPanel response={response} error={error} />
      </section>
    </main>
  );
}

function ResultPanel({ response, error }: { response: ApiResponse | null; error: string | null }) {
  if (error) {
    return (
      <section className="result">
        <p className="kicker">Error</p>
        <div className="error">{error}</div>
      </section>
    );
  }

  if (!response) {
    return (
      <section className="result empty">
        <p className="kicker">Result</p>
        <div className="empty-console">
          <Terminal size={22} strokeWidth={1.5} />
          <span>Awaiting command.</span>
        </div>
      </section>
    );
  }

  return (
    <section className="result">
      <div className="result-head">
        <div>
          <p className="kicker">Result</p>
          <h2>{response.command ?? "command"}</h2>
        </div>
        <span>{response.name ?? ""}</span>
      </div>
      <pre className="answer">{response.text || "(no text returned)"}</pre>
      <details>
        <summary>Perception trace</summary>
        <pre className="trace">{JSON.stringify(response.perceptions ?? [], null, 2)}</pre>
      </details>
    </section>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
