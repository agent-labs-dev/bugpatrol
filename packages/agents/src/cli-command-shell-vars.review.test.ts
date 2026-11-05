import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '@bugpatrol/core';
import { createDriver, type Driver } from '@bugpatrol/drivers';
import { expect, it } from 'vitest';
import { Vars } from './vars.js';

it('starts a configured CLI command that expands a shell-local variable', { timeout: 15000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'cli-command-shell-vars-'));
  const config = parseConfig({
    version: 1,
    app: {
      platform: 'cli',
      connect: { cli: { command: 'label=from-shell; printf "%s\\n" "${label}"; sleep 30' } },
    },
  });
  const vars = new Vars([], {});
  let driver: Driver | undefined;
  try {
    // This is the resolver passed by runAgentCommand, runPatrol and review's withBuild.
    driver = createDriver(config, vars.resolveStrict.bind(vars), (text) => vars.redact(text) as string, root);
    await driver.connect();
    expect(await driver.act({ kind: 'session', op: 'wait', text: 'from-shell', timeoutMs: 4000 })).toMatchObject({
      ok: true,
    });
    expect((await driver.observe()).terminal?.output).toContain('from-shell');
  } finally {
    await driver?.close();
    await rm(root, { recursive: true, force: true });
  }
});
