import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { CliDriver } from './cli.js';

it('uses the new cursor mode for a later key in the same press', async () => {
  const root = await mkdtemp(join(tmpdir(), 'keys-mode-transition-'));
  const driver = new CliDriver({ cwd: root, timeoutMs: 3000 });
  try {
    await writeFile(
      join(root, 'app.cjs'),
      `
process.stdin.setRawMode(true);
let opened = false;
process.stdin.on('data', (bytes) => {
  if (!opened) {
    opened = true;
    process.stdout.write('\\x1b[?1hPicker opened\\r\\n');
  } else {
    process.stdout.write(bytes.toString() === '\\x1bOA' ? 'up-recognized' : 'wrong-key');
  }
});
process.stdout.write('ready');
`,
    );
    await driver.connect();
    await driver.act({ kind: 'session', op: 'start', command: 'node app.cjs' });
    expect(await driver.act({ kind: 'session', op: 'wait', text: 'ready', timeoutMs: 2000 })).toMatchObject({
      ok: true,
    });
    // Escape's existing gap gives the app ample time to enter its picker's cursor mode.
    await driver.act({ kind: 'session', op: 'keys', keys: ['escape', 'up'] });
    await driver.act({ kind: 'session', op: 'wait', text: 'recognized', timeoutMs: 500 });
    expect((await driver.observe()).terminal!.output).toContain('up-recognized');
  } finally {
    await driver.close();
    await rm(root, { recursive: true, force: true });
  }
});
