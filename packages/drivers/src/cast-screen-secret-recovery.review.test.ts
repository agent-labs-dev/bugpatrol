import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { CastRecorder, readCast, Terminal } from './cast.js';

it('removes a screen-assembled secret from the saved output rather than drawing over it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cast-secret-recovery-'));
  const secret = 'private-token-1234';
  try {
    const recorder = new CastRecorder({ width: 80, height: 24 }, (value) => value.replaceAll(secret, '{{TOKEN}}'));
    recorder.start();
    recorder.push('private-token-0000');
    recorder.push('\u001b[15G1234');
    const cast = await readCast(await recorder.stop(join(dir, 'repro')));
    const playback = new Terminal(cast.width, cast.height);
    // A saved cast can be played byte by byte; a later erase cannot retract leaked output.
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

it('does not retain a screen-assembled secret in the recording scrollback', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cast-secret-scrollback-'));
  const secret = 'private-token-1234';
  try {
    const recorder = new CastRecorder({ width: 80, height: 5 }, (value) => value.replaceAll(secret, '{{TOKEN}}'));
    recorder.start();
    recorder.push('private-token-0000');
    recorder.push(`\u001b[15G1234${'\r\npublic line'.repeat(6)}`);
    const cast = await readCast(await recorder.stop(join(dir, 'repro')));
    const playback = new Terminal(cast.width, cast.height);
    for (const [, output] of cast.events) playback.write(output);
    await playback.flush();
    expect(playback.text()).not.toContain(secret);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
