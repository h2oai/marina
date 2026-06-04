/**
 * Dashboard Electroview entry point.
 *
 * This file runs in the webview context. It initializes the RPC shim
 * which intercepts fetch/WS calls from the dashboard SPA and routes
 * them through Electrobun's typed RPC to the bun process.
 *
 * The actual dashboard SPA is loaded via index.html which includes
 * the Vite-built bundle from ./app/index.js.
 */

// Import the shim to activate fetch/WS interception before the SPA loads
import "./rpc-shim";
