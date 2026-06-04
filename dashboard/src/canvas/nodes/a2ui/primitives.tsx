import { memo, useCallback, useState } from "react";
import type { A2UIAction, A2UIComponent } from "./types";

// ── Text ────────────────────────────────────────────────────────────────────

const VARIANT_CLASSES: Record<string, string> = {
  h1: "text-xl font-bold text-gray-100",
  h2: "text-lg font-semibold text-gray-100",
  h3: "text-base font-semibold text-gray-200",
  h4: "text-sm font-semibold text-gray-200",
  h5: "text-xs font-semibold text-gray-300",
  h6: "text-xs font-medium text-gray-300",
  body: "text-sm text-gray-300",
  caption: "text-xs text-gray-500",
};

export const A2UIText = memo(function A2UIText({ component }: { component: A2UIComponent }) {
  const text = (component.text as string) ?? "";
  const variant = (component.variant as string) ?? "body";
  return <div className={VARIANT_CLASSES[variant] ?? VARIANT_CLASSES.body}>{text}</div>;
});

// ── Button ──────────────────────────────────────────────────────────────────

const BTN_VARIANTS: Record<string, string> = {
  filled: "bg-indigo-600 hover:bg-indigo-500 text-white",
  outlined: "border border-indigo-500 text-indigo-400 hover:bg-indigo-500/10",
  text: "text-indigo-400 hover:text-indigo-300",
};

