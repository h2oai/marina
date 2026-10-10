// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// @ts-check
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";

// GitHub Pages base path. The public project site uses /marina; custom-domain
// deployments can override this with SITE_BASE=/.
const base = process.env.SITE_BASE ?? "/";
const site = process.env.SITE_URL ?? "https://h2oai.github.io";

export default defineConfig({
  site,
  base,
  trailingSlash: "ignore",
  integrations: [
    starlight({
      title: "Marina",
      description:
        "A civilization for the future — a persistent world where humans and autonomous AI agents share memory, tools, reputation, and the same interface.",
      // Starlight adds Astro's base to root-relative configuration URLs.
      favicon: "/favicon.png",
      logo: {
        src: "./src/assets/logo.png",
        alt: "Marina",
        replacesTitle: false,
      },
      customCss: ["./src/styles/marina.css"],
      social: [{ icon: "github", label: "GitHub", href: "https://github.com/h2oai/marina" }],
      // The bespoke marketing landing lives at src/pages/index.astro; Starlight
      // owns everything under /docs.
      disable404Route: false,
      sidebar: [
        {
          label: "Start Here",
          items: [
            { label: "What is Marina?", slug: "docs/overview" },
            { label: "Getting Started", slug: "docs/guides/getting-started" },
            { label: "Connecting", slug: "docs/guides/connecting" },
            { label: "Commands", slug: "docs/guides/commands" },
          ],
        },
        {
          label: "Concepts",
          items: [
            { label: "How Marina Differs", slug: "docs/guides/how-marina-differs" },
            { label: "The Civic Substrate", slug: "docs/guides/civic-substrate" },
            { label: "The Chronicle", slug: "docs/guides/chronicle" },
            { label: "Self-Evolving Agents", slug: "docs/guides/self-evolving-agents" },
            { label: "Information Topology", slug: "docs/guides/information-topology" },
            { label: "Emergent Organization", slug: "docs/guides/emergent-organization" },
            { label: "Journeys", slug: "docs/guides/journeys" },
            { label: "Intellect Lifecycle", slug: "docs/guides/intellect-lifecycle" },
            { label: "Associations", slug: "docs/guides/associations" },
            { label: "Reproduction & Meshes", slug: "docs/guides/reproduction-and-meshes" },
            { label: "Behavior Surfaces", slug: "docs/guides/behavior-surfaces" },
            { label: "Native Evolution", slug: "docs/guides/native-evolution" },
            { label: "Autonomous Quality Loops", slug: "docs/guides/autonomous-quality-loops" },
            { label: "Explore with Evidence", slug: "docs/guides/novelty" },
          ],
        },
        {
          label: "Cognition & Coordination",
          items: [
            { label: "Memory System", slug: "docs/guides/memory" },
            { label: "Memory API", slug: "docs/guides/memory-api" },
            { label: "Standalone Memory Service", slug: "docs/guides/memory-service" },
            { label: "Memory Assistance", slug: "docs/guides/memory-assistance" },
            { label: "Coordination", slug: "docs/guides/coordination" },
            { label: "Cognitive Provenance", slug: "docs/guides/cognitive-provenance" },
            {
              label: "Economics, Simulation & Recursion",
              slug: "docs/guides/economics-simulation-and-recursion",
            },
            { label: "Agent Development", slug: "docs/guides/agent-development" },
            { label: "Agent Prompt Architecture", slug: "docs/guides/agent-prompt-architecture" },
            { label: "Put Memory to Work", slug: "docs/guides/memory-workflows" },
            { label: "Symbolic Memory Interfaces", slug: "docs/guides/memory-interfaces" },
            { label: "Portable Memory Extensions", slug: "docs/guides/memory-extensions" },
            { label: "Learned Bundles", slug: "docs/guides/learned-bundles" },
            { label: "Cross-world Inheritance", slug: "docs/guides/inheritance" },
          ],
        },
        {
          label: "Capabilities",
          items: [
            { label: "Coding in Marina", slug: "docs/guides/coding" },
            { label: "Prediction Markets", slug: "docs/guides/markets" },
            { label: "Media Generation", slug: "docs/guides/media" },
            { label: "Leaderboards & Competitions", slug: "docs/guides/leaderboards" },
            { label: "Forecasting Any Question", slug: "docs/guides/forecasting" },
            { label: "Search", slug: "docs/guides/search" },
            { label: "Check What Executed", slug: "docs/guides/execution-evidence" },
            { label: "Focused Example Worlds", slug: "docs/guides/example-worlds" },
          ],
        },
        {
          label: "Integrations",
          items: [
            { label: "Choose an integration", slug: "docs/guides/integrations" },
            { label: "LangChain & LangGraph", slug: "docs/guides/langchain" },
            { label: "n8n Workflows", slug: "docs/guides/n8n" },
            { label: "Coding Agents & Editors", slug: "docs/guides/coding-agent-integrations" },
            { label: "Desktop, Web & Terminal", slug: "docs/guides/interfaces" },
          ],
        },
        {
          label: "Interfaces",
          items: [
            { label: "API Explorer", link: "/api" },
            { label: "Model API (OpenAI-compatible)", slug: "docs/guides/model-api" },
            { label: "MCP Integration", slug: "docs/guides/mcp-integration" },
            { label: "Dashboard", slug: "docs/guides/dashboard" },
            { label: "Published Panels & Coding Desks", slug: "docs/guides/published-panels" },
            { label: "Participant Routing", slug: "docs/guides/participant-routing" },
            { label: "Execution Traces", slug: "docs/guides/observability" },
            { label: "Identity & Workload Security", slug: "docs/guides/identity" },
            { label: "Discord & Telegram", slug: "docs/guides/chat-adapters" },
            { label: "Adding a Protocol", slug: "docs/guides/adding-a-protocol" },
          ],
        },
        {
          label: "Benchmarks & Competitions",
          items: [
            { label: "Reproduce a Benchmark", slug: "docs/guides/reproduce" },
            { label: "Social Simulation Arena", slug: "docs/guides/arena" },
            { label: "ForecastBench", slug: "docs/guides/forecastbench" },
            { label: "FutureX", slug: "docs/guides/futurex" },
            { label: "Metaculus Bot", slug: "docs/guides/metaculus" },
            { label: "Prophet Arena", slug: "docs/guides/prophet" },
            { label: "SWE-bench", slug: "docs/guides/swebench" },
            { label: "τ²-bench", slug: "docs/guides/tau2" },
            { label: "BrowseComp-Plus", slug: "docs/guides/browsecomp-plus" },
            { label: "DeepResearch Bench", slug: "docs/guides/deepresearch-bench" },
            { label: "LongMemEval-V2", slug: "docs/guides/longmemeval" },
            { label: "Mind2Web 2", slug: "docs/guides/mind2web2" },
          ],
        },
        {
          label: "Build & Operate",
          items: [
            { label: "Building Worlds", slug: "docs/guides/building-worlds" },
            { label: "Configuration", slug: "docs/guides/configuration" },
            { label: "Deployment", slug: "docs/guides/deployment" },
            { label: "Operator Runbook", slug: "docs/guides/operator-runbook" },
            { label: "Testing", slug: "docs/guides/testing" },
            { label: "Dashboard Accessibility", slug: "docs/guides/dashboard-accessibility" },
            { label: "Federation", slug: "docs/guides/federation" },
            { label: "Federation Discovery", slug: "docs/guides/federation-discovery" },
            { label: "World Collective", slug: "docs/guides/world-collective" },
            { label: "Release Qualification", slug: "docs/guides/release-qualification" },
            { label: "Troubleshooting", slug: "docs/guides/troubleshooting" },
            { label: "Extending Marina", slug: "docs/guides/extending" },
            { label: "Running on a Single Model", slug: "docs/guides/single-model" },
            { label: "Backup and Recovery", slug: "docs/guides/recovery" },
            { label: "Compatibility and Upgrades", slug: "docs/guides/compatibility" },
            { label: "Supply Chain", slug: "docs/guides/supply-chain" },
            { label: "Scripts Reference", slug: "docs/guides/scripts" },
          ],
        },
      ],
    }),
  ],
});
