import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { CastRecorder, readCast, Terminal } from './cast.js';

it('does not expose a secret assembled by a TUI updating part of a field', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cast-screen-secret-'));
  const secret = 'private-token-1234';
  try {
    const recorder = new CastRecorder({ width: 80, height: 24 }, (value) => value.replaceAll(secret, '{{TOKEN}}'));
    recorder.start();
    recorder.push('private-token-0000');
    recorder.push('\u001b[15G1234');
    const cast = await readCast(await recorder.stop(join(dir, 'repro')));
    const playback = new Terminal(cast.width, cast.height);
    for (const [, output] of cast.events) playback.write(output);
    await playback.flush();
    expect(playback.screenText()).not.toContain(secret);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
