import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '@bugpatrol/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runExplorer } from './roles/explorer.js';
import { AgentSession } from './session.js';
import { FakeDriver } from './testing/fake-driver.js';
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
  await runExplorer(session, runtime);
  return { system: systems[0]!, logs };
}

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
});
