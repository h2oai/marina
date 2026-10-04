// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Dashboard Electroview entry point.
 *
 * This file runs in the webview context. It initializes the RPC shim
 * which intercepts fetch/WS calls from the dashboard SPA and routes
 * them through Electrobun's typed RPC to the bun process.
 *
 * This entry loads the Vite-built SPA from ./app/index.js after installing
 * its native transport.
 */

// Import the shim to activate fetch/WS interception before the SPA loads
import "./rpc-shim";

// Start the SPA only after the native adapter is installed. Separate module
// script tags can evaluate shared dependency chunks before this shim runs.
const dashboard = document.createElement("script");
dashboard.type = "module";
dashboard.src = "./app/index.js";
document.body.append(dashboard);
