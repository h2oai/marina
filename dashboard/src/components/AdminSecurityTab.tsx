// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/** Admin panel tab, split out of AdminPanel.tsx without behaviour change. */

import { Shield } from "lucide-react";
import { useEffect, useState } from "react";
import { useAgents } from "../hooks/use-api";
import { fetchApi } from "../lib/api";

interface SecurityStatus {
  authRequired: boolean;
  openApi: boolean;
  keyEncryption: boolean;
  dbKeyCount: number;
  unreadableKeys?: number;
}

export function SecurityTab() {
  const { data: agents } = useAgents();
  const [status, setStatus] = useState<SecurityStatus | null>(null);

  useEffect(() => {
    fetchApi<SecurityStatus>("/api/security-status")
      .then(setStatus)
      .catch(() => {});
  }, []);

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1 text-primary text-[10px] uppercase tracking-wider">
        <Shield size={10} /> Security Status
      </div>
      <div className="space-y-1 text-[10px]">
        <div className="flex gap-2">
          <span className="text-text-dim">Dashboard auth:</span>
          {status?.authRequired ? (
            <span className="text-emerald-400">Enabled (better-auth)</span>
          ) : (
            <span className="text-warning">Off — sign-in not required</span>
          )}
        </div>
        {status?.openApi && (
          <div className="flex gap-2">
            <span className="text-text-dim">Open API:</span>
            <span className="text-red-400">
              MARINA_OPEN_API=true — API auth disabled (dev only)
            </span>
          </div>
        )}
        <div className="flex gap-2">
          <span className="text-text-dim">Key encryption:</span>
          {status?.keyEncryption ? (
            <span className="text-emerald-400">On (AES-256-GCM at rest)</span>
          ) : (
            <span className="text-warning">Off — DB keys stored in plaintext</span>
          )}
        </div>
        <div className="flex gap-2">
          <span className="text-text-dim">API keys:</span>
          <span className="text-text">{status?.dbKeyCount ?? 0} in database</span>
        </div>
        <div className="flex gap-2">
          <span className="text-text-dim">Active agents:</span>
          <span className="text-text">{agents?.length ?? 0} running</span>
        </div>
      </div>
      {status?.unreadableKeys ? (
        <div className="mt-2 rounded border border-red-400/40 bg-red-400/10 p-1.5 text-[10px] text-red-400">
          ⚠ {status.unreadableKeys} stored key(s) are encrypted but can't be decrypted —
          MARINA_KEY_SECRET is missing or changed. They read as missing until you restore the
          original secret or re-enter the keys.
        </div>
      ) : null}
      <div className="text-text-dim text-[9px] mt-2 space-y-1">
        {!status?.authRequired && (
          <div>
            Enable sign-in with <span className="text-primary">MARINA_AUTH=better-auth</span> — see{" "}
            <span className="text-primary">docs/authentication.md</span>.
          </div>
        )}
        {!status?.keyEncryption && status?.dbKeyCount ? (
          <div>
            Keys in the DB are unencrypted. Prefer provider{" "}
            <span className="text-primary">env vars</span> (never persisted) or encrypt the data
            volume.
          </div>
        ) : null}
      </div>
    </div>
  );
}
