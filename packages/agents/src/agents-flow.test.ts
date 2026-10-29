import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixtureApi } from '@bugpatrol/api-fixture';
import { AGENT_CHECKS, type Candidate, parseConfig, paths } from '@bugpatrol/core';
import { describe, expect, it } from 'vitest';
import { runPatrol } from './patrol.js';
import { replayRoutine } from './replay.js';
import { AgentSession } from './session.js';
import { FakeDriver, type FakeScreen } from './testing/fake-driver.js';
import { explorerTools } from './tools/explorer.js';
import { judgeTools, pendingCandidates } from './tools/judge.js';
import { Vars } from './vars.js';
import { Workspace } from './workspace.js';

const element = (ref: string, name: string) => ({
  ref,
  role: 'button',
  name,
  box: { x: 10, y: 10, width: 40, height: 40 },
  interactive: true,
  enabled: true,
});
// These tests cover the automatic checks, so they turn all of them on.
const config = parseConfig({
  version: 1,
  app: { connect: { url: 'fake://home' } },
  agents: { checks: [...AGENT_CHECKS] },
});
const run = async (
  tools: ReturnType<typeof explorerTools> | ReturnType<typeof judgeTools>,
  name: string,
  input: Record<string, unknown> = {},
) => {
  const tool = tools.find((item) => item.name === name);
  if (!tool) throw new Error(`Missing ${name}`);
  return tool.run(input);
};

async function fixture(options: { config?: typeof config } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'bugpatrol-flow-'));
  const screens: Record<string, FakeScreen> = {
    home: { elements: [element('e1', 'Settings')], next: { e1: 'settings' }, color: 20 },
    settings: { elements: [element('e2', 'Save')], color: 70 },
  };
  const driver = new FakeDriver(screens);
  const workspace = new Workspace(root);
  const record = await workspace.startSession('explorer');
  const vars = new Vars();
  vars.set('SECRET', 'super-secret-value');
  const session = new AgentSession(root, options.config ?? config, vars, record.id, 'explorer', driver);
  return { root, screens, driver, workspace, session };
}

