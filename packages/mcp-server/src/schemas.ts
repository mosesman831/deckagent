import { z } from "zod";

const PositiveInt = z.number().int().positive();

export const ReadFileArgsSchema = z.object({
  path: z.string(),
  offset: PositiveInt.optional().default(1),
  limit: PositiveInt.max(5000).optional().default(500),
});

export const WriteFileArgsSchema = z.object({
  path: z.string(),
  content: z.string(),
});

export const EditFileArgsSchema = z.object({
  path: z.string(),
  old_string: z.string(),
  new_string: z.string(),
  replace_all: z.boolean().optional().default(false),
});

export const SearchFilesArgsSchema = z.object({
  pattern: z.string(),
  path: z.string().optional().default("~"),
  file_glob: z.string().optional(),
  max_results: z.number().int().min(1).max(200).optional().default(50),
});

export const ListDirectoryArgsSchema = z.object({
  path: z.string(),
});

export const CreateDirectoryArgsSchema = z.object({
  path: z.string(),
});

export const MoveFileArgsSchema = z.object({
  source: z.string(),
  destination: z.string(),
});

export const GetFileInfoArgsSchema = z.object({
  path: z.string(),
});

export const ReadMultipleFilesArgsSchema = z.object({
  paths: z.array(z.string()).max(10),
});

export const TerminalSandboxPlanSchema = z
  .object({
    binary: z.string().min(1),
    trusted_dirs: z.array(z.string()).default([]),
    network: z.boolean().default(false),
  })
  .strict();

export const ExecuteCommandArgsSchema = z.object({
  command: z.string(),
  workdir: z.string().optional(),
  timeout: z.number().int().min(1).max(300).optional().default(60),
  env: z.record(z.string()).optional(),
  /** Secret names for the daemon to inject into env before spawn; handlers ignore this field. */
  use_secrets: z.array(z.string()).optional(),
  /** Hidden daemon-only execution context for terminal_mode=sandbox_fs. */
  _sandbox: TerminalSandboxPlanSchema.optional(),
});

export const ExecuteCommandStreamArgsSchema = z.object({
  command: z.string(),
  workdir: z.string().optional(),
  env: z.record(z.string()).optional(),
  /** Secret names for the daemon to inject into env before spawn; handlers ignore this field. */
  use_secrets: z.array(z.string()).optional(),
  /** Hidden daemon-only execution context for terminal_mode=sandbox_fs. */
  _sandbox: TerminalSandboxPlanSchema.optional(),
});

export const ListProcessesArgsSchema = z.object({
  filter: z.string().optional(),
  /** Hidden daemon-only execution context for terminal_mode=sandbox_fs. */
  _sandbox: TerminalSandboxPlanSchema.optional(),
});

export const KillProcessArgsSchema = z.object({
  pid: z.number().int().positive(),
  signal: z.string().optional().default("SIGTERM"),
});

export const BrowserNavigateArgsSchema = z.object({
  url: z.string(),
  headless: z.boolean().optional().default(true),
});

export const BrowserScreenshotArgsSchema = z.object({
  full_page: z.boolean().optional().default(false),
});

export const BrowserClickArgsSchema = z.object({
  selector: z.string(),
});

export const BrowserEvaluateArgsSchema = z.object({
  code: z.string(),
});

export const GetEnvironmentArgsSchema = z.object({});

export const ListSnapshotsArgsSchema = z.object({
  path: z.string().optional(),
  limit: z.number().int().min(1).max(100).optional().default(20),
});

export const RestoreSnapshotArgsSchema = z.object({
  id: z.string().uuid(),
});

export type ReadFileArgs = z.infer<typeof ReadFileArgsSchema>;
export type WriteFileArgs = z.infer<typeof WriteFileArgsSchema>;
export type EditFileArgs = z.infer<typeof EditFileArgsSchema>;
export type SearchFilesArgs = z.infer<typeof SearchFilesArgsSchema>;
export type ListDirectoryArgs = z.infer<typeof ListDirectoryArgsSchema>;
export type CreateDirectoryArgs = z.infer<typeof CreateDirectoryArgsSchema>;
export type MoveFileArgs = z.infer<typeof MoveFileArgsSchema>;
export type GetFileInfoArgs = z.infer<typeof GetFileInfoArgsSchema>;
export type ReadMultipleFilesArgs = z.infer<typeof ReadMultipleFilesArgsSchema>;
export type ExecuteCommandArgs = z.infer<typeof ExecuteCommandArgsSchema>;
export type ExecuteCommandStreamArgs = z.infer<typeof ExecuteCommandStreamArgsSchema>;
export type ListProcessesArgs = z.infer<typeof ListProcessesArgsSchema>;
export type KillProcessArgs = z.infer<typeof KillProcessArgsSchema>;
export type BrowserNavigateArgs = z.infer<typeof BrowserNavigateArgsSchema>;
export type BrowserScreenshotArgs = z.infer<typeof BrowserScreenshotArgsSchema>;
export type BrowserClickArgs = z.infer<typeof BrowserClickArgsSchema>;
export type BrowserEvaluateArgs = z.infer<typeof BrowserEvaluateArgsSchema>;
export type GetEnvironmentArgs = z.infer<typeof GetEnvironmentArgsSchema>;
export type ListSnapshotsArgs = z.infer<typeof ListSnapshotsArgsSchema>;
export type RestoreSnapshotArgs = z.infer<typeof RestoreSnapshotArgsSchema>;
export type TerminalSandboxPlan = z.infer<typeof TerminalSandboxPlanSchema>;

export type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface ToolResponse {
  content: ToolContent[];
  isError?: boolean;
}
