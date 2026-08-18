// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Optional sign-in gate. When the server reports auth is required
 * (GET /api/auth-status) and the user isn't logged in, this overlays a sign-in
 * screen. On success it exchanges the verified better-auth session for a Marina
 * session token (POST /api/auth-session) bound to a chosen *handle* (the
 * in-world named entity), stores it, and lets the existing WebSocket auth flow
 * take over.
 *
 * Handles three entry paths:
 *  - email/password sign-in or sign-up (then exchange),
 *  - social OAuth (POST /api/auth/sign-in/social → redirect → return with a
 *    cookie → silent exchange on load),
 *  - returning users with a Marina token (WS reconnects; no overlay).
 *
 * When auth is off (the default), it renders its children unchanged.
 */

import { type ReactNode, useCallback, useEffect, useState } from "react";
import { ensureChatWs, getChatWs, useChatState } from "../hooks/use-chat-state";
import { getToken, setToken } from "../lib/api";

interface AuthStatus {
  required: boolean;
  methods: string[];
  socialProviders: string[];
}

type Mode = "signin" | "signup";
// init: still deciding (no overlay — avoids a flash); form: show credentials +
// social; claimHandle: identity verified (cookie) but needs an in-world handle.
type Phase = "init" | "form" | "claimHandle";

async function postJson(path: string, body: unknown): Promise<Response> {
  return fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body),
  });
}

/** Store the minted Marina token and hand off to the WebSocket auth flow. */
function activateToken(token: string): void {
  setToken(token);
  ensureChatWs(() => {});
  getChatWs()?.send(JSON.stringify({ type: "auth", token }));
}

