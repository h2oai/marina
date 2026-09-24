// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { useMemo, useState } from "react";
import { type CommandForm, commandForms, composeCommand } from "../lib/command-forms";

const STARTERS: Record<string, string> = {
  agent: "agent spawn ",
  task: "task create ",
  canvas: "canvas post ",
  experiment: "experiment create ",
};
export function CommandFields({
  name,
  help = "",
  onCompose,
}: {
  name: string;
  help?: string;
  onCompose: (args: string) => void;
}) {
  const forms = useMemo(() => commandForms({ name, help }), [name, help]);
  const [chosen, setChosen] = useState("");
  const selected =
    forms.find((f) => f.syntax === chosen) ??
    forms.find((f) => f.syntax.startsWith(STARTERS[name] ?? "\0")) ??
    forms[0];
  if (!selected) return null;
  return (
    <fieldset className="space-y-3 rounded border border-border p-3">
      <legend className="px-1 text-xs text-primary">Guided command builder</legend>
      <label className="block text-sm">
        Action
        <select
          aria-label="Command action"
          value={selected.syntax}
          onChange={(e) => setChosen(e.target.value)}
          className="mt-1 w-full min-w-0 rounded border border-border bg-bg p-2"
        >
          {forms.map((form) => (
            <option key={form.syntax} value={form.syntax}>
              {form.label}
            </option>
          ))}
        </select>
      </label>
      <ParameterFields
        key={selected.syntax}
        form={selected}
        onCompose={(command) => onCompose(command.slice(name.length).trim())}
      />
    </fieldset>
  );
}

function ParameterFields({
  form,
  onCompose,
}: {
  form: CommandForm;
  onCompose: (command: string) => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [enabled, setEnabled] = useState<Record<string, boolean>>({});
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const result = composeCommand(form, values, enabled);
  const isEnabled = (id: string): boolean => {
    const group = form.groups.find((g) => g.id === id);
    return !!enabled[id] && (!group?.parent || isEnabled(group.parent));
  };
  const inputClass = "mt-1 w-full rounded border border-border bg-bg p-2 text-sm";
  return (
    <>
      {form.groups.length > 0 && (
        <div className="flex flex-wrap gap-x-4 gap-y-2">
          {form.groups.map((group) => (
            <label key={group.id} className="flex items-center gap-1 text-xs">
              <input
                type="checkbox"
                checked={!!enabled[group.id]}
                disabled={!!group.parent && !isEnabled(group.parent)}
                onChange={(e) => setEnabled({ ...enabled, [group.id]: e.target.checked })}
              />
              Include {group.label}
            </label>
          ))}
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        {form.fields
          .filter((f) => !f.optionalGroup || isEnabled(f.optionalGroup))
          .map((field) => {
            const label = field.label.charAt(0).toUpperCase() + field.label.slice(1);
            const props = {
              id: `composer-${field.id}`,
              value: values[field.id] ?? "",
              onChange: (
                e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>,
              ) => {
                setValues({ ...values, [field.id]: e.target.value });
                setTouched({ ...touched, [field.id]: true });
              },
              "aria-invalid": !!touched[field.id] && !!result.errors[field.id],
              className: inputClass,
            };
            return (
              <label
                key={field.id}
                htmlFor={`composer-${field.id}`}
                className={`text-sm ${field.multiline ? "sm:col-span-2" : ""}`}
              >
                {label}
                {field.kind === "choice" ? (
                  <select {...props}>
                    <option value="">Choose…</option>
                    {field.choices?.map((choice) => (
                      <option key={choice}>{choice}</option>
                    ))}
                  </select>
                ) : field.multiline ? (
                  <textarea
                    {...props}
                    rows={field.kind === "json" ? 4 : 2}
                    placeholder={field.placeholder}
                  />
                ) : (
                  <input
                    {...props}
                    type={field.kind === "number" ? "number" : "text"}
                    step={field.kind === "number" ? "any" : undefined}
                    placeholder={field.placeholder}
                  />
                )}
                {touched[field.id] && result.errors[field.id] && (
                  <span className="text-xs text-danger">{result.errors[field.id]}</span>
                )}
              </label>
            );
          })}
      </div>
      {form.fields.length === 0 && form.groups.length === 0 && (
        <p className="text-sm text-text-dim">This action needs no parameters.</p>
      )}
      <button
        type="button"
        disabled={Object.keys(result.errors).length > 0}
        onClick={() => onCompose(result.command)}
        className="rounded border border-primary/40 px-3 py-2 text-sm text-primary disabled:opacity-40"
      >
        Fill command
      </button>
    </>
  );
}
