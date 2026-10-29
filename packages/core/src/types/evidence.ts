import type { HttpMethod } from './agents.js';

/**
 * One API request and what came back, as the models, issues, and the
 * dashboard see it. The api driver builds it, and every header and body in it
 * is already redacted. `response` is absent when no answer came (`error`).
 */
export type HttpExchange = {
  /** `path` holds the query string too. Only allowlisted headers are kept. */
  request: { method: HttpMethod; path: string; headers: Record<string, string>; body?: string };
  response?: {
    status: number;
    headers: Record<string, string>;
    contentType: string | null;
    /** Empty when `tooLarge`. */
    body: string;
    /** The size of the body as it came, before redaction. */
    bytes: number;
    /** The body was over the read limit, so Bugpatrol kept none of it. */
    tooLarge?: true;
    /** The server streamed the body, and Bugpatrol cut it at the read limit. */
    stream?: true;
  };
  /** Why no response came: a timeout, a refused connection, a rejected request. */
  error?: string;
  latencyMs: number;
  at: string;
};

/**
 * What an issue shows. An `image` is a capture of the screen, with
 * workspace-relative paths. An `http` is the exchange as text: an api
 * observation has no pixels (ADR 0008).
 */
export type Evidence =
  | { kind: 'image'; screenshot: string; baseline?: string; diff?: string }
  | { kind: 'http'; exchange: HttpExchange };
