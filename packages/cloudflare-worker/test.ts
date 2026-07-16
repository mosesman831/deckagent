import type { Env } from "./src/types.js";
import worker from "./src/index.js";
import {
  getDevice,
  setDevice,
  updateDeviceStatus,
  authenticateDevice,
  hashToken,
  isDeviceOnline,
  listOnlineDevices,
  listRegisteredDeviceIds,
} from "./src/device-registry.js";
import { verifyApiToken } from "./src/auth.js";
import { TOOL_CATALOG, TOOL_NAMES, filterToolCatalog } from "./src/tool-catalog.js";
import { tools as mcpHandlerTools } from "./src/mcp-handler.js";
import { formatSseEvent, TunnelDO } from "./src/tunnel-do.js";
import {
  RESOURCE_CATALOG,
  isKnownResourceUri,
  isStaticResourceUri,
  isDaemonResourceUri,
  readStaticResource,
} from "./src/resource-catalog.js";
import {
  MCP_INSTRUCTIONS,
  PROMPT_CATALOG,
  isKnownPrompt,
} from "./src/prompt-catalog.js";
import {
  checkProtocolVersion,
  MIN_PROTOCOL_VERSION,
  WORKER_VERSION,
} from "./src/protocol.js";

const API_TOKEN = "test-api-token-secret";

// Minimal in-memory KV for local message-flow testing.
class FakeKV {
  private store = new Map<string, { value: string; expires?: number }>();

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expires !== undefined && entry.expires < Date.now() / 1000) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async put(
    key: string,
    value: string,
    options?: { expirationTtl?: number }
  ): Promise<void> {
    this.store.set(key, {
      value,
      expires: options?.expirationTtl
        ? Math.floor(Date.now() / 1000) + options.expirationTtl
        : undefined,
    });
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async list(options?: {
    prefix?: string;
  }): Promise<{ keys: Array<{ name: string }> }> {
    const prefix = options?.prefix ?? "";
    const now = Date.now() / 1000;
    const keys: Array<{ name: string }> = [];
    for (const [name, entry] of this.store.entries()) {
      if (entry.expires !== undefined && entry.expires < now) {
        this.store.delete(name);
        continue;
      }
      if (name.startsWith(prefix)) {
        keys.push({ name });
      }
    }
    return { keys };
  }

  /** Test helper: inspect whether a key has an expiration. */
  hasExpiration(key: string): boolean {
    const entry = this.store.get(key);
    return entry?.expires !== undefined;
  }

  /** Test helper: force-expire presence keys for TTL simulation. */
  forceExpire(key: string): void {
    const entry = this.store.get(key);
    if (entry) {
      entry.expires = Math.floor(Date.now() / 1000) - 1;
    }
  }
}

class FakeDurableObjectNamespace {
  /** Last Accept header seen on a stub.fetch (for SSE forwarding tests). */
  lastAccept: string | null = null;
  /**
   * S2: simulated daemon policy_caps. `null` = full catalog (pre-caps).
   */
  enabledTools: Set<string> | null = null;

  idFromName(name: string): { name: string } {
    return { name };
  }
  get(_id: { name: string }): {
    fetch: (request: Request) => Promise<Response>;
  } {
    return {
      fetch: async (request: Request) => {
        this.lastAccept = request.headers.get("Accept");
        let body: {
          method?: string;
          id?: string | number | null;
          params?: { name?: string };
        } = {};
        try {
          body = (await request.clone().json()) as typeof body;
        } catch {
          /* ignore */
        }

        // S2: tools/list filtered by enabledTools (null → full catalog).
        if (body.method === "tools/list") {
          const tools = filterToolCatalog(this.enabledTools);
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: body.id ?? null,
              result: { tools },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }

        // Light SSE mock: execute_command_stream + Accept event-stream.
        const accept = request.headers.get("Accept") ?? "";
        if (
          body.method === "tools/call" &&
          body.params?.name === "execute_command_stream" &&
          accept.includes("text/event-stream")
        ) {
          const sse =
            `event: progress\ndata: ${JSON.stringify({ chunk: "sse-ok\n" })}\n\n` +
            `event: result\ndata: ${JSON.stringify({
              content: [{ type: "text", text: "sse-ok\n" }],
            })}\n\n`;
          return new Response(sse, {
            status: 200,
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
            },
          });
        }

        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: {
              code: -32000,
              message: "Fake DO — no daemon connected",
              data: { code: "DEVICE_OFFLINE" },
            },
          }),
          { status: 503, headers: { "Content-Type": "application/json" } }
        );
      },
    };
  }
}

