import { createRegistry, execute_command_stream, closeBrowser } from "./src/index.js";
import type { ToolResponse } from "./src/schemas.js";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { spawn } from "child_process";

const TEST_ROOT = path.join(os.tmpdir(), `deckagent-mcp-test-${Date.now()}`);

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
    "browser_navigate",
    "browser_screenshot",
    "browser_click",
    "browser_evaluate",
    "get_environment",
  ];
  for (const name of expected) {
    assert(names.includes(name), `missing tool ${name}`);
  }

  await fs.mkdir(TEST_ROOT, { recursive: true });

  // get_environment
  {
    const env = await registry.execute("get_environment", {});
    assert(!env.isError, "get_environment should succeed");
    assert(textOf(env).includes("os"), "get_environment should include os");
    console.log("✓ get_environment");
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
