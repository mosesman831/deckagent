#!/usr/bin/env npx tsx
/**
 * Connector smoke matrix — mimics Cursor / Claude Desktop / MCP Playground
 * client handshake sequences against a live DeckAgent Worker.
 *
 * Usage:
 *   DECKAGENT_URL=https://….workers.dev DECKAGENT_TOKEN=… npm run smoke
 *   npx tsx scripts/connector-smoke.ts --url https://… --token …
 *
 * Exit non-zero if any profile step fails.
 */

const CLIENT_PROFILES = [
  { name: "cursor", version: "1.0.0" },
  { name: "claude-desktop", version: "0.1.0" },
  { name: "mcpplayground", version: "0.0.1" },
] as const;

type StepResult = { step: string; ok: boolean; detail?: string };

function parseArgs(argv: string[]): { url: string; token: string } {
  let url = process.env.DECKAGENT_URL ?? "";
  let token = process.env.DECKAGENT_TOKEN ?? "";

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if ((arg === "--url" || arg === "-u") && argv[i + 1]) {
      url = argv[++i];
    } else if ((arg === "--token" || arg === "-t") && argv[i + 1]) {
      token = argv[++i];
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: connector-smoke [--url URL] [--token TOKEN]\n" +
          "  or set DECKAGENT_URL and DECKAGENT_TOKEN"
      );
      process.exit(0);
    }
  }

  if (!url || !token) {
    console.error(
      "Missing DECKAGENT_URL / DECKAGENT_TOKEN (or --url / --token)"
    );
    process.exit(2);
  }

  // Normalize: strip trailing slash; ensure /mcp path is not double-appended.
  url = url.replace(/\/+$/, "");
  if (!url.endsWith("/mcp")) {
    url = `${url}/mcp`;
  }

  return { url, token };
}

async function mcpCall(
  url: string,
  token: string,
  body: Record<string, unknown>
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", ...body }),
  });
  let json: Record<string, unknown> = {};
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    json = { _parse_error: true };
  }
  return { status: res.status, json };
}

function hasResult(json: Record<string, unknown>): boolean {
  return json.result !== undefined && json.error === undefined;
}

