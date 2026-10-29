import type { RequestPolicy } from '@bugpatrol/contract';
import { formatHttpExchange, type HttpExchange, type HttpMethod } from '@bugpatrol/core';
import type { ScreenSnapshot } from '@bugpatrol/invariants';
import { z } from 'zod';
import type { Pacer } from './api-pacer.js';
import { CastRecorder } from './cast.js';
import { nativeSnapshot } from './maestro.js';
import type { ActResult, Driver, DriverAction, Observation, RawResponse } from './types.js';

type ApiOptions = {
  url: string;
  headers: Record<string, string>;
  /** What may be requested. The driver checks each request against it before it sends. */
  policy: RequestPolicy;
  pacer: Pacer;
  timeoutMs: number;
  redact: (value: string) => string;
};

const MAX_BODY_BYTES = 1024 * 1024;
const captureSchema = z.record(z.string().regex(/^RESPONSE_[A-Z0-9_]+$/), z.string().regex(/^(?:\/(?:[^~]|~[01])*)*$/));
/** The response headers an exchange keeps. The others can carry credentials or noise. */
const RESPONSE_HEADERS = ['content-type', 'location', 'retry-after', 'allow', 'www-authenticate', 'x-request-id'];
/** A JSON key or a header with one of these names holds a credential. */
const CREDENTIAL =
  /(?:token|password|secret|authorization|cookie|api[-_]?key|secret[-_]?key|jwt|session|sid|credentials|private[-_]?key)$/i;

function responseCaptures(body: string, pointers: Record<string, string>): Record<string, string> {
  const parsed: unknown = JSON.parse(body);
  return Object.fromEntries(
    Object.entries(pointers).map(([name, pointer]) => {
      let value = parsed;
      for (const part of pointer.split('/').slice(1)) {
        const key = part.replaceAll('~1', '/').replaceAll('~0', '~');
        if (typeof value !== 'object' || value === null || !Object.hasOwn(value, key))
          throw new Error(`Response capture ${name}: JSON pointer ${pointer} did not resolve`);
        value = (value as Record<string, unknown>)[key];
      }
      if ((typeof value !== 'string' && typeof value !== 'number') || value === '[redacted]')
        throw new Error(`Response capture ${name} requires an unredacted string or number`);
      return [name, String(value)];
    }),
  );
}

function redactCredentials(text: string): string {
  try {
    const value: unknown = JSON.parse(text);
    return JSON.stringify(value, (key, item: unknown) => (CREDENTIAL.test(key) ? '[redacted]' : item), 2);
  } catch {
    return text;
  }
}

/** A request before it is sent, and the response as it came: the input of `toExchange`. */
type Sent = {
  method: HttpMethod;
  url: URL;
  /** Only the headers that the action set. The configured headers carry the app's credentials. */
  headers: Record<string, string>;
  body?: string;
  at: number;
};
type Received = {
  status: number;
  headers: Headers;
  text: string;
  bytes: number;
  tooLarge: boolean;
  /** An event stream, cut after its headers (T8). */
  stream?: true;
};

/**
 * An API over HTTP, with no browser: each `request` step sends one request
 * to the configured origin, and the observation is that exchange as text. A
 * recording is an asciicast of the exchanges.
 */
export class ApiDriver implements Driver {
  readonly platform = 'api' as const;
  private readonly origin: string;
  private location: string;
  private exchange?: HttpExchange;
  private raw?: RawResponse;
  /**
   * Requests the server failed, reported once on the next observation in the
   * web driver's `METHOD url → status` form. A 4xx is the API answering
   * correctly; a 5xx or no answer at all is the server's own failure.
   */
  private serverFailures: string[] = [];
  /** The terminal that a recording of requests plays in: wide enough for indented JSON. */
  private readonly cast = new CastRecorder({ width: 100, height: 30 });

