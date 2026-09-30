// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/** Admin panel tab, split out of AdminPanel.tsx without behaviour change. */

import { Radio } from "lucide-react";
import { useState } from "react";
import { useFederationPeers, useWorldVariants } from "../hooks/use-api";
import { describeApiError, postApi } from "../lib/api";

export function CollectiveTab() {
  const query = useWorldVariants();
  const peers = useFederationPeers();
  const [name, setName] = useState("");
  const [worldTemplate, setWorldTemplate] = useState("default");
  const [hypothesis, setHypothesis] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [manifest, setManifest] = useState("");
  const [promotionDrafts, setPromotionDrafts] = useState<
    Record<string, { rationale: string; evidence: string }>
  >({});
  const act = async (id: string, action: "start" | "stop" | "promote") => {
    setBusy(id);
    setError(null);
    try {
      const draft = promotionDrafts[id];
      await postApi(
        `/api/collective/variants/${encodeURIComponent(id)}/${action}`,
        action === "promote"
          ? {
              rationale: draft?.rationale ?? "",
              evidenceRefs: (draft?.evidence ?? "")
                .split(/[\n,]/)
                .map((ref) => ref.trim())
                .filter(Boolean),
            }
          : undefined,
      );
      await query.refetch();
    } catch (cause) {
      setError(describeApiError(cause));
    } finally {
      setBusy(null);
    }
  };
  const create = async () => {
    setBusy("create");
    setError(null);
    try {
      await postApi("/api/collective/variants", { name, worldTemplate, hypothesis });
      setName("");
      setHypothesis("");
      await query.refetch();
    } catch (cause) {
      setError(describeApiError(cause));
    } finally {
      setBusy(null);
    }
  };
  const registerPeer = async () => {
    setBusy("peer");
    setError(null);
    try {
      const parsed = JSON.parse(manifest) as unknown;
      await postApi("/api/federation/peers", parsed);
      setManifest("");
      await peers.refetch();
    } catch (cause) {
      setError(describeApiError(cause));
    } finally {
      setBusy(null);
    }
  };
  const trustPeer = async (worldId: string, trust: "unverified" | "trusted" | "blocked") => {
    setBusy(worldId);
    setError(null);
    try {
      await postApi(`/api/federation/peers/${encodeURIComponent(worldId)}/trust`, { trust });
      await peers.refetch();
    } catch (cause) {
      setError(describeApiError(cause));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-2 text-[10px]">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1 uppercase tracking-wider text-primary">
          <Radio size={10} /> World Collective
        </span>
        <button
          type="button"
          onClick={() => query.refetch()}
          className="text-primary hover:underline"
        >
          Refresh
        </button>
      </div>
      <p className="rounded border border-border bg-bg/40 p-2 text-text-dim">
        Launch isolated child Marinas from this source tree for reproducible A/B work. Each variant
        has its own database, assets, ports, and explicit hypothesis. Promotion records a preferred
        candidate; it does not silently replace or restart this world.
      </p>
      {query.data && !query.data.sourceAvailable && (
        <div className="rounded border border-warning/40 p-2 text-warning">
          Source launch is unavailable in this packaged runtime. Variant records remain readable.
        </div>
      )}
      <div className="grid gap-1 rounded border border-border p-2 sm:grid-cols-2">
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="variant-name"
          aria-label="Variant name"
          className="rounded border border-border bg-bg px-2 py-1 text-text"
        />
        <input
          value={worldTemplate}
          onChange={(event) => setWorldTemplate(event.target.value)}
          placeholder="default"
          aria-label="World template"
          className="rounded border border-border bg-bg px-2 py-1 text-text"
        />
        <input
          value={hypothesis}
          onChange={(event) => setHypothesis(event.target.value)}
          placeholder="What should improve, and how will we know?"
          aria-label="Variant hypothesis"
          className="rounded border border-border bg-bg px-2 py-1 text-text sm:col-span-2"
        />
        <button
          type="button"
          disabled={!name.trim() || !worldTemplate.trim() || busy === "create"}
          onClick={create}
          className="rounded border border-primary/40 px-2 py-1 text-primary disabled:opacity-40 sm:col-span-2"
        >
          Create isolated variant
        </button>
      </div>
      {error && (
        <div role="alert" className="text-danger">
          {error}
        </div>
      )}
      {(query.data?.variants ?? []).map((variant) => (
        <article key={variant.id} className="rounded border border-border bg-bg/50 p-2">
          <div className="flex items-start justify-between gap-2">
            <div>
              <strong className="text-text-bright">{variant.name}</strong>
              <div className="text-text-dim">
                {variant.world_template} · port {variant.ws_port} · by {variant.created_by}
              </div>
              {variant.hypothesis && <p className="mt-1 text-text">{variant.hypothesis}</p>}
              {variant.last_error && <p className="mt-1 text-danger">{variant.last_error}</p>}
            </div>
            <span className={variant.status === "failed" ? "text-danger" : "text-primary"}>
              {variant.status}
              {variant.promoted_at ? " · preferred" : ""}
            </span>
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            {["draft", "stopped", "failed"].includes(variant.status) && (
              <button
                type="button"
                disabled={busy === variant.id}
                onClick={() => act(variant.id, "start")}
                className="text-success hover:underline disabled:opacity-40"
              >
                Start
              </button>
            )}
            {["starting", "running"].includes(variant.status) && (
              <button
                type="button"
                disabled={busy === variant.id}
                onClick={() => act(variant.id, "stop")}
                className="text-warning hover:underline disabled:opacity-40"
              >
                Stop
              </button>
            )}
            {["running", "stopped"].includes(variant.status) && !variant.promoted_at && (
              <button
                type="button"
                disabled={
                  busy === variant.id ||
                  (promotionDrafts[variant.id]?.rationale.trim().length ?? 0) < 10 ||
                  !promotionDrafts[variant.id]?.evidence.trim()
                }
                onClick={() => act(variant.id, "promote")}
                className="text-primary hover:underline disabled:opacity-40"
                title="Add a rationale and at least one exact evidence reference"
              >
                Promote
              </button>
            )}
            {variant.status === "running" && (
              <a
                href={`http://${window.location.hostname}:${variant.ws_port}/dashboard`}
                target="_blank"
                rel="noreferrer noopener"
                className="text-primary hover:underline"
              >
                Open dashboard ↗
              </a>
            )}
          </div>
          {["running", "stopped"].includes(variant.status) && !variant.promoted_at && (
            <div className="mt-2 grid gap-1 border-t border-border pt-2">
              <input
                value={promotionDrafts[variant.id]?.rationale ?? ""}
                onChange={(event) =>
                  setPromotionDrafts((current) => ({
                    ...current,
                    [variant.id]: {
                      rationale: event.target.value,
                      evidence: current[variant.id]?.evidence ?? "",
                    },
                  }))
                }
                placeholder="Why this variant should become preferred"
                aria-label={`Promotion rationale for ${variant.name}`}
                className="rounded border border-border bg-bg px-2 py-1 text-text"
              />
              <input
                value={promotionDrafts[variant.id]?.evidence ?? ""}
                onChange={(event) =>
                  setPromotionDrafts((current) => ({
                    ...current,
                    [variant.id]: {
                      rationale: current[variant.id]?.rationale ?? "",
                      evidence: event.target.value,
                    },
                  }))
                }
                placeholder="Exact trace, artifact, or checkpoint refs (comma separated)"
                aria-label={`Promotion evidence for ${variant.name}`}
                className="rounded border border-border bg-bg px-2 py-1 text-text"
              />
            </div>
          )}
          {variant.promoted_at && variant.promotion_rationale && (
            <div className="mt-2 border-t border-border pt-2 text-text-dim">
              Preferred by {variant.promoted_by ?? "unknown"}: {variant.promotion_rationale}
            </div>
          )}
        </article>
      ))}
      <section className="space-y-2 border-t border-border pt-2">
        <div className="flex items-center justify-between">
          <strong className="uppercase tracking-wider text-primary">Federation peers</strong>
          <a
            href="/api/federation/manifest"
            target="_blank"
            rel="noreferrer noopener"
            className="text-primary hover:underline"
          >
            This world's manifest ↗
          </a>
        </div>
        <p className="text-text-dim">
          Paste another Marina's discovery manifest. Registration starts unverified and performs no
          network request or data import.
        </p>
        <textarea
          value={manifest}
          onChange={(event) => setManifest(event.target.value)}
          placeholder='{"schema":"marina.federation.manifest.v1",...}'
          aria-label="Peer federation manifest"
          className="h-16 w-full rounded border border-border bg-bg p-2 text-text"
        />
        <button
          type="button"
          disabled={!manifest.trim() || busy === "peer"}
          onClick={registerPeer}
          className="rounded border border-primary/40 px-2 py-1 text-primary disabled:opacity-40"
        >
          Register unverified peer
        </button>
        {(peers.data ?? []).map((peer) => (
          <article key={peer.world_id} className="rounded border border-border bg-bg/50 p-2">
            <div className="flex justify-between gap-2">
              <div>
                <a
                  href={peer.base_url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="text-text-bright hover:text-primary hover:underline"
                >
                  {peer.name} ↗
                </a>
                <div className="text-text-dim">{peer.world_id}</div>
              </div>
              <span
                className={
                  peer.trust_status === "trusted"
                    ? "text-success"
                    : peer.trust_status === "blocked"
                      ? "text-danger"
                      : "text-warning"
                }
              >
                {peer.trust_status}
              </span>
            </div>
            <div className="mt-2 flex gap-2">
              {(["unverified", "trusted", "blocked"] as const).map((trust) => (
                <button
                  key={trust}
                  type="button"
                  disabled={busy === peer.world_id || peer.trust_status === trust}
                  onClick={() => trustPeer(peer.world_id, trust)}
                  className="text-primary hover:underline disabled:opacity-30"
                >
                  {trust}
                </button>
              ))}
            </div>
          </article>
        ))}
      </section>
    </div>
  );
}
