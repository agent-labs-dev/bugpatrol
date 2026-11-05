import type { HttpMethod } from './agents.js';

/** One parsed server-sent event from a bounded API response. */
export type SseEvent = {
  event: string;
  data: string;
  id?: string;
  retry?: number;
};

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
    /** An event stream: Bugpatrol keeps a bounded prefix of its text. */
    stream?: true;
    /** Parsed events from the bounded event-stream prefix. */
    events?: SseEvent[];
  };
  /** Why no response came: a timeout, a refused connection, a rejected request. */
  error?: string;
  latencyMs: number;
  at: string;
};

/**
 * What an issue shows. An `image` is a capture of the screen, with
 * workspace-relative paths. A terminal's capture also has `terminal`: its
 * text, with the complete output of the command and the colours of each cell
 * of the screenshot, which shows only the last screenful. An `http` is the
 * exchange as text: an api observation has no pixels (ADR 0008).
 */
export type Evidence =
  | { kind: 'image'; screenshot: string; baseline?: string; diff?: string; terminal?: string }
  | { kind: 'http'; exchange: HttpExchange };