  constructor(private readonly api: ApiOptions) {
    const endpoint = new URL(api.url);
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password)
      throw new Error('API endpoint must be an HTTP URL without embedded credentials');
    this.origin = endpoint.origin;
    this.location = endpoint.href;
  }

  /** The request tool offers only the methods of this policy. */
  get policy(): RequestPolicy {
    return this.api.policy;
  }

  /** `app.setup` started the API, and a request is the first contact. */
  async connect(): Promise<void> {}

  async act(action: DriverAction): Promise<ActResult> {
    if (action.kind === 'wait') {
      await new Promise((resolve) => setTimeout(resolve, action.ms));
      return { ok: true, step: { kind: 'wait', ms: action.ms } };
    }
    if (action.kind !== 'request') return { ok: false, error: 'Use request to exercise an API endpoint' };
    let sent: Sent | undefined;
    try {
      const pointers = captureSchema.parse(action.capture ?? {});
      const url = new URL(action.url, this.api.url);
      if (url.origin !== this.origin || url.username || url.password)
        throw new Error('API requests must stay on the configured origin without embedded credentials');
      const verdict = this.api.policy.check(action.method, url.href);
      if (!verdict.ok) throw new Error(`${action.method} ${url.pathname} is not allowed: ${verdict.reason}`);
      if (action.body && ['GET', 'HEAD'].includes(action.method))
        throw new Error('GET and HEAD cannot have a request body');
      if (Buffer.byteLength(action.body ?? '') > MAX_BODY_BYTES) throw new Error('Request body exceeds 1 MiB');
      const headers = new Headers(this.api.headers);
      for (const [name, value] of Object.entries(action.headers ?? {})) headers.set(name, value);
      if (['host', 'connection', 'proxy-authorization'].some((name) => headers.has(name)))
        throw new Error('Host, connection and proxy authorization headers cannot be overridden');
      let response: Response;
      // A 429 waits for its turn one time. A second 429 is "try later", not evidence (T7).
      for (let attempt = 1; ; attempt++) {
        await this.api.pacer.acquire();
        sent = { method: action.method, url, headers: action.headers ?? {}, body: action.body, at: Date.now() };
        response = await fetch(url, {
          method: action.method,
          headers,
          body: action.body,
          redirect: 'manual',
          signal: AbortSignal.timeout(this.api.timeoutMs),
        }).catch((error: unknown) => {
          this.serverFailed(`${action.method} ${url.href} → ${error instanceof Error ? error.name : 'no response'}`);
          throw error;
        });
        const pace = this.api.pacer.onResponse(response.status, response.headers.get('retry-after'));
        if (!pace) break;
        await response.body?.cancel();
        if (pace === 'rate-limited' || attempt === 2) {
          this.raw = undefined;
          this.exchange = undefined;
          return { ok: false, retryable: true, error: 'rate-limited' };
        }
      }
      if (response.status >= 500) this.serverFailed(`${action.method} ${url.href} → ${response.status}`);
      const received = await read(response);
      const all: Record<string, string> = {};
      received.headers.forEach((value, name) => {
        all[name] = value;
      });
      this.raw = {
        status: received.status,
        headers: all,
        text: received.text,
        ...json(received.text),
      };
      const exchange = this.toExchange(sent, received);
      if (Object.keys(pointers).length && received.tooLarge)
        throw new Error('Response captures need the body, and the response was over 1 MiB');
      const captures = Object.keys(pointers).length
        ? responseCaptures(redactCredentials(received.text), pointers)
        : undefined;
      this.exchange = exchange;
      this.location = url.href;
      this.cast.push(castText(exchange));
      return { ok: true, step: action, captures };
    } catch (error) {
      const message = this.api.redact(String(error));
      // Evidence of an earlier request must not stand for this one.
      this.raw = undefined;
      this.exchange = sent ? this.toExchange(sent, message) : undefined;
      if (this.exchange) this.cast.push(castText(this.exchange));
      return { ok: false, retryable: false, error: message };
    }
  }

  /**
   * The exchange as models, issues, and the dashboard see it. This is the one
   * place that picks the headers an exchange shows and redacts it: the
   * configured secrets, and any header or JSON key that names a credential.
   */
  private toExchange(sent: Sent, answer: Received | string): HttpExchange {
    const redact = (text: string) => this.api.redact(redactCredentials(text));
    const request: HttpExchange['request'] = {
      method: sent.method,
      path: this.api.redact(`${sent.url.pathname}${sent.url.search}`),
      headers: Object.fromEntries(
        Object.entries(sent.headers).map(([name, value]) => [
          name.toLowerCase(),
          CREDENTIAL.test(name) ? '[redacted]' : this.api.redact(value),
        ]),
      ),
      ...(sent.body ? { body: redact(sent.body) } : {}),
    };
    const exchange = { request, latencyMs: Date.now() - sent.at, at: new Date(sent.at).toISOString() };
    if (typeof answer === 'string') return { ...exchange, error: answer };
    return {
      ...exchange,
      response: {
        status: answer.status,
        headers: Object.fromEntries(
          RESPONSE_HEADERS.flatMap((name) => {
            const value = answer.headers.get(name);
            return value === null ? [] : [[name, this.api.redact(value)]];
          }),
        ),
        contentType: answer.headers.get('content-type'),
        body: redact(answer.text),
        bytes: answer.bytes,
        ...(answer.tooLarge ? { tooLarge: true as const } : {}),
        ...(answer.stream ? { stream: true as const } : {}),
      },
    };
  }

  /** The last response before redaction. Never put it in a tool result, a log, or a file. */
  lastRaw(): RawResponse | undefined {
    return this.raw;
  }

  async startRecording(): Promise<void> {
    this.cast.start();
  }

  async stopRecording(name: string): Promise<string> {
    return this.cast.stop(name);
  }

  private serverFailed(line: string): void {
    if (this.serverFailures.length < 50) this.serverFailures.push(this.api.redact(line));
  }

  async observe(): Promise<Observation> {
    const request = this.exchange?.request;
    return {
      platform: 'api',
      location: this.api.redact(this.location),
      ...(request ? { title: `${request.method} ${request.path}` } : {}),
      capture: { kind: 'http', ...(this.exchange ? { exchange: this.exchange } : {}) },
      viewport: { width: 0, height: 0, scale: 1 },
      elements: [],
      volatileRegions: [],
      consoleErrors: [],
      networkErrors: this.serverFailures.splice(0),
      at: new Date().toISOString(),
    };
  }

  /** A request runs to its end, so nothing changes between steps. */
  async settle(): Promise<{ frames: number; stable: boolean }> {
    return { frames: 1, stable: true };
  }

  snapshot(observation: Observation, screenId: string): ScreenSnapshot {
    return nativeSnapshot(observation, screenId);
  }

  async close(): Promise<void> {}
}

/**
 * Reads the body up to 1 MiB. A larger body is kept as its size only, never
 * cut silently. An event stream can run forever, so it stops after its headers.
 */
async function read(response: Response): Promise<Received> {
  if (/^text\/event-stream\b/i.test(response.headers.get('content-type') ?? '')) {
    await response.body?.cancel();
    return { status: response.status, headers: response.headers, text: '', bytes: 0, tooLarge: false, stream: true };
  }
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let tooLarge = false;
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_BODY_BYTES) {
          tooLarge = true;
          break;
        }
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
  }
  const length = Number(response.headers.get('content-length'));
  return {
    status: response.status,
    headers: response.headers,
    text: tooLarge ? '' : Buffer.concat(chunks).toString('utf8'),
    bytes: tooLarge && length > bytes ? length : bytes,
    tooLarge,
  };
}

function json(text: string): { json?: unknown } {
  try {
    return { json: JSON.parse(text) };
  } catch {
    return {};
  }
}

/** An exchange as terminal output, for the recording. */
function castText(exchange: HttpExchange): string {
  return `${formatHttpExchange(exchange).replaceAll(/\r?\n/g, '\r\n')}\r\n\r\n`;
}
