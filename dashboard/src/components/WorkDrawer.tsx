// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { AnimatePresence } from "motion/react";
import { WorkOverview } from "./WorkOverview";

/** The drawer's subscriptions and fetches live in the panel, which is mounted
 *  only while open — a closed drawer costs nothing per event. */
export function WorkDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <AnimatePresence>{open && <WorkOverview key="panel" onClose={onClose} />}</AnimatePresence>
  );
}
