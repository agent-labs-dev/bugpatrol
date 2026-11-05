import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { CliDriver } from './cli.js';

it('finishes a session when a daemon inherits the helper control descriptor', { timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'inherited-control-'));
  const driver = new CliDriver({ cwd: root, timeoutMs: 3000 });
  // A daemon detaches and redirects standard I/O, but knows nothing about
  // Bugpatrol's private descriptor 3. It must not keep helper.closed pending.
  const daemon = [
    'import os, time',
    'os.setsid()',
    'null = os.open("/dev/null", os.O_RDWR)',
    'for fd in range(3): os.dup2(null, fd)',
    'os.close(null)',
    'open("daemon.pid", "w").write(str(os.getpid()))',
    'time.sleep(30)',
  ].join('\n');
  try {
    await driver.connect();
    await driver.act({
      kind: 'session',
      op: 'start',
      command: `python3 -c '${daemon}' & while [ ! -f daemon.pid ]; do sleep 0.02; done; echo leader-exited`,
    });
    expect(await driver.act({ kind: 'session', op: 'wait', text: 'leader-exited', timeoutMs: 3000 })).toMatchObject({
      ok: true,
    });
    let code: number | undefined;
    for (let attempt = 0; attempt < 40 && code === undefined; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      code = (await driver.observe()).terminal?.exitCode;
    }
    expect(code, 'an inherited control pipe prevents the exited helper from closing').toBe(0);
  } finally {
    const pid = await readFile(join(root, 'daemon.pid'), 'utf8').catch(() => undefined);
    try {
      if (pid) process.kill(Number(pid), 'SIGKILL');
    } catch {}
    await driver.close();
    await rm(root, { recursive: true, force: true });
  }
});
