import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { readCast, Terminal } from './cast.js';
import { CliDriver } from './cli.js';

it('includes the already running configured TUI screen when a review starts recording', async () => {
  const root = await mkdtemp(join(tmpdir(), 'recording-initial-screen-'));
  const driver = new CliDriver({ cwd: root, timeoutMs: 5000, command: 'node app.cjs' });
  try {
    await writeFile(
      join(root, 'app.cjs'),
      `process.stdin.setRawMode(true);
process.stdout.write('\\x1b[?1049h\\x1b[?25lInvoice manager\\r\\nStatus: ready');
process.stdin.on('data', () => process.stdout.write('\\x1b[2;1HStatus: saved'));
`,
    );
    await driver.connect();
    expect(await driver.act({ kind: 'session', op: 'wait', text: 'Status: ready', timeoutMs: 3000 })).toMatchObject({
      ok: true,
    });
    // Claim review starts recording after connecting, then replays keys in the configured app.
    await driver.startRecording();
    await driver.act({ kind: 'session', op: 'keys', keys: ['s'] });
    expect(await driver.act({ kind: 'session', op: 'wait', text: 'Status: saved', timeoutMs: 3000 })).toMatchObject({
      ok: true,
    });
    const actual = (await driver.observe()).terminal!.output;
    const cast = await readCast(await driver.stopRecording(join(root, 'review')));
    const playback = new Terminal(cast.width, cast.height);
    for (const [, text, kind] of cast.events) {
      if (kind === 'r') {
        await playback.flush();
        const [cols, rows] = text.split('x').map(Number);
        playback.resize(cols!, rows!);
      } else playback.write(text);
    }
    await playback.flush();
    expect(playback.screenText()).toBe(actual);
  } finally {
    await driver.close();
    await rm(root, { recursive: true, force: true });
  }
});
