import * as os from 'os';
import type { ToolDefinition, ToolContext } from '../types.js';
import { GetEnvironmentArgsSchema } from '../schemas.js';

/** Produce a friendly platform string like "Linux 5.15.0" or "macOS 15.2". */
function platformString(): string {
  const release = os.release();
  switch (process.platform) {
    case 'darwin':
      return `macOS ${release}`;
    case 'win32':
      return `Windows ${release}`;
    case 'linux':
      return `Linux ${release}`;
    default:
      return `${process.platform} ${release}`;
  }
}

function defaultShell(context: ToolContext): string {
  if (context.shell) return context.shell;
  if (process.platform === 'win32') {
    return process.env.ComSpec || 'cmd.exe';
  }
  return process.env.SHELL || '/bin/sh';
}

export const toolDefinitions: ToolDefinition[] = [
  {
    name: 'get_environment',
    description:
      'Get system environment information — OS, architecture, platform, hostname, home directory, shell, CPU count, and memory.',
    inputSchema: GetEnvironmentArgsSchema,
    handler: async (_args, context: ToolContext) => {
      const info = {
        os: process.platform,
        arch: process.arch,
        platform: platformString(),
        hostname: os.hostname(),
        home_dir: context.homeDir ?? os.homedir(),
        shell: defaultShell(context),
        cpu_count: os.cpus().length,
        memory_gb: Math.round(os.totalmem() / 1024 / 1024 / 1024),
      };
      return { content: [{ type: 'text', text: JSON.stringify(info, null, 2) }] };
    },
  },
];