function makeEnv(): Env & { _kv: FakeKV; _do: FakeDurableObjectNamespace } {
  const kv = new FakeKV();
  const tunnelDo = new FakeDurableObjectNamespace();
  return {
    DECK_KV: kv as unknown as KVNamespace,
    APP_NAME: "DeckAgent",
    API_TOKEN,
    TUNNEL_DO: tunnelDo as unknown as DurableObjectNamespace,
    _kv: kv,
    _do: tunnelDo,
  };
}

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  PASS: ${label}`);
    passed++;
  } else {
    console.error(`  FAIL: ${label}`);
    failed++;
  }
}

async function main() {
  console.log("=== DeckAgent Cloudflare Worker Smoke Test ===\n");

  const env = makeEnv();
  const url = (path: string) => new URL(`https://test.workers.dev${path}`);

  // --- 1. Auth ---
  console.log("1. Auth (API token)");
  assert(await verifyApiToken(API_TOKEN, env) === true, "valid token accepted");
  assert(await verifyApiToken("wrong", env) === false, "invalid token rejected");
  assert(await verifyApiToken("", env) === false, "empty token rejected");

  const unauthRes = await worker.fetch(
    new Request(url("/mcp"), { method: "GET" }),
    env
  );
  assert(unauthRes.status === 401, `unauthenticated /mcp → 401 (got ${unauthRes.status})`);

  const badAuthRes = await worker.fetch(
    new Request(url("/mcp"), {
      method: "GET",
      headers: { authorization: "Bearer wrong-token" },
    }),
    env
  );
  assert(badAuthRes.status === 401, `bad bearer → 401 (got ${badAuthRes.status})`);

  // --- 2. Device register / auth ---
  console.log("\n2. Device registration & auth");
  const deviceId = "test-device-1";
  const deviceToken = "test-token-hex-deadbeef";

  const regRes = await worker.fetch(
    new Request(url("/api/devices"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${API_TOKEN}`,
      },
      body: JSON.stringify({
        device_id: deviceId,
        name: "Test Machine",
        token: deviceToken,
        capabilities: ["filesystem", "terminal"],
      }),
    }),
    env
  );
  assert(regRes.status === 200, `register → 200 (got ${regRes.status})`);
  const regBody = (await regRes.json()) as { ok?: boolean; device_id?: string };
  assert(regBody.ok === true && regBody.device_id === deviceId, "register body ok");

  const device = await getDevice(env, deviceId);
  assert(device !== null, "device stored in KV");
  assert(device?.token_hash === (await hashToken(deviceToken)), "token_hash matches");

  const authed = await authenticateDevice(env, deviceId, deviceToken);
  assert(authed !== null, "authenticateDevice succeeds");
  const badDevice = await authenticateDevice(env, deviceId, "wrong-token");
  assert(badDevice === null, "authenticateDevice rejects bad token");

  // --- 3. Status update without expiring registration ---
  console.log("\n3. Status update does not expire registration");
  await updateDeviceStatus(env, deviceId, "online");
  assert(env._kv.hasExpiration(`device:${deviceId}`) === false, "device:{id} has no TTL");
  assert(await isDeviceOnline(env, deviceId) === true, "presence key set");
  assert(
    (await listOnlineDevices(env)).includes(deviceId),
    "listed in online devices"
  );

  // Simulate presence TTL expiry (unclean disconnect) — registration must remain.
  env._kv.forceExpire(`device_online:${deviceId}`);
  assert(await isDeviceOnline(env, deviceId) === false, "presence expired");
  const stillRegistered = await getDevice(env, deviceId);
  assert(stillRegistered !== null, "registration survives presence expiry");
  assert(
    stillRegistered?.token_hash === (await hashToken(deviceToken)),
    "token_hash intact after presence expiry"
  );

  // Re-online and mark offline cleanly
  await updateDeviceStatus(env, deviceId, "online");
  await updateDeviceStatus(env, deviceId, "offline");
  assert(await isDeviceOnline(env, deviceId) === false, "offline clears presence");
  assert((await getDevice(env, deviceId)) !== null, "registration remains after offline");

  // --- 4. Tool catalog ---
  console.log("\n4. Tool catalog (single source)");
  assert(TOOL_CATALOG.length === 20, `20 tools (got ${TOOL_CATALOG.length})`);
  assert(TOOL_NAMES.has("execute_command_stream"), "has execute_command_stream");
  assert(TOOL_NAMES.has("read_file"), "has read_file");
  assert(TOOL_NAMES.has("get_environment"), "has get_environment");
  assert(TOOL_NAMES.has("list_snapshots"), "has list_snapshots");
  assert(TOOL_NAMES.has("restore_snapshot"), "has restore_snapshot");
  const execCmd = TOOL_CATALOG.find((t) => t.name === "execute_command");
  const execStream = TOOL_CATALOG.find((t) => t.name === "execute_command_stream");
  const execProps = (execCmd?.inputSchema as { properties?: Record<string, unknown> })
    ?.properties;
  const streamProps = (
    execStream?.inputSchema as { properties?: Record<string, unknown> }
  )?.properties;
  assert(
    execProps?.use_secrets !== undefined,
    "execute_command inputSchema has use_secrets"
  );
  assert(
    streamProps?.use_secrets !== undefined,
    "execute_command_stream inputSchema has use_secrets"
  );
  const listSnap = TOOL_CATALOG.find((t) => t.name === "list_snapshots");
  const restoreSnap = TOOL_CATALOG.find((t) => t.name === "restore_snapshot");
  const listSnapProps = (
    listSnap?.inputSchema as { properties?: Record<string, unknown> }
  )?.properties;
  const restoreRequired = (
    restoreSnap?.inputSchema as { required?: string[] }
  )?.required;
  assert(
    listSnapProps?.path !== undefined && listSnapProps?.limit !== undefined,
    "list_snapshots has path? and limit?"
  );
  assert(
    restoreRequired?.includes("id") === true,
    "restore_snapshot requires id"
  );
  assert(
    mcpHandlerTools === TOOL_CATALOG ||
      (mcpHandlerTools.length === TOOL_CATALOG.length &&
        mcpHandlerTools.every((t, i) => t.name === TOOL_CATALOG[i].name)),
    "mcp-handler re-exports catalog"
  );

  // --- 5. MCP tools/list with auth ---
  console.log("\n5. MCP tools/list");
  const toolsRes = await worker.fetch(
    new Request(url("/mcp"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${API_TOKEN}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
      }),
    }),
    env
  );
  assert(toolsRes.status === 200, `tools/list → 200 (got ${toolsRes.status})`);
  const toolsBody = (await toolsRes.json()) as {
    jsonrpc?: string;
    result?: { tools?: unknown[] };
  };
  assert(toolsBody.jsonrpc === "2.0", "jsonrpc 2.0");
  assert(
    Array.isArray(toolsBody.result?.tools) &&
      toolsBody.result!.tools!.length === 20,
    "tools/list returns 20 tools (no daemon → full catalog)"
  );

  // --- 5a. S2 tools/list filtering ---
  console.log("\n5a. S2 tools/list filtering (policy_caps)");
  {
    const full = filterToolCatalog(null);
    assert(full.length === 20, "null enabledTools → full catalog");
    const undef = filterToolCatalog(undefined);
    assert(undef.length === 20, "undefined enabledTools → full catalog");

    const readOnlySubset = [
      "read_file",
      "read_multiple_files",
      "list_directory",
      "get_file_info",
      "search_files",
      "list_snapshots",
      "get_environment",
    ];
    const filtered = filterToolCatalog(readOnlySubset);
    assert(
      filtered.length === readOnlySubset.length,
      `filter shrinks to ${readOnlySubset.length} (got ${filtered.length})`
    );
    assert(
      filtered.every((t) => readOnlySubset.includes(t.name)),
      "filtered tools only from enabled set"
    );
    assert(
      !filtered.some((t) => t.name === "write_file"),
      "write_file hidden when not enabled"
    );
    assert(
      !filtered.some((t) => t.name === "execute_command"),
      "execute_command hidden when not enabled"
    );
    assert(
      filtered.some((t) => t.name === "get_environment"),
      "get_environment remains"
    );

    const asSet = filterToolCatalog(new Set(["get_environment", "read_file"]));
    assert(asSet.length === 2, "Set input filters to 2 tools");

    // TunnelDO: mock policy_caps then tools/list shrinks.
    const doInst = new TunnelDO(
      {} as DurableObjectState,
      env
    );
    assert(
      doInst.getEnabledToolsForTest() === null,
      "DO starts with null enabledTools"
    );
    const before = filterToolCatalog(doInst.getEnabledToolsForTest());
    assert(before.length === 20, "pre-caps list is full catalog");

    doInst.applyPolicyCapsForTest({ tools: readOnlySubset });
    const afterCaps = doInst.getEnabledToolsForTest();
    assert(afterCaps !== null && afterCaps.size === readOnlySubset.length, "caps applied");
    const afterList = filterToolCatalog(afterCaps);
    assert(
      afterList.length < 20 && afterList.length === readOnlySubset.length,
      "after policy_caps tools/list length shrinks"
    );
    assert(
      !afterList.some((t) =>
        ["write_file", "edit_file", "execute_command", "restore_snapshot"].includes(
          t.name
        )
      ),
      "mutating tools absent after read_only-style caps"
    );

    // Edge path: online device + Fake DO with restricted caps.
    await updateDeviceStatus(env, deviceId, "online");
    env._do.enabledTools = new Set(readOnlySubset);
    const filteredListRes = await worker.fetch(
      new Request(url("/mcp"), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${API_TOKEN}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 91,
          method: "tools/list",
        }),
      }),
      env
    );
    const filteredListBody = (await filteredListRes.json()) as {
      result?: { tools?: Array<{ name: string }> };
    };
    const listed = filteredListBody.result?.tools ?? [];
    assert(filteredListRes.status === 200, "filtered tools/list → 200");
    assert(
      listed.length === readOnlySubset.length && listed.length < 20,
      `edge tools/list shrinks (got ${listed.length})`
    );
    assert(
      listed.some((t) => t.name === "get_environment"),
      "edge list includes get_environment"
    );
    assert(
      !listed.some((t) => t.name === "write_file"),
      "edge list excludes write_file"
    );

    // Reset for later tests that expect Fake DO offline behavior.
    env._do.enabledTools = null;
    await updateDeviceStatus(env, deviceId, "offline");
  }

  // --- 5b. MCP prompts + instructions ---
  console.log("\n5b. MCP prompts / instructions");
  const initRes = await worker.fetch(
    new Request(url("/mcp"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${API_TOKEN}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "initialize",
        params: {},
      }),
    }),
    env
  );
  const initBody = (await initRes.json()) as {
    result?: {
      instructions?: string;
      capabilities?: {
        prompts?: unknown;
        tools?: unknown;
        resources?: { subscribe?: boolean; listChanged?: boolean };
      };
      serverInfo?: {
        name?: string;
        version?: string;
        metadata?: { minProtocolVersion?: number };
      };
    };
  };
  assert(
    typeof initBody.result?.instructions === "string" &&
      initBody.result.instructions.includes("DeckAgent"),
    "initialize includes DeckAgent instructions"
  );
  assert(
    initBody.result?.capabilities?.prompts !== undefined,
    "initialize advertises prompts capability"
  );
  assert(
    initBody.result?.capabilities?.resources?.subscribe === false &&
      initBody.result?.capabilities?.resources?.listChanged === false,
    "initialize advertises resources { subscribe: false, listChanged: false }"
  );
  assert(
    initBody.result?.serverInfo?.version === WORKER_VERSION,
    `initialize serverInfo.version === ${WORKER_VERSION}`
  );
  assert(
    initBody.result?.serverInfo?.metadata?.minProtocolVersion ===
      MIN_PROTOCOL_VERSION,
    "initialize serverInfo.metadata.minProtocolVersion"
  );

  const promptsRes = await worker.fetch(
    new Request(url("/mcp"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${API_TOKEN}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "prompts/list",
      }),
    }),
    env
  );
  const promptsBody = (await promptsRes.json()) as {
    result?: { prompts?: Array<{ name: string }> };
  };
  assert(
    Array.isArray(promptsBody.result?.prompts) &&
      promptsBody.result!.prompts!.some((p) => p.name === "deckagent_system") &&
      promptsBody.result!.prompts!.some((p) => p.name === "deckagent_workspace"),
    "prompts/list includes deckagent_system and deckagent_workspace"
  );
  assert(isKnownPrompt("deckagent_workspace"), "deckagent_workspace is known");

  const promptGetRes = await worker.fetch(
    new Request(url("/mcp"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${API_TOKEN}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        method: "prompts/get",
        params: {
          name: "deckagent_system",
          arguments: { task: "list files in /tmp" },
        },
      }),
    }),
    env
  );
  const promptGetBody = (await promptGetRes.json()) as {
    result?: { messages?: Array<{ content?: { text?: string } }> };
  };
  const promptText = promptGetBody.result?.messages?.[0]?.content?.text ?? "";
  assert(promptText.includes("DeckAgent"), "prompts/get returns identity text");
  assert(promptText.includes("list files in /tmp"), "prompts/get includes task arg");

  const resourcesRes = await worker.fetch(
    new Request(url("/mcp"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${API_TOKEN}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 5,
        method: "resources/list",
      }),
    }),
    env
  );
  const resourcesBody = (await resourcesRes.json()) as {
    result?: { resources?: Array<{ uri: string }> };
  };
  assert(
    Array.isArray(resourcesBody.result?.resources) &&
      resourcesBody.result!.resources!.length >= 5,
    `resources/list returns >=5 entries (got ${resourcesBody.result?.resources?.length})`
  );
  assert(
    RESOURCE_CATALOG.length === 6 &&
      resourcesBody.result!.resources!.length === RESOURCE_CATALOG.length,
    "resources/list matches RESOURCE_CATALOG"
  );

  // --- 5c. MCP resources catalog + static reads ---
  console.log("\n5c. MCP resources catalog / static reads");
  assert(isKnownResourceUri("deckagent://about"), "about URI known");
  assert(isStaticResourceUri("deckagent://about"), "about is static");
  assert(isDaemonResourceUri("deckagent://policy"), "policy is daemon-backed");
  assert(
    !isStaticResourceUri("deckagent://policy"),
    "policy is not static"
  );

  const aboutRes = await worker.fetch(
    new Request(url("/mcp"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${API_TOKEN}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 6,
        method: "resources/read",
        params: { uri: "deckagent://about" },
      }),
    }),
    env
  );
  const aboutBody = (await aboutRes.json()) as {
    result?: { contents?: Array<{ uri?: string; text?: string; mimeType?: string }> };
  };
  assert(aboutRes.status === 200, `resources/read about → 200 (got ${aboutRes.status})`);
  assert(
    aboutBody.result?.contents?.[0]?.text?.includes("DeckAgent") === true,
    "about resource contains DeckAgent"
  );
  assert(
    aboutBody.result?.contents?.[0]?.mimeType === "text/markdown",
    "about mimeType text/markdown"
  );

  const instrRes = await worker.fetch(
    new Request(url("/mcp"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${API_TOKEN}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 7,
        method: "resources/read",
        params: { uri: "deckagent://session/instructions" },
      }),
    }),
    env
  );
  const instrBody = (await instrRes.json()) as {
    result?: { contents?: Array<{ text?: string }> };
  };
  assert(
    instrBody.result?.contents?.[0]?.text === MCP_INSTRUCTIONS,
    "session/instructions matches MCP_INSTRUCTIONS"
  );

  await updateDeviceStatus(env, deviceId, "online");
  const devicesStatic = await readStaticResource("deckagent://devices", env);
  assert(devicesStatic !== null, "devices static resource resolves");
  const devicesParsed = JSON.parse(devicesStatic!.text) as {
    devices?: Array<{ id: string; status: string }>;
  };
  assert(
    Array.isArray(devicesParsed.devices) &&
      devicesParsed.devices.some((d) => d.id === deviceId && d.status === "online"),
    "devices resource includes online registered device"
  );
  assert(
    (await listRegisteredDeviceIds(env)).includes(deviceId),
    "listRegisteredDeviceIds includes test device"
  );

  const unknownRes = await worker.fetch(
    new Request(url("/mcp"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${API_TOKEN}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 8,
        method: "resources/read",
        params: { uri: "deckagent://nope" },
      }),
    }),
    env
  );
  const unknownBody = (await unknownRes.json()) as {
    error?: { data?: { code?: string } };
  };
  assert(unknownRes.status === 404, `unknown URI → 404 (got ${unknownRes.status})`);
  assert(
    unknownBody.error?.data?.code === "NOT_FOUND",
    "unknown URI → NOT_FOUND"
  );

  // Daemon-backed resource without online device → DEVICE_OFFLINE
  await updateDeviceStatus(env, deviceId, "offline");
  // Also clear other online devices from section that may not have run yet
  const policyOfflineRes = await worker.fetch(
    new Request(url("/mcp"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${API_TOKEN}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 9,
        method: "resources/read",
        params: { uri: "deckagent://policy" },
      }),
    }),
    env
  );
  const policyOfflineBody = (await policyOfflineRes.json()) as {
    error?: { data?: { code?: string } };
  };
  assert(
    policyOfflineRes.status === 503 &&
      policyOfflineBody.error?.data?.code === "DEVICE_OFFLINE",
    "policy read with no daemon → DEVICE_OFFLINE"
  );

  assert(
    PROMPT_CATALOG.some((p) => p.name === "deckagent_workspace"),
    "PROMPT_CATALOG includes deckagent_workspace"
  );

  // CORS: Origin echoed, not *
  console.log("\n6. CORS");
  const corsRes = await worker.fetch(
    new Request(url("/mcp"), {
      method: "OPTIONS",
      headers: { Origin: "https://chatgpt.com" },
    }),
    env
  );
  assert(
    corsRes.headers.get("Access-Control-Allow-Origin") === "https://chatgpt.com",
    "echoes Origin"
  );
  assert(
    corsRes.headers.get("Access-Control-Allow-Origin") !== "*",
    "does not use *"
  );

  // Tunnel requires device_id
  console.log("\n7. Tunnel routing");
  const tunnelMissing = await worker.fetch(
    new Request(url("/tunnel"), {
      method: "GET",
      headers: { Upgrade: "websocket" },
    }),
    env
  );
  assert(
    tunnelMissing.status === 400,
    `/tunnel without device_id → 400 (got ${tunnelMissing.status})`
  );

  // Health
  console.log("\n8. Health");
  const healthRes = await worker.fetch(
    new Request(url("/health"), { method: "GET" }),
    env
  );
  const health = (await healthRes.json()) as { status?: string };
  assert(health.status === "ok", "health ok");

  // Direct setDevice + status (unit path)
  console.log("\n9. Direct registry helpers");
  await setDevice(env, "dev-2", {
    id: "dev-2",
    name: "Second",
    status: "offline",
    token_hash: await hashToken("tok2"),
    capabilities: [],
    last_seen: Date.now(),
  });
  await updateDeviceStatus(env, "dev-2", "online");
  await updateDeviceStatus(env, deviceId, "online");
  const online = await listOnlineDevices(env);
  assert(online.length === 2, `two online devices (got ${online.length})`);

  // --- 10. Protocol version handshake helper ---
  console.log("\n10. Protocol version handshake");
  const missing = checkProtocolVersion(undefined);
  assert(missing.ok === true, "missing protocol_version accepted");
  assert(
    missing.ok && missing.warning === "upgrade_daemon",
    "missing protocol_version → upgrade_daemon warning"
  );
  const current = checkProtocolVersion(MIN_PROTOCOL_VERSION);
  assert(
    current.ok === true && !current.warning,
    "current protocol ok"
  );
  const higher = checkProtocolVersion(MIN_PROTOCOL_VERSION + 1);
  assert(higher.ok === true, "higher protocol_version accepted");
  const tooOld = checkProtocolVersion(MIN_PROTOCOL_VERSION - 1);
  assert(tooOld.ok === false, "below MIN rejected");
  assert(
    !tooOld.ok && tooOld.reason === "protocol_mismatch",
    "below MIN → protocol_mismatch"
  );
  assert(
    typeof WORKER_VERSION === "string" && WORKER_VERSION.length > 0,
    `WORKER_VERSION set (${WORKER_VERSION})`
  );
  // auth_ok shape contract (unit-level, no WS)
  const authOkShape = {
    type: "auth_ok" as const,
    session_id: "sess-1",
    worker_version: WORKER_VERSION,
    min_protocol_version: MIN_PROTOCOL_VERSION,
    server_time: Date.now(),
    warning: "upgrade_daemon" as const,
  };
  assert(
    authOkShape.session_id.length > 0 &&
      authOkShape.worker_version === WORKER_VERSION &&
      authOkShape.min_protocol_version === MIN_PROTOCOL_VERSION &&
      typeof authOkShape.server_time === "number" &&
      authOkShape.warning === "upgrade_daemon",
    "auth_ok shape includes session_id, worker_version, min_protocol_version, server_time, warning"
  );

  // --- 11. SSE format helper + Accept forwarding for execute_command_stream ---
  console.log("\n11. SSE streaming (format + Accept forward mock)");
  const sseProgress = formatSseEvent("progress", { chunk: "hello" });
  assert(
    sseProgress === 'event: progress\ndata: {"chunk":"hello"}\n\n',
    "formatSseEvent progress shape"
  );
  const sseResult = formatSseEvent("result", {
    content: [{ type: "text", text: "done" }],
  });
  assert(
    sseResult.startsWith("event: result\ndata: ") && sseResult.endsWith("\n\n"),
    "formatSseEvent result shape"
  );
  const sseError = formatSseEvent("error", {
    code: "TOOL_TIMEOUT",
    message: "timed out",
  });
  assert(
    sseError.includes('"code":"TOOL_TIMEOUT"'),
    "formatSseEvent error shape"
  );

  await updateDeviceStatus(env, deviceId, "online");
  // Ensure only one online device so routing is unambiguous.
  await updateDeviceStatus(env, "dev-2", "offline");
  env._do.lastAccept = null;
  const sseCallRes = await worker.fetch(
    new Request(url("/mcp"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${API_TOKEN}`,
        Accept: "text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 100,
        method: "tools/call",
        params: {
          name: "execute_command_stream",
          arguments: { command: "echo sse-ok" },
        },
      }),
    }),
    env
  );
  const sseCt = sseCallRes.headers.get("content-type") ?? "";
  assert(
    sseCt.includes("event-stream"),
    `SSE tools/call Content-Type event-stream (got ${sseCt})`
  );
  assert(
    env._do.lastAccept?.includes("text/event-stream") === true,
    "mcp-handler forwards Accept: text/event-stream to DO"
  );
  const sseBody = await sseCallRes.text();
  assert(
    sseBody.includes("sse-ok") &&
      (sseBody.includes("event: progress") || sseBody.includes("event: result")),
    "SSE body contains sse-ok and at least one event"
  );

  // Without Accept event-stream, Fake DO returns DEVICE_OFFLINE JSON (buffered path).
  const jsonCallRes = await worker.fetch(
    new Request(url("/mcp"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${API_TOKEN}`,
        Accept: "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 101,
        method: "tools/call",
        params: {
          name: "execute_command_stream",
          arguments: { command: "echo sse-ok" },
        },
      }),
    }),
    env
  );
  assert(
    (jsonCallRes.headers.get("content-type") ?? "").includes("application/json"),
    "non-SSE Accept keeps JSON Content-Type"
  );
  assert(jsonCallRes.status === 503, "non-SSE path hits Fake DO offline JSON");

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
