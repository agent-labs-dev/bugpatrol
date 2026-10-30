import type { z } from 'zod';
import type { logSourceSchema } from '../config/schema.js';

/**
 * How Bugpatrol reaches a backend's logs. Kept generic on purpose: no
 * language, framework or log library is assumed, so the same config works for
 * a Go service writing a file and a JS service POSTing events.
 */
export type LogSourceKind = 'file' | 'stream' | 'webhook';

/** One configured log source, exactly as it appears under `logs:` in bugpatrol.yml. */
export type LogSource = z.infer<typeof logSourceSchema>;

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

/**
 * One collected line. It has been through the same redaction as the rest of
 * the run, so a secret the backend logged cannot reach an artifact.
 */
export type LogRecord = {
  /** The line's own timestamp when it carries one, else the moment it was read. */
  at: string;
  /** The configured source name. */
  source: string;
  level?: LogLevel;
  message: string;
};

/** The slice of a source one session reads, so a long-lived file is not re-read. */
export type LogWindow = { from: string; to: string };

/**
 * One line of `sessions/<id>/signals.jsonl`: what the app itself reported
 * between observations, with the moment it was seen. A failed request or a
 * console error is the link between a user action and the backend's logs.
 */
export type SessionSignal = {
  at: string;
  kind: 'request' | 'console';
  text: string;
};

export type FlowEntryKind = 'action' | 'request' | 'log';

/**
 * One line of the issue flow view. Read top to bottom it is what a human wants
 * when triaging: the action, the request it caused, and the backend log that
 * followed.
 */
export type FlowEntry = {
  at: string;
  kind: FlowEntryKind;
  /** One short sentence for the timeline. */
  summary: string;
  /** The role for an action, `METHOD /path` for a request, the source name for a log. */
  label?: string;
  level?: LogLevel;
  /** A capture file, relative to the workspace root: a PNG, or the exchange JSON of an API. */
  capture?: string;
  /**
   * True for a backend log that landed inside the correlation window of the
   * failed request or error before it: the log is probably that call's answer.
   */
  correlated?: boolean;
};

/** `sessions/<id>/flow.json`: the merged timeline for one session. */
export type SessionFlow = {
  version: 1;
  sessionId: string;
  role: string;
  startedAt: string;
  endedAt?: string;
  /** What each configured source contributed, so an empty view is explainable. */
  sources: Array<{ name: string; kind: LogSourceKind; collected: number }>;
  durationMs?: number;
  /** The window logs were read for, so a reader can tell a gap from silence. */
  window?: LogWindow;
  entries: FlowEntry[];
};
