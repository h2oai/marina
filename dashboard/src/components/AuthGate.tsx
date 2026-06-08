/**
 * Optional sign-in gate. When the server reports auth is required
 * (GET /api/auth-status), and the user isn't logged in, this overlays a
 * sign-in screen over the app. On success it exchanges the verified identity
 * for a Marina session token (POST /api/auth-session) bound to a chosen
 * *handle* (the in-world named entity), stores it, and lets the existing
 * WebSocket auth flow take over.
 *
 * When auth is off (the default), this renders its children unchanged — the
 * standalone/local dashboard behaves exactly as before.
 */

import { type ReactNode, useCallback, useEffect, useState } from "react";
import { ensureChatWs, getChatWs, useChatState } from "../hooks/use-chat-state";
import { setToken } from "../lib/api";

interface AuthStatus {
  required: boolean;
  methods: string[];
  socialProviders: string[];
}

type Mode = "signin" | "signup";

async function postJson(path: string, body: unknown): Promise<Response> {
  return fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body),
  });
}

export function AuthGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [graceElapsed, setGraceElapsed] = useState(false);
  const loggedIn = useChatState((s) => s.loggedIn);

  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [handle, setHandle] = useState("");
  const [needHandle, setNeedHandle] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Discover whether auth is required.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth-status")
      .then((r) => r.json())
      .then((s: AuthStatus) => {
        if (!cancelled) setStatus(s);
      })
      .catch(() => {
        if (!cancelled) setStatus({ required: false, methods: [], socialProviders: [] });
      });
    // Grace window so returning users with a valid token connect before the
    // overlay flashes (loggedIn flips true once the WS reconnect succeeds).
    const t = setTimeout(() => setGraceElapsed(true), 1200);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, []);

  const completeSession = useCallback(async () => {
    // Exchange the now-active better-auth session for a Marina token bound to
    // a named handle, then hand off to the WebSocket auth flow.
    const res = await postJson("/api/auth-session", handle.trim() ? { handle: handle.trim() } : {});
    if (res.status === 400) {
      setNeedHandle(true);
      setError("Choose a handle for your artilect (2–20 letters/numbers).");
      return;
    }
    if (res.status === 409) {
      setNeedHandle(true);
      setError("That handle is already claimed — pick another.");
      return;
    }
    if (!res.ok) {
      setError("Could not establish a session. Try again.");
      return;
    }
    const data = (await res.json()) as { token: string };
    setToken(data.token);
    // Connect (or reuse) the chat WS and authenticate with the token.
    ensureChatWs(() => {});
    getChatWs()?.send(JSON.stringify({ type: "auth", token: data.token }));
  }, [handle]);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!email.trim() || !password) {
        setError("Email and password are required.");
        return;
      }
      setBusy(true);
      setError(null);
      try {
        const path = mode === "signup" ? "/api/auth/sign-up/email" : "/api/auth/sign-in/email";
        const body =
          mode === "signup"
            ? { email: email.trim(), password, name: email.trim() }
            : { email: email.trim(), password };
        const res = await postJson(path, body);
        if (!res.ok) {
          const msg = await res.json().catch(() => null);
          setError(
            (msg as { message?: string } | null)?.message ??
              (mode === "signup" ? "Sign-up failed." : "Invalid email or password."),
          );
          return;
        }
        await completeSession();
      } catch {
        setError("Network error. Try again.");
      } finally {
        setBusy(false);
      }
    },
    [email, password, mode, completeSession],
  );

  const socialSignIn = useCallback((provider: string) => {
    const callbackURL = window.location.href;
    window.location.href = `/api/auth/sign-in/social/${provider}?callbackURL=${encodeURIComponent(callbackURL)}`;
  }, []);

  // Off, still discovering, already logged in, or within the grace window:
  // render the app untouched.
  if (!status?.required || loggedIn || !graceElapsed) {
    return <>{children}</>;
  }

  return (
    <>
      {children}
      <div
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 9999,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "rgba(8,8,12,0.92)",
          backdropFilter: "blur(3px)",
          fontFamily: "'VT323', monospace",
        }}
      >
        <form
          onSubmit={handleSubmit}
          style={{
            width: "min(92vw, 360px)",
            display: "flex",
            flexDirection: "column",
            gap: "10px",
            padding: "22px",
            border: "1px solid var(--color-border, #333)",
            background: "rgba(17,17,24,0.95)",
            borderRadius: "4px",
          }}
        >
          <div
            style={{
              fontFamily: "'Press Start 2P', monospace",
              fontSize: "11px",
              textTransform: "uppercase",
              letterSpacing: "1px",
              color: "var(--color-primary, #6cf)",
              marginBottom: "4px",
            }}
          >
            {mode === "signup" ? "Create account" : "Sign in"}
          </div>

          <input
            type="email"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            style={inputStyle}
          />
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === "signup" ? "new-password" : "current-password"}
            style={inputStyle}
          />
          {needHandle && (
            <input
              type="text"
              placeholder="Handle (your artilect name)"
              value={handle}
              onChange={(e) => setHandle(e.target.value)}
              style={inputStyle}
            />
          )}

          {error && (
            <div style={{ color: "var(--color-danger, #c33)", fontSize: "15px" }}>{error}</div>
          )}

          <button type="submit" disabled={busy} style={{ ...btnStyle, opacity: busy ? 0.6 : 1 }}>
            {busy ? "…" : mode === "signup" ? "Create account" : "Sign in"}
          </button>

          <button
            type="button"
            onClick={() => {
              setMode((m) => (m === "signup" ? "signin" : "signup"));
              setError(null);
            }}
            style={{ ...btnStyle, border: "none", color: "#888" }}
          >
            {mode === "signup" ? "Have an account? Sign in" : "New here? Create an account"}
          </button>

          {status.socialProviders.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: "6px", marginTop: "4px" }}>
              {status.socialProviders.map((p) => (
                <button key={p} type="button" onClick={() => socialSignIn(p)} style={btnStyle}>
                  Continue with {p}
                </button>
              ))}
            </div>
          )}
        </form>
      </div>
    </>
  );
}

const inputStyle: React.CSSProperties = {
  background: "rgba(8,8,12,0.6)",
  border: "1px solid var(--color-border, #333)",
  color: "#ddd",
  fontFamily: "'VT323', monospace",
  fontSize: "18px",
  padding: "6px 10px",
  outline: "none",
  width: "100%",
};

const btnStyle: React.CSSProperties = {
  background: "none",
  border: "1px solid var(--color-primary, #6cf)",
  color: "var(--color-primary, #6cf)",
  fontFamily: "'VT323', monospace",
  fontSize: "18px",
  padding: "6px 10px",
  cursor: "pointer",
};
