import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixtureSpecPath, startFixtureApi } from '@bugpatrol/api-fixture';
import { buildContract, loadSpec, requestPolicy } from '@bugpatrol/contract';
import { type Assertion, parseConfig, type Routine } from '@bugpatrol/core';
import { ApiDriver, type DriverAction, type Observation, Pacer } from '@bugpatrol/drivers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkAssertions, replayRoutine, replaySteps } from './replay.js';
import { AgentSession } from './session.js';
import { FakeDriver, type FakeScreen } from './testing/fake-driver.js';
import { Vars } from './vars.js';
import { Workspace } from './workspace.js';

const config = parseConfig({ version: 1, app: { connect: { url: 'fake://home' } } });
const button = (ref: string, name: string) => ({
  ref,
  role: 'button',
  name,
  box: { x: 10, y: 10, width: 40, height: 40 },
  interactive: true,
  enabled: true,
});
const screens: Record<string, FakeScreen> = {
  home: { elements: [button('e1', 'Open settings')], next: { e1: 'settings' } },
  settings: { elements: [button('e2', 'Save'), button('e3', 'Cancel')] },
};

// Step 0 closes a banner that is not there this time; step 1 is the real path.
function routine(expect?: Routine['expect']): Routine {
  return {
    version: 1,
    id: 'open-settings',
    description: 'Open settings',
    platform: 'web',
    steps: [
      { kind: 'tap', target: { name: 'Dismiss banner', role: 'button' } },
      { kind: 'tap', target: { name: 'Open settings', role: 'button' } },
    ],
    expect,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'bugpatrol-replay-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function replay(value: Routine) {
  const workspace = new Workspace(root);
  await workspace.saveRoutine(value);
  const record = await workspace.startSession('explorer');
  const session = new AgentSession(root, config, new Vars(), record.id, 'explorer', new FakeDriver(screens));
  // A short retry window: the rule under test is the skip, not the wait.
  const result = await replayRoutine(session, value.id, { windowMs: 200 });
  return { result, saved: await workspace.readRoutine(value.id) };
}

// FakeDriver finds a locator by ref, testId or name; see testing/fake-driver.ts.
describe('replayRoutine end check', () => {
  it('stores a failure from a fix build but leaves success on that build unsaved', async () => {
    const workspace = new Workspace(root);
    const record = await workspace.startSession('explorer');
    const driver = new FakeDriver(screens);
    const session = new AgentSession(root, config, new Vars(), record.id, 'explorer', driver);
    await workspace.saveRoutine(routine());
    expect((await replayRoutine(session, 'open-settings', { windowMs: 10, save: false, onFixBuild: true })).ok).toBe(
      false,
    );
    expect((await workspace.readRoutine('open-settings'))?.lastReplay).toMatchObject({ ok: false, onFixBuild: true });
    await workspace.saveRoutine({ ...routine({ elements: ['Save', 'Cancel'] }), lastReplay: undefined });
    expect((await replayRoutine(session, 'open-settings', { windowMs: 10, save: false, onFixBuild: true })).ok).toBe(
      true,
    );
    expect((await workspace.readRoutine('open-settings'))?.lastReplay).toBeUndefined();
  });
  it('skips a missing step when the routine still ends where it should', async () => {
    const { result, saved } = await replay(routine({ elements: ['Save', 'Cancel'] }));
    expect(result).toMatchObject({ ok: true, degraded: true });
    expect(saved?.lastReplay).toMatchObject({ ok: true, skipped: [0] });
  });

  it('fails at the skipped step when the end does not match', async () => {
    const { result } = await replay(routine({ elements: ['Delete account', 'Billing'] }));
    expect(result).toMatchObject({ ok: false, failedStep: 0 });
  });

  it('fails at the first miss when the routine has no end check', async () => {
    const { result } = await replay(routine());
    expect(result).toMatchObject({ ok: false, failedStep: 0 });
  });
});

describe('replaySteps', () => {
  it('replays a path from the current screen', async () => {
    const record = await new Workspace(root).startSession('explorer');
    const driver = new FakeDriver(screens);
    const session = new AgentSession(root, config, new Vars(), record.id, 'explorer', driver);
    const result = await replaySteps(session, [{ kind: 'tap', target: { role: 'button', name: 'Open settings' } }], {
      windowMs: 50,
    });
    expect(result).toMatchObject({ ok: true, degraded: false });
    expect(driver.current).toBe('settings');
  });

  it('stops at the first failed step without skipping it', async () => {
    const record = await new Workspace(root).startSession('explorer');
    const driver = new FakeDriver(screens);
    const session = new AgentSession(root, config, new Vars(), record.id, 'explorer', driver);
    const result = await replaySteps(
      session,
      [
        { kind: 'tap', target: { role: 'button', name: 'Missing' } },
        { kind: 'tap', target: { role: 'button', name: 'Open settings' } },
      ],
      { windowMs: 50 },
    );
    expect(result).toMatchObject({ ok: false, failedStep: 0 });
    expect(driver.current).toBe('home');
  });
});

describe('replay control boundaries', () => {
  it('does not retry or skip an action whose delivery is unknown', async () => {
    class RefusedDriver extends FakeDriver {
      calls = 0;
      override async act(_action: DriverAction) {
        this.calls++;
        return { ok: false, retryable: false, error: 'Delivery unknown' };
      }
    }
    const driver = new RefusedDriver(screens);
    const workspace = new Workspace(root);
    const record = await workspace.startSession('explorer');
    const session = new AgentSession(root, config, new Vars(), record.id, 'explorer', driver);
    await workspace.saveRoutine(routine({ elements: ['Open settings'] }));
    expect(await replayRoutine(session, 'open-settings', { windowMs: 1000 })).toMatchObject({
      ok: false,
      failedStep: 0,
      error: 'Delivery unknown',
    });
    expect(driver.calls).toBe(1);
  });
  it('fails the replay when human control changes while settling an input', async () => {
    class TakenDriver extends FakeDriver {
      controlVersion = 0;
      override async settle() {
        this.controlVersion++;
        return { frames: 1, stable: true };
      }
    }
    const driver = new TakenDriver(screens);
    const workspace = new Workspace(root);
    const record = await workspace.startSession('explorer');
    const session = new AgentSession(root, config, new Vars(), record.id, 'explorer', driver);
    expect(
      await replaySteps(session, [{ kind: 'tap', target: { name: 'Open settings', role: 'button' } }]),
    ).toMatchObject({ ok: false, error: expect.stringContaining('Human takeover') });
  });
});

describe('step assertions', () => {
  it('a step assertion fails on step 2 of 3', async () => {
    const fixture = await startFixtureApi({ perSecond: 1000 });
    const vars = new Vars();
    const driver = new ApiDriver({
      url: fixture.url,
      credentials: { self: { Authorization: 'Bearer fixture-token-a', 'X-Workspace-Id': 'ws-a' } },
      policy: requestPolicy(buildContract(await loadSpec({ file: fixtureSpecPath }), {}), {
        url: fixture.url,
        methods: ['GET'],
        deny: [],
        disposable: false,
      }),
      pacer: new Pacer({ perMinute: 60_000 }),
      timeoutMs: 2000,
      redact: (value) => vars.redact(value) as string,
    });
    try {
      const api = parseConfig({
        version: 1,
        app: { platform: 'api', connect: { url: fixture.url, spec: '/openapi.json' } },
      });
      const workspace = new Workspace(root);
      const record = await workspace.startSession('explorer');
      const session = new AgentSession(root, api, vars, record.id, 'explorer', driver);
      const contract: Assertion[] = [{ kind: 'contract' }];
      await workspace.saveRoutine({
        ...routine(),
        id: 'list-items',
        platform: 'api',
        steps: [
          { kind: 'request', method: 'GET', url: '/items/1', assert: contract },
          { kind: 'request', method: 'GET', url: '/items', assert: contract },
          { kind: 'request', method: 'GET', url: '/health' },
        ],
      });
      // No contract is passed in, so the replay reads the one that the driver gates on.
      const result = await replayRoutine(session, 'list-items');
      expect(result).toMatchObject({ ok: false, failedStep: 1 });
      expect(result.error).toMatch(/^The checks failed: the body does not match the schema: .*\(internal_note\)/);
      expect(fixture.hits().map((hit) => hit.path)).toEqual(['/items/1', '/items']);
    } finally {
      await fixture.close();
    }
  });

  it('schema check runs before redaction', () => {
    const contract = buildContract(
      {
        openapi: '3.1.0',
        paths: {},
        components: {
          schemas: { Session: { type: 'object', required: ['token'], properties: { token: { type: 'number' } } } },
        },
      },
      {},
    );
    const screen: Observation = {
      platform: 'api',
      location: 'http://127.0.0.1/session',
      capture: {
        kind: 'http',
        exchange: {
          request: { method: 'GET', path: '/session', headers: {} },
          response: {
            status: 200,
            headers: {},
            contentType: 'application/json',
            body: '{"token": "[redacted]"}',
            bytes: 11,
          },
          latencyMs: 1,
          at: '2026-01-01T00:00:00.000Z',
        },
      },
      viewport: { width: 0, height: 0, scale: 1 },
      elements: [],
      volatileRegions: [],
      consoleErrors: [],
      at: '2026-01-01T00:00:00.000Z',
    };
    const raw = {
      status: 200,
      headers: { 'content-type': 'application/json' },
      text: '{"token":5}',
      json: { token: 5 },
    };
    const assertions: Assertion[] = [
      { kind: 'schema', ref: '#/components/schemas/Session' },
      { kind: 'pointer', pointer: '/token', equals: 5 },
    ];
    expect(checkAssertions(assertions, screen, { raw, contract }).map((result) => result.ok)).toEqual([true, true]);
    // A result shows only what the redacted exchange shows.
    expect(checkAssertions([{ kind: 'pointer', pointer: '/token', equals: 6 }], screen, { raw })[0]).toMatchObject({
      ok: false,
      actual: '"[redacted]"',
    });
  });
});
