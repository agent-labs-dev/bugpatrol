import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { CliDriver } from './cli.js';

it('ends a session whose leader exited while an escaped writer keeps printing', { timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'escaped-writer-'));
  const driver = new CliDriver({ cwd: root, timeoutMs: 3000 });
  // Leaves the process group, so the group kill misses it, and keeps the pty busy.
  const writer =
    'import os, time\nos.setsid()\nopen("writer.pid", "w").write(str(os.getpid()))\nwhile True:\n    print("x", flush=True)\n    time.sleep(0.01)';
  try {
    await driver.connect();
    await driver.act({
      kind: 'session',
      op: 'start',
      command: `python3 -c '${writer}' & sleep 0.3; echo leader-exiting`,
    });
    let exitCode: number | undefined;
    for (let attempt = 0; attempt < 60 && exitCode === undefined; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      exitCode = (await driver.observe()).terminal?.exitCode;
    }
    expect(exitCode, 'the session never ended while the escaped writer printed').toBe(0);
  } finally {
    const pid = await readFile(join(root, 'writer.pid'), 'utf8').catch(() => undefined);
    try {
      if (pid) process.kill(Number(pid), 'SIGKILL');
    } catch {
      // It died when the terminal closed under it.
    }
    await driver.close();
    await rm(root, { recursive: true, force: true });
  }
});
