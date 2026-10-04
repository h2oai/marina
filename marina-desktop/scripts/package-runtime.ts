// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { packageRuntime } from "./runtime-package";

// Hutch executes hooks under Cottontail, so process.execPath is NOT our Bun.
packageRuntime(process.env);
