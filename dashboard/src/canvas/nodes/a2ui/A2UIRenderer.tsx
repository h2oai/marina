import { memo, useCallback, useMemo } from "react";
import {
  A2UIButton,
  A2UICard,
  A2UICheckBox,
  A2UIColumn,
  A2UIDataTable,
  A2UIDateTimeInput,
  A2UIRow,
  A2UISurface,
  A2UIText,
  A2UITextField,
  A2UITimeline,
} from "./primitives";
import type { A2UIAction, A2UIComponent, A2UINodeData } from "./types";

const MAX_DEPTH = 20;

interface RendererProps {
  nodeData: A2UINodeData;
  onAction: (action: A2UIAction) => void;
}

export const A2UIRenderer = memo(function A2UIRenderer({ nodeData, onAction }: RendererProps) {
  const componentMap = useMemo(() => {
    const map = new Map<string, A2UIComponent>();
    for (const c of nodeData.components ?? []) {
      map.set(c.id, c);
    }
    return map;
  }, [nodeData.components]);

  const rootId = nodeData.rootId ?? nodeData.components?.[0]?.id;

  const renderComponent = useCallback(
    (id: string, depth: number): React.ReactNode => {
      if (depth > MAX_DEPTH) return null;
      const c = componentMap.get(id);
      if (!c) return null;

      const renderChild = (childId: string) => renderComponent(childId, depth + 1);

      switch (c.component) {
        case "Text":
          return <A2UIText key={id} component={c} />;
        case "Button":
          return (
            <A2UIButton key={id} component={c} onAction={onAction} renderChild={renderChild} />
          );
        case "TextField":
          return <A2UITextField key={id} component={c} onAction={onAction} />;
        case "CheckBox":
          return <A2UICheckBox key={id} component={c} onAction={onAction} />;
        case "DateTimeInput":
          return <A2UIDateTimeInput key={id} component={c} onAction={onAction} />;
        case "Row":
          return <A2UIRow key={id} component={c} renderChild={renderChild} />;
        case "Column":
          return <A2UIColumn key={id} component={c} renderChild={renderChild} />;
        case "Card":
          return <A2UICard key={id} component={c} renderChild={renderChild} />;
        case "Surface":
          return <A2UISurface key={id} component={c} renderChild={renderChild} />;
        case "DataTable":
          return <A2UIDataTable key={id} component={c} />;
        case "Timeline":
          return <A2UITimeline key={id} component={c} />;
        default:
          return (
            <div
              key={id}
              className="rounded border border-dashed border-amber-700/70 px-2 py-1.5 text-xs text-amber-300/80 bg-amber-900/10"
              title={`A2UI component "${c.component}" is not registered. Supported: Text, Button, TextField, CheckBox, DateTimeInput, Row, Column, Card, Surface, DataTable, Timeline.`}
            >
              <span className="font-semibold">Unsupported component:</span>{" "}
              <span className="font-mono">{c.component}</span>
              <span className="block text-[10px] text-amber-500/70 mt-0.5">
                hover for the full list of supported components
              </span>
            </div>
          );
      }
    },
    [componentMap, onAction],
  );

  if (!rootId) {
    return <div className="text-xs text-gray-500 italic p-2">Empty A2UI surface</div>;
  }

  return <>{renderComponent(rootId, 0)}</>;
});
