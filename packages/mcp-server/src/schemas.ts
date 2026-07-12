import { z } from 'zod';

/**
 * Central registry of Zod input schemas for every tool. Numeric/boolean fields
 * use `z.coerce` because MCP clients frequently send them as strings.
 */

// ---- Filesystem ----

export const ReadFileArgsSchema = z.object({
  path: z.string().min(1, 'path is required'),
  offset: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(5000).default(500),
});

export const WriteFileArgsSchema = z.object({
  path: z.string().min(1, 'path is required'),
  content: z.string(),
});

export const EditFileArgsSchema = z.object({
  path: z.string().min(1, 'path is required'),
  old_string: z.string(),
  new_string: z.string(),
  replace_all: z.coerce.boolean().default(false),
});

export const SearchFilesArgsSchema = z.object({
  pattern: z.string().min(1, 'pattern is required'),
  path: z.string().default('~'),
  file_glob: z.string().optional(),
  max_results: z.coerce.number().int().min(1).max(200).default(50),
});

export const ListDirectoryArgsSchema = z.object({
  path: z.string().min(1, 'path is required'),
});

export const CreateDirectoryArgsSchema = z.object({
  path: z.string().min(1, 'path is required'),
});

export const MoveFileArgsSchema = z.object({
  source: z.string().min(1, 'source is required'),
  destination: z.string().min(1, 'destination is required'),
});

export const GetFileInfoArgsSchema = z.object({
  path: z.string().min(1, 'path is required'),
});

export const ReadMultipleFilesArgsSchema = z.object({
  paths: z.array(z.string().min(1)).min(1, 'at least one path is required'),
});

// ---- Terminal ----

export const ExecuteCommandArgsSchema = z.object({
  command: z.string().min(1, 'command is required'),
  workdir: z.string().optional(),
  timeout: z.coerce.number().int().min(1).max(300).default(60),
  env: z.record(z.string()).optional(),
});

export const ExecuteCommandStreamArgsSchema = z.object({
  command: z.string().min(1, 'command is required'),
  workdir: z.string().optional(),
});

export const ListProcessesArgsSchema = z.object({
  filter: z.string().optional(),
});

export const KillProcessArgsSchema = z.object({
  pid: z.coerce.number().int().min(1),
  signal: z.string().default('SIGTERM'),
});

// ---- Browser ----

export const BrowserNavigateArgsSchema = z.object({
  url: z.string().min(1, 'url is required'),
  headless: z.coerce.boolean().default(true),
});

export const BrowserScreenshotArgsSchema = z.object({
  full_page: z.coerce.boolean().default(false),
});

export const BrowserClickArgsSchema = z.object({
  selector: z.string().min(1, 'selector is required'),
});

export const BrowserEvaluateArgsSchema = z.object({
  code: z.string().min(1, 'code is required'),
});

// ---- Environment ----

export const GetEnvironmentArgsSchema = z.object({});

/** All schemas grouped for convenient re-export. */
export const schemas = {
  ReadFileArgsSchema,
  WriteFileArgsSchema,
  EditFileArgsSchema,
  SearchFilesArgsSchema,
  ListDirectoryArgsSchema,
  CreateDirectoryArgsSchema,
  MoveFileArgsSchema,
  GetFileInfoArgsSchema,
  ReadMultipleFilesArgsSchema,
  ExecuteCommandArgsSchema,
  ExecuteCommandStreamArgsSchema,
  ListProcessesArgsSchema,
  KillProcessArgsSchema,
  BrowserNavigateArgsSchema,
  BrowserScreenshotArgsSchema,
  BrowserClickArgsSchema,
  BrowserEvaluateArgsSchema,
  GetEnvironmentArgsSchema,
} as const;
