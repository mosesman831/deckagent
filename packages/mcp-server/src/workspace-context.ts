import path from "path";
import os from "os";

export interface WorkspaceContext {
  root: string | null;
  name: string | null;
}

let ctx: WorkspaceContext = { root: null, name: null };

export function setWorkspaceContext(c: WorkspaceContext): void {
  ctx = { root: c.root, name: c.name };
}

export function getWorkspaceContext(): WorkspaceContext {
  return { root: ctx.root, name: ctx.name };
}

function expandHome(input: string): string {
  if (input === "~") return os.homedir();
  if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
  return input;
}

/**
 * Resolve a tool path for filesystem/terminal operations.
 * - Absolute or `~/` paths: expand home, return absolute.
 * - Relative with workspace set: resolve against workspace.root.
 * - Relative with no workspace: resolve against process.cwd().
 */
export function resolveToolPath(input: string): string {
  if (input === "~" || input.startsWith("~/") || path.isAbsolute(input)) {
    return path.resolve(expandHome(input));
  }

  const workspace = getWorkspaceContext();
  if (workspace.root) {
    return path.resolve(workspace.root, input);
  }

  return path.resolve(process.cwd(), input);
}
