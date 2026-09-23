// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { OperationalAlertRow } from "../db-alerts";
import type { ExactKeys } from "./exact-keys";

/** Operational alerts (`db-alerts.ts`). */
export interface AlertsStore {
  upsertOperationalAlert(alert: {
    key: string;
    severity: "critical" | "warning" | "info";
    category: string;
    title: string;
    detail: string;
    remedy: string;
    kind?: string;
    sourceEntity?: string;
    targetEntity?: string;
    assignedTo?: string;
    actionLabel?: string;
    actionRef?: string;
    metadata?: Record<string, unknown>;
    deadlineAt?: number;
  }): OperationalAlertRow;
  listOperationalAlerts(
    status?: "open" | "acknowledged" | "resolved",
    limit?: number,
  ): OperationalAlertRow[];
  setOperationalAlertStatus(id: number, status: "acknowledged" | "resolved"): boolean;
  snoozeOperationalAlert(id: number, until: number): boolean;
  resolveOperationalAlertsExcept(category: string, activeKeys: string[]): number;
}

/** Runtime mirror of `AlertsStore`'s method names — the drift test compares it to the facade. */
export const ALERTS_STORE_METHODS = [
  "upsertOperationalAlert",
  "listOperationalAlerts",
  "setOperationalAlertStatus",
  "snoozeOperationalAlert",
  "resolveOperationalAlertsExcept",
] as const satisfies readonly (keyof AlertsStore)[];

export const ALERTS_STORE_COMPLETE: ExactKeys<AlertsStore, typeof ALERTS_STORE_METHODS> = true;
