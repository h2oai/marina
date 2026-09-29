// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/** Admin panel tab, split out of AdminPanel.tsx without behaviour change. */

import { Key } from "lucide-react";
import { useEffect, useState } from "react";
import { useKeys } from "../hooks/use-api";
import { deleteApi, describeApiError, fetchApi, postApi, putApi } from "../lib/api";
import { ModelSelect } from "./ModelSelect";
import { PanelSkeleton } from "./OperatorFeedback";

const SUPPORTED_PROVIDERS = [
  "anthropic",
  "openai",
  "google",
  "groq",
  "openrouter",
  "huggingface",
  "cerebras",
  "xai",
  "mistral",
  "deepseek",
];

/**
 * Runtime-changeable default model — what marina/default routes to and what new
 * agents spawn with. Lists only keyed providers (incl. OpenRouter), plus a custom
 * entry, and persists via PUT /api/default-model. Takes effect immediately for
 * marina/default routing and for newly spawned agents.
 */
function DefaultModelSelector() {
  const [sel, setSel] = useState<string>("");
  const [custom, setCustom] = useState("");
  const [saving, setSaving] = useState(false);
  const [flash, setFlash] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetchApi<{ model: string; configured: string | null }>("/api/default-model")
      .then((d) => setSel(d.configured ?? d.model))
      .catch(() => {});
  }, []);

  const save = async (model: string) => {
    if (!model.trim()) return;
    setSaving(true);
    setErr(null);
    try {
      const d = await putApi<{ model: string; configured: string }>("/api/default-model", {
        model: model.trim(),
      });
      setSel(d.configured);
      setCustom("");
      setFlash(true);
      setTimeout(() => setFlash(false), 2000);
    } catch (e) {
      setErr(describeApiError(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-1 rounded border border-border bg-bg-surface/50 p-1.5">
      {/* Same picker the agent-launch panel uses, for a consistent look & feel.
          Selecting a listed model saves immediately; a custom entry commits on Set. */}
      <ModelSelect
        label="Default model"
        model={sel}
        onModelChange={(v) => {
          setSel(v);
          if (v !== "__custom") save(v);
        }}
        customModel={custom}
        onCustomModelChange={setCustom}
      />
      <div className="text-text-dim text-[9px]">
        Used by marina/default and newly spawned agents.
      </div>
      {sel === "__custom" && (
        <button
          type="button"
          onClick={() => save(custom)}
          disabled={saving || !custom.trim()}
          className="w-full bg-primary/20 hover:bg-primary/30 text-primary text-[10px] rounded px-2 py-0.5 disabled:opacity-50"
        >
          Set default
        </button>
      )}
      {flash && <div className="text-success text-[9px]">✓ Default updated</div>}
      {err && <div className="text-danger text-[9px]">{err}</div>}
    </div>
  );
}

export function KeysTab() {
  const { data: keys, isLoading, isError, error, refetch } = useKeys();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [provider, setProvider] = useState("");
  const [value, setValue] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [keyAction, setKeyAction] = useState<string | null>(null);
  const [keyResult, setKeyResult] = useState<string | null>(null);

  const handleAdd = async () => {
    // Be explicit about why a save won't proceed — the old silent return on a
    // missing field looked like "nothing happens".
    if (!name.trim()) return setFormError("Enter a key name.");
    if (!provider) return setFormError("Select a provider.");
    if (!value.trim()) return setFormError("Enter the API key value.");
    setSaving(true);
    setFormError(null);
    try {
      await postApi("/api/keys", { name: name.trim(), provider, value: value.trim() });
      setName("");
      setProvider("");
      setValue("");
      setAdding(false);
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 2500);
      await refetch();
    } catch (e) {
      setFormError(describeApiError(e));
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async (keyName: string) => {
    setKeyAction(keyName);
    setKeyResult(null);
    try {
      const result = await postApi<{ ok?: boolean; error?: string }>(
        `/api/keys/${encodeURIComponent(keyName)}/test`,
      );
      setKeyResult(result.ok ? `${keyName}: connection succeeded` : `${keyName}: test failed`);
    } catch (e) {
      setKeyResult(`${keyName}: ${describeApiError(e)}`);
    } finally {
      setKeyAction(null);
    }
  };

  const handleRemove = async (keyName: string) => {
    if (!window.confirm(`Remove API key "${keyName}"?`)) return;
    setKeyAction(keyName);
    setKeyResult(null);
    try {
      await deleteApi(`/api/keys/${encodeURIComponent(keyName)}`);
      setKeyResult(`${keyName}: removed`);
      await refetch();
    } catch (e) {
      setKeyResult(`${keyName}: ${describeApiError(e)}`);
    } finally {
      setKeyAction(null);
    }
  };

  if (isLoading) return <PanelSkeleton />;
  return (
    <div className="space-y-2">
      <DefaultModelSelector />

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1 text-primary text-[10px] uppercase tracking-wider">
          <Key size={10} /> API Keys
        </div>
        <button
          type="button"
          onClick={() => setAdding(!adding)}
          className="text-[9px] text-text-dim hover:text-primary transition-colors"
        >
          {adding ? "Cancel" : "+ Add"}
        </button>
      </div>

      {adding && (
        <div className="space-y-1 bg-bg-surface/50 rounded p-1.5 border border-border">
          <input
            placeholder="Key name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full bg-bg-surface border border-border rounded px-1.5 py-0.5 text-[10px] text-text-bright outline-none"
          />
          <select
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
            className="w-full bg-bg-surface border border-border rounded px-1.5 py-0.5 text-[10px] text-text-bright outline-none"
          >
            <option value="">Select provider...</option>
            {SUPPORTED_PROVIDERS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          <input
            type="password"
            placeholder="API key value"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="w-full bg-bg-surface border border-border rounded px-1.5 py-0.5 text-[10px] text-text outline-none"
          />
          <button
            type="button"
            onClick={handleAdd}
            disabled={saving}
            className="w-full bg-primary/20 hover:bg-primary/30 text-primary text-[10px] rounded px-2 py-0.5 disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save Key"}
          </button>
          {formError && <div className="text-danger text-[10px]">{formError}</div>}
        </div>
      )}

      {!adding && formError && <div className="text-danger text-[10px]">{formError}</div>}
      {savedFlash && <div className="text-success text-[10px]">✓ Key saved</div>}
      {keyResult && <div className="text-text-dim text-[10px]">{keyResult}</div>}

      {isError ? (
        <div className="text-danger text-[10px]">{describeApiError(error)}</div>
      ) : !keys || keys.length === 0 ? (
        <div className="text-text-dim text-[10px]">
          No saved keys. Click + Add, choose your provider, paste its API key, then click Save Key.
        </div>
      ) : (
        keys.map((k) => (
          <div key={k.name} className="flex items-center gap-2 text-[10px]">
            <span className="text-text-bright">{k.name}</span>
            <span className="text-text-dim">{k.provider}</span>
            <span className="text-text-dim font-mono text-[9px]">{k.masked}</span>
            <span className="flex-1" />
            <button
              type="button"
              onClick={() => handleTest(k.name)}
              disabled={keyAction === k.name}
              className="text-[9px] text-text-dim hover:text-primary disabled:opacity-50"
            >
              Test
            </button>
            <button
              type="button"
              onClick={() => handleRemove(k.name)}
              disabled={keyAction === k.name}
              className="text-[9px] text-text-dim hover:text-danger disabled:opacity-50"
            >
              Remove
            </button>
          </div>
        ))
      )}
    </div>
  );
}
