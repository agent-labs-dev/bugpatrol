import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { CastRecorder } from './cast.js';

it('redacts a secret in an OSC hyperlink target before saving the cast', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cast-osc-secret-'));
  const secret = 'private-access-token';
  try {
    const cast = new CastRecorder({ width: 80, height: 24 }, (text) => text.replaceAll(secret, '{{TOKEN}}'));
    cast.start();
    cast.push(`\u001b]8;;https://example.com/download?token=${secret}\u001b\\Download\u001b]8;;\u001b\\`);
    const file = await cast.stop(join(root, 'repro'));
    expect(await readFile(file, 'utf8')).not.toContain(secret);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