export function AuthGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [phase, setPhase] = useState<Phase>("init");
  const loggedIn = useChatState((s) => s.loggedIn);

  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [handle, setHandle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Exchange the active better-auth session (cookie) for a Marina token.
  // Returns "ok" | "needHandle" | "noSession".
  const exchange = useCallback(async (chosenHandle?: string) => {
    const res = await postJson("/api/auth-session", chosenHandle ? { handle: chosenHandle } : {});
    if (res.ok) {
      const data = (await res.json()) as { token: string };
      activateToken(data.token);
      return "ok" as const;
    }
    if (res.status === 400) return "needHandle" as const;
    if (res.status === 409) return "handleTaken" as const;
    return "noSession" as const;
  }, []);

  // Discover auth status, then decide the entry path.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let s: AuthStatus;
      try {
        s = (await (await fetch("/api/auth-status")).json()) as AuthStatus;
      } catch {
        s = { required: false, methods: [], socialProviders: [] };
      }
      if (cancelled) return;
      setStatus(s);
      if (!s.required) return;

      // Returning Marina-token user: let the WS authenticate; only fall back to
      // the form if that doesn't land shortly.
      if (getToken()) {
        setTimeout(() => {
          if (!cancelled) setPhase((p) => (p === "init" ? "form" : p));
        }, 1500);
        return;
      }

      // No Marina token: maybe a better-auth cookie is present (e.g. just
      // returned from an OAuth redirect) — try a silent exchange.
      const result = await exchange();
      if (cancelled) return;
      if (result === "needHandle") setPhase("claimHandle");
      else if (result !== "ok") setPhase("form");
      // "ok" → loggedIn flips via the WS; stay in "init" (no overlay).
    })();
    // Safety net: never get stuck invisibly waiting.
    const fallback = setTimeout(() => {
      if (!cancelled) setPhase((p) => (p === "init" ? "form" : p));
    }, 4000);
    return () => {
      cancelled = true;
      clearTimeout(fallback);
    };
  }, [exchange]);

  const completeAfterAuth = useCallback(async () => {
    const result = await exchange(handle.trim() || undefined);
    if (result === "needHandle") {
      setPhase("claimHandle");
      setError("Choose a handle for your artilect (2–20 letters/numbers).");
    } else if (result === "handleTaken") {
      setPhase("claimHandle");
      setError("That handle is already claimed — pick another.");
    } else if (result === "noSession") {
      setError("Could not establish a session. Try again.");
    }
    // "ok" → loggedIn flips; overlay disappears.
  }, [exchange, handle]);

  const handleCredentials = useCallback(
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
          const msg = (await res.json().catch(() => null)) as { message?: string } | null;
          setError(
            msg?.message ?? (mode === "signup" ? "Sign-up failed." : "Invalid credentials."),
          );
          return;
        }
        await completeAfterAuth();
      } catch {
        setError("Network error. Try again.");
      } finally {
        setBusy(false);
      }
    },
    [email, password, mode, completeAfterAuth],
  );

  const handleClaim = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (handle.trim().length < 2) {
        setError("Handle must be 2–20 letters/numbers.");
        return;
      }
      setBusy(true);
      setError(null);
      try {
        await completeAfterAuth();
      } finally {
        setBusy(false);
      }
    },
    [handle, completeAfterAuth],
  );

  const socialSignIn = useCallback(async (provider: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await postJson("/api/auth/sign-in/social", {
        provider,
        callbackURL: window.location.href,
      });
      const data = (await res.json().catch(() => null)) as { url?: string } | null;
      if (data?.url) {
        window.location.href = data.url;
      } else {
        setError(`Could not start ${provider} sign-in.`);
        setBusy(false);
      }
    } catch {
      setError("Network error. Try again.");
      setBusy(false);
    }
  }, []);

  // Off, still deciding, or already authenticated: render the app untouched.
  if (!status?.required || loggedIn || phase === "init") {
    return <>{children}</>;
  }

  return (
    <>
      {children}
      <div style={overlayStyle}>
        {phase === "claimHandle" ? (
          <form onSubmit={handleClaim} style={cardStyle}>
            <div style={titleStyle}>Claim your handle</div>
            <div style={{ color: "#aaa", fontSize: "15px" }}>
              You're signed in. Choose the name your artilect will be known by.
            </div>
            <input
              type="text"
              placeholder="Handle (e.g. creator)"
              value={handle}
              onChange={(e) => setHandle(e.target.value)}
              style={inputStyle}
            />
            {error && <div style={errorStyle}>{error}</div>}
            <button type="submit" disabled={busy} style={{ ...btnStyle, opacity: busy ? 0.6 : 1 }}>
              {busy ? "…" : "Enter"}
            </button>
          </form>
        ) : (
          <form onSubmit={handleCredentials} style={cardStyle}>
            <div style={titleStyle}>{mode === "signup" ? "Create account" : "Sign in"}</div>
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
            {error && <div style={errorStyle}>{error}</div>}
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
              <div
                style={{ display: "flex", flexDirection: "column", gap: "6px", marginTop: "4px" }}
              >
                {status.socialProviders.map((p) => (
                  <button
                    key={p}
                    type="button"
                    disabled={busy}
                    onClick={() => socialSignIn(p)}
                    style={btnStyle}
                  >
                    Continue with {p[0]!.toUpperCase()}
                    {p.slice(1)}
                  </button>
                ))}
              </div>
            )}
          </form>
        )}
      </div>
    </>
  );
}

const overlayStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 9999,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "rgba(8,8,12,0.92)",
  backdropFilter: "blur(3px)",
  fontFamily: "'VT323', monospace",
};

const cardStyle: React.CSSProperties = {
  width: "min(92vw, 360px)",
  display: "flex",
  flexDirection: "column",
  gap: "10px",
  padding: "22px",
  border: "1px solid var(--color-border, #333)",
  background: "rgba(17,17,24,0.95)",
  borderRadius: "4px",
};

const titleStyle: React.CSSProperties = {
  fontFamily: "'Press Start 2P', monospace",
  fontSize: "11px",
  textTransform: "uppercase",
  letterSpacing: "1px",
  color: "var(--color-primary, #6cf)",
  marginBottom: "4px",
};

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

const errorStyle: React.CSSProperties = { color: "var(--color-danger, #c33)", fontSize: "15px" };
