import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { CliDriver } from './cli.js';

it('answers a TUI cursor-position query through the pty', { timeout: 15000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'terminal-query-'));
  const driver = new CliDriver({ cwd: root, timeoutMs: 5000 });
  try {
    await writeFile(
      join(root, 'query.py'),
      [
        'import os, select, tty',
        'tty.setraw(0)',
        "os.write(1, b'\\x1b[6n')",
        'ready, _, _ = select.select([0], [], [], 2)',
        "answer = os.read(0, 128) if ready else b''",
        "os.write(1, b'query-ok' if answer == b'\\x1b[1;1R' else b'query-unanswered')",
      ].join('\n'),
    );
    await driver.connect();
    await driver.act({ kind: 'session', op: 'start', command: 'python3 -I query.py' });
    await driver.act({ kind: 'session', op: 'wait', text: 'query-', timeoutMs: 4000 });
    expect((await driver.observe()).terminal?.output).toContain('query-ok');
  } finally {
    await driver.close();
    await rm(root, { recursive: true, force: true });
  }
});
