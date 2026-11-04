/**
 * Thin fetch wrapper: token injection, timeouts, ArcGIS error normalisation,
 * and one automatic retry when the server reports an expired token (498/499).
 */

import {
  NullIslandAuthError,
  NullIslandError,
  NullIslandHttpError,
  isAbortError,
} from './errors.ts';
import type {TokenSource} from './types.ts';

export type QueryParams = Record<string, string | number | boolean | null | undefined>;

export interface HttpClientOptions {
  fetch?: typeof fetch;
  token?: TokenSource;
  timeoutMs?: number;
}

interface ArcGisErrorBody {
  error?: {
    code?: number;
    message?: string;
    details?: string[];
  };
}

const DEFAULT_TIMEOUT_MS = 30_000;

export class HttpClient {
  private token: TokenSource | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: HttpClientOptions = {}) {
    const impl = options.fetch ?? (typeof fetch === 'function' ? fetch : undefined);
    if (!impl) {
      throw new NullIslandError('No fetch implementation available', 'NULLISLAND_NO_FETCH');
    }
    this.fetchImpl = impl;
    this.token = options.token;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  setToken(token: TokenSource | undefined): void {
    this.token = token;
  }

  /** GET a URL with query parameters and the configured token. */
  async request(url: string, params: QueryParams = {}, init: RequestInit = {}): Promise<Response> {
    let lastError: NullIslandHttpError | undefined;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const token = await this.resolveToken();
      const full = withParams(url, params, token);
      let response: Response;
      try {
        response = await this.fetchWithTimeout(full, init);
      } catch (error) {
        if (isAbortError(error)) throw error;
        throw new NullIslandHttpError(
          error instanceof Error ? error.message : 'Network request failed',
          0,
          full,
          {cause: error},
        );
      }

      if ((response.status === 498 || response.status === 499) && attempt === 0) {
        lastError = await this.toError(response, full);
        continue;
      }

      if (!response.ok) throw await this.toError(response, full);
      return response;
    }

    throw lastError ?? new NullIslandAuthError('Token rejected by the ArcGIS server', 499, url);
  }

  /** GET and parse JSON, surfacing ArcGIS `{error: ...}` documents as exceptions. */
  async json<T>(url: string, params: QueryParams = {}): Promise<T> {
    const response = await this.request(url, params);
    return parseJson<T>(await response.text(), url);
  }

  /** GET binary data. */
  async bytes(url: string, params: QueryParams = {}): Promise<{buffer: ArrayBuffer; contentType: string}> {
    const response = await this.request(url, params);
    return {buffer: await response.arrayBuffer(), contentType: response.headers.get('content-type') ?? ''};
  }

  private async resolveToken(): Promise<string | null> {
    if (!this.token) return null;
    if (typeof this.token === 'string') return this.token;
    try {
      const value = await this.token();
      return value || null;
    } catch (error) {
      throw new NullIslandAuthError(
        'Token provider threw',
        401,
        'token',
        {cause: error},
      );
    }
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('Request timed out')), this.timeoutMs);
    const source = init.signal;
    const forwardAbort = () => controller.abort(source?.reason);
    if (source) {
      if (source.aborted) forwardAbort();
      else source.addEventListener('abort', forwardAbort, {once: true});
    }

    try {
      return await this.fetchImpl(url, {...init, signal: controller.signal});
    } finally {
      clearTimeout(timer);
      source?.removeEventListener('abort', forwardAbort);
    }
  }

  private async toError(response: Response, url: string): Promise<NullIslandHttpError> {
    let message = `ArcGIS request failed with HTTP ${response.status}`;
    let details: unknown;
    try {
      const text = await response.text();
      if (text) {
        const body = parseJson<ArcGisErrorBody>(text, url, {soft: true});
        if (body?.error?.message) {
          message = body.error.message;
          details = body.error.details;
        }
      }
    } catch {
      // Ignore body parsing failures; the status code is the useful signal.
    }

    const ErrorType = response.status === 401 || response.status === 498 || response.status === 499
      ? NullIslandAuthError
      : NullIslandHttpError;
    return new ErrorType(message, response.status, url, {details});
  }
}

function withParams(url: string, params: QueryParams, token: string | null): string {
  const absolute = new URL(url, getBaseUrl());
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    absolute.searchParams.set(key, String(value));
  }
  if (token) absolute.searchParams.set('token', token);
  return absolute.toString();
}

function getBaseUrl(): string {
  if (typeof location !== 'undefined' && location.href) return location.href;
  return 'http://localhost/';
}

function parseJson<T>(text: string, url: string, options: {soft?: boolean} = {}): T {
  try {
    const data = JSON.parse(text) as T & ArcGisErrorBody;
    if (data && typeof data === 'object' && 'error' in data && data.error) {
      throw new NullIslandHttpError(
        data.error.message ?? 'ArcGIS request failed',
        data.error.code ?? 500,
        url,
        {details: data.error.details},
      );
    }
    return data;
  } catch (error) {
    if (error instanceof NullIslandHttpError) throw error;
    if (options.soft) return undefined as T;
    throw new NullIslandError(`Invalid JSON from ${url}`, 'NULLISLAND_BAD_JSON', {cause: error});
  }
}
