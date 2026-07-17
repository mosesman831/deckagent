import { homedir } from "node:os";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
  readdirSync,
} from "node:fs";
import { dirname, join, basename } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export class Logger {
  private logDir: string;
  private currentPath: string;
  private currentStream: ReturnType<typeof createWriteStream> | null = null;
  private level: LogLevel;
  private foreground: boolean;
  private maxBytes = 10 * 1024 * 1024;
  private keepFiles = 5;

  constructor(level: LogLevel = "info", foreground = false) {
    this.level = level;
    this.foreground = foreground;
    this.logDir = join(homedir(), ".deckagent", "logs");
    this.currentPath = this.logPathForDate(new Date());
    this.ensureLogDir();
  }

  private ensureLogDir(): void {
    if (!existsSync(this.logDir)) {
      mkdirSync(this.logDir, { recursive: true });
    }
  }

  private logPathForDate(date: Date): string {
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, "0");
    const dd = String(date.getDate()).padStart(2, "0");
    return join(this.logDir, `deckagent-${yyyy}-${mm}-${dd}.log`);
  }

  private write(level: LogLevel, message: string): void {
    if (LOG_LEVELS[level] < LOG_LEVELS[this.level]) return;

    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] [${level.toUpperCase()}] ${message}\n`;

    if (this.foreground) {
      if (level === "error") {
        process.stderr.write(line);
      } else {
        process.stdout.write(line);
      }
    }

    this.rotateIfNeeded();
    this.openStream();
    this.currentStream?.write(line);
  }

  private openStream(): void {
    const expectedPath = this.logPathForDate(new Date());
    if (this.currentStream && this.currentPath === expectedPath) {
      return;
    }

    this.close();
    this.currentPath = expectedPath;
    this.ensureLogDir();
    this.currentStream = createWriteStream(this.currentPath, { flags: "a" });
  }

  private close(): void {
    if (this.currentStream) {
      this.currentStream.end();
      this.currentStream = null;
    }
  }

  private rotateIfNeeded(): void {
    if (!existsSync(this.currentPath)) return;

    let size: number;
    try {
      size = statSync(this.currentPath).size;
    } catch {
      return;
    }

    if (size < this.maxBytes) return;

    this.close();

    const timestamp = Date.now();
    const rotatedName = `${basename(this.currentPath)}.${timestamp}`;
    const rotatedPath = join(this.logDir, rotatedName);

    try {
      renameSync(this.currentPath, rotatedPath);
    } catch {
      // If rotation fails, keep appending.
      return;
    }

    this.cleanupOldLogs();
  }

  private cleanupOldLogs(): void {
    const files = readdirSync(this.logDir)
      .filter((f) => f.startsWith("deckagent-") && f.endsWith(".log"))
      .map((f) => ({ name: f, path: join(this.logDir, f), mtime: 0 }))
      .filter((f) => {
        try {
          f.mtime = statSync(f.path).mtimeMs;
          return true;
        } catch {
          return false;
        }
      })
      .sort((a, b) => a.mtime - b.mtime);

    const rotated = files.filter((f) => f.name.includes(".log."));
    while (rotated.length > this.keepFiles) {
      const oldest = rotated.shift();
      if (!oldest) break;
      try {
        unlinkSync(oldest.path);
      } catch {
        // Ignore cleanup errors.
      }
    }
  }

  rotate(): void {
    this.close();
    if (existsSync(this.currentPath)) {
      const rotatedPath = `${this.currentPath}.${Date.now()}`;
      try {
        renameSync(this.currentPath, rotatedPath);
      } catch {
        // Ignore rotation errors.
      }
    }
    this.cleanupOldLogs();
  }

  debug(message: string): void {
    this.write("debug", message);
  }

  info(message: string): void {
    this.write("info", message);
  }

  warn(message: string): void {
    this.write("warn", message);
  }

  error(message: string): void {
    this.write("error", message);
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  shutdown(): void {
    this.close();
  }
}
