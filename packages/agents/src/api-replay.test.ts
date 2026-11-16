import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixtureSpecPath, startFixtureApi } from '@bugpatrol/api-fixture';
import { buildContract, loadSpec, requestPolicy } from '@bugpatrol/contract';
import { parseConfig, type RoutineStep } from '@bugpatrol/core';
import { ApiDriver, Pacer } from '@bugpatrol/drivers';
import { expect, it } from 'vitest';
import { replaySteps } from './replay.js';
import { type CaptureTarget, captureTargets } from './roles/capture.js';
import { AgentSession } from './session.js';
import { Vars } from './vars.js';
import { Workspace } from './workspace.js';

it('replays fresh string and numeric ids without rewriting literal request data', async () => {
  const fixture = await startFixtureApi();
  const root = await mkdtemp(join(tmpdir(), 'bugpatrol-api-replay-'));
  const vars = new Vars();
  const driver = new ApiDriver({
    url: fixture.url,
    credentials: { self: { Authorization: 'Bearer fixture-token-a', 'X-Workspace-Id': 'ws-a' } },
    policy: requestPolicy(buildContract(await loadSpec({ file: fixtureSpecPath }), {}), {
      url: fixture.url,
      methods: ['GET', 'POST'],
      deny: [],
      disposable: false,
    }),
    pacer: new Pacer({ perMinute: 60_000 }),
    timeoutMs: 1000,
    redact: (value) => vars.redact(value) as string,
  });
  try {
    await driver.connect();
    const record = await new Workspace(root).startSession('explorer');
    const session = new AgentSession(
      root,
      parseConfig({ version: 1, app: { platform: 'api', connect: { url: fixture.url } } }),
      vars,
      record.id,
      'explorer',
      driver,
    );
    // The literal name holds the digits of the ids that the replays capture.
    const steps: RoutineStep[] = [
      {
        kind: 'request',
        method: 'POST',
        url: '/items',
        body: '{"name":"1034"}',
        capture: { RESPONSE_ITEM: '/result/id' },
      },
      { kind: 'request', method: 'GET', url: '/items/{{RESPONSE_ITEM}}' },
      // The one number in the fixture contract: the minimum length of an item name, 1.
      {
        kind: 'request',
        method: 'GET',
        url: '/openapi.json',
        capture: { RESPONSE_LENGTH: '/components/schemas/ItemInput/properties/name/minLength' },
      },
      { kind: 'request', method: 'GET', url: '/items/{{RESPONSE_LENGTH}}' },
    ];
    expect((await replaySteps(session, steps)).ok).toBe(true);
    expect((await replaySteps(session, steps)).ok).toBe(true);
    const reads = fixture
      .hits()
      .filter((hit) => hit.method === 'GET' && hit.path.startsWith('/items/'))
      .map((hit) => hit.path);
    expect(reads).toEqual(['/items/3', '/items/1', '/items/4', '/items/1']);
    const { capture } = await driver.observe();
    expect(capture.kind === 'http' && JSON.parse(capture.exchange!.response!.body)).toEqual({
      result: { id: '1', name: 'Alpha', owner: 'a', workspace: 'ws-a' },
    });
    await driver.act({ kind: 'request', method: 'GET', url: '/items' });
    const listed = await driver.observe();
    const items = listed.capture.kind === 'http' ? JSON.parse(listed.capture.exchange!.response!.body).result : [];
    expect(items.map((item: { name: string }) => item.name)).toEqual(['Alpha', '1034', '1034']);
  } finally {
    await driver.close();
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
}, 20000);

// The missing metadata capture was collected during exploration, before an independent finding.
it.each([false, true])('replays an API finding with a required metadata capture: %s', async (required) => {
  const fixture = await startFixtureApi();
  const root = await mkdtemp(join(tmpdir(), 'bugpatrol-replay-dependencies-'));
  const vars = new Vars();
  const driver = new ApiDriver({
    url: fixture.url,
    credentials: { self: { Authorization: 'Bearer fixture-token-a', 'X-Workspace-Id': 'ws-a' } },
    policy: requestPolicy(buildContract(await loadSpec({ file: fixtureSpecPath }), {}), {
      url: fixture.url,
      methods: ['GET', 'POST'],
      deny: [],
      disposable: false,
    }),
    pacer: new Pacer({ perMinute: 60_000 }),
    timeoutMs: 1000,
    redact: (value) => vars.redact(value) as string,
  });
  try {
    const record = await new Workspace(root).startSession('explorer');
    const session = new AgentSession(
      root,
      parseConfig({ version: 1, app: { platform: 'api', connect: { url: fixture.url } } }),
      vars,
      record.id,
      'explorer',
      driver,
    );
    const target: CaptureTarget = {
      capture: {},
      steps: [
        { kind: 'request', method: 'GET', url: '/items/absent', capture: { RESPONSE_METADATA: '/id' } },
        {
          kind: 'request',
          method: 'POST',
          url: '/items',
          body: required ? '{"name":"{{RESPONSE_METADATA}}"}' : '{"name":"independent"}',
          capture: { RESPONSE_ITEM: '/result/id' },
        },
        { kind: 'request', method: 'GET', url: '/items/${RESPONSE_ITEM}' },
      ],
    };
    let replayError: boolean | undefined;
    await captureTargets(
      session,
      {
        label: 'scripted',
        async run(task) {
          const call = (name: string, input: Record<string, unknown>) =>
            task.tools.find((tool) => tool.name === name)!.run(input);
          replayError = (await call('replay_issue_steps', { target: 1 })).isError;
          await call('capture_after', { target: 1, reached: !replayError, note: 'Replayed the recorded API steps' });
          await call('finish_retest', { summary: 'Finished' });
          return { stop: 'done', steps: 3, costUsd: 0 };
        },
      },
      [target],
      { system: '', prompt: '', replay: { windowMs: 200 } },
    );
    expect(Boolean(replayError)).toBe(required);
    expect(target.capture.reached).toBe(!required);
    expect(fixture.hits().filter((hit) => hit.method === 'POST' && hit.path === '/items')).toHaveLength(
      required ? 0 : 1,
    );
    if (!required) {
      expect(vars.resolve('{{RESPONSE_ITEM}}')).toBe('3');
      const observation = await driver.observe();
      expect(observation.capture.kind === 'http' && observation.capture.exchange?.request.path).toBe('/items/3');
    }
  } finally {
    await driver.close();
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('resumes a required asynchronous capture without resubmitting the successful request', async () => {
  let completed = false;
  let submissions = 0;
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.method === 'POST' && request.url === '/items') {
      submissions++;
      response.statusCode = 202;
      response.end(JSON.stringify({ status: 'processing' }));
    } else if (request.url === '/items') {
      response.end(JSON.stringify({ result: completed ? [{ id: 'task-1' }] : [] }));
    } else {
      response.end(JSON.stringify({ result: { id: 'task-1' } }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP server');
  const url = `http://127.0.0.1:${address.port}`;
  const root = await mkdtemp(join(tmpdir(), 'bugpatrol-async-replay-'));
  const vars = new Vars();
  const driver = new ApiDriver({
    url,
    credentials: { self: {} },
    policy: requestPolicy(buildContract(await loadSpec({ file: fixtureSpecPath }), {}), {
      url,
      methods: ['GET', 'POST'],
      deny: [],
      disposable: false,
    }),
    pacer: new Pacer({ perMinute: 60_000 }),
    timeoutMs: 1000,
    redact: (value) => value,
  });
  try {
    const record = await new Workspace(root).startSession('explorer');
    const session = new AgentSession(
      root,
      parseConfig({ version: 1, app: { platform: 'api', connect: { url } } }),
      vars,
      record.id,
      'explorer',
      driver,
    );
    const target: CaptureTarget = {
      capture: {},
      steps: [
        { kind: 'request', method: 'POST', url: '/items', body: '{"name":"task"}' },
        { kind: 'request', method: 'GET', url: '/items', capture: { RESPONSE_TASK: '/result/0/id' } },
        { kind: 'request', method: 'GET', url: '/items/{{RESPONSE_TASK}}' },
      ],
    };
    await captureTargets(
      session,
      {
        label: 'scripted',
        async run(task) {
          const call = (name: string, input: Record<string, unknown>) =>
            task.tools.find((tool) => tool.name === name)!.run(input);
          expect((await call('replay_issue_steps', { target: 1 })).isError).toBe(true);
          expect(vars.has('RESPONSE_TASK')).toBe(false);
          // Completion is controlled by the server, with no dependence on wall-clock sleeps.
          completed = true;
          expect((await call('replay_issue_steps', { target: 1, resume: true })).isError).not.toBe(true);
          await call('capture_after', { target: 1, reached: true, note: 'Task completed and replay resumed' });
          await call('finish_retest', { summary: 'Finished' });
          return { stop: 'done', steps: 4, costUsd: 0 };
        },
      },
      [target],
      { system: '', prompt: '', replay: { windowMs: 200 } },
    );
    expect(submissions).toBe(1);
    expect(target.capture.reached).toBe(true);
    expect(vars.resolve('{{RESPONSE_TASK}}')).toBe('task-1');
  } finally {
    await driver.close();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await rm(root, { recursive: true, force: true });
  }
});
