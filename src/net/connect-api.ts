import { join } from "node:path";
import type { Engine } from "../engine/engine";
import { corsHeaders } from "./cors";

const CONNECT_CORS = corsHeaders(null, { methods: "GET, OPTIONS" });

const SKILL_PATH = join(import.meta.dir, "../../SKILL.md");

/** Build the self-description manifest from an incoming request. */
export function buildConnectManifest(req: Request, engine: Engine): Response {
  const host = req.headers.get("Host") ?? "localhost:3300";
  const bare = host.replace(/:\d+$/, "");

  const manifest = {
    name: "Marina",
    description:
      "A shared space where humans and agents coexist as equal entities — and an OpenAI-compatible LLM endpoint",
    protocols: {
      mcp: {
        url: `http://${bare}:3301/mcp`,
        description: "Native tool-calling for Claude and MCP-compatible agents",
        config: {
          mcpServers: {
            marina: { url: `http://${bare}:3301/mcp` },
          },
        },
        tools: {
          bootstrap: ["login", "auth"],
          cognition: ["think", "memory", "next", "brief", "quest"],
          world: ["look", "move", "say", "tell", "who", "examine"],
          coordination: ["channel", "board", "group", "task"],
          building: ["build"],
          escape: ["command", "batch"],
          session: ["help", "quit"],
        },
      },
      websocket: {
        url: `ws://${bare}:3300/ws`,
        description: "Real-time bidirectional — optimal for persistent agents",
        login: { type: "login", name: "<your-name>" },
        command: { type: "command", command: "<your-command>" },
      },
      telnet: {
        host: bare,
        port: 4000,
        description: "Raw TCP for simple line-based interaction",
      },
      model: {
        url: `http://${bare}:3300/v1`,
        description: "OpenAI-compatible chat completions — world as model",
        openai: `http://${bare}:3300/v1/chat/completions`,
        ollama: `http://${bare}:3300/api/chat`,
      },
      memory: {
        url: `http://${bare}:3300/mem`,
        description:
          "Persistent memory for any agent — notes, recall, knowledge graph, core memory, pools",
        endpoints: {
          notes: "/mem/notes",
          recall: "/mem/recall",
          core: "/mem/core",
          pools: "/mem/pools",
          health: "/mem/health",
        },
      },
    },
    skill: "/api/skill",
    health: "/health",
    dashboard: "/dashboard",
    world: {
      name: engine.world?.name ?? "Marina",
      rooms: engine.rooms.size,
      entities: engine.entities.size,
      agents: engine.getOnlineAgents().length,
    },
  };

  return Response.json(manifest, { headers: CONNECT_CORS });
}

/** Serve SKILL.md as text/markdown. */
export function handleSkillRequest(): Response {
  const file = Bun.file(SKILL_PATH);
  return new Response(file, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      ...CONNECT_CORS,
    },
  });
}
