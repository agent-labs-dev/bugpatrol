import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type FixtureApi, fixtureSpecPath, startFixtureApi } from '@bugpatrol/api-fixture';
import { buildContract, type Contract, loadSpec, type OpenApiDoc, sweepCases } from '@bugpatrol/contract';
import { type CoverageCell, parseConfig } from '@bugpatrol/core';
import { createDriver } from '@bugpatrol/drivers';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentSession } from './session.js';
import { runSweep, type SweepBudget } from './sweep.js';
import { Vars } from './vars.js';
import { Workspace } from './workspace.js';

const ERROR = {
  type: 'object',
  required: ['error'],
  properties: {
    error: {
      type: 'object',
      required: ['code', 'message'],
      properties: { code: { type: 'string' }, message: { type: 'string' } },
    },
  },
};
const BUDGET: SweepBudget = { maxRequests: 600, timeoutMs: 60_000 };

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A sweep on the fixture, as user a, with 401 and 409 in `connect.errors`. `other` adds user b. */
async function sweeper(
  options: {
    perSecond?: number;
    errors?: boolean;
    other?: boolean;
    doc?: (doc: OpenApiDoc) => void;
    fixture?: FixtureApi;
  } = {},
) {
  const fixture = options.fixture ?? (await startFixtureApi({ perSecond: options.perSecond ?? 1000 }));
  if (!options.fixture) cleanups.push(() => fixture.close());
  const root = await mkdtemp(join(tmpdir(), 'bugpatrol-sweep-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const config = parseConfig({
    version: 1,
    app: {
      platform: 'api',
      connect: {
        url: fixture.url,
        headers: { Authorization: 'Bearer fixture-token-a', 'X-Workspace-Id': 'ws-a' },
        ...(options.other
          ? {
              credentials: {
                self: { headers: {} },
                other: { headers: { Authorization: 'Bearer fixture-token-b', 'X-Workspace-Id': 'ws-b' } },
              },
            }
          : {}),
        deny: ['/admin/**'],
        perMinute: 60_000,
        timeoutMs: 2000,
        ...(options.errors === false ? {} : { errors: { statuses: [401, 409], schema: ERROR } }),
      },
    },
  });
  const doc = await loadSpec({ file: fixtureSpecPath });
  options.doc?.(doc);
  const contract: Contract = buildContract(doc, config.app.connect);
  const vars = new Vars();
  const driver = createDriver(config, (value) => value, undefined, root, contract);
  const workspace = new Workspace(root);
  const cases = sweepCases(contract, { credentials: options.other ? ['self', 'other'] : ['self'] });
  const run = async (budget: Partial<SweepBudget> = {}, before?: (session: AgentSession) => void) => {
    const record = await workspace.startSession('explorer');
    const session = new AgentSession(root, config, vars, record.id, 'explorer', driver);
    before?.(session);
    const result = await runSweep(session, cases, { ...BUDGET, ...budget });
    return { result, session, candidates: await workspace.readCandidates(record.id) };
  };
  return { fixture, workspace, cases, run };
}

const found = (result: Awaited<ReturnType<Awaited<ReturnType<typeof sweeper>>['run']>>['result']) =>
  Object.fromEntries(result.findings.map((finding) => [finding.key, finding.failed]));

