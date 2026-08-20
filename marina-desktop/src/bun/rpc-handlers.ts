// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { testKeyConnectivity } from "../../../src/engine/commands/key";
import { discoverModels } from "../../../src/net/model-discovery";
import type { Connection, EntityId, Perception } from "../../../src/types";
import type { EngineHost } from "./engine-host";
import type {
  AgentSpawnParams,
  ApiProxyParams,
  ApiKeyParams,
  CreateCanvasParams,
  CreateNodeParams,
  DeleteNodeParams,
  EngineStatusData,
  PreferencesData,
  SystemData,
  UpdateNodeParams,
  UploadAssetParams,
  WorldData,
} from "./rpc-schema";

/**
 * Build the RPC request handler object for the bun side.
 * Each handler receives `params` (matching the schema) and returns the response.
 * Mirrors the data shapes returned by src/net/dashboard-api.ts.
 */
export function createRpcHandlers(
  engineHost: () => EngineHost | null,
  appActions: {
    getPreferences: () => PreferencesData;
    setPreferences: (prefs: Partial<PreferencesData>) => void;
    switchToRemote: (url: string) => Promise<void>;
    switchToLocal: () => Promise<void>;
  },
  gamePush: (perception: unknown) => void,
  canvasPush: (event: unknown) => void,
) {
  function requireEngine() {
    const host = engineHost();
    if (!host || !host.isRunning) {
      throw new Error("Engine not running");
    }
    return { engine: host.getEngine()!, db: host.getDb()! };
  }

  function requireStorage() {
    const host = engineHost();
    return host?.getStorage() ?? null;
  }

  // ── Virtual game connection for the desktop web chat ──
  let desktopGameConn: Connection | null = null;
  let gameConnCounter = 0;

  function maskKey(value: string): string {
    if (value.length <= 8) return "****";
    return `${value.slice(0, 4)}...${value.slice(-4)}`;
  }

  return {
    getWorld(): WorldData {
      const { engine } = requireEngine();

      const rooms = engine.rooms.all().map((r) => {
        const district = (r.id as string).split("/")[0] ?? "";
        const entities = engine.entities.inRoom(r.id);
        return {
          id: r.id as string,
          short: r.module.short,
          district,
          exits: Object.fromEntries(
            Object.entries(r.module.exits ?? {}).map(([k, v]) => [
              k,
              v as string,
            ]),
          ),
          entityCount: entities.length,
        };
      });

      const entities = engine.entities.all().map((e) => ({
        id: e.id as string,
        name: e.name,
        kind: e.kind,
        room: e.room as string,
        rank: (e.properties.rank as number) ?? 0,
      }));

      return { rooms, entities };
    },

    getSystem(): SystemData {
      const { engine, db } = requireEngine();

      const allEntities = engine.entities.all();
      const agents = allEntities.filter((e) => e.kind === "agent");
      const npcs = allEntities.filter((e) => e.kind === "npc");
      const roomPops: Record<string, number> = {};
      for (const e of agents) {
        roomPops[e.room as string] =
          (roomPops[e.room as string] ?? 0) + 1;
      }

      const mem = process.memoryUsage();
      const result: SystemData = {
        status: "ok",
        uptime: engine.getUptime(),
        connections: engine.getConnections().size,
        rooms: engine.rooms.size,
        entities: {
          total: allEntities.length,
          agents: agents.length,
          npcs: npcs.length,
        },
        roomPopulations: roomPops,
        memory: { heapUsed: mem.heapUsed, rss: mem.rss },
      };

      if (db) {
        const allTasks = db.listTasks({ limit: 1000 });
        const taskCounts = {
          open: 0,
          claimed: 0,
          submitted: 0,
          completed: 0,
        };
        for (const t of allTasks) {
          if (t.status in taskCounts) {
            taskCounts[t.status as keyof typeof taskCounts]++;
          }
        }
        result.tasks = taskCounts;
        result.projectCount = db.listProjects().length;
        result.connectorCount = db.listConnectors().length;
        result.commandCount = db.listCommands().length;
      }

      return result;
    },

    getEntities(): unknown[] {
      const { engine } = requireEngine();
      return engine.entities.all().map((e) => ({
        id: e.id as string,
        name: e.name,
        kind: e.kind,
        room: e.room as string,
        rank: (e.properties.rank as number) ?? 0,
      }));
    },

    getRoomDetail(roomId: string): unknown {
      const { engine, db } = requireEngine();
      const room = engine.rooms.get(roomId as any);
      if (!room) return { error: "Room not found" };

      const entities = engine.entities.inRoom(room.id).map((e) => ({
        id: e.id as string,
        name: e.name,
        kind: e.kind,
      }));

      const longText =
        typeof room.module.long === "string" ? room.module.long : "[dynamic]";

      const items: Record<string, string> = {};
      if (room.module.items) {
        for (const [key, val] of Object.entries(room.module.items)) {
          items[key] = typeof val === "string" ? val : "[dynamic]";
        }
      }

      let source: string | undefined;
      if (db) {
        const src = db.getRoomSource(roomId);
        if (src) source = src.source;
      }

      return {
        id: room.id as string,
        short: room.module.short,
        long: longText,
        exits: room.module.exits ?? {},
        items,
        entities,
        source,
      };
    },

    getEntityDetail(name: string): unknown {
      const { engine, db } = requireEngine();
      const entity = engine.findEntityGlobal(name);
      if (!entity) return { error: "Entity not found" };

      const result: Record<string, unknown> = {
        id: entity.id as string,
        name: entity.name,
        kind: entity.kind,
        room: entity.room as string,
        rank: (entity.properties.rank as number) ?? 0,
        properties: entity.properties,
        inventory: entity.inventory,
      };

      if (db) {
        result.coreMemory = db.listCoreMemory(entity.name);
        result.notes = db.getNotesByEntity(entity.name, 10);
        result.recentActivity = db.getEventsByEntity(entity.id, 20);
      }

      return result;
    },

    async deleteEntity(name: string): Promise<unknown> {
      const { engine } = requireEngine();
      const entity = engine.findEntityGlobal(name);
      if (!entity) return { error: "Entity not found" };
      const result = await engine.removeEntity(entity.id);
      if ("error" in result) return { error: result.error };
      return { ok: true, name: result.name };
    },

    getBoards(): unknown[] {
      const { db } = requireEngine();
      return db.getAllBoards().map((b) => {
        const posts = db.listBoardPosts(b.id, { limit: 1000 });
        return { ...b, postCount: posts.length };
      });
    },

    getBoardDetail(boardName: string): unknown {
      const { db } = requireEngine();
      const boards = db.getAllBoards();
      const board = boards.find((b) => b.name === boardName);
      if (!board) return { error: "Board not found" };

      const allPosts = db.listBoardPosts(board.id, { limit: 1000 });
      const posts = db.listBoardPosts(board.id, { limit: 5 }).map((p) => ({
        id: p.id,
        title: p.title,
        body: p.body,
        author_name: p.author_name,
        created_at: p.created_at,
      }));

      return {
        id: board.id,
        name: board.name,
        scope_type: board.scope_type,
        postCount: allPosts.length,
        created_at: board.created_at,
        posts,
      };
    },

    getTasks(): unknown[] {
      const { db } = requireEngine();
      return db.listTasks({ limit: 50 });
    },

    getTaskDetail(taskId: number): unknown {
      const { db } = requireEngine();
      const task = db.getTask(taskId);
      if (!task) return { error: "Task not found" };

      const children = db
        .listTasks({ parentId: taskId, limit: 50 })
        .map((t) => ({
          id: t.id,
          title: t.title,
          status: t.status,
          creator_name: t.creator_name,
          created_at: t.created_at,
        }));

      return {
        id: task.id,
        title: task.title,
        status: task.status,
        description: task.description,
        creator_name: task.creator_name,
        parent_task_id: task.parent_task_id,
        created_at: task.created_at,
        children: children.length > 0 ? children : undefined,
      };
    },

    getChannels(): unknown[] {
      const { db } = requireEngine();
      return db.getAllChannels().map((c) => {
        const history = db.getChannelHistory(c.id, 1);
        return { ...c, messageCount: history.length > 0 ? "1+" : "0" };
      });
    },

    getChannelDetail(channelName: string): unknown {
      const { db } = requireEngine();
      const channels = db.getAllChannels();
      const channel = channels.find((c) => c.name === channelName);
      if (!channel) return { error: "Channel not found" };

      const allHistory = db.getChannelHistory(channel.id, 1);
      const messages = db.getChannelHistory(channel.id, 5).map((m) => ({
        sender_name: m.sender_name,
        content: m.content,
        created_at: m.created_at,
      }));

      return {
        id: channel.id,
        name: channel.name,
        type: channel.type,
        messageCount: allHistory.length > 0 ? "1+" : "0",
        messages,
      };
    },

    getGroups(): unknown[] {
      const { db } = requireEngine();
      return db.getAllGroups().map((g) => {
        const members = db.getGroupMembers(g.id);
        return { ...g, memberCount: members.length };
      });
    },

    getGroupDetail(groupName: string): unknown {
      const { db } = requireEngine();
      const groups = db.getAllGroups();
      const group = groups.find((g) => g.name === groupName);
      if (!group) return { error: "Group not found" };

      const members = db.getGroupMembers(group.id);
      return {
        id: group.id,
        name: group.name,
        description: group.description,
        leader_id: group.leader_id,
        memberCount: members.length,
        members: members.map((m) => ({
          entity_id: m.entity_id,
          rank: m.rank,
          joined_at: m.joined_at,
        })),
      };
    },

    getProjects(): unknown[] {
      const { db } = requireEngine();
      return db.listProjects().map((p) => {
        let bundleProgress: { total: number; done: number } | undefined;
        if (p.bundle_id) {
          const children = db.listTasks({
            parentId: p.bundle_id,
            limit: 200,
          });
          const done = children.filter(
            (t) => t.status === "completed",
          ).length;
          bundleProgress = { total: children.length, done };
        }
        return {
          id: p.id,
          name: p.name,
          description: p.description,
          orchestration: p.orchestration,
          memory_arch: p.memory_arch,
          status: p.status,
          bundle_id: p.bundle_id,
          pool_id: p.pool_id,
          group_id: p.group_id,
          created_by: p.created_by,
          bundleProgress,
        };
      });
    },

    getConnectors(): unknown[] {
      const { db } = requireEngine();
      return db.listConnectors().map((c) => ({
        id: c.id,
        name: c.name,
        transport: c.transport,
        url: c.url,
        status: c.status,
        auth_type: c.auth_type,
        created_by: c.created_by,
      }));
    },

    getCommands(): unknown[] {
      const { db } = requireEngine();
      return db.listCommands().map((c) => ({
        id: c.id,
        name: c.name,
        version: c.version,
        valid: c.valid,
        created_by: c.created_by,
        created_at: c.created_at,
      }));
    },

    getMemoryPools(): unknown[] {
      const { db } = requireEngine();
      return db.listMemoryPools();
    },

    getMemoryNotes(entityName: string): unknown[] {
      const { db } = requireEngine();
      return db.getNotesByEntity(entityName, 50);
    },

    getMemoryCore(entityName: string): unknown[] {
      const { db } = requireEngine();
      return db.listCoreMemory(entityName);
    },

    getEvents(limit: number): unknown[] {
      const { engine } = requireEngine();
      const cap = Math.min(limit || 100, 500);
      return engine
        .getEventLog()
        .filter((e) => e.type !== "tick")
        .slice(-cap);
    },

    getEngineStatus(): EngineStatusData {
      const host = engineHost();
      if (!host) {
        return {
          running: false,
          uptime: 0,
          entityCount: 0,
          agentCount: 0,
          roomCount: 0,
          connectionCount: 0,
          memory: { heapUsed: 0, rss: 0 },
        };
      }
      return host.getStatus();
    },

    getPreferences(): PreferencesData {
      return appActions.getPreferences();
    },

    setPreferences(prefs: Partial<PreferencesData>): { ok: boolean } {
      appActions.setPreferences(prefs);
      return { ok: true };
    },

    async connectRemote(
      url: string,
    ): Promise<{ ok: boolean; error?: string }> {
      try {
        const healthUrl = `${url.replace(/\/$/, "")}/health`;
        const res = await fetch(healthUrl, {
          signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) {
          return { ok: false, error: `Server returned ${res.status}` };
        }
        await appActions.switchToRemote(url);
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : "Failed to connect",
        };
      }
    },

    async switchToLocal(): Promise<{ ok: boolean }> {
      await appActions.switchToLocal();
      return { ok: true };
    },

    // ── Game chat handlers ──

    gameConnect(): { connId: string } {
      const { engine } = requireEngine();

      // Clean up previous connection
      if (desktopGameConn) {
        engine.removeConnection(desktopGameConn.id);
      }

      const connId = `desktop_${++gameConnCounter}`;
      desktopGameConn = {
        id: connId,
        protocol: "websocket",
        entity: null,
        connectedAt: Date.now(),
        send(perception: Perception) {
          gamePush(perception);
        },
        close() {
          /* no-op for desktop */
        },
      };

      engine.addConnection(desktopGameConn);

      // Send welcome
      gamePush({
        kind: "system",
        timestamp: Date.now(),
        data: { text: "Welcome to Marina. Enter your name to begin." },
      });

      return { connId };
    },

    gameSend(raw: string): void {
      if (!desktopGameConn) throw new Error("Not connected");
      const { engine } = requireEngine();

      let parsed: {
        type: string;
        name?: string;
        command?: string;
        token?: string;
      };
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = { type: "command", command: raw };
      }

      if (parsed.type === "login" && parsed.name) {
        const result = engine.login(desktopGameConn.id, parsed.name);
        if ("error" in result) {
          gamePush({
            kind: "error",
            timestamp: Date.now(),
            data: { text: result.error },
          });
          return;
        }
        gamePush({
          kind: "system",
          timestamp: Date.now(),
          data: {
            text: `Logged in as ${parsed.name}.`,
            entityId: result.entityId,
            token: result.token,
          },
        });
        engine.sendLook(result.entityId);
        engine.sendBrief(result.entityId);
        return;
      }

      if (parsed.type === "auth" && parsed.token) {
        const result = engine.reconnect(desktopGameConn.id, parsed.token);
        if ("error" in result) {
          gamePush({
            kind: "error",
            timestamp: Date.now(),
            data: { text: result.error },
          });
          return;
        }
        gamePush({
          kind: "system",
          timestamp: Date.now(),
          data: {
            text: `Reconnected as ${result.name}.`,
            entityId: result.entityId,
          },
        });
        engine.sendLook(result.entityId);
        return;
      }

      if (parsed.type === "command" && parsed.command) {
        const entityId = engine.getConnectionEntity(desktopGameConn.id);
        if (entityId) {
          engine.processCommand(entityId, parsed.command);
        } else {
          gamePush({
            kind: "error",
            timestamp: Date.now(),
            data: {
              text: 'Not logged in. Enter your name to begin.',
            },
          });
        }
      }
    },

    gameDisconnect(): void {
      if (desktopGameConn) {
        const host = engineHost();
        if (host?.isRunning) {
          host.getEngine()?.removeConnection(desktopGameConn.id);
        }
        desktopGameConn = null;
      }
    },

    // These handlers are available only to the bundled local webview. Remote
    // mode loads the server dashboard, where normal HTTP authorization applies.
    getKeys(): unknown[] {
      const { db } = requireEngine();
      return db.getAllApiKeys().map((key) => ({
        name: key.name,
        provider: key.provider,
        masked: maskKey(key.encrypted_value),
        setBy: key.set_by,
        updatedAt: key.updated_at,
      }));
    },

    addKey(params: ApiKeyParams): unknown {
      if (!params.name?.trim() || !params.provider?.trim() || !params.value?.trim()) {
        return { error: "name, provider, and value are required" };
      }
      const { db } = requireEngine();
      db.saveApiKey({
        name: params.name.trim(),
        provider: params.provider.trim(),
        encryptedValue: params.value.trim(),
        isEncrypted: false,
        setBy: "desktop",
      });
      return { ok: true, name: params.name.trim(), provider: params.provider.trim() };
    },

    deleteKey(name: string): unknown {
      const { db } = requireEngine();
      if (!db.getApiKey(name)) return { error: "Key not found" };
      db.deleteApiKey(name);
      return { ok: true };
    },

    async testKey(name: string): Promise<unknown> {
      const { db } = requireEngine();
      const key = db.getApiKey(name);
      if (!key) return { error: "Key not found" };
      const result = await testKeyConnectivity(key.provider, key.encrypted_value);
      return { name, provider: key.provider, ...result };
    },

    getModels(): Promise<unknown> {
      const { db } = requireEngine();
      return discoverModels(db);
    },

    getDefaultModel(): unknown {
      const { db } = requireEngine();
      return { model: db.getDefaultModel(), configured: db.getSetting("default_model") ?? null };
    },

    setDefaultModel(model: string): unknown {
      const value = model.trim();
      if (!/^[\w.-]+\/[\w./:-]+$/.test(value)) {
        return { error: 'model must be "provider/model-id"' };
      }
      const { db } = requireEngine();
      db.setSetting("default_model", value);
      return { ok: true, model: db.getDefaultModel(), configured: value };
    },

    clearDefaultModel(): unknown {
      const { db } = requireEngine();
      db.deleteSetting("default_model");
      return { ok: true, model: db.getDefaultModel(), configured: null };
    },

    getRoles(): unknown[] {
      return requireEngine().db.getAllRoles();
    },

    getAgents(): unknown[] {
      return requireEngine().engine.agentRuntime.list();
    },

    async spawnAgent(params: AgentSpawnParams): Promise<unknown> {
      if (!params.name?.trim()) return { error: "name is required" };
      try {
        const { engine } = requireEngine();
        const handle = await engine.agentRuntime.spawn({
          ...params,
          name: params.name.trim(),
          spawnedBy: "operator",
        });
        const status = handle.getStatus();
        engine.logEvent({
          type: "agent_spawn",
          entity: (status.entityId ?? "") as EntityId,
          name: params.name.trim(),
          model: status.model,
          role: status.role ?? "",
          timestamp: Date.now(),
        });
        return status;
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    },

    async stopAgent(name: string): Promise<unknown> {
      try {
        const { engine } = requireEngine();
        const status = engine.agentRuntime.get(name)?.getStatus();
        await engine.agentRuntime.stop(name);
        engine.logEvent({
          type: "agent_stop",
          entity: (status?.entityId ?? "") as EntityId,
          name,
          reason: "manual",
          timestamp: Date.now(),
        });
        return { ok: true };
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    },

    async sendAgentAttention(params: { name: string; message: string }): Promise<unknown> {
      const agent = requireEngine().engine.agentRuntime.get(params.name);
      if (!agent) return { error: "Agent not found" };
      if (!params.message.trim()) return { error: "message is required" };
      await agent.sendAttention(params.message.trim());
      return { ok: true };
    },

    async proxyApi(
      params: ApiProxyParams,
    ): Promise<{ status: number; contentType: string; body: string }> {
      if (!params.path.startsWith("/api/") || params.path.includes("://")) {
        return {
          status: 400,
          contentType: "application/json",
          body: JSON.stringify({ error: "Invalid local API path" }),
        };
      }
      const prefs = appActions.getPreferences();
      const headers = { ...params.headers };
      delete headers["x-marina-desktop-token"];
      headers["x-marina-desktop-token"] = process.env.MARINA_DESKTOP_API_TOKEN ?? "";
      const response = await fetch(`http://127.0.0.1:${prefs.wsPort}${params.path}`, {
        method: params.method,
        headers,
        body: params.body,
      });
      return {
        status: response.status,
        contentType: response.headers.get("content-type") ?? "application/json",
        body: await response.text(),
      };
    },

    // ── Canvas handlers ──

    getCanvases(): unknown[] {
      const { db } = requireEngine();
      return db.listCanvases({ limit: 50 });
    },

    getCanvasDetail(id: string): unknown {
      const { db } = requireEngine();
      const storage = requireStorage();
      const canvas = db.getCanvas(id);
      if (!canvas) return { error: "Canvas not found" };
      const nodes = db.getNodesByCanvas(id).map((n) => enrichNode(n, db, storage));
      return { ...canvas, nodes };
    },

    createCanvas(params: CreateCanvasParams): unknown {
      const { db } = requireEngine();
      const existing = db.getCanvasByName(params.name);
      if (existing) return { error: "Canvas name already exists" };
      const id = crypto.randomUUID();
      db.createCanvas({
        id,
        name: params.name,
        description: params.description ?? "",
        scope: params.scope ?? "global",
        scopeId: params.scope_id,
        creatorName: params.creator_name ?? "desktop",
      });
      return db.getCanvas(id);
    },

    deleteCanvas(id: string): unknown {
      const { db } = requireEngine();
      const deleted = db.deleteCanvas(id);
      if (!deleted) return { error: "Canvas not found" };
      return { ok: true, id };
    },

    createNode(params: CreateNodeParams): unknown {
      const { db } = requireEngine();
      const storage = requireStorage();
      const canvas = db.getCanvas(params.canvas_id);
      if (!canvas) return { error: "Canvas not found" };
      const id = crypto.randomUUID();
      db.createNode({
        id,
        canvasId: params.canvas_id,
        type: params.type ?? "text",
        x: params.x,
        y: params.y,
        width: params.width,
        height: params.height,
        assetId: params.asset_id,
        data: params.data,
        creatorName: params.creator_name ?? "desktop",
      });
      const node = db.getNode(id)!;
      const enriched = enrichNode(node, db, storage);
      canvasPush({ type: "node_added", canvasId: params.canvas_id, node: enriched });
      return enriched;
    },

    updateNode(params: UpdateNodeParams): unknown {
      const { db } = requireEngine();
      const storage = requireStorage();
      const updated = db.updateNode(params.id, {
        x: params.x,
        y: params.y,
        width: params.width,
        height: params.height,
        data: params.data ? JSON.stringify(params.data) : undefined,
      });
      if (!updated) return { error: "Node not found" };
      const node = db.getNode(params.id)!;
      const enriched = enrichNode(node, db, storage);
      canvasPush({
        type: "node_updated",
        canvasId: params.canvas_id,
        nodeId: params.id,
        changes: enriched,
      });
      return enriched;
    },

    deleteNode(params: DeleteNodeParams): unknown {
      const { db } = requireEngine();
      const storage = requireStorage();
      const node = db.getNode(params.id);
      if (!node) return { error: "Node not found" };
      // Clean up associated asset
      if (node.asset_id && storage) {
        const asset = db.getAsset(node.asset_id);
        if (asset) {
          storage.delete(asset.storage_key);
          db.deleteAsset(node.asset_id);
        }
      }
      db.deleteNode(params.id);
      canvasPush({ type: "node_deleted", canvasId: params.canvas_id, nodeId: params.id });
      return { ok: true, id: params.id };
    },

    getNode(params: { canvas_id: string; node_id: string }): unknown {
      const { db } = requireEngine();
      const storage = requireStorage();
      const node = db.getNode(params.node_id);
      if (!node || node.canvas_id !== params.canvas_id) return { error: "Node not found" };
      return enrichNode(node, db, storage);
    },

    // ── Asset handlers ──

    getAssets(): unknown[] {
      const { db } = requireEngine();
      const storage = requireStorage();
      return db.listAssets({ limit: 50 }).map((a) => ({
        ...a,
        metadata: JSON.parse(a.metadata),
        url: storage?.resolve(a.storage_key),
      }));
    },

    getAssetDetail(id: string): unknown {
      const { db } = requireEngine();
      const storage = requireStorage();
      const asset = db.getAsset(id);
      if (!asset) return { error: "Asset not found" };
      return {
        ...asset,
        metadata: JSON.parse(asset.metadata),
        url: storage?.resolve(asset.storage_key),
      };
    },

    async uploadAsset(params: UploadAssetParams): Promise<unknown> {
      const { db } = requireEngine();
      const storage = requireStorage();
      if (!storage) return { error: "Storage not available" };
      const data = Uint8Array.from(atob(params.dataBase64), (c) => c.charCodeAt(0));
      if (data.byteLength === 0) return { error: "Empty file" };
      if (data.byteLength > 50 * 1024 * 1024) return { error: "File too large (max 50MB)" };
      const id = crypto.randomUUID();
      const ext = params.filename.includes(".")
        ? params.filename.slice(params.filename.lastIndexOf("."))
        : "";
      const storageKey = `${id}${ext}`;
      await storage.put(storageKey, data, params.mime);
      db.createAsset({
        id,
        entityName: params.entity ?? "system",
        filename: params.filename,
        mimeType: params.mime,
        size: data.byteLength,
        storageKey,
      });
      const asset = db.getAsset(id)!;
      return {
        ...asset,
        metadata: JSON.parse(asset.metadata),
        url: storage.resolve(asset.storage_key),
      };
    },

    async deleteAsset(id: string): Promise<unknown> {
      const { db } = requireEngine();
      const storage = requireStorage();
      const asset = db.getAsset(id);
      if (!asset) return { error: "Asset not found" };
      if (storage) {
        await storage.delete(asset.storage_key);
      }
      db.deleteAsset(id);
      return { ok: true, id };
    },
  };
}

/** Enrich a raw canvas node row with resolved asset URL and parsed data. */
function enrichNode(
  node: { asset_id: string | null; data: string },
  db: {
    getAsset(id: string): { storage_key: string; filename: string; mime_type: string } | undefined;
  },
  storage: { resolve(key: string): string } | null,
): Record<string, unknown> {
  const parsed = JSON.parse(node.data as string);
  let url: string | undefined;
  let filename: string | undefined;
  let mime: string | undefined;
  if (node.asset_id && storage) {
    const asset = db.getAsset(node.asset_id);
    if (asset) {
      url = storage.resolve(asset.storage_key);
      filename = asset.filename;
      mime = asset.mime_type;
    }
  }
  return {
    ...node,
    data: {
      ...parsed,
      url: url ?? parsed.url,
      filename: filename ?? parsed.filename,
      mime: mime ?? parsed.mime,
    },
  };
}
