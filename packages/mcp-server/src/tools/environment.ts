import os from "os";
import { GetEnvironmentArgsSchema, type GetEnvironmentArgs, type ToolResponse } from "../schemas.js";

export async function get_environment(args: GetEnvironmentArgs = {}): Promise<ToolResponse> {
  GetEnvironmentArgsSchema.parse(args);

  const platform = os.platform();
  const release = os.release();
  const totalMemoryBytes = os.totalmem();
  const totalMemoryGB = Math.round(totalMemoryBytes / (1024 * 1024 * 1024));

  const info = {
    os: platform,
    arch: os.arch(),
    platform: `${platform} ${release}`,
    hostname: os.hostname(),
    home_dir: os.homedir(),
    shell: process.env.SHELL || "unknown",
    cpu_count: os.cpus().length,
    memory_gb: totalMemoryGB,
  };

  return {
    content: [{ type: "text", text: JSON.stringify(info, null, 2) }],
  };
}
