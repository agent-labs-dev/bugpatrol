import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '@bugpatrol/core';
import { createDriver } from '@bugpatrol/drivers';
import { expect, it } from 'vitest';
import { startApp } from './lifecycle.js';
import { runExplorer } from './roles/explorer.js';
import { AgentSession } from './session.js';
import { Vars } from './vars.js';
import { Workspace } from './workspace.js';

it('reports writes blocked while replaying a routine with assertions', { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'bugpatrol-routine-writes-'));
  const config = parseConfig({
    version: 1,
    app: {
      platform: 'cli',
      readOnly: { proxy: { API: 'http://127.0.0.1:9' } },
      connect: { cli: { env: { API: '{{API}}' } } },
    },
    agents: { memory: { enabled: false } },
  });
  const vars = new Vars();
  const app = await startApp(config.app, { root, vars });
  const driver = createDriver(config, vars.resolveStrict.bind(vars), undefined, root, undefined, app.writes);
  try {
    await driver.connect();
    const workspace = new Workspace(root);
    await workspace.saveRoutine({
      version: 1,
      id: 'blocked-write',
      platform: 'cli',
      description: 'Exercise a blocked backend write',
      steps: [
        {
          kind: 'run',
          command: `node -e "fetch(process.env.API + '/items', {method: 'POST'}).then(r => console.log(r.status))"`,
          assert: [{ kind: 'exit-code', value: 0 }],
        },
      ],
      createdAt: 'now',
      updatedAt: 'now',
    });
    const record = await workspace.startSession('explorer');
    const session = new AgentSession(root, config, vars, record.id, 'explorer', driver);
    let replayError = false;
    const outcome = await runExplorer(session, {
      label: 'scripted',
      async run(task) {
        const result = await task.tools.find((tool) => tool.name === 'run_routine')!.run({ id: 'blocked-write' });
        replayError = result.isError === true;
        return { stop: 'done', steps: 1, costUsd: 0, summary: 'Replayed the routine.' };
      },
    });
    expect(replayError).toBe(false);
    expect(app.writes?.count).toBe(1);
    expect(outcome.summary).toContain('Read-only mode blocked 1 write(s).');
    expect((await workspace.readEvents(record.id)).filter((event) => event.kind === 'write-blocked')).toHaveLength(1);
  } finally {
    await driver.close();
    await app.stop();
    await rm(root, { recursive: true, force: true });
  }
});
