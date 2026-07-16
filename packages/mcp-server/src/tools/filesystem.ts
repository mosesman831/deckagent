import fs from "fs/promises";
import path from "path";
import os from "os";
import { execFile } from "child_process";
import { promisify } from "util";
import {
  ReadFileArgsSchema,
  WriteFileArgsSchema,
  EditFileArgsSchema,
  SearchFilesArgsSchema,
  ListDirectoryArgsSchema,
  CreateDirectoryArgsSchema,
  MoveFileArgsSchema,
  GetFileInfoArgsSchema,
  ReadMultipleFilesArgsSchema,
  type ReadFileArgs,
  type WriteFileArgs,
  type EditFileArgs,
  type SearchFilesArgs,
  type ListDirectoryArgs,
  type CreateDirectoryArgs,
  type MoveFileArgs,
  type GetFileInfoArgs,
  type ReadMultipleFilesArgs,
  type ToolResponse,
} from "../schemas.js";

const execFileAsync = promisify(execFile);

/** Default 10 MiB; daemon may lower via setMaxFileReadSize. */
let maxFileReadSize = 10 * 1024 * 1024;

export function setMaxFileReadSize(bytes: number): void {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    throw new Error("max file read size must be a positive number");
  }
  maxFileReadSize = Math.floor(bytes);
}

export function getMaxFileReadSize(): number {
  return maxFileReadSize;
}

function expandHome(input: string): string {
  if (input === "~" || input.startsWith("~/")) {
    return path.join(os.homedir(), input.slice(1));
  }
  return input;
}

function humanError(err: unknown, fallback: string): string {
  if (err instanceof Error) return err.message;
  return fallback;
}

async function isBinary(filePath: string): Promise<boolean> {
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = new Uint8Array(4096);
    const { bytesRead } = await handle.read(buffer, 0, 4096, 0);
    if (bytesRead === 0) return false;
    let nullCount = 0;
    for (let i = 0; i < bytesRead; i++) {
      if (buffer[i] === 0) nullCount++;
    }
    return nullCount / bytesRead > 0.3;
  } finally {
    await handle.close();
  }
}

export async function read_file(args: ReadFileArgs): Promise<ToolResponse> {
  const parsed = ReadFileArgsSchema.parse(args);
  const filePath = expandHome(parsed.path);

  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      return {
        content: [{ type: "text", text: `Not a file: ${filePath}` }],
        isError: true,
      };
    }

    if (stat.size > maxFileReadSize) {
      return {
        content: [
          {
            type: "text",
            text: `File too large to read: ${filePath} (${stat.size} bytes exceeds limit of ${maxFileReadSize} bytes)`,
          },
        ],
        isError: true,
      };
    }

    if (await isBinary(filePath)) {
      return {
        content: [{ type: "text", text: `File appears to be binary: ${filePath}` }],
        isError: true,
      };
    }

    const content = await fs.readFile(filePath, "utf-8");
    const lines = content.split(/\r?\n/);
    const offset = Math.max(1, parsed.offset);
    const limit = Math.min(parsed.limit, 5000);
    const slice = lines.slice(offset - 1, offset - 1 + limit);
    const text = slice.join("\n");

    return {
      content: [{ type: "text", text }],
    };
  } catch (err) {
    return {
      content: [{ type: "text", text: `Failed to read file ${filePath}: ${humanError(err, "unknown error")}` }],
      isError: true,
    };
  }
}

