// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Runtime decision settings (Admin → Ops → Decisions), operators only. Reads
 * and writes `/api/ops/decisions/settings` (src/decisions/settings.ts): a
 * value set in the environment is locked and shown as such; base URLs, paths
 * and API keys are never editable here. Changes take effect on the next
 * decision, are audited, and survive a restart.
 */

import { useCallback, useEffect, useState } from "react";
import { authFetch } from "../../lib/api";
import { Chip } from "./primitives";

export interface DecisionSettingRow {
  name: string;
  env: string;
  describe: string;
  value?: string;
  source: "environment" | "runtime" | "default";
  locked: boolean;
  options?: string[];
}

interface SettingsChange {
  at: string;
  by: string;
  setting: string;
  from: string | null;
  to: string | null;
}

interface SettingsResponse {
  settings: DecisionSettingRow[];
  history: SettingsChange[];
  runtime: boolean;
}

const SETTINGS_PATH = "/api/ops/decisions/settings";

async function errorText(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    return body.error ?? `Request failed (${res.status}).`;
  } catch {
    return `Request failed (${res.status}).`;
  }
}

const SOURCE_CLASS: Record<DecisionSettingRow["source"], string> = {
  environment: "border-border text-text-dim",
  runtime: "border-primary/60 text-primary",
  default: "border-border text-text-dim",
};

function SettingRow({
  row,
  busy,
  onSave,
}: {
  row: DecisionSettingRow;
  busy: boolean;
  onSave: (setting: string, value: string | null) => void;
}) {
  const [draft, setDraft] = useState(row.value ?? "");
  useEffect(() => setDraft(row.value ?? ""), [row.value]);
  const changed = draft.trim() !== (row.value ?? "");
  const label = `${row.name} (${row.env})`;
  return (
    <tr className="border-t border-border/40" title={row.describe}>
      <td className="py-0.5 pr-2 font-mono">{row.name}</td>
      <td className="py-0.5 pr-2">
        {row.locked ? (
          <span className="font-mono text-text-dim">{row.value}</span>
        ) : row.options ? (
          <select
            aria-label={label}
            className="rounded border border-border bg-bg px-1 py-0 text-[10px]"
            value={draft}
            disabled={busy}
            onChange={(e) => setDraft(e.target.value)}
          >
            <option value="">(default)</option>
            {row.options.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        ) : (
          <input
            aria-label={label}
            className="w-full min-w-[10rem] rounded border border-border bg-bg px-1 py-0 font-mono text-[10px]"
            value={draft}
            placeholder="(default)"
            disabled={busy}
            onChange={(e) => setDraft(e.target.value)}
          />
        )}
      </td>
      <td className="py-0.5 pr-2">
        <Chip className={SOURCE_CLASS[row.source]}>{row.locked ? "env · locked" : row.source}</Chip>
      </td>
      <td className="py-0.5 whitespace-nowrap">
        {!row.locked && (
          <>
            <button
              type="button"
              aria-label={`Save ${label}`}
              disabled={busy || !changed}
              onClick={() => onSave(row.name, draft.trim() === "" ? null : draft.trim())}
              className="rounded bg-primary/20 px-1.5 text-[10px] text-primary hover:bg-primary/30 disabled:opacity-40"
            >
              Save
            </button>
            {row.source === "runtime" && (
              <button
                type="button"
                aria-label={`Reset ${label} to its default`}
                disabled={busy}
                onClick={() => onSave(row.name, null)}
                className="ml-1 rounded px-1.5 text-[10px] text-text-dim hover:text-text disabled:opacity-40"
              >
                Reset
              </button>
            )}
          </>
        )}
      </td>
    </tr>
  );
}

export function DecisionSettings({ onChanged }: { onChanged?: () => void }) {
  const [data, setData] = useState<SettingsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await authFetch(SETTINGS_PATH);
    if (!res.ok) {
      setError(await errorText(res));
      return;
    }
    setData((await res.json()) as SettingsResponse);
    setError(null);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (setting: string, value: string | null) => {
    setBusy(true);
    setSaved(null);
    try {
      const res = await authFetch(SETTINGS_PATH, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ setting, value }),
      });
      if (!res.ok) {
        setError(await errorText(res));
        return;
      }
      setError(null);
      setSaved(setting);
      await load();
      onChanged?.();
    } finally {
      setBusy(false);
    }
  };

  if (!data) {
    return error ? <div className="text-danger text-[10px]">{error}</div> : null;
  }
  return (
    <section className="space-y-1" aria-label="Decision settings">
      <div className="text-[9px] text-text-dim">
        Settings — take effect on the next decision. A value set in the environment is locked; base
        URLs and API keys stay in the environment / Keys.
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-[10px]">
          <thead className="text-[8px] uppercase text-text-dim">
            <tr>
              <th className="py-0.5 pr-2">Setting</th>
              <th className="py-0.5 pr-2">Value</th>
              <th className="py-0.5 pr-2">Source</th>
              <th className="py-0.5" />
            </tr>
          </thead>
          <tbody>
            {data.settings.map((row) => (
              <SettingRow key={row.env} row={row} busy={busy} onSave={save} />
            ))}
          </tbody>
        </table>
      </div>
      {error && (
        <div role="alert" className="text-danger text-[10px]">
          {error}
        </div>
      )}
      {saved && !error && <div className="text-success text-[9px]">✓ {saved} updated</div>}
      {data.history.length > 0 && (
        <details className="text-[9px] text-text-dim">
          <summary>Recent changes</summary>
          <ul>
            {data.history.slice(0, 8).map((c) => (
              <li key={`${c.at}-${c.setting}`}>
                {c.at.slice(0, 16).replace("T", " ")} · {c.by} · {c.setting}:{" "}
                {c.from ?? "(default)"} → {c.to ?? "(default)"}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
