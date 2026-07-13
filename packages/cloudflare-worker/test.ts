import type { Env } from "./src/types.js";
import worker from "./src/index.js";

// Minimal in-memory KV for local message-flow testing.
class FakeKV {
  private store = new Map<string, { value: string; expires?: number }>();

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expires && entry.expires < Date.now() / 1000) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async getJSON<T = unknown>(key: string): Promise<T | null> {
    const raw = await this.get(key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  }

  async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    this.store.set(key, {
      value,
      expires: options?.expirationTtl ? Math.floor(Date.now() / 1000) + options.expirationTtl : undefined,
    });
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

function makeEnv(): Env {
  return {
    DECK_KV: new FakeKV() as any,
    GITHUB_CLIENT_ID: "test-client-id",
    GITHUB_CLIENT_SECRET: "test-client-secret",
    COOKIE_ENCRYPTION_KEY: "test-key-32-chars-minimum-required!!",
    APP_NAME: "DeckAgent",
    DEPLOY_SECRET: "test-deploy-secret",
  };
}

async function main() {
  console.log("=== DeckAgent Cloudflare Worker Smoke Test ===\n");

  const env = makeEnv();
  const url = (path: string) => new URL(`https://test.workers.dev${path}`);
  const req = (method: string, path: string, body?: any) => ({
    request: new Request(url(path), {
      method,
      headers: { "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    }),
    env,
  });

  // 1. Health check
  const healthRes = await worker.fetch(new Request(url("/health"), { method: "GET" }), env);
  const health = await healthRes.json();
  console.log("1. Health:", JSON.stringify(health));

  // 2. Device registration
  const deviceId = "test-device-1";
  const deviceToken = "test-token-hex-deadbeef";
  
  const regReq = new Request(url("/api/devices"), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": "Bearer test-deploy-secret",
    },
    body: JSON.stringify({
      device_id: deviceId,
      name: "Test Machine",
      token: deviceToken,
      capabilities: ["filesystem", "terminal"],
    }),
  });
  const regRes = await worker.fetch(regReq, env);
  console.log("2. Device registration:", regRes.status, await regRes.text());

  // 3. MCP tools/list
  const toolsReq = new Request(url("/mcp"), {
    method: "GET",
    headers: { "authorization": "Bearer test-session-token" },
  });
  const toolsRes = await worker.fetch(toolsReq, env);
  console.log("3. MCP tools/list:", toolsRes.status);
  if (toolsRes.ok) {
    const tools = await toolsRes.json();
    console.log("   Tools:", JSON.stringify(tools).substring(0, 200) + "...");
  }

  // 4. Unauthenticated request
  const unauthReq = new Request(url("/mcp"), { method: "GET" });
  const unauthRes = await worker.fetch(unauthReq, env);
  console.log("4. Unauthenticated:", unauthRes.status);

  console.log("\n=== Smoke test complete ===");
}

main().catch(console.error);
