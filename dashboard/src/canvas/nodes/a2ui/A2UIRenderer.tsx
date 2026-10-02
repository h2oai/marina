// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { memo, useCallback, useMemo } from "react";
import { validatePanelDocument } from "../../../../../src/sdk/panel-document";
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
  onAction?: (action: A2UIAction) => void;
  onFieldChange?: (id: string, value: string | boolean) => void;
  renderResource?: (component: A2UIComponent) => React.ReactNode;
}

export const A2UIRenderer = memo(function A2UIRenderer({
  nodeData,
  onAction,
  renderResource,
  onFieldChange,
}: RendererProps) {
  const validated = useMemo(() => validatePanelDocument(nodeData), [nodeData]);
  const document = validated.ok ? validated.document : null;
  const componentMap = useMemo(() => {
    const map = new Map<string, A2UIComponent>();
    for (const c of document?.components ?? []) {
      map.set(c.id, c);
    }
    return map;
  }, [document]);

  const rootId = document?.rootId;

  const renderComponent = useCallback(
    (id: string, depth: number): React.ReactNode => {
      if (depth > MAX_DEPTH) return null;
      const c = componentMap.get(id);
      if (!c) return null;

      const renderChild = (childId: string) => renderComponent(childId, depth + 1);

      switch (c.component) {
        case "Resource":
          return (
            <div key={id}>
              {renderResource?.(c) ??
                "Open this resource in Marina to inspect its current content."}
            </div>
          );
        case "Text":
          return <A2UIText key={id} component={c} />;
        case "Button":
          return (
            <A2UIButton key={id} component={c} onAction={onAction} renderChild={renderChild} />
          );
        case "TextField":
          return (
            <A2UITextField
              key={id}
              component={c}
              onAction={onAction}
              onFieldChange={onFieldChange}
            />
          );
        case "CheckBox":
          return (
            <A2UICheckBox
              key={id}
              component={c}
              onAction={onAction}
              onFieldChange={onFieldChange}
            />
          );
        case "DateTimeInput":
          return (
            <A2UIDateTimeInput
              key={id}
              component={c}
              onAction={onAction}
              onFieldChange={onFieldChange}
            />
          );
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
    [componentMap, onAction, renderResource, onFieldChange],
  );

  if (!validated.ok)
    return (
      <p role="alert" className="p-2 text-sm text-danger">
        Cannot display panel: {validated.error}
      </p>
    );

  if (!rootId) {
    return <div className="text-xs text-text-dim italic p-2">Empty A2UI surface</div>;
  }

  return <>{renderComponent(rootId, 0)}</>;
});
