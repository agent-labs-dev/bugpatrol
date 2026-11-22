import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '@bugpatrol/core';
import { expect, it } from 'vitest';
import { AgentSession } from './session.js';
import { FakeDriver, type FakeScreen } from './testing/fake-driver.js';
import { explorerTools } from './tools/explorer.js';
import { Vars } from './vars.js';
import { Workspace } from './workspace.js';

it.each(['home', 'settings'])('keeps only replayable %s errors when a routine chain is flattened', async (screen) => {
  const root = await mkdtemp(join(tmpdir(), 'bugpatrol-flattened-errors-'));
  try {
    const screens: Record<string, FakeScreen> = {
      home: {
        elements: [
          {
            ref: 'e1',
            role: 'button',
            name: 'Settings',
            box: { x: 10, y: 10, width: 40, height: 40 },
            interactive: true,
            enabled: true,
          },
        ],
        next: { e1: 'settings' },
      },
      settings: { elements: [] },
    };
    const workspace = new Workspace(root);
    const record = await workspace.startSession('explorer');
    const config = parseConfig({ version: 1, app: { connect: { url: 'fake://home' } } });
    const session = new AgentSession(root, config, new Vars(), record.id, 'explorer', new FakeDriver(screens));
    const tools = explorerTools(session);
    const run = async (name: string, input: Record<string, unknown> = {}) => {
      const result = await tools.find((tool) => tool.name === name)!.run(input);
      expect(result.isError, JSON.stringify(result)).toBeFalsy();
      return result;
    };
    const save = (id: string) => run('save_routine', { id, description: id });
    await run('press', { key: 'Tab' });
    await save('a');
    if (screen === 'settings') screens.settings!.consoleErrors = ['Error: settings failed to load'];
    await run('tap', { ref: 'e1' });
    screens.settings!.consoleErrors = [];
    await save('b');
    screens.home!.consoleErrors = screen === 'home' ? ['Error: home failed to load'] : [];
    await run('open', { url: 'fake://home' });
    await save('c');
    screens.home!.consoleErrors = [];
    await run('tap', { ref: 'e1' });
    await save('d');
    // Flattening b, c, d removes the detour back home. The replay only
    // presses Tab (a) and taps Settings, so it cannot show the home error.
    const routine = await workspace.readRoutine('d');
    expect(routine?.requires).toEqual(['a']);
    expect(routine?.steps).toMatchObject([{ kind: 'tap' }]);
    expect(routine?.steps).toHaveLength(1);
    await run('open', { url: 'fake://home' });
    await save('e');
    await run('tap', { ref: 'e1' });
    await save('f');
    expect((await workspace.readRoutine('f'))?.steps).toHaveLength(1);
    const report = await tools
      .find((tool) => tool.name === 'report_bug')!
      .run({
        screen_id: 'unrecorded',
        title: 'Home logs a failure',
        what_is_wrong: 'Home failed to load',
        expected: 'Home loads without errors',
        severity: 'major',
        error: `${screen} failed to load`,
      });
    expect(Boolean(report.isError), 'only retained parent steps are replayable evidence').toBe(screen === 'home');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
