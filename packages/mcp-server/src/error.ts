/**
 * ToolError is the single error type thrown by every tool. It carries a
 * machine-readable `code` (see SPEC §6.1) and a human-readable message.
 */
export class ToolError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ToolError';
    Object.setPrototypeOf(this, ToolError.prototype);
  }
}

/**
 * Coerce an unknown thrown value into a ToolError with a sensible default code.
 * Node.js filesystem/system errors are mapped to human-readable messages.
 */
export function toToolError(err: unknown, fallbackCode = 'INTERNAL_ERROR'): ToolError {
  if (err instanceof ToolError) return err;
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    switch (code) {
      case 'ENOENT':
        return new ToolError('FILE_NOT_FOUND', humanizeErrno(err), { cause: code });
      case 'EACCES':
      case 'EPERM':
        return new ToolError('INTERNAL_ERROR', `Permission denied: ${err.message}`, { cause: code });
      default:
        return new ToolError(fallbackCode, err.message, { cause: code });
    }
  }
  return new ToolError(fallbackCode, String(err));
}

function humanizeErrno(err: Error): string {
  const path = (err as NodeJS.ErrnoException).path;
  return path ? `File or directory not found: ${path}` : err.message;
}
