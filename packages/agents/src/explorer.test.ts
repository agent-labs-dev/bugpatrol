import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixtureSpecPath, startFixtureApi } from '@bugpatrol/api-fixture';
import { buildContract, caseKey, loadSpec, sweepCases } from '@bugpatrol/contract';
import { type EndpointKey, parseConfig, type RoutineStep } from '@bugpatrol/core';
import { createDriver } from '@bugpatrol/drivers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { explorerSystem } from './prompts.js';
import { runExplorer } from './roles/explorer.js';
import { AgentSession } from './session.js';
import { runSweep } from './sweep.js';
import { FakeDriver } from './testing/fake-driver.js';
import { explorerTools } from './tools/explorer.js';
import type { Runtime } from './types.js';
import { Vars } from './vars.js';
import { Workspace } from './workspace.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'bugpatrol-explorer-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Runs the explorer once, and returns its system prompt and the run log. */
async function explore(app: Record<string, unknown> = {}) {
  const record = await new Workspace(root).startSession('explorer');
  const logs: string[] = [];
  const session = new AgentSession(
    root,
    parseConfig({ version: 1, app: { connect: { url: 'fake://home' }, ...app } }),
    new Vars(),
    record.id,
    'explorer',
    new FakeDriver({ home: { elements: [] } }),
    (summary) => logs.push(summary),
  );
  const systems: string[] = [];
  const runtime: Runtime = {
    label: 'scripted',
    async run(task) {
      systems.push(task.system);
      return { stop: 'done', steps: 0, costUsd: 0 };
    },
  };
  const outcome = await runExplorer(session, runtime);
  return { system: systems[0]!, logs, outcome };
}

describe('the explorer prompt', () => {
  it('gives an api explorer requests and endpoints, not screens', () => {
    const api = explorerSystem('api', '');
    expect(api).toContain('YOUR JOB IS DEPTH ON EACH ENDPOINT');
    expect(api).toContain('Each request returns the HTTP exchange');
    for (const words of ['record_screen', 'Each action tool returns a screenshot', 'FULL COVERAGE'])
      expect(api).not.toContain(words);
    expect(explorerSystem('web', '')).toContain('record_screen');
  });
});

