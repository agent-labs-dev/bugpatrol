import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type AgentEvent,
  type Candidate,
  type CaseId,
  type CoverageCell,
  type CoverageFile,
  type EndpointKey,
  type HttpExchange,
  type HttpMethod,
  type Issue,
  paths,
  type SessionSummary,
} from '@bugpatrol/core';

const SESSION_ID = 'ses_sweep';
const SESSION = `.bugpatrol/runs/sessions/${SESSION_ID}`;

/**
 * `[endpoint, case, status, failed, body]`, or a blocked reason in place of the
 * status. A copy of a sweep on the api fixture. Without a body, the cell takes
 * the body of its status from `BODIES`.
 */
const RESULTS: [string, CaseId, number | string, string[]?, string?][] = [
  ['GET /health', 'ok', 200],
  ['GET /version', 'ok', 200],
  ['GET /version/fleet', 'ok', 200],
  [
    'GET /items',
    'ok',
    200,
    ['contract:schema'],
    json({
      result: [{ id: '1', name: 'Alpha', owner: 'a', workspace: 'ws-a', internal_note: 'seeded by a' }],
    }),
  ],
  ['GET /items', 'no-auth', 401],
  ['POST /items', 'ok', 201],
  ['POST /items', 'no-auth', 401],
  [
    'POST /items',
    'invalid-input',
    200,
    ['contract:status', 'status'],
    json({ error: { code: 'invalid_body', message: 'A name is required.' } }),
  ],
  ['GET /items/{id}', 'ok', 200],
  ['GET /items/{id}', 'no-auth', 401],
  ['GET /items/{id}', 'invalid-input', 500, ['contract:status', 'contract:no-5xx', 'status']],
  ['GET /items/{id}', 'missing-id', 404, ['contract:status']],
  ['GET /items/{id}', 'other-user', 'other-user needs a second credential set'],
  ['PATCH /items/{id}', 'ok', 200],
  ['PATCH /items/{id}', 'no-auth', 401],
  ['PATCH /items/{id}', 'invalid-input', 422],
  ['PATCH /items/{id}', 'missing-id', 404],
  ['DELETE /items/{id}', 'ok', 204],
  ['DELETE /items/{id}', 'no-auth', 401],
  ['DELETE /items/{id}', 'missing-id', 404],
  ['DELETE /items/{id}', 'repeat-delete', 500, ['contract:status', 'contract:no-5xx', 'status']],
  ['GET /search', 'ok', 200],
  ['GET /search', 'no-auth', 401],
  ['GET /events', 'ok', 'the response is an event stream, which the sweep does not test'],
];

/** The error statuses that the fixture spec declares for each endpoint. `connect.errors` adds 401 to each. */
const DECLARED: Record<string, number[]> = {
  'POST /items': [422],
  'PATCH /items/{id}': [404, 422],
  'DELETE /items/{id}': [404],
};

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

const BODIES: Record<number, string> = {
  200: '{\n  "result": {\n    "id": 1,\n    "name": "First item"\n  }\n}',
  201: '{\n  "result": {\n    "id": 4,\n    "name": "Bugpatrol item"\n  }\n}',
  401: '{\n  "error": {\n    "code": "unauthorized",\n    "message": "Sign in first."\n  }\n}',
  404: '{\n  "error": {\n    "code": "not_found",\n    "message": "No such item."\n  }\n}',
  422: '{\n  "error": {\n    "code": "invalid",\n    "message": "name must be a string."\n  }\n}',
  500: '{\n  "error": {\n    "code": "internal",\n    "message": "Division by zero."\n  }\n}',
};

/** The failure words of a failed case, as the sweep writes them after the case key. */
function failureWords(failed: string[], status: number): string {
  return failed.includes('contract:schema') ? 'the body does not match the schema' : `the status is ${status}`;
}

/**
 * Write `coverage.json` of an interrupted sweep, with the exchange behind each
 * cell, and the session of that sweep. Two cases wait in the cursor, and the
 * spec skips `POST /notify`. Each failed case is a candidate: the judge filed
 * one as an issue, and the others wait for the judge.
 */
