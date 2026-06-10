import { useMemo } from "react";
import { useModels } from "../hooks/use-api";
import { mergeGroups, providerLabel, totalModelCount } from "../lib/model-catalog";

/**
 * Shared model picker — the single source of truth for how a model is chosen
 * across the dashboard (agent launch, default-model setting, …). Lists only
 * keyed providers (incl. OpenRouter) grouped by provider, with a discovery
 * status line and a "Custom…" escape hatch. Controlled via the two-field
 * (model + customModel) shape so callers decide what to do with the choice.
 */
export function ModelSelect({
  model,
  onModelChange,
  customModel,
  onCustomModelChange,
  label = "Model",
  placeholderOption,
}: {
  /** The <select> value: a model value, "__custom", or "" (none). */
  model: string;
  onModelChange: (value: string) => void;
  customModel: string;
  onCustomModelChange: (value: string) => void;
  label?: string;
  /** Optional first option (e.g. a "Default Model" sentinel) rendered above the groups. */
  placeholderOption?: { value: string; label: string };
}) {
  const { data: modelsData, isLoading } = useModels();
  const groups = useMemo(() => mergeGroups(modelsData?.groups), [modelsData]);
  // Only providers we hold a key for are callable — same filter the launch
  // picker uses, so the two surfaces always show the identical set.
  const liveGroups = useMemo(
    () => groups.filter((g) => g.keySource !== null && g.models.length > 0),
    [groups],
  );
  const hasLive = liveGroups.length > 0;
  const liveModelCount = totalModelCount(liveGroups);

  // If the controlled value isn't one of the discovered options (e.g. a saved
  // default for a model discovery doesn't list), surface it as a leading option
  // so the select still reflects the real current value instead of snapping to
  // the first entry.
  const known = useMemo(
    () => new Set(liveGroups.flatMap((g) => g.models.map((m) => m.value))),
    [liveGroups],
  );
  const showCurrentOption =
    !!model && model !== "__custom" && model !== placeholderOption?.value && !known.has(model);

  return (
    <div className="space-y-1">
      <label className="block space-y-1">
        <span className="flex items-center justify-between text-text-dim text-[9px] uppercase tracking-wider">
          <span>{label}</span>
          <span className="text-text-dim normal-case tracking-normal">
            {isLoading
              ? "discovering…"
              : hasLive
                ? `${liveModelCount} available`
                : "no API key — add one in Admin → Keys"}
          </span>
        </span>
        <select
          value={model}
          onChange={(e) => onModelChange(e.target.value)}
          className="w-full bg-bg-surface border border-border rounded px-1.5 py-0.5 text-[11px] text-text-bright outline-none focus:border-primary"
        >
          {placeholderOption && (
            <option value={placeholderOption.value}>{placeholderOption.label}</option>
          )}
          {showCurrentOption && <option value={model}>{model} (current)</option>}
          {liveGroups.map((g) => (
            <optgroup key={g.provider} label={providerLabel(g.provider)}>
              {g.models.map((m) => (
                <option key={m.value} value={m.value} title={m.description}>
                  {m.label}
                </option>
              ))}
            </optgroup>
          ))}
          <option value="__custom">Custom…</option>
        </select>
      </label>
      {!isLoading && !hasLive && (
        <div className="text-text-dim text-[9px]">
          No keyed providers — add an API key in Admin → Keys, or enter a custom provider/model.
        </div>
      )}
      {model === "__custom" && (
        <input
          type="text"
          placeholder="provider/model-name"
          value={customModel}
          onChange={(e) => onCustomModelChange(e.target.value)}
          className="w-full bg-bg-surface border border-border rounded px-1.5 py-0.5 text-[11px] text-text outline-none focus:border-primary"
        />
      )}
    </div>
  );
}
