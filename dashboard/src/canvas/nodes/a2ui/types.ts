// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

/** A2UI v0.9 component types supported by the Marina canvas renderer */

export type A2UIComponentType =
  | "Text"
  | "Button"
  | "TextField"
  | "CheckBox"
  | "DateTimeInput"
  | "Row"
  | "Column"
  | "Card"
  | "Surface"
  | "DataTable"
  | "Timeline";

export interface A2UIComponent {
  id: string;
  component: A2UIComponentType;
  /** Single child component ID */
  child?: string;
  /** Multiple child component IDs */
  children?: string[];
  /** All other properties are component-specific */
  [key: string]: unknown;
}

export interface A2UIAction {
  event: { name: string; payload?: Record<string, unknown> };
}

export interface A2UINodeData {
  components: A2UIComponent[];
  rootId?: string;
  dataModel?: Record<string, unknown>;
  title?: string;
  lastAction?: { name: string; payload?: Record<string, unknown>; timestamp: number };
}