export function writeCoverageFixture(root: string): void {
  const now = Date.now();
  mkdirSync(join(root, SESSION), { recursive: true });
  const cells: Record<string, CoverageCell> = {};
  const candidates: Candidate[] = [];
  for (const [index, [endpoint, id, result, failed = [], own]] of RESULTS.entries()) {
    const at = new Date(now - (RESULTS.length - index) * 1000).toISOString();
    const cell: CoverageCell = { endpoint: endpoint as EndpointKey, case: id, ok: !failed.length, failed, at };
    if (typeof result === 'string') {
      cells[`${endpoint} ${id}`] = { ...cell, ok: false, blocked: result };
      continue;
    }
    const [method, template] = endpoint.split(' ') as [HttpMethod, string];
    const path = template.replace('{id}', id === 'missing-id' ? '999999' : id === 'invalid-input' ? '0' : '1');
    const body = own ?? BODIES[result] ?? '';
    const exchange: HttpExchange = {
      request: { method, path, headers: id === 'no-auth' ? {} : { 'x-workspace-id': 'ws-a' } },
      response: {
        status: result,
        headers: { 'content-type': 'application/json' },
        contentType: 'application/json',
        body,
        bytes: body.length,
      },
      latencyMs: 3 + index,
      at,
    };
    const file = `${SESSION}/${String(index + 1).padStart(3, '0')}-sweep-${id}.exchange.json`;
    writeFileSync(join(root, file), JSON.stringify(exchange, null, 2));
    cells[`${endpoint} ${id}`] = { ...cell, status: result, exchange: file };
    if (failed.length)
      candidates.push({
        id: `can_sweep_${index}`,
        sessionId: SESSION_ID,
        source: 'sweep',
        ruleId: `sweep:${id}`,
        fingerprint: `sweep-${index}`,
        summary: `${endpoint} ${id}: ${failureWords(failed, result)}`,
        severity: failed.includes('contract:no-5xx') ? 'major' : 'minor',
        evidence: { capture: { kind: 'http', exchange }, steps: [{ kind: 'request', method, url: path }] },
        route: { to: 'judge', reason: 'The sweep failure repeats on a second replay' },
        // One failure did not come back on the second replay.
        blocking: id !== 'ok',
        createdAt: at,
      });
    // The sweep copies a case that got a declared error status into the column of that status.
    if (result === 401 || DECLARED[endpoint]?.includes(result))
      cells[`${endpoint} declared:${result}`] = { ...cell, case: `declared:${result}`, status: result, exchange: file };
  }
  const coverage: CoverageFile = {
    version: 1,
    cells,
    skipped: {
      'POST /notify ok': 'the spec marks it x-bugpatrol-skip',
      'POST /admin/wipe ok': 'app.connect.deny has /admin/**',
      'POST /admin/wipe no-auth': 'app.connect.deny has /admin/**',
    },
    cursor: { specDigest: '37818a38a26d9594', next: ['GET /export ok', 'GET /export no-auth'] },
  };
  writeFileSync(paths.coverage(root), JSON.stringify(coverage, null, 2));
  writeSweepSession(root, now, candidates);
}

function writeSweepSession(root: string, now: number, candidates: Candidate[]): void {
  const dir = join(root, SESSION);
  const filed = candidates.find((candidate) => candidate.summary.startsWith('DELETE /items/{id} repeat-delete'))!;
  const repeat = candidates.filter((candidate) => candidate.blocking).length;
  const session: SessionSummary = {
    version: 1,
    id: SESSION_ID,
    role: 'explorer',
    startedAt: new Date(now - (RESULTS.length + 5) * 1000).toISOString(),
    endedAt: new Date(now).toISOString(),
    status: 'finished',
    summary: `Sweep: ${RESULTS.length + candidates.length} request(s), ${candidates.length} finding(s), ${repeat} that repeat`,
    steps: 0,
    costUsd: 0,
    screensFound: [],
    candidates: candidates.length,
    issues: ['iss-sweep-item'],
  };
  writeFileSync(join(dir, 'session.json'), JSON.stringify(session, null, 2));
  const lines = (values: unknown[]) => values.map((value) => `${JSON.stringify(value)}\n`).join('');
  writeFileSync(join(dir, 'candidates.jsonl'), lines(candidates));
  const events: AgentEvent[] = candidates.map((candidate) => ({
    at: candidate.createdAt,
    sessionId: SESSION_ID,
    role: 'explorer',
    kind: 'candidate',
    summary: candidate.summary,
  }));
  writeFileSync(join(dir, 'events.jsonl'), lines(events));
  const issue: Issue = {
    version: 1,
    id: 'iss-sweep-item',
    fingerprint: filed.fingerprint,
    title: 'A second delete of an item returns a server error',
    body: 'The second `DELETE /items/1` returns **500**. The contract declares 204, 401, and 404.',
    severity: 'major',
    status: 'new',
    candidateIds: [filed.id],
    evidence: filed.evidence,
    judgement: {
      by: 'model: judge',
      reason: 'A server error on a documented route.',
      confidence: 0.95,
      at: filed.createdAt,
    },
    occurrences: 1,
    firstSeenAt: filed.createdAt,
    lastSeenAt: filed.createdAt,
  };
  mkdirSync(paths.issues(root), { recursive: true });
  writeFileSync(paths.issue(root, issue.id), JSON.stringify(issue, null, 2));
}
