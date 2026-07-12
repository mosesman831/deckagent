import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_ROTATED_FILES = 5;

export interface LoggerOptions {
  /** Directory to write logs to. Defaults to `~/.deckagent/logs`. */
  dir?: string;
  /** Minimum level to emit. Defaults to `info`. */
  level?: LogLevel;
  /** Also mirror log lines to stdout (used with `--foreground`). */
  console?: boolean;
  /** Rotate when the current log would exceed this many bytes. Defaults to 10MB. */
  maxBytes?: number;
  /** Number of rotated files to keep. Defaults to 5. */
  maxFiles?: number;
}

/**
 * A small append-only file logger with size-based rotation.
 *
 * Current log:   `<dir>/deckagent.log`
 * Rotated files: `<dir>/deckagent-1.log` ... `<dir>/deckagent-5.log`
 *
 * When the current log reaches 10MB it is rotated: `deckagent-4.log` becomes
 * `deckagent-5.log`, ..., `deckagent.log` becomes `deckagent-1.log`, and a new
 * empty current log is started. At most 5 rotated files are kept.
 */
export class Logger {
  private dir: string;
  private level: LogLevel;
  private toConsole: boolean;
  private currentFile: string;
  private maxBytes: number;
  private maxFiles: number;

  constructor(options: LoggerOptions = {}) {
    this.dir = options.dir ?? path.join(os.homedir(), '.deckagent', 'logs');
    this.level = options.level ?? 'info';
    this.toConsole = options.console ?? false;
    this.maxBytes = options.maxBytes ?? MAX_LOG_SIZE;
    this.maxFiles = options.maxFiles ?? MAX_ROTATED_FILES;
    this.currentFile = path.join(this.dir, 'deckagent.log');
    fs.mkdirSync(this.dir, { recursive: true });
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  getCurrentFile(): string {
    return this.currentFile;
  }

  debug(message: string): void {
    this.log('debug', message);
  }

  info(message: string): void {
    this.log('info', message);
  }

  warn(message: string): void {
    this.log('warn', message);
  }

  error(message: string): void {
    this.log('error', message);
  }

  log(level: LogLevel, message: string): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return;
    const line = `${formatTimestamp(new Date())} [${level.toUpperCase()}] ${message}\n`;
    this.rotateIfNeeded(line.length);
    fs.appendFileSync(this.currentFile, line, 'utf8');
    if (this.toConsole) {
      const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
      stream.write(line);
    }
  }

  /** Rotate the current log if writing `incomingBytes` would exceed the size cap. */
  private rotateIfNeeded(incomingBytes: number): void {
    let size = 0;
    try {
      size = fs.statSync(this.currentFile).size;
    } catch {
      return; // no current file yet, nothing to rotate
    }
    if (size + incomingBytes <= this.maxBytes) return;
    this.rotate();
  }

  private rotate(): void {
    // Drop the oldest, then shift each rotated file up by one.
    const oldest = this.rotatedPath(this.maxFiles);
    if (fs.existsSync(oldest)) fs.rmSync(oldest, { force: true });
    for (let i = this.maxFiles - 1; i >= 1; i--) {
      const from = this.rotatedPath(i);
      const to = this.rotatedPath(i + 1);
      if (fs.existsSync(from)) fs.renameSync(from, to);
    }
    if (fs.existsSync(this.currentFile)) {
      fs.renameSync(this.currentFile, this.rotatedPath(1));
    }
  }

  private rotatedPath(n: number): string {
    return path.join(this.dir, `deckagent-${n}.log`);
  }
}

/** Format a date as `YYYY-MM-DD HH:mm:ss` in local time. */
export function formatTimestamp(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

/**
 * Create a logger. The exported singleton `logger` is initialized lazily via
 * {@link initLogger} so the config-driven level/dir can be applied at startup.
 */
export function createLogger(options: LoggerOptions = {}): Logger {
  return new Logger(options);
}

let singleton: Logger | null = null;

/** Initialize (or reconfigure) the process-wide logger singleton. */
export function initLogger(options: LoggerOptions = {}): Logger {
  singleton = new Logger(options);
  return singleton;
}

/**
 * The process-wide logger. Falls back to a default (`~/.deckagent/logs`, info)
 * if {@link initLogger} has not been called yet.
 */
export const logger = {
  debug: (m: string): void => getSingleton().debug(m),
  info: (m: string): void => getSingleton().info(m),
  warn: (m: string): void => getSingleton().warn(m),
  error: (m: string): void => getSingleton().error(m),
  setLevel: (l: LogLevel): void => getSingleton().setLevel(l),
  getCurrentFile: (): string => getSingleton().getCurrentFile(),
};

function getSingleton(): Logger {
  if (!singleton) singleton = new Logger();
  return singleton;
}
