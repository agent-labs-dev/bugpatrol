import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixtureSpecPath, startFixtureApi } from '@bugpatrol/api-fixture';
import { buildContract, caseKey, loadSpec, sweepCases } from '@bugpatrol/contract';
import { type EndpointKey, parseConfig, type RoutineStep } from '@bugpatrol/core';
import { createDriver } from '@bugpatrol/drivers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { explorerPrompt, explorerSystem } from './prompts.js';
import { runExplorer, wasBlocked } from './roles/explorer.js';
import { AgentSession } from './session.js';
import { runSweep } from './sweep.js';
import { FakeDriver } from './testing/fake-driver.js';
import { explorerTools, showsOnly, waitTimeoutMs } from './tools/explorer.js';
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

describe('a session that could not test the app', () => {
  /** Runs the explorer once, finishing with `input`, and returns the outcome. */
  async function finish(input: Record<string, unknown>) {
    const record = await new Workspace(root).startSession('explorer');
    const session = new AgentSession(
      root,
      parseConfig({ version: 1, app: { connect: { url: 'fake://home' } } }),
      new Vars(),
      record.id,
      'explorer',
      new FakeDriver({ home: { elements: [] } }),
      () => undefined,
    );
    const runtime: Runtime = {
      label: 'scripted',
      async run(task) {
        const result = await task.tools.find((tool) => tool.name === 'finish')!.run(input);
        const text = result.content.map((part) => ('text' in part ? part.text : '')).join('');
        return { stop: 'done', steps: 1, costUsd: 0, summary: text };
      },
    };
    return runExplorer(session, runtime);
  }

  it('is told apart from one that tested something, so explore can fail on it', async () => {
    const blocked = await finish({ summary: 'Blocked: the app never started.', blocked: true });
    expect(blocked.summary).toMatch(/^Blocked: the app never started\./);
    expect(wasBlocked(blocked)).toBe(true);
    expect(wasBlocked(await finish({ summary: 'Covered the landing screen.' }))).toBe(false);
  });
});

describe('a command that only shows something', () => {
  const run = (command: string): RoutineStep => ({ kind: 'run', command });

  it('is a read of the source: printing, listing, searching, read-only git', () => {
    for (const command of [
      'ls tools; head -40 tests/api_spec.lua',
      'sed -n 300,420p Core/Plan.lua',
      'grep -rn foo src 2>/dev/null | head',
      'git log --oneline -5',
      'git branch --list',
      'git branch -a',
      'git --no-pager diff --stat --oneline HEAD~1',
      'uniq in.txt',
      'tree src',
    ])
      expect(showsOnly(run(command)), command).toBe(true);
  });

  it('is not anything that could leave state behind', () => {
    for (const command of [
      'echo x > notes.txt',
      "sed -i 's/a/b/' file",
      'find . -name "*.tmp" -delete',
      'luajit -e "print(1)"',
      'cat $(make path)',
      'git checkout main',
      'git branch foo',
      'git --no-pager diff --no-index --output=output.diff old.txt new.txt',
      'git log --outp=log.txt',
      'git diff --ext-diff',
      'git grep -O foo',
      'uniq in.txt out.txt',
      'tree -o out.txt src',
      "sed -n '1w out.txt' file",
      "sed -n '1e touch x' file",
      "sed -n 's/old/new/w out.txt' file",
      'cat <(touch x)',
      'for s in a b; do echo $s; done',
    ])
      expect(showsOnly(run(command)), command).toBe(false);
    expect(showsOnly({ kind: 'run', command: 'cat', input: 'typed' })).toBe(false);
  });
});

describe('a cli wait', () => {
  it('may last as long as the configured command limit, above a minute', () => {
    // A slow terminal app that draws its first screen after 90 s.
    expect(waitTimeoutMs(120_000, 90_000)).toBe(90_000);
    expect(waitTimeoutMs(120_000, 900_000)).toBe(120_000);
    expect(waitTimeoutMs(60_000, 30_000)).toBe(30_000);
    expect(waitTimeoutMs(600_000, 600_000)).toBe(600_000);
    expect(waitTimeoutMs(120_000)).toBe(5000);
  });
});

