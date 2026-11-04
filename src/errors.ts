/** Error types thrown and emitted by nullisland. */

export class NullIslandError extends Error {
  readonly code: string;

  constructor(message: string, code = 'NULLISLAND_ERROR', options?: ErrorOptions) {
    super(message, options);
    this.name = 'NullIslandError';
    this.code = code;
  }
}

export class NullIslandConfigError extends NullIslandError {
  constructor(message: string) {
    super(message, 'NULLISLAND_CONFIG');
    this.name = 'NullIslandConfigError';
  }
}

export class NullIslandHttpError extends NullIslandError {
  readonly status: number;
  readonly url: string;
  readonly details?: unknown;

  constructor(message: string, status: number, url: string, options?: ErrorOptions & {details?: unknown}) {
    super(message, 'NULLISLAND_HTTP', options);
    this.name = 'NullIslandHttpError';
    this.status = status;
    this.url = url;
    this.details = options?.details;
  }
}

/** The ArcGIS server rejected the request because the token is missing or expired. */
export class NullIslandAuthError extends NullIslandHttpError {
  constructor(message: string, status: number, url: string, options?: ErrorOptions & {details?: unknown}) {
    super(message, status, url, options);
    this.name = 'NullIslandAuthError';
  }
}

/** A request was superseded before it completed. Usually safe to ignore. */
export class NullIslandAbortError extends NullIslandError {
  constructor(message = 'Request aborted') {
    super(message, 'NULLISLAND_ABORTED');
    this.name = 'NullIslandAbortError';
  }
}

export function isAbortError(error: unknown): boolean {
  if (error instanceof NullIslandAbortError) return true;
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as {name?: unknown}).name === 'AbortError'
  );
}
