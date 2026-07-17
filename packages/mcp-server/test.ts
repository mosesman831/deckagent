import { createRegistry } from "./src/index.js";

async function main() {
  const registry = createRegistry();

  console.log("Registered tools:", registry.list().map((t) => t.name));

  const env = await registry.execute("get_environment", {});
  console.log("\nget_environment:", JSON.stringify(env, null, 2));

  const write = await registry.execute("write_file", {
    path: "/tmp/deckagent-test.txt",
    content: "hello world\nsecond line\n",
  });
  console.log("\nwrite_file:", JSON.stringify(write, null, 2));

  const read = await registry.execute("read_file", { path: "/tmp/deckagent-test.txt" });
  console.log("\nread_file:", JSON.stringify(read, null, 2));

  const edit = await registry.execute("edit_file", {
    path: "/tmp/deckagent-test.txt",
    old_string: "second line",
    new_string: "modified line",
  });
  console.log("\nedit_file:", JSON.stringify(edit, null, 2));

  const list = await registry.execute("list_directory", { path: "/tmp" });
  console.log("\nlist_directory (first 3 lines):", list.content[0].text.split("\n").slice(0, 3).join("\n"));

  const cmd = await registry.execute("execute_command", { command: "echo 'from deckagent'" });
  console.log("\nexecute_command:", JSON.stringify(cmd, null, 2));

  const notFound = await registry.execute("read_file", { path: "/nonexistent/file.txt" });
  console.log("\nread_file (not found):", JSON.stringify(notFound, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
