import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '@bugpatrol/core';
import { CliDriver } from '@bugpatrol/drivers';
import { expect, it } from 'vitest';
import { AgentSession } from './session.js';
import { Vars } from './vars.js';
import { Workspace } from './workspace.js';

it('keeps early failures in the complete terminal evidence of a long command', { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'bugpatrol-full-output-'));
  const driver = new CliDriver({ cwd: root, timeoutMs: 10_000, cols: 40, rows: 6 });
  try {
    await driver.connect();
    const workspace = new Workspace(root);
    const record = await workspace.startSession('explorer');
    const config = parseConfig({ version: 1, app: { platform: 'cli' } });
    const session = new AgentSession(root, config, new Vars(), record.id, 'explorer', driver);
    // The command text itself does not contain the sentinel as one string.
    const result = await driver.act({
      kind: 'run',
      command: `python3 -c "print('EARLY_' + 'FAILURE'); [print('passing case', i) for i in range(10100)]"`,
    });
    expect(result.ok).toBe(true);
    await session.capture(await driver.observe(), 'long-command');
    const transcript = await readFile(join(root, session.lastTerminal!), 'utf8');
    expect(transcript).toContain('passing case 10099');
    expect(transcript.includes('EARLY_FAILURE'), 'complete output must keep failures before the scrollback limit').toBe(
      true,
    );
  } finally {
    await driver.close();
    await rm(root, { recursive: true, force: true });
  }
});
