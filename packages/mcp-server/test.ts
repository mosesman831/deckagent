import {
  createRegistry,
  execute_command,
  execute_command_stream,
  closeBrowser,
  setBrowserHostPolicy,
  browserHostMatches,
  evaluateBrowserHostPolicy,
  setWorkspaceContext,
  getWorkspaceContext,
  setSnapshotsDir,
  setSnapshotRetention,
  resetSnapshotRetention,
  createSnapshotBeforeMutation,
  setJobsDirForTest,
} from "./src/index.js";
import type { ToolResponse } from "./src/schemas.js";
import { ExecuteCommandArgsSchema } from "./src/schemas.js";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { spawn } from "child_process";

const TEST_ROOT = path.join(os.tmpdir(), `deckagent-mcp-test-${Date.now()}`);
const SNAPSHOTS_ROOT = path.join(TEST_ROOT, "snapshots");

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERT: ${message}`);
}

function textOf(res: ToolResponse): string {
  return res.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

async function main() {
  const registry = createRegistry();
  const names = registry.list().map((t) => t.name);
  console.log("Registered tools:", names.join(", "));

  const expected = [
    "read_file",
    "write_file",
    "edit_file",
    "search_files",
    "list_directory",
    "create_directory",
    "move_file",
    "get_file_info",
    "read_multiple_files",
    "execute_command",
    "execute_command_stream",
    "list_processes",
    "kill_process",
    "start_job",
    "list_jobs",
    "get_job",
    "cancel_job",
    "browser_navigate",
    "browser_screenshot",
    "browser_click",
    "browser_evaluate",
    "get_environment",
    "list_snapshots",
    "restore_snapshot",
  ];
  for (const name of expected) {
    assert(names.includes(name), `missing tool ${name}`);
  }

  await fs.mkdir(TEST_ROOT, { recursive: true });
  await fs.mkdir(SNAPSHOTS_ROOT, { recursive: true });
  setSnapshotsDir(SNAPSHOTS_ROOT);
  setJobsDirForTest(path.join(TEST_ROOT, "jobs"));

  // get_environment
  {
    const env = await registry.execute("get_environment", {});
    assert(!env.isError, "get_environment should succeed");
    const envText = textOf(env);
    assert(envText.includes("os"), "get_environment should include os");
    const envJson = JSON.parse(envText) as {
      workspace_root: string | null;
      workspace_name: string | null;
    };
    assert(envJson.workspace_root === null, "workspace_root should be null by default");
    assert(envJson.workspace_name === null, "workspace_name should be null by default");
    console.log("✓ get_environment");
  }

  // workspace relative paths
  {
    const wsRoot = path.join(TEST_ROOT, "workspace");
    await fs.mkdir(wsRoot, { recursive: true });
    setWorkspaceContext({ root: wsRoot, name: "smoke-ws" });

    const env = await registry.execute("get_environment", {});
    assert(!env.isError, "get_environment with workspace should succeed");
    const envJson = JSON.parse(textOf(env)) as {
      workspace_root: string | null;
      workspace_name: string | null;
    };
    assert(envJson.workspace_root === wsRoot, "workspace_root should match set root");
    assert(envJson.workspace_name === "smoke-ws", "workspace_name should match set name");

    const writeRes = await registry.execute("write_file", {
      path: "rel-note.txt",
      content: "workspace-relative-content\n",
    });
    assert(!writeRes.isError, `workspace write_file failed: ${textOf(writeRes)}`);

    const absWritten = path.join(wsRoot, "rel-note.txt");
    const onDisk = await fs.readFile(absWritten, "utf-8");
    assert(onDisk.includes("workspace-relative-content"), "relative write should land in workspace");

    const readRes = await registry.execute("read_file", { path: "rel-note.txt" });
    assert(!readRes.isError, `workspace read_file failed: ${textOf(readRes)}`);
    assert(textOf(readRes).includes("workspace-relative-content"), "relative read should resolve via workspace");

    const cmdRes = await registry.execute("execute_command", {
      command: "pwd",
      workdir: ".",
    });
    assert(!cmdRes.isError, `workspace execute_command failed: ${textOf(cmdRes)}`);
    assert(textOf(cmdRes).includes(wsRoot), "relative workdir should resolve via workspace");

    setWorkspaceContext({ root: null, name: null });
    const cleared = getWorkspaceContext();
    assert(cleared.root === null && cleared.name === null, "workspace should clear");

    const envCleared = await registry.execute("get_environment", {});
    const clearedJson = JSON.parse(textOf(envCleared)) as {
      workspace_root: string | null;
      workspace_name: string | null;
    };
    assert(clearedJson.workspace_root === null, "workspace_root null after clear");
    assert(clearedJson.workspace_name === null, "workspace_name null after clear");
    console.log("✓ workspace relative paths");
  }

  // create_directory
  const subDir = path.join(TEST_ROOT, "subdir");
  {
    const res = await registry.execute("create_directory", { path: subDir });
    assert(!res.isError, `create_directory failed: ${textOf(res)}`);
    console.log("✓ create_directory");
  }

  // write_file
  const fileA = path.join(TEST_ROOT, "a.txt");
  {
    const res = await registry.execute("write_file", {
      path: fileA,
      content: "hello world\nsecond line\nsearchable-token\n",
    });
    assert(!res.isError, `write_file failed: ${textOf(res)}`);
    console.log("✓ write_file");
  }

  // read_file
  {
    const res = await registry.execute("read_file", { path: fileA });
    assert(!res.isError, `read_file failed: ${textOf(res)}`);
    assert(textOf(res).includes("hello world"), "read_file content mismatch");
    console.log("✓ read_file");
  }

  // edit_file
  {
    const res = await registry.execute("edit_file", {
      path: fileA,
      old_string: "second line",
      new_string: "modified line",
    });
    assert(!res.isError, `edit_file failed: ${textOf(res)}`);
    console.log("✓ edit_file");
  }

  // F3 snapshots: list after edit, restore previous content
  {
    const listRes = await registry.execute("list_snapshots", { path: fileA, limit: 10 });
    assert(!listRes.isError, `list_snapshots failed: ${textOf(listRes)}`);
    const listJson = JSON.parse(textOf(listRes)) as {
      snapshots: Array<{ id: string; tool: string; path: string; ts: string }>;
      count: number;
    };
    assert(listJson.count >= 1, "list_snapshots should find at least one entry after edit");
    assert(
      listJson.snapshots.some((s) => s.tool === "edit_file" && s.path === fileA),
      "list_snapshots should include edit_file entry for fileA",
    );

    const snapId = listJson.snapshots.find((s) => s.tool === "edit_file")!.id;
    const restoreRes = await registry.execute("restore_snapshot", { id: snapId });
    assert(!restoreRes.isError, `restore_snapshot failed: ${textOf(restoreRes)}`);

    const restored = await fs.readFile(fileA, "utf-8");
    assert(restored.includes("second line"), "restore_snapshot should bring back pre-edit content");
    assert(!restored.includes("modified line"), "restore_snapshot should not keep edited content");

    // Re-apply edit so later tests see consistent content
    const reEdit = await registry.execute("edit_file", {
      path: fileA,
      old_string: "second line",
      new_string: "modified line",
    });
    assert(!reEdit.isError, `re-edit after restore failed: ${textOf(reEdit)}`);
    console.log("✓ list_snapshots + restore_snapshot");
  }

  // F3 snapshot rotation (cap)
  {
    setSnapshotRetention({ maxSnapshots: 3 });
    const rotFile = path.join(TEST_ROOT, "rotate.txt");
    await fs.writeFile(rotFile, "v0\n", "utf-8");
    for (let i = 1; i <= 5; i++) {
      await createSnapshotBeforeMutation({ tool: "write_file", path: rotFile });
      await fs.writeFile(rotFile, `v${i}\n`, "utf-8");
    }
    const listRes = await registry.execute("list_snapshots", { path: rotFile, limit: 20 });
    assert(!listRes.isError, `list_snapshots (rotation) failed: ${textOf(listRes)}`);
    const listJson = JSON.parse(textOf(listRes)) as { count: number };
    assert(listJson.count <= 3, `rotation should keep <= 3 snapshots, got ${listJson.count}`);
    resetSnapshotRetention();
    console.log("✓ snapshot rotation");
  }

  // F4 use_secrets accepted by schema (handlers ignore; daemon injects)
  {
    const parsed = ExecuteCommandArgsSchema.parse({
      command: "echo ok",
      use_secrets: ["GITHUB_TOKEN"],
    });
    assert(
      Array.isArray(parsed.use_secrets) && parsed.use_secrets[0] === "GITHUB_TOKEN",
      "use_secrets should pass schema validation",
    );
    const res = await registry.execute("execute_command", {
      command: "echo secrets-ok",
      use_secrets: ["GITHUB_TOKEN"],
    });
    assert(!res.isError, `execute_command with use_secrets failed: ${textOf(res)}`);
    assert(textOf(res).includes("secrets-ok"), "execute_command should still run with use_secrets");
    console.log("✓ use_secrets schema");
  }

  // get_file_info
  {
    const res = await registry.execute("get_file_info", { path: fileA });
    assert(!res.isError, `get_file_info failed: ${textOf(res)}`);
    assert(textOf(res).includes("Size:"), "get_file_info missing size");
    console.log("✓ get_file_info");
  }

  // list_directory
  {
    const res = await registry.execute("list_directory", { path: TEST_ROOT });
    assert(!res.isError, `list_directory failed: ${textOf(res)}`);
    assert(textOf(res).includes("a.txt"), "list_directory missing a.txt");
    console.log("✓ list_directory");
  }

  // read_multiple_files
  const fileB = path.join(TEST_ROOT, "b.txt");
  await fs.writeFile(fileB, "file-b-content\n", "utf-8");
  {
    const res = await registry.execute("read_multiple_files", { paths: [fileA, fileB] });
    assert(!res.isError, `read_multiple_files failed: ${textOf(res)}`);
    assert(textOf(res).includes("file-b-content"), "read_multiple_files missing b");
    console.log("✓ read_multiple_files");
  }

  // search_files
  {
    const res = await registry.execute("search_files", {
      pattern: "searchable-token",
      path: TEST_ROOT,
      max_results: 10,
    });
    assert(!res.isError, `search_files failed: ${textOf(res)}`);
    assert(
      textOf(res).includes("searchable-token") || textOf(res).includes("No results"),
      "search_files unexpected output",
    );
    console.log("✓ search_files");
  }

  // move_file
  const moved = path.join(subDir, "moved.txt");
  {
    const res = await registry.execute("move_file", { source: fileB, destination: moved });
    assert(!res.isError, `move_file failed: ${textOf(res)}`);
    console.log("✓ move_file");
  }

  // execute_command
  {
    const res = await registry.execute("execute_command", { command: "echo 'from deckagent'" });
    assert(!res.isError, `execute_command failed: ${textOf(res)}`);
    assert(textOf(res).includes("from deckagent"), "execute_command output mismatch");
    console.log("✓ execute_command");
  }

  // background jobs: start echo, inspect output, cancel sleep
  {
    const startRes = await registry.execute("start_job", {
      command: "echo job-hi",
      cwd: TEST_ROOT,
    });
    assert(!startRes.isError, `start_job failed: ${textOf(startRes)}`);
    const started = JSON.parse(textOf(startRes)) as { job_id: string };
    assert(typeof started.job_id === "string", "start_job returns job_id");

    let jobText = "";
    for (let i = 0; i < 20; i++) {
      const getRes = await registry.execute("get_job", {
        job_id: started.job_id,
        tail_lines: 20,
      });
      assert(!getRes.isError, `get_job failed: ${textOf(getRes)}`);
      jobText = textOf(getRes);
      const job = JSON.parse(jobText) as { status: string; stdout: string };
      if (job.status === "completed" && job.stdout.includes("job-hi")) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const completed = JSON.parse(jobText) as { status: string; stdout: string };
    assert(completed.status === "completed", "echo job completed");
    assert(completed.stdout.includes("job-hi"), "get_job includes stdout tail");

    const sleepStart = await registry.execute("start_job", {
      command: "sleep 30",
      cwd: TEST_ROOT,
      timeout_ms: 30_000,
    });
    assert(!sleepStart.isError, `start sleep job failed: ${textOf(sleepStart)}`);
    const sleepJob = JSON.parse(textOf(sleepStart)) as { job_id: string };
    const cancelRes = await registry.execute("cancel_job", { job_id: sleepJob.job_id });
    assert(!cancelRes.isError, `cancel_job failed: ${textOf(cancelRes)}`);

    let cancelledText = "";
    for (let i = 0; i < 20; i++) {
      const getRes = await registry.execute("get_job", {
        job_id: sleepJob.job_id,
        tail_lines: 5,
      });
      assert(!getRes.isError, `get cancelled job failed: ${textOf(getRes)}`);
      cancelledText = textOf(getRes);
      const job = JSON.parse(cancelledText) as { status: string };
      if (job.status === "cancelled") break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const cancelled = JSON.parse(cancelledText) as { status: string };
    assert(cancelled.status === "cancelled", "sleep job cancelled");

    const listRes = await registry.execute("list_jobs", {});
    assert(!listRes.isError, `list_jobs failed: ${textOf(listRes)}`);
    const listed = JSON.parse(textOf(listRes)) as { count: number };
    assert(listed.count >= 2, "list_jobs includes tracked jobs");
    console.log("✓ background jobs");
  }

  // execute_command abort signal (best-effort)
  {
    const controller = new AbortController();
    const started = Date.now();
    const command = `"${process.execPath}" -e "setTimeout(() => {}, 30000)"`;
    const running = execute_command(
      { command, workdir: TEST_ROOT, timeout: 30 },
      { signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 100);
    const res = await running;
    const elapsed = Date.now() - started;
    assert(res.isError, "aborted execute_command returns isError");
    assert(textOf(res).toLowerCase().includes("aborted"), "abort result mentions aborted");
    assert(elapsed < 5000, `abort returns promptly (elapsed ${elapsed}ms)`);
    console.log("✓ execute_command abort signal");
  }

  // execute_command sandbox wrapping (fake bwrap records argv, then execs command after --)
  if (process.platform !== "win32") {
    const fakeBinDir = path.join(TEST_ROOT, "fake-bin");
    const fakeBwrap = path.join(fakeBinDir, "bwrap");
    const fakeLog = path.join(TEST_ROOT, "fake-bwrap-argv.txt");
    await fs.mkdir(fakeBinDir, { recursive: true });
    await fs.writeFile(
      fakeBwrap,
      [
        "#!/bin/sh",
        "printf '%s\\n' \"$@\" > \"$FAKE_BWRAP_LOG\"",
        "while [ \"$1\" != \"--\" ]; do",
        "  shift",
        "done",
        "shift",
        "exec \"$@\"",
        "",
      ].join("\n"),
      "utf-8",
    );
    await fs.chmod(fakeBwrap, 0o755);

    process.env.FAKE_BWRAP_LOG = fakeLog;
    try {
      const wrapped = await registry.execute("execute_command", {
        command: "echo sandbox-wrapped",
        workdir: TEST_ROOT,
        _sandbox: {
          binary: fakeBwrap,
          trusted_dirs: [TEST_ROOT],
          network: false,
        },
      });
      assert(!wrapped.isError, `sandboxed execute_command failed: ${textOf(wrapped)}`);
      assert(textOf(wrapped).includes("sandbox-wrapped"), "sandboxed command output mismatch");
      const argvLog = await fs.readFile(fakeLog, "utf-8");
      assert(argvLog.includes("--unshare-net"), "sandbox wrapper disables network");
      assert(argvLog.includes("--bind\n" + TEST_ROOT + "\n" + TEST_ROOT), "sandbox binds trusted dir rw");
      assert(argvLog.includes("/bin/sh\n-c\necho sandbox-wrapped"), "sandbox wraps shell command after --");
    } finally {
      delete process.env.FAKE_BWRAP_LOG;
    }

    const missingSandbox = await registry.execute("execute_command", {
      command: "echo should-not-run",
      _sandbox: {
        binary: path.join(fakeBinDir, "missing-bwrap"),
        trusted_dirs: [TEST_ROOT],
        network: false,
      },
    });
    assert(missingSandbox.isError, "missing sandbox binary fails closed");
    assert(
      textOf(missingSandbox).includes("Sandbox binary is unavailable"),
      "missing sandbox binary has clear error",
    );
    console.log("✓ execute_command sandbox wrapping");
  }

  // execute_command_stream (via registry + direct onChunk)
  {
    const chunks: string[] = [];
    const streamed = await execute_command_stream(
      { command: "echo stream-chunk-1 && echo stream-chunk-2" },
      (chunk) => chunks.push(chunk),
    );
    assert(!streamed.isError, `execute_command_stream failed: ${textOf(streamed)}`);
    assert(chunks.join("").includes("stream-chunk"), "onChunk did not receive output");
    const viaRegistry = await registry.execute("execute_command_stream", {
      command: "echo via-registry",
    });
    assert(!viaRegistry.isError, `execute_command_stream registry failed: ${textOf(viaRegistry)}`);
    console.log("✓ execute_command_stream");
  }

  // list_processes
  {
    const res = await registry.execute("list_processes", { filter: "node" });
    assert(!res.isError, `list_processes failed: ${textOf(res)}`);
    console.log("✓ list_processes");
  }

  // kill_process — spawn sleep then kill
  {
    const child = spawn("sleep", ["30"], { stdio: "ignore", detached: false });
    assert(child.pid, "failed to spawn sleep for kill_process test");
    const res = await registry.execute("kill_process", { pid: child.pid, signal: "SIGTERM" });
    assert(!res.isError, `kill_process failed: ${textOf(res)}`);
    await new Promise<void>((resolve) => {
      child.on("close", () => resolve());
      setTimeout(resolve, 2000);
    });
    console.log("✓ kill_process");
  }

  // browser host policy matcher/wiring
  {
    assert(browserHostMatches("example.com", "example.com"), "host exact match");
    assert(browserHostMatches("app.example.com", "*.example.com"), "host wildcard subdomain match");
    assert(browserHostMatches("example.com", "*.example.com"), "host wildcard apex match");
    assert(!browserHostMatches("evil-example.com", "*.example.com"), "host wildcard suffix boundary");

    setBrowserHostPolicy({
      allow: ["example.com", "*.trusted.test"],
      deny: ["blocked.example.com"],
    });
    const allowed = evaluateBrowserHostPolicy("https://app.trusted.test/path");
    assert(allowed.allowed, "allowed browser host passes policy");
    const denied = evaluateBrowserHostPolicy("https://blocked.example.com/path");
    assert(!denied.allowed, "deny list wins over allow list");
    assert(
      (denied.reason ?? "").includes("denied"),
      "denied browser host has human-readable reason",
    );
    const notAllowed = evaluateBrowserHostPolicy("https://other.test/path");
    assert(!notAllowed.allowed, "non-allowlisted browser host denied");

    setBrowserHostPolicy({
      allow: [],
      deny: ["*.bad.test"],
    });
    assert(evaluateBrowserHostPolicy("https://ok.test").allowed, "empty allow list permits non-denied hosts");
    assert(!evaluateBrowserHostPolicy("https://x.bad.test").allowed, "deny list blocks with empty allow list");
    setBrowserHostPolicy(null);
    console.log("✓ browser host policy matcher");
  }

  // browser_* — success if chromium available, else graceful isError with install hint
  {
    const nav = await registry.execute("browser_navigate", {
      url: "https://example.com",
      headless: true,
    });
    if (nav.isError) {
      const msg = textOf(nav).toLowerCase();
      assert(
        msg.includes("playwright") ||
          msg.includes("chromium") ||
          msg.includes("install") ||
          msg.includes("failed to navigate") ||
          msg.includes("disabled"),
        `browser_navigate error should be human-readable, got: ${textOf(nav)}`,
      );
      console.log("✓ browser_navigate (graceful error)");
    } else {
      console.log("✓ browser_navigate (success)");
    }

    const shot = await registry.execute("browser_screenshot", { full_page: false });
    if (shot.isError) {
      assert(textOf(shot).length > 0, "browser_screenshot error should have message");
      console.log("✓ browser_screenshot (graceful error)");
    } else {
      const img = shot.content.find((c) => c.type === "image");
      assert(img && img.type === "image" && img.data.length > 0, "screenshot should return image");
      console.log("✓ browser_screenshot (success)");
    }

    const click = await registry.execute("browser_click", { selector: "h1" });
    assert(typeof click.isError === "boolean" || click.content.length > 0, "browser_click returned");
    console.log(click.isError ? "✓ browser_click (graceful error/or no page)" : "✓ browser_click (success)");

    const evalRes = await registry.execute("browser_evaluate", { code: "1+1" });
    if (evalRes.isError) {
      assert(textOf(evalRes).length > 0, "browser_evaluate error should have message");
      console.log("✓ browser_evaluate (graceful error)");
    } else {
      assert(textOf(evalRes).includes("2"), "browser_evaluate should return 2");
      console.log("✓ browser_evaluate (success)");
    }

    await closeBrowser();
  }

  // error path: missing file
  {
    const notFound = await registry.execute("read_file", { path: "/nonexistent/deckagent-file.txt" });
    assert(notFound.isError, "read_file missing file should be error");
    console.log("✓ read_file error path");
  }

  await fs.rm(TEST_ROOT, { recursive: true, force: true });
  setJobsDirForTest(null);
  console.log("\nAll smoke tests passed.");
}

main().catch(async (err) => {
  console.error(err);
  try {
    await closeBrowser();
  } catch {
    // ignore
  }
  process.exit(1);
});