describe('the explorer app guide', () => {
  it('says in the run log when the app has no guide', async () => {
    const { logs } = await explore();
    expect(logs).toContain('No app guide at .bugpatrol/instructions.md, so the explorer runs without one.');
  });

  it('gives the explorer the default guide, and logs nothing about it', async () => {
    await mkdir(join(root, '.bugpatrol'), { recursive: true });
    await writeFile(join(root, '.bugpatrol', 'instructions.md'), 'You start signed in on the Home screen.\n');
    const { system, logs } = await explore();
    expect(system).toContain('You start signed in on the Home screen.');
    expect(logs.some((line) => line.startsWith('No app guide'))).toBe(false);
  });

  it('fails when the configured guide is missing', async () => {
    await expect(explore({ instructions: 'docs/guide.md' })).rejects.toThrow(/ENOENT/);
  });

  it('names the runtime error in the summary when the run fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bugpatrol-explorer-'));
    try {
      const record = await new Workspace(root).startSession('explorer');
      const session = new AgentSession(
        root,
        parseConfig({ version: 1, app: { connect: { url: 'fake://home' } } }),
        new Vars(),
        record.id,
        'explorer',
        new FakeDriver({ home: { elements: [] } }),
        () => {},
      );
      const runtime: Runtime = {
        label: 'scripted',
        async run() {
          return { stop: 'error', steps: 7, costUsd: 0, error: 'Insufficient Balance (request_id: 17d40ebf)' };
        },
      };
      const outcome = await runExplorer(session, runtime);
      expect(outcome.summary).toContain('Insufficient Balance (request_id: 17d40ebf)');
      expect(outcome.summary).toContain('7 steps');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

/** An explorer on the fixture API as user a, with user b as the other credential set. */
async function apiExplorer(options: { other?: boolean } = {}) {
  const fixture = await startFixtureApi({ perSecond: 1000 });
  const config = parseConfig({
    version: 1,
    app: {
      platform: 'api',
      connect: {
        url: fixture.url,
        headers: { Accept: 'application/json' },
        credentials: {
          self: { headers: { Authorization: 'Bearer fixture-token-a', 'X-Workspace-Id': 'ws-a' } },
          ...(options.other === false
            ? {}
            : { other: { headers: { Authorization: 'Bearer fixture-token-b', 'X-Workspace-Id': 'ws-b' } } }),
        },
        errors: { statuses: [401, 409] },
        perMinute: 60_000,
      },
    },
  });
  const contract = buildContract(await loadSpec({ file: fixtureSpecPath }), config.app.connect);
  const driver = createDriver(config, (value) => value, undefined, root, contract);
  const workspace = new Workspace(root);
  const record = await workspace.startSession('explorer');
  const session = new AgentSession(root, config, new Vars(), record.id, 'explorer', driver);
  const tools = explorerTools(session);
  const run = async (name: string, input: Record<string, unknown>) => {
    const result = await tools.find((tool) => tool.name === name)!.run(input);
    return { ...result, text: result.content.map((part) => (part.type === 'text' ? part.text : '')).join('\n') };
  };
  return { fixture, workspace, session, contract, tools, run };
}

describe('the api explorer', () => {
  const closers: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const close of closers.splice(0)) await close();
  });

  it('request maps to an endpoint and records a cell', async () => {
    const f = await apiExplorer();
    closers.push(f.fixture.close);
    const found = await f.run('request', { method: 'GET', url: '/items/1' });
    expect(found.text).toContain('HTTP 200');
    expect(found.text).toContain('Expected contract of GET /items/{id} (getItem):');
    expect(found.text).toContain('- 200: application/json #/components/schemas/ItemResult = ');
    expect(found.text).toContain('- 401, 409 (connect.errors)');
    expect(found.text).toContain('This is request 1 of the routine in progress.');
    const missing = await f.run('request', { method: 'GET', url: '/items/999', case: 'missing-id' });
    expect(missing.text).toContain('HTTP 404');
    const unknown = await f.run('request', { method: 'GET', url: '/nowhere' });
    expect(unknown.text).toContain('No endpoint of the contract matches this request.');
    const { cells } = (await f.workspace.readCoverage())!;
    expect(cells['GET /items/{id} ok']).toMatchObject({ status: 200, ok: true, failed: [] });
    // Bug 7: getItem declares only 200.
    expect(cells['GET /items/{id} missing-id']).toMatchObject({ status: 404, ok: false, failed: ['contract:status'] });
    expect(Object.keys(cells)).toHaveLength(2);
  });

  it('a report on a named case has the key of the sweep failure of that case', async () => {
    const f = await apiExplorer();
    closers.push(f.fixture.close);
    const missing = sweepCases(f.contract, {
      credentials: { self: { authorization: 'a' }, other: { authorization: 'b' } },
    }).filter((item) => caseKey(item.endpoint.key, item.case) === 'GET /items/{id} missing-id');
    await runSweep(f.session, missing, { maxRequests: 10, timeoutMs: 10_000 });
    const sent = await f.run('request', { method: 'GET', url: '/items/2147483647', case: 'missing-id' });
    expect(sent.text).toContain('HTTP 404');
    await f.run('report_bug', {
      screen_id: 'unrecorded',
      title: 'A missing item gives an undeclared 404',
      what_is_wrong: 'getItem declares only 200',
      expected: 'A declared status',
      severity: 'minor',
    });
    const candidates = await f.workspace.readCandidates(f.session.sessionId);
    expect(candidates.map((item) => item.source)).toEqual(['sweep', 'explorer']);
    expect(candidates[1]!.fingerprint).toBe(candidates[0]!.fingerprint);
  });

  it('an explorer request keeps the exchange and the repeats of the sweep cell that it replaces', async () => {
    const f = await apiExplorer();
    closers.push(f.fixture.close);
    await f.workspace.writeCoverage({
      version: 1,
      cells: {
        'GET /items/{id} missing-id': {
          endpoint: 'GET /items/{id}' as EndpointKey,
          case: 'missing-id',
          status: 404,
          ok: false,
          failed: ['contract:status'],
          repeats: false,
          at: '2024-01-01T00:00:00Z',
        },
      },
    });
    await f.run('request', { method: 'GET', url: '/items/2147483647', case: 'missing-id' });
    const cell = (await f.workspace.readCoverage())!.cells['GET /items/{id} missing-id'];
    expect(cell).toMatchObject({ ok: false, failed: ['contract:status'], repeats: false });
    expect(cell?.exchange).toMatch(/^\.bugpatrol\/.*\.exchange\.json$/);
    expect(cell?.at).not.toBe('2024-01-01T00:00:00Z');
  });

  it('as: other uses the other credential set', async () => {
    const f = await apiExplorer();
    closers.push(f.fixture.close);
    const request = f.tools.find((tool) => tool.name === 'request')!;
    expect((request.inputSchema as { properties: Record<string, unknown> }).properties.as).toBeDefined();
    const other = await f.run('request', { method: 'GET', url: '/items/1', as: 'other' });
    // Bug 3: user b learns that item 1 of user a exists.
    expect(other.text).toContain('HTTP 403');
    expect(f.session.trail.at(-1)).toMatchObject({ kind: 'request', url: '/items/1', as: 'other' });
    expect((await f.workspace.readCoverage())!.cells['GET /items/{id} other-user']).toMatchObject({
      status: 403,
      ok: false,
    });
    expect((await f.run('request', { method: 'GET', url: '/items/1' })).text).toContain('HTTP 200');
  });

  it('offers no other user without a second credential set', async () => {
    const f = await apiExplorer({ other: false });
    closers.push(f.fixture.close);
    const request = f.tools.find((tool) => tool.name === 'request')!;
    expect((request.inputSchema as { properties: Record<string, unknown> }).properties.as).toBeUndefined();
    const sent = await f.run('request', { method: 'GET', url: '/items/1', as: 'other' });
    expect(sent.isError).toBe(true);
    expect(sent.text).toContain('No second credential set is configured');
  });

  it('save_routine keeps the assertions that hold on each request, and refuses one that does not', async () => {
    const f = await apiExplorer();
    closers.push(f.fixture.close);
    await f.run('request', { method: 'GET', url: '/items', capture: { RESPONSE_ID: '/result/0/id' } });
    await f.run('request', { method: 'GET', url: '/items/{{RESPONSE_ID}}' });
    const refused = await f.run('save_routine', {
      id: 'read-item',
      description: 'Reads the first item',
      assert: [{ request: 2, kind: 'status', value: 404 }],
    });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('request 2:');
    expect(await f.workspace.readRoutine('read-item')).toBeUndefined();
    expect(
      (await f.run('save_routine', { id: 'x', description: 'x', assert: [{ request: 3, kind: 'contract' }] })).text,
    ).toContain('request 3 is not one of the 2 request(s)');
    const saved = await f.run('save_routine', {
      id: 'read-item',
      description: 'Reads the first item',
      assert: [
        { request: 2, kind: 'status', value: 200 },
        { request: 2, kind: 'pointer', pointer: '/result/name', equals: 'Alpha' },
        { request: 2, kind: 'schema', ref: '#/components/schemas/ItemResult' },
        { request: 2, kind: 'header', name: 'content-type', matches: '^application/json' },
      ],
    });
    expect(saved.isError).toBeFalsy();
    const steps = (await f.workspace.readRoutine('read-item'))!.steps as RoutineStep[];
    expect(steps.map((step) => step.assert?.map((item) => item.kind))).toEqual([
      undefined,
      ['status', 'pointer', 'schema', 'header'],
    ]);
  });
});
