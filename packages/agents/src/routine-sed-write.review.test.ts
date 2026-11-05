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

it('keeps a sed substitution that writes the file consumed by the next routine step', async () => {
  const root = await mkdtemp(join(tmpdir(), 'routine-sed-write-'));
  const driver = new CliDriver({ cwd: root, timeoutMs: 5000 });
  try {
    await writeFile(join(root, 'input.txt'), 'old\n');
    await driver.connect();
    const config = parseConfig({ version: 1, app: { platform: 'cli' } });
    const workspace = new Workspace(root);
    const record = await workspace.startSession('explorer');
    const session = new AgentSession(root, config, new Vars(), record.id, 'explorer', driver);
    const tools = explorerTools(session);
    const run = (name: string, input: Record<string, unknown>) => tools.find((tool) => tool.name === name)!.run(input);
    const command = "sed -n 's/old/new/w output.txt' input.txt";
    expect((await run('run_command', { command })).isError).toBeFalsy();
    expect(await readFile(join(root, 'output.txt'), 'utf8')).toBe('new\n');
    expect((await run('run_command', { command: 'cat output.txt' })).isError).toBeFalsy();
    expect(
      (await run('save_routine', { id: 'read-generated-file', description: 'Generate and read a file' })).isError,
    ).toBeFalsy();
    await rm(join(root, 'output.txt'));
    expect((await run('run_routine', { id: 'read-generated-file' })).isError).toBeFalsy();
    expect((await driver.observe()).terminal!.output).toBe('new');
  } finally {
    await driver.close();
    await rm(root, { recursive: true, force: true });
  }
});