export const A2UIButton = memo(function A2UIButton({
  component,
  onAction,
  renderChild,
}: {
  component: A2UIComponent;
  onAction: (action: A2UIAction) => void;
  renderChild: (id: string) => React.ReactNode;
}) {
  const label = (component.label as string) ?? "";
  const variant = (component.variant as string) ?? "filled";
  const disabled = (component.disabled as boolean) ?? false;
  const action = component.action as A2UIAction | undefined;

  const handleClick = useCallback(() => {
    if (action && !disabled) onAction(action);
  }, [action, disabled, onAction]);

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={disabled}
      className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${
        BTN_VARIANTS[variant] ?? BTN_VARIANTS.filled
      } ${disabled ? "opacity-40 cursor-not-allowed" : "cursor-pointer"}`}
    >
      {component.child ? renderChild(component.child) : label}
    </button>
  );
});

// ── TextField ───────────────────────────────────────────────────────────────

export const A2UITextField = memo(function A2UITextField({
  component,
  onAction,
}: {
  component: A2UIComponent;
  onAction: (action: A2UIAction) => void;
}) {
  const label = (component.label as string) ?? "";
  const placeholder = (component.placeholder as string) ?? "";
  const initialValue = (component.value as string) ?? "";
  const fieldId = (component.fieldId as string) ?? component.id;
  const [value, setValue] = useState(initialValue);

  const submit = useCallback(() => {
    onAction({ event: { name: "field_change", payload: { fieldId, value } } });
  }, [fieldId, value, onAction]);

  return (
    <label className="flex flex-col gap-1">
      {label && <span className="text-xs text-gray-400">{label}</span>}
      <input
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={submit}
        onKeyDown={(e) => e.key === "Enter" && submit()}
        placeholder={placeholder}
        className="bg-gray-800 border border-gray-600 rounded px-2 py-1 text-sm text-gray-200 placeholder-gray-600 focus:border-indigo-500 focus:outline-none"
      />
    </label>
  );
});

// ── CheckBox ────────────────────────────────────────────────────────────────

export const A2UICheckBox = memo(function A2UICheckBox({
  component,
  onAction,
}: {
  component: A2UIComponent;
  onAction: (action: A2UIAction) => void;
}) {
  const label = (component.label as string) ?? "";
  const initialChecked = (component.checked as boolean) ?? false;
  const fieldId = (component.fieldId as string) ?? component.id;
  const [checked, setChecked] = useState(initialChecked);

  const toggle = useCallback(() => {
    const next = !checked;
    setChecked(next);
    onAction({ event: { name: "field_change", payload: { fieldId, value: next } } });
  }, [checked, fieldId, onAction]);

  return (
    <label className="flex items-center gap-2 cursor-pointer text-sm text-gray-300">
      <input type="checkbox" checked={checked} onChange={toggle} className="accent-indigo-500" />
      {label}
    </label>
  );
});

// ── DateTimeInput ───────────────────────────────────────────────────────────

export const A2UIDateTimeInput = memo(function A2UIDateTimeInput({
  component,
  onAction,
}: {
  component: A2UIComponent;
  onAction: (action: A2UIAction) => void;
}) {
  const label = (component.label as string) ?? "";
  const initialValue = (component.value as string) ?? "";
  const fieldId = (component.fieldId as string) ?? component.id;
  const [value, setValue] = useState(initialValue);

  const submit = useCallback(() => {
    onAction({ event: { name: "field_change", payload: { fieldId, value } } });
  }, [fieldId, value, onAction]);

  return (
    <label className="flex flex-col gap-1">
      {label && <span className="text-xs text-gray-400">{label}</span>}
      <input
        type="datetime-local"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={submit}
        className="bg-gray-800 border border-gray-600 rounded px-2 py-1 text-sm text-gray-200 focus:border-indigo-500 focus:outline-none"
      />
    </label>
  );
});

// ── Row ─────────────────────────────────────────────────────────────────────

export const A2UIRow = memo(function A2UIRow({
  component,
  renderChild,
}: {
  component: A2UIComponent;
  renderChild: (id: string) => React.ReactNode;
}) {
  const gap = (component.gap as string) ?? "gap-2";
  const align = (component.align as string) ?? "items-start";
  const children = component.children ?? [];
  return (
    <div className={`flex flex-row ${gap} ${align}`}>
      {children.map((id) => (
        <div key={id} className="min-w-0">
          {renderChild(id)}
        </div>
      ))}
    </div>
  );
});

// ── Column ──────────────────────────────────────────────────────────────────

export const A2UIColumn = memo(function A2UIColumn({
  component,
  renderChild,
}: {
  component: A2UIComponent;
  renderChild: (id: string) => React.ReactNode;
}) {
  const gap = (component.gap as string) ?? "gap-2";
  const children = component.children ?? [];
  return (
    <div className={`flex flex-col ${gap}`}>
      {children.map((id) => (
        <div key={id}>{renderChild(id)}</div>
      ))}
    </div>
  );
});

// ── Card ────────────────────────────────────────────────────────────────────

export const A2UICard = memo(function A2UICard({
  component,
  renderChild,
}: {
  component: A2UIComponent;
  renderChild: (id: string) => React.ReactNode;
}) {
  const title = (component.title as string) ?? "";
  const children = component.children ?? [];
  const child = component.child;
  return (
    <div className="rounded-lg border border-gray-700 bg-gray-800/50 p-3 flex flex-col gap-2">
      {title && <div className="text-sm font-semibold text-gray-200">{title}</div>}
      {child && renderChild(child)}
      {children.map((id) => (
        <div key={id}>{renderChild(id)}</div>
      ))}
    </div>
  );
});

// ── Surface ─────────────────────────────────────────────────────────────────

export const A2UISurface = memo(function A2UISurface({
  component,
  renderChild,
}: {
  component: A2UIComponent;
  renderChild: (id: string) => React.ReactNode;
}) {
  const title = (component.title as string) ?? "";
  const children = component.children ?? [];
  const child = component.child;
  return (
    <div className="flex flex-col gap-3 h-full">
      {title && (
        <div className="text-base font-bold text-gray-100 border-b border-gray-700 pb-2">
          {title}
        </div>
      )}
      {child && renderChild(child)}
      {children.map((id) => (
        <div key={id}>{renderChild(id)}</div>
      ))}
    </div>
  );
});

// ── DataTable ───────────────────────────────────────────────────────────────

interface TableColumn {
  key: string;
  label: string;
}

export const A2UIDataTable = memo(function A2UIDataTable({
  component,
}: {
  component: A2UIComponent;
}) {
  const columns = (component.columns as TableColumn[]) ?? [];
  const rows = (component.rows as Record<string, unknown>[]) ?? [];

  return (
    <div className="overflow-auto rounded border border-gray-700">
      <table className="w-full text-sm text-left">
        <thead className="bg-gray-800 text-xs text-gray-400 uppercase">
          <tr>
            {columns.map((col) => (
              <th key={col.key} className="px-3 py-2">
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: A2UI rows are server-rendered in fixed order
            <tr key={i} className="border-t border-gray-800 hover:bg-gray-800/50">
              {columns.map((col) => (
                <td key={col.key} className="px-3 py-1.5 text-gray-300">
                  {String(row[col.key] ?? "")}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
});

// ── Timeline ────────────────────────────────────────────────────────────────

interface TimelineItem {
  label: string;
  timestamp?: string;
  description?: string;
}

export const A2UITimeline = memo(function A2UITimeline({
  component,
}: {
  component: A2UIComponent;
}) {
  const items = (component.items as TimelineItem[]) ?? [];

  return (
    <div className="flex flex-col">
      {items.map((item, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: A2UI timeline items are server-rendered in fixed order
        <div key={i} className="flex gap-3">
          <div className="flex flex-col items-center">
            <div className="w-2 h-2 rounded-full bg-indigo-500 mt-1.5" />
            {i < items.length - 1 && <div className="w-px flex-1 bg-gray-700" />}
          </div>
          <div className="pb-4">
            <div className="text-sm font-medium text-gray-200">{item.label}</div>
            {item.timestamp && <div className="text-xs text-gray-500">{item.timestamp}</div>}
            {item.description && (
              <div className="text-xs text-gray-400 mt-0.5">{item.description}</div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
});