describe('the explorer prompt', () => {
  it('gives an api explorer requests and endpoints, not screens', () => {
    const api = explorerSystem('api', '');
    expect(api).toContain('YOUR JOB IS DEPTH ON EACH ENDPOINT');
    expect(api).toContain('Each request returns the HTTP exchange');
    for (const words of ['record_screen', 'Each action tool returns a screenshot', 'FULL COVERAGE'])
      expect(api).not.toContain(words);
    expect(explorerSystem('web', '')).toContain('record_screen');
    const prompt = { screens: [], routines: [], placeholders: [], maxSteps: 5 };
    expect(explorerPrompt({ ...prompt, endpoints: [] })).not.toContain('SCREENS');
    expect(explorerPrompt(prompt)).toContain('KNOWN SCREENS\n(none yet)\n\nKNOWN ROUTINES');
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

  it('reports a bug and sums up the session with no screen wording', async () => {
    const f = await apiExplorer();
    closers.push(f.fixture.close);
    await f.run('request', { method: 'GET', url: '/items/1' });
    const reported = await f.run('report_bug', {
      title: 'Item 1 has the wrong name',
      what_is_wrong: 'The name is Alpha',
      expected: 'Beta',
      severity: 'minor',
    });
    expect(reported.isError).toBeFalsy();
    expect(reported.text).not.toMatch(/screen/i);
    const report = f.tools.find((tool) => tool.name === 'report_bug')!;
    expect((report.inputSchema as { required: string[] }).required).not.toContain('screen_id');
    expect(report.description).not.toMatch(/screen/i);
    const runtime: Runtime = {
      label: 'scripted',
      async run() {
        return { stop: 'max-steps', steps: 3, costUsd: 0 };
      },
    };
    const outcome = await runExplorer(f.session, runtime);
    expect(outcome.summary).toBe('The explorer used all its steps. 1 candidate(s) raised in 3 steps.');
  });

  it('reads a part of the spec, and of the last response, by JSON pointer', async () => {
    const f = await apiExplorer();
    closers.push(f.fixture.close);
    const schema = await f.run('spec', { pointer: '/components/schemas/ItemResult' });
    expect(schema.text).toContain('"$ref": "#/components/schemas/Item"');
    expect((await f.run('spec', { pointer: '/components/schemas/Nope' })).text).toContain(
      'Keys at /components/schemas: Health, Version',
    );
    await f.run('request', { method: 'GET', url: '/items/1' });
    const part = await f.run('look', { pointer: '/result/name' });
    expect(part.text).toBe('/result/name:\n"Alpha"');
  });

  it('puts the endpoints that the goal names first, and reports the ones the run did not reach', async () => {
    const f = await apiExplorer();
    closers.push(f.fixture.close);
    const prompts: string[] = [];
    const runtime: Runtime = {
      label: 'scripted',
      async run(task) {
        prompts.push(task.prompt);
        await task.tools.find((tool) => tool.name === 'request')!.run({ method: 'GET', url: '/search?q=A' });
        return { stop: 'max-steps', steps: 1, costUsd: 0 };
      },
    };
    const outcome = await runExplorer(f.session, runtime, { goal: 'Audit the search and the export endpoints.' });
    const listed = prompts[0]!.split('ENDPOINTS TO TEST FIRST\n')[1]!.split('\n');
    expect(listed.slice(0, 2)).toEqual(['- GET /search: named by the goal', '- GET /export: named by the goal']);
    expect(outcome.summary).toContain(
      'Goal not met: 1 of the 2 endpoint(s) that the goal names got no request: GET /export.',
    );

    const paths = await runExplorer(f.session, runtime, { goal: 'Only test /items/* endpoints' });
    const named = prompts[1]!
      .split('ENDPOINTS TO TEST FIRST\n')[1]!
      .split('\n')
      .filter((line) => line.endsWith('named by the goal'));
    expect(named.map((line) => line.split(':')[0])).toEqual([
      '- GET /items',
      '- POST /items',
      '- GET /items/{id}',
      '- PATCH /items/{id}',
      '- DELETE /items/{id}',
    ]);
    expect(paths.summary).toContain('Goal not met: 5 of the 5 endpoint(s)');
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

describe('the explorer on a terminal UI', () => {
  /** Counts the presses of j, and shows the last line typed after enter. */
  const COUNTER = `
let count = 0;
let line = '';
let last = '';
const draw = () => process.stdout.write('\\x1b[H\\x1b[2Jcount ' + count + '\\r\\nlast ' + last);
process.stdout.write('\\x1b[?1049h');
process.stdin.setRawMode(true);
process.stdin.on('data', (data) => {
  for (const key of data.toString()) {
    if (key === 'j') count++;
    else if (key === '\\r') [last, line] = [line, ''];
    else line += key;
  }
  draw();
});
draw();
`;

  it('drives a session with keys, and saves a routine that replays with its secrets as placeholders', async () => {
    await writeFile(join(root, 'counter.cjs'), COUNTER);
    const config = parseConfig({ version: 1, app: { platform: 'cli', source: '.', secrets: ['PIN'] } });
    const vars = new Vars(['PIN'], { PIN: 'pin-4821' });
    const driver = createDriver(
      config,
      (value) => value,
      (value) => vars.redact(value) as string,
      root,
    );
    await driver.connect();
    const workspace = new Workspace(root);
    const record = await workspace.startSession('explorer');
    const session = new AgentSession(root, config, vars, record.id, 'explorer', driver);
    const tools = explorerTools(session);
    const run = async (name: string, input: Record<string, unknown> = {}) => {
      const result = await tools.find((tool) => tool.name === name)!.run(input);
      return { ...result, text: result.content.map((part) => (part.type === 'text' ? part.text : '')).join('\n') };
    };
    try {
      const names = tools.map((tool) => tool.name);
      for (const name of ['run_command', 'start_session', 'press', 'wait_for', 'resize', 'stop_session'])
        expect(names).toContain(name);
      expect(names).not.toContain('tap');

      // A shell ${name} is the shell's, not an unknown placeholder.
      const loop = await run('run_command', { command: 'for s in a b; do echo "item-${s}"; done' });
      expect(loop.text).toContain('item-a\nitem-b');

      // A read of the source shows something and sets nothing up.
      expect((await run('run_command', { command: 'head -3 counter.cjs' })).isError).toBeFalsy();
      expect((await run('start_session', { command: 'node counter.cjs' })).text).toContain('The program is running.');
      expect((await run('wait_for', { text: 'count 0' })).isError).toBeFalsy();
      const pressed = await run('press', { keys: ['j', 'j', '{{PIN}}', 'enter'] });
      expect(pressed.text).toContain('Screen:\ncount 2\nlast {{PIN}}');
      expect((await run('wait_for', { text: 'never', timeoutMs: 200 })).isError).toBe(true);
      expect((await run('save_routine', { id: 'count-twice', description: 'Counts to two' })).isError).toBeFalsy();
      await run('stop_session');

      const routine = (await workspace.readRoutine('count-twice'))!;
      expect(routine.steps.map(({ at: _at, ...step }) => step)).toEqual([
        { kind: 'run', command: 'for s in a b; do echo "item-${s}"; done' },
        { kind: 'session', op: 'start', command: 'node counter.cjs' },
        { kind: 'session', op: 'wait', text: 'count 0', timeoutMs: 5000 },
        { kind: 'session', op: 'keys', keys: ['j', 'j', '{{PIN}}', 'enter'] },
      ]);
      const replayed = await run('run_routine', { id: 'count-twice' });
      expect(replayed.isError).toBeFalsy();
      expect(replayed.text).toContain('count 2\nlast {{PIN}}');
    } finally {
      await driver.close();
    }
  });

  it('tells the explorer when the screen was still changing', { timeout: 30_000 }, async () => {
    const config = parseConfig({ version: 1, app: { platform: 'cli', source: '.' } });
    const driver = createDriver(config, (value) => value, undefined, root);
    await driver.connect();
    const record = await new Workspace(root).startSession('explorer');
    const session = new AgentSession(root, config, new Vars(), record.id, 'explorer', driver);
    const start = explorerTools(session).find((tool) => tool.name === 'start_session')!;
    try {
      const result = await start.run({ command: 'while true; do date +%N; sleep 0.02; done' });
      expect(result.content[0]).toMatchObject({ type: 'text', text: expect.stringMatching(/still changing/) });
    } finally {
      await driver.close();
    }
  });
});
