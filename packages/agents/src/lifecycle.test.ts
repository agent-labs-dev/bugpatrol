import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixtureApi } from '@bugpatrol/api-fixture';
import { appSchema, InfrastructureError } from '@bugpatrol/core';
import { describe, expect, it } from 'vitest';
import { startApp } from './lifecycle.js';
import { Vars } from './vars.js';

describe('startApp', () => {
  it('captures values for later commands and keeps a ready background process', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bugpatrol-life-'));
    const vars = new Vars();
    const emitted: string[] = [];
    try {
      const app = appSchema.parse({
        setup: [
          { run: 'echo "CDP :9624"', capture: { CDP_PORT: 'CDP :(\\d+)' } },
          { run: 'test "${CDP_PORT}" = 9624' },
          { run: 'echo READY; sleep 20', background: true, readyWhen: 'READY', timeoutMs: 1000 },
        ],
        teardown: [{ run: 'echo goodbye' }, { run: 'exit 2' }],
      });
      const running = await startApp(app, { root, vars, emit: (line) => emitted.push(line) });
      expect(vars.resolve('{{CDP_PORT}}')).toBe('9624');
      await expect(running.stop()).resolves.toBeUndefined();
      expect(emitted.some((line) => line.includes('Teardown: ran'))).toBe(true);
      expect(emitted.some((line) => line.includes('failed'))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('loads the contract of an api app from the running app, after setup', async () => {
    const fixture = await startFixtureApi();
    try {
      const port = new URL(fixture.url).port;
      const app = appSchema.parse({
        platform: 'api',
        setup: [{ run: `echo "listening on ${port}"`, capture: { API_PORT: 'listening on (\\d+)' } }],
        connect: { url: 'http://127.0.0.1:{{API_PORT}}', spec: '/openapi.json' },
      });
      const running = await startApp(app, { root: process.cwd(), vars: new Vars() });
      expect(running.contract?.endpoints.map((endpoint) => endpoint.key)).toContain('POST /admin/wipe');
      expect(fixture.hits()).toEqual([{ method: 'GET', path: '/openapi.json' }]);
      // No spec and no inventory: a contract without endpoints, so only reads go out.
      const bare = appSchema.parse({ platform: 'api', connect: { url: fixture.url } });
      expect((await startApp(bare, { root: process.cwd(), vars: new Vars() })).contract?.endpoints).toEqual([]);
      expect((await startApp(appSchema.parse({}), { root: process.cwd(), vars: new Vars() })).contract).toBeUndefined();
    } finally {
      await fixture.close();
    }
  });

  it('redacts failure output', async () => {
    const vars = new Vars();
    vars.set('TOKEN', 'secret-value');
    const app = appSchema.parse({ setup: [{ run: 'echo secret-value; exit 3' }] });
    await expect(startApp(app, { root: process.cwd(), vars })).rejects.toBeInstanceOf(InfrastructureError);
    await expect(startApp(app, { root: process.cwd(), vars })).rejects.toThrow('{{TOKEN}}');
  });

  it('runs the teardown when a setup command fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bugpatrol-teardown-'));
    try {
      const app = appSchema.parse({
        setup: [{ run: 'echo up > state' }, { run: 'exit 2' }],
        teardown: [{ run: 'echo down > state' }],
      });
      await expect(startApp(app, { root, vars: new Vars() })).rejects.toBeInstanceOf(InfrastructureError);
      expect((await readFile(join(root, 'state'), 'utf8')).trim()).toBe('down');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('swaps only source commands into the worktree and sets BUGPATROL_SOURCE for every command', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bugpatrol-source-'));
    const source = join(root, 'source');
    const worktree = join(root, 'fix');
    const other = join(root, 'other');
    const { mkdir } = await import('node:fs/promises');
    try {
      await Promise.all([mkdir(source), mkdir(worktree), mkdir(other)]);
      const app = appSchema.parse({
        source: 'source',
        setup: [
          { run: 'pwd > source-cwd; echo "$BUGPATROL_SOURCE" > source-env', cwd: './source' },
          { run: 'pwd > other-cwd; echo "$BUGPATROL_SOURCE" > other-env', cwd: 'other' },
        ],
      });
      await (await startApp(app, { root, vars: new Vars(), source: worktree })).stop();
      expect((await readFile(join(worktree, 'source-cwd'), 'utf8')).trim()).toBe(await realpath(worktree));
      expect((await readFile(join(other, 'other-cwd'), 'utf8')).trim()).toBe(await realpath(other));
      expect((await readFile(join(other, 'other-env'), 'utf8')).trim()).toBe(worktree);
      await (await startApp(app, { root, vars: new Vars() })).stop();
      expect((await readFile(join(source, 'source-env'), 'utf8')).trim()).toBe(source);
      expect((await readFile(join(other, 'other-env'), 'utf8')).trim()).toBe(source);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
