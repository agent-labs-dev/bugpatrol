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

it('replays a git diff command that creates the file read by the next step', { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'routine-git-output-'));
  const driver = new CliDriver({ cwd: root, timeoutMs: 5000 });
  try {
    await writeFile(join(root, 'old.txt'), 'old\n');
    await writeFile(join(root, 'new.txt'), 'new\n');
    await driver.connect();
    const config = parseConfig({ version: 1, app: { platform: 'cli' } });
    const workspace = new Workspace(root);
    const record = await workspace.startSession('explorer');
    const session = new AgentSession(root, config, new Vars(), record.id, 'explorer', driver);
    const tools = explorerTools(session);
    const run = (name: string, input: Record<string, unknown>) => tools.find((tool) => tool.name === name)!.run(input);
    expect(
      (await run('run_command', { command: 'git --no-pager diff --no-index --output=output.diff old.txt new.txt' }))
        .isError,
    ).toBeFalsy();
    const patch = await readFile(join(root, 'output.diff'), 'utf8');
    expect(patch).toContain('+new');
    expect((await run('run_command', { command: 'cat output.diff' })).isError).toBeFalsy();
    expect(
      (await run('save_routine', { id: 'read-patch', description: 'Generate and read a patch' })).isError,
    ).toBeFalsy();
    await rm(join(root, 'output.diff'));
    expect((await run('run_routine', { id: 'read-patch' })).isError).toBeFalsy();
    expect((await driver.observe()).terminal!.output).toContain('+new');
  } finally {
    await driver.close();
    await rm(root, { recursive: true, force: true });
  }
});
