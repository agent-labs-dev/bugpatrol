import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '@bugpatrol/core';
import { createDriver } from '@bugpatrol/drivers';
import { expect, it } from 'vitest';
import { startApp } from './lifecycle.js';
import { runExplorer } from './roles/explorer.js';
import { AgentSession } from './session.js';
import type { Runtime } from './types.js';
import { Vars } from './vars.js';
import { Workspace } from './workspace.js';

it('reports a native app write blocked by its read-only proxy in the session summary and events', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bugpatrol-native-readonly-'));
  const config = parseConfig({
    version: 1,
    app: {
      platform: 'android',
      connect: { appId: 'com.example.app' },
      // A write must be blocked without connecting to the upstream.
      readOnly: { proxy: { API: 'http://127.0.0.1:9' } },
    },
    agents: { memory: { enabled: false } },
  });
  const vars = new Vars();
  const app = await startApp(config.app, { root, vars });
  try {
    const driver = createDriver(config, vars.resolveStrict.bind(vars), undefined, root, undefined, app.writes);
    const workspace = new Workspace(root);
    const record = await workspace.startSession('explorer');
    const session = new AgentSession(root, config, vars, record.id, 'explorer', driver);
    const runtime: Runtime = {
      label: 'scripted',
      async run() {
        // The app's network activity is independent of the native UI transport.
        const response = await fetch(`${vars.resolveStrict('{{API}}')}/items`, { method: 'POST' });
        expect(response.status).toBe(405);
        expect(app.writes?.count).toBe(1);
        return { stop: 'done', steps: 1, costUsd: 0, summary: 'Tested the app.' };
      },
    };
    const outcome = await runExplorer(session, runtime);
    expect(outcome.summary).toContain('Read-only mode blocked 1 write(s).');
    expect((await workspace.readEvents(record.id)).filter((event) => event.kind === 'write-blocked')).toHaveLength(1);
  } finally {
    await app.stop();
    await rm(root, { recursive: true, force: true });
  }
});
