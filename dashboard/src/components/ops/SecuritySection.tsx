// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { OpsSecurity } from "../../lib/ops-types";
import { autonomyClass, formatDuration, trustProfileClass } from "./format";
import { Chip, OnOff } from "./primitives";

function Row({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div
      className="flex items-center justify-between gap-2 border-t border-border/60 py-1 first:border-t-0"
      title={hint}
    >
      <span className="text-text-dim">{label}</span>
      <span className="text-right">{value}</span>
    </div>
  );
}

export function SecuritySection({ security }: { security: OpsSecurity }) {
  return (
    <div className="grid gap-x-4 md:grid-cols-2">
      <div>
        <Row
          label="Trust profile"
          hint="MARINA_PROFILE — derived from the bind + auth situation"
          value={
            <Chip className={trustProfileClass(security.trustProfile)}>
              {security.trustProfile.toUpperCase()}
              {security.ungated && " · ungated"}
            </Chip>
          }
        />
        <Row
          label="Autonomy"
          hint="MARINA_AUTONOMY (env-only by design)"
          value={<Chip className={autonomyClass(security.autonomy)}>{security.autonomy}</Chip>}
        />
        <Row
          label="Bind"
          value={<OnOff on={security.loopbackBind} onLabel="loopback only" offLabel="public" />}
          hint="WS_HOST / MARINA_HOST / MARINA_PUBLIC"
        />
        <Row
          label="Sign-in required"
          value={<OnOff on={security.authRequired} />}
          hint="MARINA_AUTH gates passwordless name-login"
        />
      </div>
      <div>
        <Row
          label="MCP transport auth"
          value={
            <OnOff
              on={security.mcpAuthRequired}
              onLabel="bearer required"
              offLabel="open (local)"
            />
          }
          hint="On with MODEL_API_KEYS, MARINA_AUTH=better-auth or a non-loopback bind"
        />
        <Row
          label="MARINA_OPEN_API"
          value={
            <Chip
              className={
                security.openApi
                  ? "border-red-400/60 bg-red-400/10 text-red-300"
                  : "border-border text-text-dim"
              }
            >
              {security.openApi ? "ON — dev-only read bypass" : "off"}
            </Chip>
          }
        />
        <Row
          label="Trust proxy headers"
          value={<OnOff on={security.trustProxy} />}
          hint="MARINA_TRUST_PROXY — X-Forwarded-For feeds per-IP limiters"
        />
        <Row
          label="Command limiter"
          value={
            <OnOff
              on={!security.commandLimiterBypassed}
              onLabel="enforced"
              offLabel="bypassed (local)"
            />
          }
          hint="RateLimiter.bypass is set under the local profile"
        />
      </div>
      <div className="pt-1 md:col-span-2">
        <div className="text-[8px] uppercase text-text-dim">HTTP limiters</div>
        <div className="flex flex-wrap gap-1 pt-0.5">
          {security.limiters.map((l) => (
            <Chip key={l.name} className="border-border text-text" title={`keyed per ${l.keyedBy}`}>
              {l.name}{" "}
              <span className="tabular-nums text-text-dim">
                {l.maxTokens}/{formatDuration(l.refillIntervalMs)} · {l.keyedBy}
              </span>
            </Chip>
          ))}
        </div>
      </div>
    </div>
  );
}
