import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
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

it('keeps the writes of a cli app from its backend, and reports each one', { timeout: 30_000 }, async () => {
  const seen: string[] = [];
  const backend = createServer((request, response) => {
    seen.push(`${request.method} ${request.url}`);
    response.end('ok');
  });
  await new Promise<void>((done) => backend.listen(0, '127.0.0.1', done));
  const root = await mkdtemp(join(tmpdir(), 'bugpatrol-readonly-'));
  const logs: string[] = [];
  const config = parseConfig({
    version: 1,
    app: {
      platform: 'cli',
      source: '.',
      readOnly: { proxy: { API_URL: `http://127.0.0.1:${(backend.address() as AddressInfo).port}/v1` } },
      connect: { cli: { env: { API_URL: '{{API_URL}}' } } },
    },
  });
  const vars = new Vars();
  const app = await startApp(config.app, { root, vars, emit: (line) => logs.push(line) });
  const driver = createDriver(config, vars.resolveStrict.bind(vars), undefined, root, undefined, app.writes);
  try {
    await driver.connect();
    const record = await new Workspace(root).startSession('explorer');
    const session = new AgentSession(root, config, vars, record.id, 'explorer', driver);
    const outputs: string[] = [];
    const runtime: Runtime = {
      label: 'scripted',
      async run(task) {
        const tool = (name: string) => task.tools.find((each) => each.name === name)!;
        const post = `node -e "fetch(process.env.API_URL + '/items?token=t0k', { method: 'POST' }).then((r) => console.log(r.status))"`;
        for (const command of [
          `node -e "fetch(process.env.API_URL + '/items').then((r) => console.log(r.status))"`,
          post,
        ]) {
          const result = await tool('run_command').run({ command });
          outputs.push(result.content.map((part) => (part.type === 'text' ? part.text : '')).join(''));
        }
        // The count adds up across steps.
        await tool('run_command').run({ command: post.replace('console.log(r.status)', '0') });
        await tool('finish').run({ summary: 'Looked at the items.' });
        return { stop: 'done', steps: 3, costUsd: 0, summary: 'Looked at the items.' };
      },
    };
    const outcome = await runExplorer(session, runtime);
    expect(seen).toEqual(['GET /v1/items']);
    expect(outputs[0]).toContain('200');
    expect(outputs[1]).toContain('405');
    expect(outputs[1]).toMatch(
      /Writes blocked by read-only mode[^\n]*:\n- POST http:\/\/127\.0\.0\.1:\d+\/v1\/items\?token=\[redacted\]/,
    );
    expect(outcome.summary).toContain('Read-only mode blocked 2 write(s).');
    const events = await session.workspace.readEvents(record.id);
    expect(events.filter((event) => event.kind === 'write-blocked')).toHaveLength(2);
    expect((await session.workspace.readSession(record.id))?.writesBlocked).toBe(2);
    expect(logs.some((line) => line.startsWith('Read-only: {{API_URL}} is http://127.0.0.1:'))).toBe(true);
  } finally {
    await driver.close();
    await app.stop();
    backend.closeAllConnections();
    await new Promise((done) => backend.close(done));
    await rm(root, { recursive: true, force: true });
  }
});
