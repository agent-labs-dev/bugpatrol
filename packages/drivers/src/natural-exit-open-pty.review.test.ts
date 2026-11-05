import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { CliDriver } from './cli.js';

it('cleans up a surviving descendant even when it keeps its pty open', { timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'natural-open-pty-'));
  const driver = new CliDriver({ cwd: root, timeoutMs: 3000 });
  try {
    await driver.connect();
    await driver.act({
      kind: 'session',
      op: 'start',
      command:
        "trap '' HUP; (while [ ! -f go.txt ]; do sleep 0.02; done; echo leaked > leaked.txt) & echo leader-exiting",
    });
    // Allow the short-lived shell to exit. Its child deliberately keeps the
    // terminal descriptors, as normal background processes do.
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((await driver.observe()).terminal?.output.includes('leader-exiting')) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect((await driver.observe()).terminal?.output).toContain('leader-exiting');
    await new Promise((resolve) => setTimeout(resolve, 500));
    await writeFile(join(root, 'go.txt'), 'continue');
    await new Promise((resolve) => setTimeout(resolve, 300));
    const leaked = await readFile(join(root, 'leaked.txt'), 'utf8').catch(() => undefined);
    expect(leaked, 'a descendant kept running after the session leader exited naturally').toBeUndefined();
  } finally {
    await driver.close();
    await rm(root, { recursive: true, force: true });
  }
});
