// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// @ts-check
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";

// GitHub Pages base path. The public project site uses /marina; custom-domain
// deployments can override this with SITE_BASE=/.
const base = process.env.SITE_BASE ?? "/";
const site = process.env.SITE_URL ?? "https://h2oai.github.io";
const asset = (path) => `${base === "/" ? "" : base}/${path.replace(/^\//, "")}`;

export default defineConfig({
  site,
  base,
  trailingSlash: "ignore",
  integrations: [
    starlight({
      title: "Marina",
      description:
        "A civilization for the future — a persistent world where humans and autonomous AI agents share memory, tools, reputation, and the same interface.",
      favicon: asset("favicon.png"),
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
          ],
        },
        {
          label: "Cognition & Coordination",
          items: [
            { label: "Memory System", slug: "docs/guides/memory" },
            { label: "Memory API", slug: "docs/guides/memory-api" },
            { label: "Coordination", slug: "docs/guides/coordination" },
            { label: "Cognitive Provenance", slug: "docs/guides/cognitive-provenance" },
            {
              label: "Economics, Simulation & Recursion",
              slug: "docs/guides/economics-simulation-and-recursion",
            },
            { label: "Agent Development", slug: "docs/guides/agent-development" },
          ],
        },
        {
          label: "Capabilities",
          items: [
            { label: "Coding in Marina", slug: "docs/guides/coding" },
            { label: "Prediction Markets", slug: "docs/guides/markets" },
            { label: "Media Generation", slug: "docs/guides/media" },
          ],
        },
        {
          label: "Interfaces",
          items: [
            { label: "Model API (OpenAI-compatible)", slug: "docs/guides/model-api" },
            { label: "MCP Integration", slug: "docs/guides/mcp-integration" },
            { label: "Dashboard", slug: "docs/guides/dashboard" },
            { label: "Execution Traces", slug: "docs/guides/observability" },
            { label: "Identity & Workload Security", slug: "docs/guides/identity" },
            { label: "Discord & Telegram", slug: "docs/guides/chat-adapters" },
          ],
        },
        {
          label: "Build & Operate",
          items: [
            { label: "Building Worlds", slug: "docs/guides/building-worlds" },
            { label: "Configuration", slug: "docs/guides/configuration" },
            { label: "Deployment", slug: "docs/guides/deployment" },
            { label: "Federation", slug: "docs/guides/federation" },
            { label: "Federation Discovery", slug: "docs/guides/federation-discovery" },
            { label: "World Collective", slug: "docs/guides/world-collective" },
            { label: "Release Qualification", slug: "docs/guides/release-qualification" },
            { label: "Troubleshooting", slug: "docs/guides/troubleshooting" },
          ],
        },
      ],
    }),
  ],
});
