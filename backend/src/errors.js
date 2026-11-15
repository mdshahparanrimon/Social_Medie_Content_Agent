export function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// Failures with a machine-readable `code`, so callers (and MCP clients) can tell an expired link from an oversized file.
export class AppError extends Error {
  constructor(code, message, { status = 400, details } = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    if (details) this.details = details;
  }
}
