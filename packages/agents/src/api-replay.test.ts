import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixtureSpecPath, startFixtureApi } from '@bugpatrol/api-fixture';
import { buildContract, loadSpec, requestPolicy } from '@bugpatrol/contract';
import { parseConfig, type RoutineStep } from '@bugpatrol/core';
import { ApiDriver, Pacer } from '@bugpatrol/drivers';
import { expect, it } from 'vitest';
import { replaySteps } from './replay.js';
import { AgentSession } from './session.js';
import { Vars } from './vars.js';
import { Workspace } from './workspace.js';

it('replays fresh string and numeric ids without rewriting literal request data', async () => {
  const fixture = await startFixtureApi();
  const root = await mkdtemp(join(tmpdir(), 'bugpatrol-api-replay-'));
  const vars = new Vars();
  const driver = new ApiDriver({
    url: fixture.url,
    headers: { Authorization: 'Bearer fixture-token-a', 'X-Workspace-Id': 'ws-a' },
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
