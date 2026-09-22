// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { AlertTriangle, RefreshCw, RotateCcw } from "lucide-react";
import { Component, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryProps {
  children: ReactNode;
  /** Heading shown above the error message. Defaults to "Something went wrong". */
  fallbackTitle?: string;
  /** Called after the boundary clears its error state on "Try again". */
  onReset?: () => void;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Catches render/lifecycle errors from its subtree and shows a compact card
 * instead of blanking the whole dashboard. One panel throwing must never take
 * the rest of the page with it, so every lazy route and the main App surface
 * are wrapped in one of these from `main.tsx`.
 *
 * Class component by necessity: React only exposes `getDerivedStateFromError`
 * / `componentDidCatch` on classes.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Keep the stack in the console for debugging; the card only shows the message.
    console.error("[ErrorBoundary]", error, info.componentStack);
  }

  private reset = () => {
    this.setState({ error: null });
    this.props.onReset?.();
  };

  private reload = () => {
    window.location.reload();
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    const title = this.props.fallbackTitle ?? "Something went wrong";
    return (
      <div
        role="alert"
        className="glass-panel m-2 flex max-w-[520px] flex-col gap-2 rounded-md border border-border bg-bg/90 px-4 py-3 text-[12px] text-text"
      >
        <div className="flex items-center gap-1.5 font-display text-[11px] font-semibold uppercase tracking-wider text-primary">
          <AlertTriangle size={13} className="text-red-400" />
          <span>{title}</span>
        </div>
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-bg px-2 py-1 text-[11px] text-red-300">
          {error.message || String(error)}
        </pre>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={this.reset}
            className="flex items-center gap-1 rounded border border-border bg-bg px-2 py-0.5 text-text transition-colors hover:text-primary"
          >
            <RotateCcw size={11} />
            Try again
          </button>
          <button
            type="button"
            onClick={this.reload}
            className="flex items-center gap-1 rounded border border-border bg-bg px-2 py-0.5 text-text-dim transition-colors hover:text-primary"
          >
            <RefreshCw size={11} />
            Reload
          </button>
        </div>
      </div>
    );
  }
}