describe('explorer, replay, and judge', () => {
  it('runs no automatic checks by default, and shows the explorer the console and network errors', async () => {
    const f = await fixture({ config: parseConfig({ version: 1, app: { connect: { url: 'fake://home' } } }) });
    try {
      f.screens.home!.consoleErrors = [
        'TypeError: x is undefined',
        'TypeError: x is undefined',
        'token super-secret-value',
      ];
      f.screens.home!.networkErrors = ['GET https://api.test/me → 500'];
      const tools = explorerTools(f.session);
      const looked = JSON.stringify(await run(tools, 'look'));
      expect(looked).toContain('Console errors:\\n- TypeError: x is undefined\\n- token {{SECRET}}');
      expect(looked).toContain('Failed requests:\\n- GET https://api.test/me → 500');
      expect(looked).not.toContain('super-secret-value');
      const recorded = JSON.stringify(
        await run(tools, 'record_screen', { id: 'home', name: 'Home', description: 'Home' }),
      );
      expect(recorded).not.toContain('automatic');
      expect(recorded).toContain('GET https://api.test/me → 500');
      f.screens.home!.color = 230;
      await run(tools, 'record_screen', { id: 'home', name: 'Home', description: 'Home' });
      expect(await f.workspace.readCandidates(f.session.sessionId)).toEqual([]);
      expect(await readFile(paths.agentBaseline(f.root, 'home')).catch(() => undefined)).toBeUndefined();
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it('records direct tap and open transitions, counts repeats, and skips long paths', async () => {
    const f = await fixture();
    try {
      const tools = explorerTools(f.session);
      await run(tools, 'look');
      await run(tools, 'record_screen', { id: 'home', name: 'Home', description: 'Home' });
      await run(tools, 'tap', { ref: 'e1' });
      await run(tools, 'record_screen', { id: 'settings', name: 'Settings', description: 'Settings' });
      expect(
        (await f.workspace.readAppMap())?.screens.find((screen) => screen.id === 'home')?.transitions,
      ).toMatchObject([{ to: 'settings', kind: 'tap', via: 'Settings', steps: 1, count: 1 }]);
      await run(tools, 'open', { url: 'fake://home' });
      expect(
        (await f.workspace.readAppMap())?.screens.find((screen) => screen.id === 'settings')?.transitions,
      ).toMatchObject([{ to: 'home', kind: 'open', via: 'open fake://home', steps: 1 }]);
      await run(tools, 'tap', { ref: 'e1' });
      expect(
        (await f.workspace.readAppMap())?.screens.find((screen) => screen.id === 'home')?.transitions,
      ).toMatchObject([{ to: 'settings', kind: 'tap', via: 'Settings', steps: 1, count: 2 }]);
      await run(tools, 'open', { url: 'fake://home' });
      for (let index = 0; index < 5; index++) await run(tools, 'press', { key: 'Tab' });
      await run(tools, 'tap', { ref: 'e1' });
      expect(
        (await f.workspace.readAppMap())?.screens.find((screen) => screen.id === 'home')?.transitions,
      ).toMatchObject([{ count: 2 }]);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it('returns image observations, keeps secrets as placeholders, and records screens and candidates', async () => {
    const f = await fixture();
    try {
      const tools = explorerTools(f.session);
      const looked = await run(tools, 'look');
      expect(looked.content.map((part) => part.type)).toEqual(['image', 'text']);
      expect(JSON.stringify(looked.content.filter((part) => part.type === 'text'))).toContain('[e1] button');
      await run(tools, 'type', { text: '{{SECRET}}' });
      expect(f.driver.actions[0]).toMatchObject({ kind: 'type', value: 'super-secret-value' });
      await run(tools, 'type', { text: ' more', append: true });
      expect(f.driver.actions[1]).toMatchObject({ kind: 'type', append: true });
      expect(f.session.trail.at(-1)).toMatchObject({ kind: 'type', append: true });
      await run(tools, 'save_routine', { id: 'enter-app', description: 'Enter app' });
      const first = await run(tools, 'record_screen', { id: 'Home', name: 'Home', description: 'Launcher' });
      expect(JSON.stringify(first)).toContain('No automatic findings');
      await run(tools, 'wait', { seconds: 0 });
      await run(tools, 'tap', { ref: 'e1' });
      await run(tools, 'record_screen', { id: 'Settings', name: 'Settings', description: 'Settings pane' });
      const map = await f.workspace.readAppMap();
      expect(map?.screens.find((item) => item.id === 'home')?.links).toContain('settings');
      expect((await f.workspace.readRoutine('screen-settings'))?.requires).toEqual(['screen-home']);
      expect((await f.workspace.readRoutine('screen-settings'))?.steps.map((step) => step.kind)).toEqual(['tap']);
      f.screens.settings!.color = 230;
      await run(tools, 'record_screen', { id: 'settings', name: 'Settings', description: 'Settings pane' });
      const candidates = await f.workspace.readCandidates(f.session.sessionId);
      expect(candidates.some((item) => item.source === 'pixel-diff')).toBe(true);
      expect(candidates.find((item) => item.source === 'pixel-diff')?.evidence.steps).toEqual([]);
      await run(tools, 'report_bug', {
        title: 'Save does nothing',
        what_is_wrong: 'No confirmation',
        expected: 'A confirmation',
        severity: 'major',
      });
      const reported = (await f.workspace.readCandidates(f.session.sessionId)).find(
        (item) => item.source === 'explorer',
      );
      expect(reported?.evidence.routineId).toBe('screen-settings');
      expect(reported?.evidence.steps).toEqual([]);
      await new Promise((done) => setTimeout(done, 20));
      const events = await readFile(join(paths.session(f.root, f.session.sessionId), 'events.jsonl'), 'utf8');
      const routines = await readFile(paths.routine(f.root, 'enter-app'), 'utf8');
      expect(events + routines).not.toContain('super-secret-value');
      expect(routines).toContain('{{SECRET}}');
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it('replays dependencies once, breaks cycles, and records failures', async () => {
    const f = await fixture();
    try {
      const now = new Date().toISOString();
      const base = {
        version: 1 as const,
        platform: 'web' as const,
        description: 'path',
        createdAt: now,
        updatedAt: now,
      };
      await f.workspace.saveRoutine({ ...base, id: 'a', requires: ['b'], steps: [{ kind: 'press', key: 'A' }] });
      await f.workspace.saveRoutine({ ...base, id: 'b', requires: ['a'], steps: [{ kind: 'press', key: 'B' }] });
      expect((await replayRoutine(f.session, 'a')).ok).toBe(true);
      expect(f.driver.actions.map((item) => item.kind)).toEqual(['press', 'press']);
      expect((f.driver.actions[0] as { key: string }).key).toBe('B');
      f.session.completedRoutines.clear();
      f.driver.failAt = 3;
      const failed = await replayRoutine(f.session, 'a');
      expect(failed).toMatchObject({ ok: false, error: 'Required routine b: fake action failed' });
      expect((await f.workspace.readRoutine('b'))?.lastReplay?.ok).toBe(false);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it('files and merges issues, dismisses changes with baseline updates, and hides decisions', async () => {
    const f = await fixture();
    try {
      const tools = explorerTools(f.session);
      await run(tools, 'record_screen', { id: 'home', name: 'Home', description: 'Launcher' });
      await run(tools, 'report_bug', {
        title: 'Save does nothing',
        what_is_wrong: 'No confirmation',
        expected: 'A confirmation',
        severity: 'major',
      });
      const first = (await pendingCandidates(f.session, [f.session.sessionId]))[0]!;
      const judge = judgeTools(f.session, [f.session.sessionId], 'fake-judge');
      expect(
        (
          await run(judge, 'file_issue', {
            candidate_ids: [first.id],
            title: first.summary,
            body: 'What happened: nothing',
            severity: 'major',
          })
        ).isError,
      ).toBe(true);
      const longTitle = 'The save control does not work when someone tries to update their settings in the desktop app';
      // A long title is refused, not cut: the end of a title is often the point.
      const refused = await run(judge, 'file_issue', {
        candidate_ids: [first.id],
        title: longTitle,
        body: 'What happened: nothing',
        severity: 'major',
        reason: 'The save control has no effect.',
      });
      expect(refused.isError).toBe(true);
      expect(refused.content[0]).toMatchObject({ text: expect.stringContaining(`${longTitle.length} characters`) });
      expect(await f.workspace.listIssues()).toEqual([]);
      await run(judge, 'file_issue', {
        candidate_ids: [first.id],
        title: 'Save in settings does nothing',
        body: 'What happened: nothing',
        severity: 'major',
        reason: 'The save control has no effect.',
      });
      const filed = (await f.workspace.listIssues())[0]!;
      expect(filed.title).toBe('Save in settings does nothing');
      expect(await pendingCandidates(f.session, [f.session.sessionId])).toEqual([]);
      const repeated = await run(tools, 'report_bug', {
        title: 'Save does nothing',
        what_is_wrong: 'No confirmation',
        expected: 'A confirmation',
        severity: 'major',
      });
      expect(repeated.content[0]).toMatchObject({ text: expect.stringContaining('Already filed as') });
      expect((await f.workspace.listIssues())[0]?.occurrences).toBe(2);
      expect((await f.workspace.listIssues())[0]?.judgement.reason).toBe('The save control has no effect.');
      f.screens.home!.color = 240;
      await run(tools, 'record_screen', { id: 'home', name: 'Home', description: 'Launcher' });
      const visual = (await pendingCandidates(f.session, [f.session.sessionId])).find(
        (item) => item.source === 'pixel-diff',
      )!;
      const before = await readFile(paths.agentBaseline(f.root, 'home'));
      await run(judge, 'dismiss', { candidate_ids: [visual.id], reason: 'Accepted design', update_baseline: true });
      expect((await readFile(paths.agentBaseline(f.root, 'home'))).equals(before)).toBe(false);
      const stillPending = await pendingCandidates(f.session, [f.session.sessionId]);
      expect(stillPending.some((item) => item.id === visual.id)).toBe(false);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("saves a new issue's repro as a committed routine", async () => {
    const f = await fixture();
    try {
      const tools = explorerTools(f.session);
      await run(tools, 'record_screen', { id: 'home', name: 'Home', description: 'Launcher' });
      await run(tools, 'tap', { ref: 'e1' });
      await run(tools, 'report_bug', {
        screen_id: 'settings',
        title: 'Save does nothing',
        what_is_wrong: 'No confirmation',
        expected: 'A confirmation',
        severity: 'major',
      });
      const candidate = (await pendingCandidates(f.session, [f.session.sessionId]))[0]!;
      await run(judgeTools(f.session, [f.session.sessionId], 'fake-judge'), 'file_issue', {
        candidate_ids: [candidate.id],
        title: 'Save in settings does nothing',
        body: 'What happened: nothing',
        severity: 'major',
        reason: 'The save control has no effect.',
      });
      const issue = (await f.workspace.listIssues())[0]!;
      expect(issue.evidence.reproRoutineId).toMatch(/^repro-/);
      const saved = JSON.parse(await readFile(paths.routine(f.root, issue.evidence.reproRoutineId!), 'utf8'));
      expect(saved).toMatchObject({
        id: issue.evidence.reproRoutineId,
        description: 'Reproduces: Save in settings does nothing',
        requires: [candidate.evidence.routineId],
        steps: [{ kind: 'tap', target: { name: 'Settings' } }],
      });
      expect(paths.routine(f.root, saved.id).startsWith(join(f.root, '.bugpatrol', 'routines'))).toBe(true);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it('keeps how a replay tells that the bug shows, checked against the screen, in the repro routine', async () => {
    const f = await fixture();
    try {
      f.screens.settings!.consoleErrors = ['TypeError: save is not a function'];
      const tools = explorerTools(f.session);
      await run(tools, 'tap', { ref: 'e1' });
      const report = (bug: Record<string, unknown>) =>
        run(tools, 'report_bug', {
          screen_id: 'settings',
          title: 'Save does nothing',
          what_is_wrong: 'No confirmation',
          expected: 'A confirmation',
          severity: 'major',
          ...bug,
        });
      // Each part of the check must hold on the screen that the explorer looked at last.
      expect((await report({ shows: 'Saved' })).isError).toBe(true);
      expect((await report({ lacks: 'Save' })).isError).toBe(true);
      expect((await report({ error: 'ReferenceError' })).isError).toBe(true);
      expect((await pendingCandidates(f.session, [f.session.sessionId])).length).toBe(0);
      await report({ shows: 'Save', lacks: 'Saved', error: 'save is not a function' });
      const candidate = (await pendingCandidates(f.session, [f.session.sessionId]))[0]!;
      await run(judgeTools(f.session, [f.session.sessionId], 'fake-judge'), 'file_issue', {
        candidate_ids: [candidate.id],
        title: 'Save in settings does nothing',
        body: 'What happened: nothing',
        severity: 'major',
        reason: 'The save control has no effect.',
      });
      const issue = (await f.workspace.listIssues())[0]!;
      const saved = await f.workspace.readRoutine(issue.evidence.reproRoutineId!);
      expect(saved!.bug).toEqual({ shows: 'Save', lacks: 'Saved', error: 'save is not a function' });
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it('compacts routines and keeps only steps after the current anchor as evidence', async () => {
    const f = await fixture();
    try {
      const tools = explorerTools(f.session);
      await run(tools, 'look');
      await run(tools, 'press', { key: 'Enter' });
      await run(tools, 'save_routine', { id: 'enter-app', description: 'Entry' });
      await run(tools, 'wait', { seconds: 0 });
      await run(tools, 'press', { key: 'Home' });
      await run(tools, 'press', { key: 'Home' });
      await run(tools, 'tap', { ref: 'e1' });
      f.session.trail.push({
        kind: 'tap',
        target: { role: 'button', name: 'Settings', point: { x: 99, y: 99 } },
      });
      await run(tools, 'save_routine', { id: 'settings', description: 'Open settings' });
      expect((await f.workspace.readRoutine('settings'))?.steps).toHaveLength(2);
      await run(tools, 'press', { key: 'Home' });
      await run(tools, 'report_bug', {
        title: 'Settings is broken',
        what_is_wrong: 'Wrong content',
        expected: 'Settings',
        severity: 'major',
      });
      const candidate = (await f.workspace.readCandidates(f.session.sessionId)).at(-1);
      expect(candidate?.evidence.routineId).toBe('settings');
      expect(candidate?.evidence.steps).toEqual([{ kind: 'press', key: 'Home' }]);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it('retries a targeted replay and skips completed dependencies', async () => {
    const f = await fixture();
    try {
      const now = new Date().toISOString();
      const base = {
        version: 1 as const,
        platform: 'web' as const,
        description: 'path',
        createdAt: now,
        updatedAt: now,
      };
      await f.workspace.saveRoutine({ ...base, id: 'enter-app', steps: [{ kind: 'press', key: 'Enter' }] });
      await f.workspace.saveRoutine({
        ...base,
        id: 'settings',
        requires: ['enter-app'],
        steps: [{ kind: 'tap', target: { role: 'button', name: 'Settings' } }],
      });
      const originalAct = f.driver.act.bind(f.driver);
      let attempts = 0;
      f.driver.act = async (action) => {
        if (action.kind === 'tap' && ++attempts < 3) {
          return { ok: false, error: 'not loaded', degraded: true };
        }
        return originalAct(action);
      };
      expect(await replayRoutine(f.session, 'settings')).toMatchObject({ ok: true, degraded: true });
      expect(attempts).toBe(3);
      f.driver.current = 'home';
      expect((await replayRoutine(f.session, 'settings')).ok).toBe(true);
      expect(f.driver.actions.filter((action) => action.kind === 'press')).toHaveLength(1);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it('does not offer window switching on iOS', async () => {
    const f = await fixture();
    try {
      const ios = new AgentSession(
        f.root,
        f.session.config,
        f.session.vars,
        f.session.sessionId,
        'explorer',
        new FakeDriver(f.screens, 'home', 'ios'),
      );
      expect(explorerTools(ios).some((tool) => tool.name === 'switch_window')).toBe(false);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it('flattens a deep routine chain and removes a return detour', async () => {
    const f = await fixture();
    try {
      const tools = explorerTools(f.session);
      const now = new Date().toISOString();
      const base = {
        version: 1 as const,
        platform: 'web' as const,
        description: 'Path',
        createdAt: now,
        updatedAt: now,
      };
      await f.workspace.saveRoutine({ ...base, id: 'enter-app', steps: [{ kind: 'press', key: 'Enter' }] });
      await f.workspace.saveRoutine({
        ...base,
        id: 'first',
        requires: ['enter-app'],
        steps: [{ kind: 'press', key: 'First' }],
      });
      await f.workspace.saveRoutine({
        ...base,
        id: 'second',
        requires: ['first'],
        steps: [{ kind: 'press', key: 'Second' }],
      });
      f.session.anchor = { routineId: 'second', index: 0 };
      f.session.trail.push(
        { kind: 'press', key: 'Open', at: 'A' },
        { kind: 'press', key: 'Detour', at: 'B' },
        { kind: 'back', at: 'A' },
        { kind: 'press', key: 'Done', at: 'C' },
      );
      const result = await run(tools, 'save_routine', { id: 'third', description: 'Done' });
      expect(result.content[0]).toMatchObject({ text: expect.stringContaining('flattened from a chain of 4') });
      const saved = await f.workspace.readRoutine('third');
      expect(saved?.requires).toEqual(['enter-app']);
      expect(saved?.steps.map((step) => (step.kind === 'press' ? step.key : step.kind))).toEqual([
        'First',
        'Second',
        'Open',
        'Done',
      ]);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it('keeps steps that stay in one place, such as a form', async () => {
    const f = await fixture();
    try {
      const tools = explorerTools(f.session);
      f.session.anchor = { index: 0 };
      f.session.trail.push(
        { kind: 'type', value: 'First', at: 'form' },
        { kind: 'type', value: 'Last', at: 'form' },
        { kind: 'type', value: 'Team', at: 'form' },
        { kind: 'press', key: 'Enter', at: 'home' },
      );
      await run(tools, 'save_routine', { id: 'onboard', description: 'Onboarding' });
      const saved = await f.workspace.readRoutine('onboard');
      expect(saved?.steps).toHaveLength(4);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it('resolves a previous ref by role, name and position', async () => {
    const f = await fixture();
    try {
      f.screens.settings!.elements = [element('e9', 'Settings')];
      f.screens.settings!.next = { e9: 'home' };
      const tools = explorerTools(f.session);
      await run(tools, 'look');
      await run(tools, 'tap', { ref: 'e1' });
      const result = await run(tools, 'tap', { ref: 'e1' });
      expect(result.content[0]).toMatchObject({ text: expect.stringContaining('used e9') });
      expect(f.driver.actions.at(-1)).toMatchObject({ kind: 'tap', ref: 'e9' });
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it('uses the reported screen id and suppresses a dismissed fingerprint', async () => {
    const f = await fixture();
    try {
      const tools = explorerTools(f.session);
      await run(tools, 'record_screen', { id: 'home', name: 'Home', description: 'Home' });
      await run(tools, 'tap', { ref: 'e1' });
      await run(tools, 'record_screen', { id: 'settings', name: 'Settings', description: 'Settings' });
      const input = {
        screen_id: 'home',
        title: 'Control is broken',
        what_is_wrong: 'No action',
        expected: 'An action',
        severity: 'major',
      };
      await run(tools, 'report_bug', input);
      const candidate = (await f.workspace.readCandidates(f.session.sessionId)).at(-1)!;
      expect(candidate.screenId).toBe('home');
      await f.workspace.recordTriage({
        [candidate.fingerprint]: { decision: 'dismissed', reason: 'Expected', at: 'now' },
      });
      const result = await run(tools, 'report_bug', input);
      expect(result.content[0]).toMatchObject({ text: expect.stringContaining('dismissed this before (Expected)') });
      expect(
        (await f.workspace.readCandidates(f.session.sessionId)).filter((item) => item.source === 'explorer'),
      ).toHaveLength(1);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
});

describe('api explorer and judge on the fixture, with a scripted model', () => {
  /**
   * One patrol cycle: the sweep, then a scripted explorer that reads item 1
   * of user a as user b and reads /health, then a scripted judge that files
   * each explorer candidate and dismisses the sweep candidates.
   */
  async function patrol() {
    const fixture = await startFixtureApi({ perSecond: 1000 });
    const root = await mkdtemp(join(tmpdir(), 'bugpatrol-api-flow-'));
    const config = parseConfig({
      version: 1,
      app: {
        platform: 'api',
        connect: {
          url: fixture.url,
          spec: '/openapi.json',
          credentials: {
            self: { headers: { Authorization: 'Bearer fixture-token-a', 'X-Workspace-Id': 'ws-a' } },
            other: { headers: { Authorization: 'Bearer fixture-token-b', 'X-Workspace-Id': 'ws-b' } },
          },
          errors: { statuses: [401, 409] },
          deny: ['/admin/**'],
          perMinute: 60_000,
        },
      },
      agents: { fixer: { enabled: false }, patrol: { cycles: 1 } },
    });
    const seen: { explorer?: string; judge?: string; candidates: Candidate[] } = { candidates: [] };
    try {
      const result = await runPatrol({
        root,
        config,
        once: true,
        force: true,
        createRuntime: () => ({
          label: 'scripted',
          async run(task) {
            const tool = (name: string) => task.tools.find((item) => item.name === name)!;
            if (task.role === 'explorer') {
              seen.explorer = task.prompt;
              await tool('request').run({ method: 'GET', url: '/items/1', as: 'other', case: 'other-user' });
              expect(
                (
                  await tool('report_bug').run({
                    screen_id: 'unrecorded',
                    title: 'User b learns that item 1 of user a exists',
                    what_is_wrong: 'GET /items/1 as user b gives 403',
                    expected: '404, so the item stays hidden',
                    severity: 'major',
                    rule: 'other-user-data',
                    shows: 'forbidden',
                  })
                ).isError,
              ).toBeFalsy();
              await tool('request').run({ method: 'GET', url: '/health' });
              await tool('report_bug').run({
                screen_id: 'unrecorded',
                title: 'Health says ok while the database is down',
                what_is_wrong: 'status is ok and db is down',
                expected: 'status is not ok when db is down',
                severity: 'major',
                rule: 'body-contradicts-status',
                shows: 'down',
              });
              return { stop: 'done', steps: 4, costUsd: 0, summary: 'Done' };
            }
            seen.judge = task.system;
            const sessionId = task.prompt.match(/session\(s\) (\S+)\./)![1]!;
            seen.candidates = await new Workspace(root).readCandidates(sessionId);
            for (const candidate of seen.candidates) {
              await (candidate.source === 'explorer'
                ? tool('file_issue').run({
                    candidate_ids: [candidate.id],
                    title: candidate.summary,
                    body: candidate.detail ?? candidate.summary,
                    severity: candidate.severity,
                    reason: 'The exchange breaks an API rule',
                  })
                : tool('dismiss').run({ candidate_ids: [candidate.id], reason: 'Covered by the sweep test' }));
            }
            return { stop: 'done', steps: 1, costUsd: 0, summary: 'Done' };
          },
        }),
      });
      const issues = await new Workspace(root).listIssues();
      return { result, issues, seen, coverage: await new Workspace(root).readCoverage() };
    } finally {
      await fixture.close();
      await rm(root, { recursive: true, force: true });
    }
  }

  // One cycle for both tests: it runs the full sweep.
  let cycle: ReturnType<typeof patrol> | undefined;
  const once = () => {
    cycle ??= patrol();
    return cycle;
  };

  it('files bug 3 as other-user', async () => {
    const { result, issues, seen, coverage } = await once();
    expect(result.problems).toEqual([]);
    expect(seen.explorer).toContain('ENDPOINTS TO TEST FIRST');
    expect(seen.judge).toContain('API RULES');
    expect(seen.judge).toContain('Account enumeration depends on context. The judge gives "unclear".');
    expect(seen.judge).toContain('Latency is not a bug. It shows as information only.');

    const bug3 = issues.find((issue) => issue.title.startsWith('User b learns'))!;
    expect(bug3.evidence.steps).toEqual([expect.objectContaining({ method: 'GET', url: '/items/1', as: 'other' })]);
    expect(bug3.evidence.capture).toMatchObject({ kind: 'http', exchange: { response: { status: 403 } } });
    expect(JSON.stringify(bug3.evidence)).not.toContain('fixture-token-b');
    expect(coverage?.cells['GET /items/{id} other-user']).toMatchObject({ status: 403, ok: false });
    // The sweep found bug 3 too, with the second credential set, and it repeats.
    expect(
      seen.candidates.find((candidate) => candidate.source === 'sweep' && candidate.ruleId === 'sweep:other-user'),
    ).toMatchObject({ blocking: true });
  });

  it('bug 6 is non-blocking', async () => {
    const { issues, seen } = await once();

    const bug6 = issues.find((issue) => issue.title.startsWith('Health says ok'))!;
    expect(bug6.evidence.capture).toMatchObject({ kind: 'http', exchange: { response: { status: 200 } } });
    const explorer = seen.candidates.filter((candidate) => candidate.source === 'explorer');
    expect(explorer.map((candidate) => [candidate.ruleId, candidate.blocking])).toEqual([
      ['judge:other-user-data', false],
      ['judge:body-contradicts-status', false],
    ]);
  });
});
