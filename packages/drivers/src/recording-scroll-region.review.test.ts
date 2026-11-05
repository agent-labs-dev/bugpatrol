import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { readCast, Terminal } from './cast.js';
import { CliDriver } from './cli.js';

it('preserves an already running TUI scroll region when recording begins', async () => {
  const root = await mkdtemp(join(tmpdir(), 'recording-scroll-region-'));
  const driver = new CliDriver({ cwd: root, cols: 20, rows: 5, timeoutMs: 5000, command: 'node app.cjs' });
  try {
    await writeFile(
      join(root, 'app.cjs'),
      String.raw`
process.stdin.setRawMode(true);
process.stdout.write('\x1b[?1049h\x1b[?25l\x1b[1;1HHEADER\x1b[2;5r\x1b[5;1Hready');
process.stdin.on('data', () => process.stdout.write('\r\nupdated'));
`,
    );
    await driver.connect();
    expect(await driver.act({ kind: 'session', op: 'wait', text: 'ready', timeoutMs: 3000 })).toMatchObject({
      ok: true,
    });
    await driver.startRecording();
    await driver.act({ kind: 'session', op: 'keys', keys: ['j'] });
    expect(await driver.act({ kind: 'session', op: 'wait', text: 'updated', timeoutMs: 3000 })).toMatchObject({
      ok: true,
    });
    const actual = (await driver.observe()).terminal!.output;
    expect(actual).toContain('HEADER');
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
