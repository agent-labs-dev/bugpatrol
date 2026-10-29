import type { AgentEvent, FlowEntry, LogRecord, SessionFlow, SessionSignal, SessionSummary } from '@bugpatrol/core';

/**
 * How long after a failure a backend log still counts as its answer. Five
 * seconds covers a synchronous request plus the first flush of an async
 * logger, without pairing a log with a failure it had nothing to do with.
 */
export const DEFAULT_CORRELATION_MS = 5000;

/** A single log line can be huge; the timeline keeps a readable prefix. */
const MAX_SUMMARY = 400;

export type FlowInput = {
  session: SessionSummary;
  events: AgentEvent[];
  signals: SessionSignal[];
  logs: LogRecord[];
  sources: SessionFlow['sources'];
  correlationMs?: number;
  window?: { from: string; to: string };
};

type Staged = { entry: FlowEntry; failure: boolean };

/**
 * Merge one session into a single timeline: what the agent did, what the app's
 * calls did, and what the backend logged. A backend log close behind a failed
 * request or an error is marked `correlated` - that pairing is the line a
 * human reads first when triaging an issue.
 */
export function buildFlow(input: FlowInput): SessionFlow {
  const correlationMs = input.correlationMs ?? DEFAULT_CORRELATION_MS;
  const staged: Staged[] = [
    ...input.events.map((event) => ({ entry: actionEntry(event), failure: event.kind === 'error' })),
    ...input.signals.map((signal) => ({ entry: signalEntry(signal), failure: true })),
    ...input.logs.map((record) => ({ entry: logEntry(record), failure: false })),
  ].sort((a, b) => (a.entry.at < b.entry.at ? -1 : a.entry.at > b.entry.at ? 1 : 0));

  let lastFailureAt: number | undefined;
  for (const item of staged) {
    const at = Date.parse(item.entry.at);
    if (Number.isNaN(at)) continue;
    if (item.failure) {
      lastFailureAt = at;
    } else if (
      item.entry.kind === 'log' &&
      lastFailureAt !== undefined &&
      at >= lastFailureAt &&
      at - lastFailureAt <= correlationMs
    ) {
      item.entry.correlated = true;
    }
  }

  const startedAt = Date.parse(input.session.startedAt);
  const endedAt = input.session.endedAt === undefined ? undefined : Date.parse(input.session.endedAt);
  return {
    version: 1,
    sessionId: input.session.id,
    role: input.session.role,
    startedAt: input.session.startedAt,
    endedAt: input.session.endedAt,
    sources: input.sources,
    durationMs: endedAt !== undefined && !Number.isNaN(startedAt) ? endedAt - startedAt : undefined,
    window: input.window,
    entries: staged.map((item) => item.entry),
  };
}

function clip(text: string): string {
  return text.length <= MAX_SUMMARY ? text : `${text.slice(0, MAX_SUMMARY - 3)}...`;
}

function actionEntry(event: AgentEvent): FlowEntry {
  return {
    at: event.at,
    kind: 'action',
    summary: clip(event.summary),
    label: event.role,
    capture: event.capture,
  };
}

function signalEntry(signal: SessionSignal): FlowEntry {
  return {
    at: signal.at,
    kind: 'request',
    label: signal.kind,
    summary: clip(signal.kind === 'console' ? `Console error: ${signal.text}` : signal.text),
  };
}

function logEntry(record: LogRecord): FlowEntry {
  return {
    at: record.at,
    kind: 'log',
    label: record.source,
    level: record.level,
    summary: clip(record.message),
  };
}
