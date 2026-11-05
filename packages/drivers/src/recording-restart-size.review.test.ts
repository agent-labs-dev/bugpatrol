import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { readCast, Terminal } from './cast.js';
import { CliDriver } from './cli.js';

it('restores the recording size when a resized app exits and another starts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'recording-restart-size-'));
  const driver = new CliDriver({ cwd: root, timeoutMs: 3000 });
  try {
    await driver.connect();
    await driver.startRecording();
    await driver.act({ kind: 'session', op: 'start', command: 'echo ready; read answer' });
    expect(await driver.act({ kind: 'session', op: 'wait', text: 'ready', timeoutMs: 3000 })).toMatchObject({
      ok: true,
    });
    await driver.act({ kind: 'session', op: 'resize', cols: 40, rows: 10 });
    await driver.act({ kind: 'session', op: 'keys', keys: ['enter'] });
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((await driver.observe()).terminal?.exitCode !== undefined) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect((await driver.observe()).terminal?.exitCode).toBe(0);
    await driver.act({ kind: 'session', op: 'start', command: "printf '\\033[2J\\033[H'; printf '%080d' 0" });
    expect(await driver.act({ kind: 'session', op: 'wait', text: '00000000', timeoutMs: 3000 })).toMatchObject({
      ok: true,
    });
    const actual = await driver.observe();
    const cast = await readCast(await driver.stopRecording(join(root, 'restarted')));
    const playback = new Terminal(cast.width, cast.height);
    for (const [, text, kind] of cast.events) {
      if (kind === 'r') {
        await playback.flush();
        const [cols, rows] = text.split('x').map(Number);
        playback.resize(cols!, rows!);
      } else playback.write(text);
    }
    await playback.flush();
    expect({ cols: playback.cols, rows: playback.rows, text: playback.screenText() }).toEqual({
      cols: actual.viewport.width / 8,
      rows: actual.viewport.height / 16,
      text: actual.terminal!.output,
    });
  } finally {
    await driver.close();
    await rm(root, { recursive: true, force: true });
  }
});
