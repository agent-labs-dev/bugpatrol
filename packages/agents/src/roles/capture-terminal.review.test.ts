import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '@bugpatrol/core';
import { CliDriver } from '@bugpatrol/drivers';
import { expect, it } from 'vitest';
import { AgentSession } from '../session.js';
import { Vars } from '../vars.js';
import { Workspace } from '../workspace.js';
import { beforeParts } from './capture.js';

it('includes the reported terminal transcript when comparing a PR or fix with its baseline', {
  timeout: 30_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'bugpatrol-compare-terminal-'));
  const driver = new CliDriver({ cwd: root, timeoutMs: 10_000, cols: 40, rows: 6 });
  try {
    await driver.connect();
    const workspace = new Workspace(root);
    const record = await workspace.startSession('explorer');
    const config = parseConfig({ version: 1, app: { platform: 'cli' } });
    const session = new AgentSession(root, config, new Vars(), record.id, 'explorer', driver);
    await driver.act({
      kind: 'run',
      command: `echo 'case empty: cost 0.0000672 (expected 0)'; for i in $(seq 1 30); do echo "case $i: ok"; done`,
    });
    const screenshot = await session.capture(await driver.observe(), 'reported');
    const terminal = session.lastTerminal!;
    expect(await readFile(join(root, terminal), 'utf8')).toContain('cost 0.0000672');
    const parts = await beforeParts(root, {
      capture: { before: screenshot },
      steps: [],
      reported: { kind: 'image', screenshot: screenshot!, terminal },
    });
    expect(parts.some((part) => part.type === 'image')).toBe(true);
    const text = parts.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n');
    expect(text).toContain('case empty: cost 0.0000672 (expected 0)');
  } finally {
    await driver.close();
    await rm(root, { recursive: true, force: true });
  }
});
