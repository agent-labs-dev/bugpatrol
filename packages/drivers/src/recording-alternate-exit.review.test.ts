import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { readCast, Terminal } from './cast.js';
import { CliDriver } from './cli.js';

it('restores the normal screen when a recording begins in the alternate screen', async () => {
  const root = await mkdtemp(join(tmpdir(), 'recording-alternate-exit-'));
  const driver = new CliDriver({ cwd: root, cols: 20, rows: 5, timeoutMs: 5000, command: 'node app.cjs' });
  try {
    await writeFile(
      join(root, 'app.cjs'),
      String.raw`
process.stdin.setRawMode(true);
process.stdout.write('Before TUI\r\n\x1b[?1049hInside TUI');
process.stdin.once('data', () => {
  process.stdout.write('\x1b[?1049lAfter TUI');
  process.exit(0);
});
`,
    );
    await driver.connect();
    expect(await driver.act({ kind: 'session', op: 'wait', text: 'Inside TUI', timeoutMs: 3000 })).toMatchObject({
      ok: true,
    });
    await driver.startRecording();
    await driver.act({ kind: 'session', op: 'keys', keys: ['j'] });
    expect(await driver.act({ kind: 'session', op: 'wait', text: 'After TUI', timeoutMs: 3000 })).toMatchObject({
      ok: true,
    });
    const actual = (await driver.observe()).terminal!.output;
    expect(actual).toContain('Before TUI');
    const cast = await readCast(await driver.stopRecording(join(root, 'review')));
    const playback = new Terminal(cast.width, cast.height);
    for (const [, text] of cast.events) playback.write(text);
    await playback.flush();
    expect(playback.screenText()).toBe(actual);
  } finally {
    await driver.close();
    await rm(root, { recursive: true, force: true });
  }
});
