import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { CliDriver } from './cli.js';

it('kills remaining process-group members after the session leader exits', { timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'natural-exit-cleanup-'));
  const driver = new CliDriver({ cwd: root, timeoutMs: 3000 });
  let pid: number | undefined;
  try {
    await driver.connect();
    // A child that ignores HUP and closes its terminal descriptors survives
    // the shell's normal exit unless the helper cleans up the process group.
    await driver.act({
      kind: 'session',
      op: 'start',
      command:
        "trap '' HUP; (while [ ! -f go.txt ]; do sleep 0.02; done; echo leaked > leaked.txt) </dev/null >/dev/null 2>&1 3>&- & echo $!",
    });
    let exited = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      const observation = await driver.observe();
      if (observation.terminal?.exitCode !== undefined) {
        pid = Number(observation.terminal.output.trim());
        exited = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(exited).toBe(true);
    await driver.close();
    await writeFile(join(root, 'go.txt'), 'continue');
    await new Promise((resolve) => setTimeout(resolve, 300));
    const leaked = await readFile(join(root, 'leaked.txt'), 'utf8').catch(() => undefined);
    expect(leaked, 'a child kept running and writing after close completed').toBeUndefined();
  } finally {
    if (pid) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
    await driver.close();
    await rm(root, { recursive: true, force: true });
  }
});
