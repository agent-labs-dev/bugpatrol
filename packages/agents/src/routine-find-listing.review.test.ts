import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '@bugpatrol/core';
import { CliDriver } from '@bugpatrol/drivers';
import { expect, it } from 'vitest';
import { AgentSession } from './session.js';
import { explorerTools } from './tools/explorer.js';
import { Vars } from './vars.js';
import { Workspace } from './workspace.js';

it('replays a find command that writes a listing read by the next step', { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'routine-find-listing-'));
  const driver = new CliDriver({ cwd: root, timeoutMs: 5000 });
  try {
    await writeFile(join(root, 'source.txt'), 'data\n');
    await driver.connect();
    const config = parseConfig({ version: 1, app: { platform: 'cli' } });
    const workspace = new Workspace(root);
    const record = await workspace.startSession('explorer');
    const session = new AgentSession(root, config, new Vars(), record.id, 'explorer', driver);
    const tools = explorerTools(session);
    const run = (name: string, input: Record<string, unknown>) => tools.find((tool) => tool.name === name)!.run(input);
    expect((await run('run_command', { command: 'find source.txt -fls listing.txt' })).isError).toBeFalsy();
    expect(await readFile(join(root, 'listing.txt'), 'utf8')).toContain('source.txt');
    expect((await run('run_command', { command: 'cat listing.txt' })).isError).toBeFalsy();
    expect(
      (await run('save_routine', { id: 'listing', description: 'Generate and read a listing' })).isError,
    ).toBeFalsy();
    await rm(join(root, 'listing.txt'));
    expect((await run('run_routine', { id: 'listing' })).isError).toBeFalsy();
    expect((await driver.observe()).terminal!.output).toContain('source.txt');
  } finally {
    await driver.close();
    await rm(root, { recursive: true, force: true });
  }
});