describe('runSweep', () => {
  it('finds bugs 1, 2, 4, 5, 7', async () => {
    const { fixture, run } = await sweeper();
    const { result, candidates } = await run();
    const findings = found(result);
    // 1: GET /items/0 gives 500.
    expect(findings['GET /items/{id} invalid-input']).toEqual(
      expect.arrayContaining(['contract:status', 'contract:no-5xx', 'status']),
    );
    // 2: an undeclared field.
    expect(findings['GET /items ok']).toEqual(['contract:schema']);
    // 4: a second DELETE gives 500.
    expect(findings['DELETE /items/{id} repeat-delete']).toEqual(expect.arrayContaining(['contract:no-5xx', 'status']));
    // 5: a bad body gives 200.
    expect(findings['POST /items invalid-input']).toEqual(expect.arrayContaining(['contract:status', 'status']));
    // 7: a missing id gives an undeclared 404.
    expect(findings['GET /items/{id} missing-id']).toEqual(['contract:status']);
    expect(Object.keys(findings).sort()).toEqual(
      [
        'GET /items/{id} invalid-input',
        'GET /items ok',
        'DELETE /items/{id} repeat-delete',
        'POST /items invalid-input',
        'GET /items/{id} missing-id',
      ].sort(),
    );
    expect(result.findings.every((finding) => finding.repeats)).toBe(true);
    expect(candidates.map((candidate) => [candidate.source, candidate.blocking])).toEqual(
      Array(5).fill(['sweep', true]),
    );
    expect(candidates[0]!.evidence.capture.kind).toBe('http');
    expect(fixture.hits().filter((hit) => hit.path.startsWith('/admin'))).toEqual([]);
    expect(result.skipped.map((item) => item.key)).toEqual(['POST /admin/wipe ok', 'POST /admin/wipe no-auth']);
    expect(result.remaining).toBe(0);
  }, 30_000);

  it('slow route and missing Location give no finding', async () => {
    const { run, workspace } = await sweeper();
    const { result } = await run();
    const cells = result.cells;
    const cell = (key: string) => cells.find((item) => `${item.endpoint} ${item.case}` === key);
    expect(cell('GET /search ok')).toMatchObject({ status: 200, ok: true });
    // The matrix opens the exchange behind each cell and shows the refused cases.
    expect(cell('GET /search ok')?.exchange).toMatch(/^\.bugpatrol\/.*sweep-ok\.exchange\.json$/);
    expect((await workspace.readCoverage())!.skipped).toEqual({
      'POST /notify ok': 'the spec marks it x-bugpatrol-skip',
      'POST /admin/wipe ok': 'app.connect.deny has /admin/**',
      'POST /admin/wipe no-auth': 'app.connect.deny has /admin/**',
    });
    expect(cell('POST /items ok')).toMatchObject({ status: 201, ok: true });
    // The event stream is cut and proves nothing, and the 2 MiB export has no schema check.
    expect(cell('GET /events ok')?.blocked).toContain('event stream');
    expect(cell('GET /export ok')).toMatchObject({ status: 200, ok: true });
  }, 30_000);

  it('a failure that does not repeat does not block', async () => {
    const { fixture, run } = await sweeper();
    fixture.failOnce('GET', '/health');
    const { result, candidates } = await run();
    const flaky = result.findings.find((finding) => finding.key === 'GET /health ok');
    expect(flaky).toMatchObject({ repeats: false, failed: ['contract:status', 'contract:no-5xx'] });
    const candidate = candidates.find((item) => item.summary.startsWith('GET /health ok'));
    expect(candidate).toMatchObject({ blocking: false, route: { to: 'judge' } });
    expect(candidate?.route?.reason).toContain('does not repeat');
  }, 30_000);

  it('a dismissed fingerprint stays quiet and does not block', async () => {
    const { workspace, run } = await sweeper();
    const first = await run();
    const schema = first.candidates.find((item) => item.summary.startsWith('GET /items ok'))!;
    await workspace.recordTriage({
      [schema.fingerprint]: { decision: 'dismissed', reason: 'The extra field is fine', at: 'now' },
    });
    const second = await run();
    // The same failure on the next run has the same key.
    expect(second.candidates.map((item) => item.fingerprint).sort()).toEqual(
      first.candidates
        .map((item) => item.fingerprint)
        .filter((print) => print !== schema.fingerprint)
        .sort(),
    );
    const dismissed = second.result.findings.filter((finding) => finding.dismissed).map((finding) => finding.key);
    expect(dismissed).toEqual(['GET /items ok']);
  }, 30_000);

  it('resumes after interruption', async () => {
    const { workspace, cases, run } = await sweeper();
    const first = await run({}, (session) => {
      const driver = session.driver!;
      const act = driver.act.bind(driver);
      let calls = 0;
      driver.act = (action) => {
        if (++calls === 4) session.cancelled = true;
        return act(action);
      };
    });
    expect(first.result.stopped).toBe('interrupted');
    const ran = first.result.cells.filter((cell) => !cell.blocked).map((cell) => `${cell.endpoint} ${cell.case}`);
    const pending = (await workspace.readCoverage())!.cursor!.next;
    expect(pending.some((key) => ran.includes(key))).toBe(false);
    const second = await run({ maxRequests: 5 });
    expect(second.result.stopped).toBe('budget');
    const resumed = second.result.cells
      .filter((cell) => !cell.blocked && !cell.case.startsWith('declared:'))
      .map((cell) => `${cell.endpoint} ${cell.case}`);
    expect(resumed).toEqual(pending.slice(0, resumed.length));
    expect(cases.length).toBeGreaterThan(ran.length);
  }, 30_000);

  it('does not starve endpoints', async () => {
    const { workspace, run } = await sweeper();
    for (let index = 0; index < 20; index++) {
      const { result } = await run({ maxRequests: 5 });
      if (!result.remaining && !result.stopped) break;
    }
    const cells = Object.values((await workspace.readCoverage())!.cells);
    const endpoints = new Set(cells.map((cell) => cell.endpoint));
    // Every endpoint but the denied one and the skipped one has a cell.
    expect(endpoints.size).toBe(11);
    // A new pass starts with the oldest cell.
    const oldest = cells.filter((cell) => !cell.blocked).sort((a, b) => a.at.localeCompare(b.at))[0]!;
    const { result } = await run({ maxRequests: 2 });
    expect(result.cells.filter((cell) => !cell.blocked)[0]).toMatchObject({
      endpoint: oldest.endpoint,
      case: oldest.case,
    });
  }, 60_000);

  it('a 429 stays pending', async () => {
    const { run, workspace } = await sweeper({ perSecond: 0 });
    const { result, candidates } = await run({ maxRequests: 10 });
    expect(result.stopped).toBe('rate-limited');
    expect(result.findings).toEqual([]);
    expect(candidates).toEqual([]);
    const coverage = (await workspace.readCoverage())!;
    expect(Object.values(coverage.cells).every((cell) => cell.blocked)).toBe(true);
    expect(coverage.cursor!.next.length).toBe(result.remaining);
    expect(result.remaining).toBeGreaterThan(0);
  }, 30_000);

  it('a schema bug on one endpoint gives one finding, not one for each case', async () => {
    const { run } = await sweeper({
      other: true,
      doc: (doc) => {
        const get = (doc.paths['/items/{id}'] as Record<string, { responses: Record<string, unknown> }>).get!;
        get.responses['200'] = {
          description: 'An item with a field that the fixture never sends',
          content: { 'application/json': { schema: { type: 'object', required: ['result', 'bugpatrol'] } } },
        };
      },
    });
    const { result } = await run();
    const schema = result.findings.filter(
      (finding) => finding.endpoint === 'GET /items/{id}' && finding.failed.includes('contract:schema'),
    );
    expect(schema.map((finding) => finding.key)).toEqual(['GET /items/{id} ok']);
  }, 30_000);

  it('a spec without errors gives one finding', async () => {
    const { run, cases } = await sweeper({
      errors: false,
      doc: (doc) => {
        for (const item of Object.values(doc.paths))
          for (const operation of Object.values(item) as { responses?: Record<string, unknown> }[])
            for (const code of Object.keys(operation.responses ?? {}))
              if (/^4/.test(code) && code !== '422') delete operation.responses![code];
      },
    });
    expect(cases.some((item) => item.case !== 'ok' && item.case !== 'repeat-delete')).toBe(false);
    const { result, candidates } = await run();
    expect(result.findings.filter((finding) => finding.case === 'spec')).toEqual([
      expect.objectContaining({ failed: ['spec:no-errors'], repeats: false }),
    ]);
    expect(candidates.filter((candidate) => candidate.ruleId === 'sweep:spec')).toHaveLength(1);
  }, 30_000);

  it('two runs give the same coverage, ignoring at', async () => {
    const strip = (cells: CoverageCell[]) =>
      cells
        .map(({ at: _at, exchange: _exchange, ...cell }) => cell)
        .sort((a, b) => `${a.endpoint} ${a.case}`.localeCompare(`${b.endpoint} ${b.case}`));
    const one = await (await sweeper()).run();
    const two = await (await sweeper()).run();
    expect(strip(two.result.cells)).toEqual(strip(one.result.cells));
  }, 60_000);
});
