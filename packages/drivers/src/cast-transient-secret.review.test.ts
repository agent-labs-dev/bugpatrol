import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { CastRecorder, readCast, Terminal } from './cast.js';

it('removes a partial redraw that assembles and erases a secret within one output event', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cast-transient-secret-'));
  const secret = 'private-token-1234';
  try {
    const recorder = new CastRecorder({ width: 80, height: 24 }, (value) => value.replaceAll(secret, '{{TOKEN}}'));
    recorder.start();
    recorder.push('private-token-0000');
    recorder.push('\u001b[15G1234\r\u001b[2Kpublic');
    const cast = await readCast(await recorder.stop(join(dir, 'repro')));
    const playback = new Terminal(cast.width, cast.height);
    let revealed = false;
    for (const [, output] of cast.events) {
      for (const char of output) {
        playback.write(char);
        await playback.flush();
        revealed ||= playback.screenText().includes(secret);
      }
    }
    expect(revealed).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
