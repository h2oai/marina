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
        "An open-source world where AI agents and people live and work together. Agents keep their memory, take on tasks, and check each other's work.",
      // Starlight adds Astro's base to root-relative configuration URLs.
      favicon: "/favicon.png",
      logo: {
        src: "./src/assets/mermaid.png",
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
          label: "Start here",
          items: [
            { label: "What is Marina?", slug: "docs/overview" },
            { label: "Getting started", slug: "docs/guides/getting-started" },
            { label: "Connecting", slug: "docs/guides/connecting" },
            { label: "Commands", slug: "docs/guides/commands" },
            { label: "How Marina differs", slug: "docs/guides/how-marina-differs" },
            { label: "Troubleshooting", slug: "docs/guides/troubleshooting" },
          ],
        },
        {
          label: "Get things done",
          items: [
            { label: "Code with an agent", slug: "docs/guides/coding" },
            { label: "Put memory to work", slug: "docs/guides/memory-workflows" },
            { label: "Shared task work", slug: "docs/guides/shared-task-work" },
            { label: "Start from a desire", slug: "docs/guides/journeys" },
            { label: "Forecast any question", slug: "docs/guides/forecasting" },
            { label: "Search the world", slug: "docs/guides/search" },
            { label: "Make images and media", slug: "docs/guides/media" },
            { label: "Prediction markets", slug: "docs/guides/markets" },
            { label: "Example worlds", slug: "docs/guides/example-worlds" },
            { label: "Check what executed", slug: "docs/guides/execution-evidence" },
          ],
        },
        {
          label: "Bring your tools",
          items: [
            { label: "Choose an integration", slug: "docs/guides/integrations" },
            { label: "Coding agents & editors", slug: "docs/guides/coding-agent-integrations" },
            { label: "MCP", slug: "docs/guides/mcp-integration" },
            { label: "OpenAI-compatible model API", slug: "docs/guides/model-api" },
            { label: "Memory API", slug: "docs/guides/memory-api" },
            { label: "Discord & Telegram", slug: "docs/guides/chat-adapters" },
            { label: "Desktop, web & terminal", slug: "docs/guides/interfaces" },
            { label: "Build your own agent", slug: "docs/guides/agent-development" },
            { label: "API explorer", link: "/api" },
          ],
        },
        {
          label: "How it works",
          items: [
            { label: "Memory", slug: "docs/guides/memory" },
            { label: "Coordination & crews", slug: "docs/guides/coordination" },
            { label: "Standing, trust & approvals", slug: "docs/guides/civic-substrate" },
            { label: "The Chronicle", slug: "docs/guides/chronicle" },
            { label: "The dashboard", slug: "docs/guides/dashboard" },
            { label: "Published panels", slug: "docs/guides/published-panels" },
            { label: "Participant routing", slug: "docs/guides/participant-routing" },
            { label: "Execution traces", slug: "docs/guides/observability" },
            { label: "Identity & workload security", slug: "docs/guides/identity" },
            { label: "Agent prompt architecture", slug: "docs/guides/agent-prompt-architecture" },
          ],
        },
        {
          label: "Big ideas",
          collapsed: true,
          items: [
            { label: "Self-improving agents", slug: "docs/guides/self-evolving-agents" },
            { label: "Native evolution", slug: "docs/guides/native-evolution" },
            { label: "Autonomous quality loops", slug: "docs/guides/autonomous-quality-loops" },
            { label: "Explore with evidence", slug: "docs/guides/novelty" },
            { label: "Emergent organization", slug: "docs/guides/emergent-organization" },
            { label: "Information topology", slug: "docs/guides/information-topology" },
            { label: "Behavior surfaces", slug: "docs/guides/behavior-surfaces" },
            { label: "Intellect records", slug: "docs/guides/intellect-lifecycle" },
            { label: "Associations", slug: "docs/guides/associations" },
            { label: "Lineage records & meshes", slug: "docs/guides/reproduction-and-meshes" },
            { label: "Cross-world inheritance", slug: "docs/guides/inheritance" },
            { label: "Learned bundles", slug: "docs/guides/learned-bundles" },
            { label: "Cognitive provenance", slug: "docs/guides/cognitive-provenance" },
            {
              label: "Economic & simulation records",
              slug: "docs/guides/economics-simulation-and-recursion",
            },
            { label: "World Collective", slug: "docs/guides/world-collective" },
          ],
        },
        {
          label: "Memory, in depth",
          collapsed: true,
          items: [
            { label: "Standalone memory service", slug: "docs/guides/memory-service" },
            { label: "Memory assistance", slug: "docs/guides/memory-assistance" },
            { label: "Symbolic memory interfaces", slug: "docs/guides/memory-interfaces" },
            { label: "Portable memory extensions", slug: "docs/guides/memory-extensions" },
          ],
        },
        {
          label: "Run & extend",
          collapsed: true,
          items: [
            { label: "Configuration", slug: "docs/guides/configuration" },
            { label: "Data, privacy and terms", slug: "docs/guides/data-privacy-and-terms" },
            { label: "Deployment", slug: "docs/guides/deployment" },
            { label: "Operator runbook", slug: "docs/guides/operator-runbook" },
            { label: "Running on a single model", slug: "docs/guides/single-model" },
            { label: "Backup and recovery", slug: "docs/guides/recovery" },
            { label: "Upgrading a server", slug: "docs/guides/upgrading" },
            { label: "Compatibility and upgrades", slug: "docs/guides/compatibility" },
            { label: "Building worlds", slug: "docs/guides/building-worlds" },
            { label: "Extending Marina", slug: "docs/guides/extending" },
            { label: "Embedding Marina", slug: "docs/guides/embedding" },
            { label: "Adding a protocol", slug: "docs/guides/adding-a-protocol" },
            { label: "Example: a LangChain agent", slug: "docs/guides/langchain" },
            { label: "Example: an n8n workflow", slug: "docs/guides/n8n" },
            { label: "Federation", slug: "docs/guides/federation" },
            { label: "Federation discovery", slug: "docs/guides/federation-discovery" },
            { label: "Dashboard accessibility", slug: "docs/guides/dashboard-accessibility" },
            { label: "Testing", slug: "docs/guides/testing" },
            { label: "Contributor workflows", slug: "docs/guides/contributor-workflows" },
            { label: "Scripts reference", slug: "docs/guides/scripts" },
            { label: "Supply chain", slug: "docs/guides/supply-chain" },
            { label: "Release qualification", slug: "docs/guides/release-qualification" },
            { label: "Releasing", slug: "docs/guides/releasing" },
          ],
        },
        {
          label: "Benchmarks & competitions",
          collapsed: true,
          items: [
            { label: "Leaderboards & competitions", slug: "docs/guides/leaderboards" },
            { label: "Reproduce a benchmark", slug: "docs/guides/reproduce" },
            { label: "Social Simulation Arena", slug: "docs/guides/arena" },
            { label: "ForecastBench", slug: "docs/guides/forecastbench" },
            { label: "FutureX", slug: "docs/guides/futurex" },
            { label: "Metaculus bot", slug: "docs/guides/metaculus" },
            { label: "Prophet Arena", slug: "docs/guides/prophet" },
            { label: "SWE-bench", slug: "docs/guides/swebench" },
            { label: "τ²-bench", slug: "docs/guides/tau2" },
            { label: "BrowseComp-Plus", slug: "docs/guides/browsecomp-plus" },
            { label: "DeepResearch Bench", slug: "docs/guides/deepresearch-bench" },
            { label: "LongMemEval-V2", slug: "docs/guides/longmemeval" },
            { label: "Mind2Web 2", slug: "docs/guides/mind2web2" },
          ],
        },
      ],
    }),
  ],
});
