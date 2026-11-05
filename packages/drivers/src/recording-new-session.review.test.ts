import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { readCast, Terminal } from './cast.js';
import { CliDriver } from './cli.js';

it('records a newly started interactive program on the same blank terminal that observe uses', async () => {
  const root = await mkdtemp(join(tmpdir(), 'recording-new-session-'));
  const driver = new CliDriver({ cwd: root, timeoutMs: 3000 });
  try {
    await writeFile(
      join(root, 'app.cjs'),
      String.raw`
process.stdin.setRawMode(true);
process.stdout.write('Status: ready');
process.stdin.on('data', () => process.stdout.write('\x1b[1;1HStatus: saved'));
`,
    );
    await driver.connect();
    await driver.startRecording();
    await driver.act({ kind: 'run', command: 'printf "inspecting source\\n"' });
    await driver.act({ kind: 'session', op: 'start', command: 'node app.cjs' });
    expect(await driver.act({ kind: 'session', op: 'wait', text: 'Status: ready', timeoutMs: 2000 })).toMatchObject({
      ok: true,
    });
    await driver.act({ kind: 'session', op: 'keys', keys: ['s'] });
    expect(await driver.act({ kind: 'session', op: 'wait', text: 'Status: saved', timeoutMs: 2000 })).toMatchObject({
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