export async function write_file(args: WriteFileArgs): Promise<ToolResponse> {
  const parsed = WriteFileArgsSchema.parse(args);
  const filePath = expandHome(parsed.path);

  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.tmp.${Date.now()}`;
    await fs.writeFile(tmpPath, parsed.content, "utf-8");
    await fs.rename(tmpPath, filePath);
    return {
      content: [{ type: "text", text: `Written ${Buffer.byteLength(parsed.content)} bytes to ${filePath}` }],
    };
  } catch (err) {
    return {
      content: [{ type: "text", text: `Failed to write file ${filePath}: ${humanError(err, "unknown error")}` }],
      isError: true,
    };
  }
}

export async function edit_file(args: EditFileArgs): Promise<ToolResponse> {
  const parsed = EditFileArgsSchema.parse(args);
  const filePath = expandHome(parsed.path);

  try {
    const content = await fs.readFile(filePath, "utf-8");
    const occurrences = content.split(parsed.old_string).length - 1;

    if (occurrences === 0) {
      return {
        content: [{ type: "text", text: `old_string not found in ${filePath}` }],
        isError: true,
      };
    }

    if (!parsed.replace_all && occurrences > 1) {
      return {
        content: [
          {
            type: "text",
            text: `Found ${occurrences} occurrences. Use replace_all=true or provide more context.`,
          },
        ],
        isError: true,
      };
    }

    const newContent = parsed.replace_all
      ? content.split(parsed.old_string).join(parsed.new_string)
      : content.replace(parsed.old_string, parsed.new_string);

    await fs.writeFile(filePath, newContent, "utf-8");

    const oldLines = parsed.old_string.split("\n");
    const newLines = parsed.new_string.split("\n");
    const diff = [
      `- ${oldLines[0]}`,
      `+ ${newLines[0]}`,
    ].join("\n");

    return {
      content: [{ type: "text", text: `Edited ${filePath}\nDiff:\n${diff}` }],
    };
  } catch (err) {
    return {
      content: [{ type: "text", text: `Failed to edit file ${filePath}: ${humanError(err, "unknown error")}` }],
      isError: true,
    };
  }
}

export async function search_files(args: SearchFilesArgs): Promise<ToolResponse> {
  const parsed = SearchFilesArgsSchema.parse(args);
  const searchPath = expandHome(parsed.path);

  try {
    let output = "";
    try {
      const rgArgs = ["-n", "--color", "never", "--max-count", "10", parsed.pattern];
      if (parsed.file_glob) {
        rgArgs.push("-g", parsed.file_glob);
      }
      rgArgs.push(searchPath);
      const { stdout } = await execFileAsync("rg", rgArgs, { maxBuffer: 10 * 1024 * 1024 });
      output = stdout;
    } catch {
      output = await fallbackSearch(searchPath, parsed.pattern, parsed.file_glob, parsed.max_results);
    }

    const lines = output.split("\n").filter(Boolean).slice(0, parsed.max_results);
    return {
      content: [{ type: "text", text: lines.join("\n") || "No results found" }],
    };
  } catch (err) {
    return {
      content: [{ type: "text", text: `Failed to search files: ${humanError(err, "unknown error")}` }],
      isError: true,
    };
  }
}

async function fallbackSearch(
  searchPath: string,
  pattern: string,
  fileGlob: string | undefined,
  maxResults: number,
): Promise<string> {
  const regex = new RegExp(pattern, "g");
  const results: string[] = [];

  async function walk(dir: string) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        if (fileGlob && !entry.name.match(new RegExp(fileGlob.replace(/\*/g, ".*").replace(/\?/g, ".")))) {
          continue;
        }
        try {
          const content = await fs.readFile(fullPath, "utf-8");
          const lines = content.split("\n");
          for (let i = 0; i < lines.length; i++) {
            if (regex.test(lines[i])) {
              results.push(`${fullPath}:${i + 1}: ${lines[i]}`);
              if (results.length >= maxResults) return;
            }
          }
        } catch {
          // ignore unreadable files
        }
      }
    }
  }

  try {
    await walk(searchPath);
  } catch {
    // ignore walk errors
  }

  return results.join("\n");
}

export async function list_directory(args: ListDirectoryArgs): Promise<ToolResponse> {
  const parsed = ListDirectoryArgsSchema.parse(args);
  const dirPath = expandHome(parsed.path);

  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    const lines = await Promise.all(
      entries.map(async (entry) => {
        const fullPath = path.join(dirPath, entry.name);
        let info = "";
        try {
          const stat = await fs.stat(fullPath);
          info = `${stat.isDirectory() ? "DIR" : "FILE"} ${stat.size} bytes ${stat.mtime.toISOString()}`;
        } catch {
          info = "unknown";
        }
        return `${entry.name}\t${info}`;
      }),
    );
    return {
      content: [{ type: "text", text: lines.join("\n") }],
    };
  } catch (err) {
    return {
      content: [{ type: "text", text: `Failed to list directory ${dirPath}: ${humanError(err, "unknown error")}` }],
      isError: true,
    };
  }
}

export async function create_directory(args: CreateDirectoryArgs): Promise<ToolResponse> {
  const parsed = CreateDirectoryArgsSchema.parse(args);
  const dirPath = expandHome(parsed.path);

  try {
    await fs.mkdir(dirPath, { recursive: true });
    return {
      content: [{ type: "text", text: `Created directory ${dirPath}` }],
    };
  } catch (err) {
    return {
      content: [{ type: "text", text: `Failed to create directory ${dirPath}: ${humanError(err, "unknown error")}` }],
      isError: true,
    };
  }
}

export async function move_file(args: MoveFileArgs): Promise<ToolResponse> {
  const parsed = MoveFileArgsSchema.parse(args);
  const source = expandHome(parsed.source);
  const destination = expandHome(parsed.destination);

  try {
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.rename(source, destination);
    return {
      content: [{ type: "text", text: `Moved ${source} to ${destination}` }],
    };
  } catch (err) {
    return {
      content: [{ type: "text", text: `Failed to move ${source} to ${destination}: ${humanError(err, "unknown error")}` }],
      isError: true,
    };
  }
}

export async function get_file_info(args: GetFileInfoArgs): Promise<ToolResponse> {
  const parsed = GetFileInfoArgsSchema.parse(args);
  const filePath = expandHome(parsed.path);

  try {
    const stat = await fs.stat(filePath);
    return {
      content: [
        {
          type: "text",
          text: [
            `Path: ${filePath}`,
            `Type: ${stat.isFile() ? "file" : stat.isDirectory() ? "directory" : "other"}`,
            `Size: ${stat.size}`,
            `Created: ${stat.birthtime.toISOString()}`,
            `Modified: ${stat.mtime.toISOString()}`,
            `Permissions: ${stat.mode.toString(8)}`,
          ].join("\n"),
        },
      ],
    };
  } catch (err) {
    return {
      content: [{ type: "text", text: `Failed to get file info ${filePath}: ${humanError(err, "unknown error")}` }],
      isError: true,
    };
  }
}

export async function read_multiple_files(args: ReadMultipleFilesArgs): Promise<ToolResponse> {
  const parsed = ReadMultipleFilesArgsSchema.parse(args);
  const results: string[] = [];

  for (const p of parsed.paths.slice(0, 10)) {
    const res = await read_file({ path: p, offset: 1, limit: 500 });
    results.push(`--- ${p} ---`);
    results.push(
      res.content
        .map((c) => (c.type === "text" ? c.text : `[image ${c.mimeType}]`))
        .join("\n"),
    );
  }

  return {
    content: [{ type: "text", text: results.join("\n") }],
  };
}