async function runProfile(
  url: string,
  token: string,
  client: { name: string; version: string }
): Promise<StepResult[]> {
  const results: StepResult[] = [];
  let id = 1;

  // 1. initialize
  {
    const step = "initialize";
    try {
      const { status, json } = await mcpCall(url, token, {
        id: id++,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: client.name, version: client.version },
        },
      });
      const result = json.result as
        | { serverInfo?: { name?: string; version?: string } }
        | undefined;
      const ok =
        status === 200 &&
        hasResult(json) &&
        typeof result?.serverInfo?.version === "string";
      results.push({
        step,
        ok,
        detail: ok
          ? `serverInfo.version=${result?.serverInfo?.version}`
          : `status=${status} body=${JSON.stringify(json).slice(0, 200)}`,
      });
    } catch (err) {
      results.push({
        step,
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 2. notifications/initialized
  {
    const step = "notifications/initialized";
    try {
      const { status, json } = await mcpCall(url, token, {
        id: id++,
        method: "notifications/initialized",
        params: {},
      });
      // Some servers return empty result; others may omit body for notifications.
      const ok = status === 200 && (hasResult(json) || json.error === undefined);
      results.push({
        step,
        ok,
        detail: ok ? undefined : `status=${status}`,
      });
    } catch (err) {
      results.push({
        step,
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 3. tools/list
  {
    const step = "tools/list";
    try {
      const { status, json } = await mcpCall(url, token, {
        id: id++,
        method: "tools/list",
        params: {},
      });
      const tools = (json.result as { tools?: Array<{ name?: string }> } | undefined)
        ?.tools;
      const hasEnv =
        Array.isArray(tools) &&
        tools.length > 0 &&
        tools.some((t) => t.name === "get_environment");
      const ok = status === 200 && hasResult(json) && hasEnv;
      results.push({
        step,
        ok,
        detail: ok
          ? `${tools!.length} tools (incl. get_environment)`
          : `status=${status} count=${tools?.length ?? "n/a"}`,
      });
    } catch (err) {
      results.push({
        step,
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 4. prompts/list + prompts/get deckagent_system
  {
    const step = "tools/call list_devices";
    try {
      const { status, json } = await mcpCall(url, token, {
        id: id++,
        method: "tools/call",
        params: { name: "list_devices", arguments: {} },
      });
      const devices = (json.result as { devices?: unknown[] } | undefined)
        ?.devices;
      const ok =
        status === 200 &&
        hasResult(json) &&
        Array.isArray(devices);
      results.push({
        step,
        ok,
        detail: ok ? `${devices!.length} device(s)` : `status=${status}`,
      });
    } catch (err) {
      results.push({
        step,
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 5. prompts/list + prompts/get deckagent_system
  {
    const step = "prompts/list";
    try {
      const { status, json } = await mcpCall(url, token, {
        id: id++,
        method: "prompts/list",
        params: {},
      });
      const prompts = (json.result as { prompts?: Array<{ name: string }> })
        ?.prompts;
      const ok =
        status === 200 &&
        hasResult(json) &&
        Array.isArray(prompts) &&
        prompts.some((p) => p.name === "deckagent_system");
      results.push({
        step,
        ok,
        detail: ok ? "deckagent_system present" : `status=${status}`,
      });
    } catch (err) {
      results.push({
        step,
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  {
    const step = "prompts/get deckagent_system";
    try {
      const { status, json } = await mcpCall(url, token, {
        id: id++,
        method: "prompts/get",
        params: {
          name: "deckagent_system",
          arguments: { task: "smoke test" },
        },
      });
      const messages = (json.result as { messages?: unknown[] })?.messages;
      const ok =
        status === 200 && hasResult(json) && Array.isArray(messages);
      results.push({
        step,
        ok,
        detail: ok ? undefined : `status=${status}`,
      });
    } catch (err) {
      results.push({
        step,
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 5. resources/list + resources/read
  {
    const step = "resources/list";
    try {
      const { status, json } = await mcpCall(url, token, {
        id: id++,
        method: "resources/list",
        params: {},
      });
      const resources = (json.result as { resources?: unknown[] })?.resources;
      const ok =
        status === 200 &&
        hasResult(json) &&
        Array.isArray(resources) &&
        resources.length >= 5;
      results.push({
        step,
        ok,
        detail: ok ? `${resources!.length} resources` : `status=${status} count=${resources?.length ?? "n/a"}`,
      });
    } catch (err) {
      results.push({
        step,
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  {
    const step = "resources/read deckagent://about";
    try {
      const { status, json } = await mcpCall(url, token, {
        id: id++,
        method: "resources/read",
        params: { uri: "deckagent://about" },
      });
      const contents = (json.result as { contents?: Array<{ text?: string }> })
        ?.contents;
      const text = contents?.[0]?.text ?? "";
      const ok =
        status === 200 &&
        hasResult(json) &&
        Array.isArray(contents) &&
        text.includes("DeckAgent");
      results.push({
        step,
        ok,
        detail: ok ? undefined : `status=${status}`,
      });
    } catch (err) {
      results.push({
        step,
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  {
    const step = "resources/read deckagent://session/instructions";
    try {
      const { status, json } = await mcpCall(url, token, {
        id: id++,
        method: "resources/read",
        params: { uri: "deckagent://session/instructions" },
      });
      const contents = (json.result as { contents?: Array<{ text?: string }> })
        ?.contents;
      const text = contents?.[0]?.text ?? "";
      const ok =
        status === 200 &&
        hasResult(json) &&
        Array.isArray(contents) &&
        text.includes("DeckAgent");
      results.push({
        step,
        ok,
        detail: ok ? undefined : `status=${status}`,
      });
    } catch (err) {
      results.push({
        step,
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  {
    const step = "resources/read deckagent://policy";
    try {
      const { status, json } = await mcpCall(url, token, {
        id: id++,
        method: "resources/read",
        params: { uri: "deckagent://policy" },
      });
      // Requires online daemon — fail the matrix if DEVICE_OFFLINE (same as tools/call).
      const contents = (json.result as { contents?: Array<{ text?: string }> })
        ?.contents;
      const text = contents?.[0]?.text ?? "";
      const ok =
        status === 200 &&
        hasResult(json) &&
        Array.isArray(contents) &&
        contents.length > 0 &&
        text.length > 0;
      results.push({
        step,
        ok,
        detail: ok
          ? undefined
          : `status=${status} ${(json.error as { message?: string; data?: { code?: string } })?.data?.code ?? (json.error as { message?: string })?.message ?? JSON.stringify(json).slice(0, 160)}`,
      });
    } catch (err) {
      results.push({
        step,
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 6. tools/call get_environment
  {
    const step = "tools/call get_environment";
    try {
      const { status, json } = await mcpCall(url, token, {
        id: id++,
        method: "tools/call",
        params: { name: "get_environment", arguments: {} },
      });
      // DEVICE_OFFLINE (503) is a soft infrastructure fail — still FAIL the matrix
      // because a connected daemon is expected for a full connector smoke.
      const result = json.result as
        | { content?: unknown[]; isError?: boolean }
        | undefined;
      const ok =
        status === 200 &&
        hasResult(json) &&
        Array.isArray(result?.content) &&
        result?.isError !== true;
      results.push({
        step,
        ok,
        detail: ok
          ? undefined
          : `status=${status} ${(json.error as { message?: string })?.message ?? JSON.stringify(json).slice(0, 160)}`,
      });
    } catch (err) {
      results.push({
        step,
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 7. tools/call list_directory "." (workspace-relative; avoids outside-workspace confirmation)
  {
    const step = 'tools/call list_directory "."';
    try {
      const { status, json } = await mcpCall(url, token, {
        id: id++,
        method: "tools/call",
        params: {
          name: "list_directory",
          arguments: { path: "." },
        },
      });
      const result = json.result as
        | { content?: unknown[]; isError?: boolean }
        | undefined;
      const ok =
        status === 200 &&
        hasResult(json) &&
        Array.isArray(result?.content) &&
        result?.isError !== true;
      results.push({
        step,
        ok,
        detail: ok
          ? undefined
          : `status=${status} ${(json.error as { message?: string })?.message ?? JSON.stringify(json).slice(0, 160)}`,
      });
    } catch (err) {
      results.push({
        step,
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 8. Optional SSE path for execute_command_stream (one profile only).
  if (client.name === "mcpplayground") {
    const step = "tools/call execute_command_stream SSE";
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          Accept: "text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: id++,
          method: "tools/call",
          params: {
            name: "execute_command_stream",
            arguments: { command: "echo sse-ok" },
          },
        }),
      });

      const ct = res.headers.get("content-type") ?? "";
      const text = await res.text();

      // Daemon offline → skip (soft pass).
      let offline = res.status === 503;
      if (!offline) {
        try {
          const parsed = JSON.parse(text) as {
            error?: { data?: { code?: string }; message?: string };
          };
          if (parsed?.error?.data?.code === "DEVICE_OFFLINE") {
            offline = true;
          }
        } catch {
          /* SSE body is not JSON — fine */
        }
      }

      if (offline) {
        results.push({
          step,
          ok: true,
          detail: "skipped — daemon offline",
        });
      } else {
        const hasEventStream = ct.includes("event-stream");
        const hasSseOk = text.includes("sse-ok");
        const hasEvent =
          text.includes("event: progress") ||
          text.includes("event: result") ||
          text.includes("event: error") ||
          hasSseOk;
        const ok = hasEventStream && hasEvent && hasSseOk;
        results.push({
          step,
          ok,
          detail: ok
            ? "SSE stream ok"
            : `ct=${ct.slice(0, 40)} status=${res.status} body=${text.slice(0, 160)}`,
        });
      }
    } catch (err) {
      results.push({
        step,
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return results;
}

async function main(): Promise<void> {
  const { url, token } = parseArgs(process.argv.slice(2));
  console.log(`=== DeckAgent connector smoke matrix ===`);
  console.log(`URL: ${url}`);
  console.log(`Profiles: ${CLIENT_PROFILES.map((c) => c.name).join(", ")}\n`);

  let failed = 0;

  for (const client of CLIENT_PROFILES) {
    console.log(`── clientInfo.name=${client.name} ──`);
    const steps = await runProfile(url, token, client);
    for (const s of steps) {
      const mark = s.ok ? "PASS" : "FAIL";
      const extra = s.detail ? `  (${s.detail})` : "";
      console.log(`  ${mark}  ${s.step}${extra}`);
      if (!s.ok) failed++;
    }
    console.log("");
  }

  if (failed > 0) {
    console.error(`=== ${failed} step(s) failed ===`);
    process.exit(1);
  }
  console.log("=== All profiles PASS ===");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
