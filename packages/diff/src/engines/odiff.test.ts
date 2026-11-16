import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { diffWithOdiff, OdiffUnavailableError, summarizeLoaderError } from './odiff.js';

// What the loader actually printed on a glibc 2.36 host: one line per library,
// each carrying two absolute paths.
const LOADER_DUMP = [
  "/w/node_modules/odiff-bin/bin/odiff.exe: /lib/x86_64-linux-gnu/libm.so.6: version `GLIBC_2.38' not found (required by /w/node_modules/odiff-bin/bin/odiff.exe)",
  "/w/node_modules/odiff-bin/bin/odiff.exe: /lib/x86_64-linux-gnu/libc.so.6: version `GLIBC_2.38' not found (required by /w/node_modules/odiff-bin/bin/odiff.exe)",
].join('\n');

describe('summarizeLoaderError', () => {
  it('reduces a loader dump to the one fact that matters', () => {
    expect(summarizeLoaderError(new Error(LOADER_DUMP))).toBe(
      "needs GLIBC_2.38, which this system's C library does not provide",
    );
  });

  it('explains other failure shapes in plain words', () => {
    expect(summarizeLoaderError(new Error('spawn odiff ENOENT'))).toBe('binary not found');
    expect(
      summarizeLoaderError(
        new Error(
          'odiff-bin: could not find the odiff binary. The "@odiff/linux-x64" package should have been installed automatically as an optional dependency of odiff-bin.',
        ),
      ),
    ).toBe('binary not found');
    expect(summarizeLoaderError(new Error('Exec format error'))).toBe('built for a different CPU architecture');
  });

  it('keeps the error to one line and the raw dump on the cause', () => {
    const cause = new Error(LOADER_DUMP);
    const error = new OdiffUnavailableError(cause);
    expect(error.message).not.toContain('\n');
    expect(error.message).not.toContain('/lib/');
    expect(error.cause).toBe(cause);
  });
});

describe('diffWithOdiff', () => {
  let dir: string;

  function writePng(name: string, red: boolean): string {
    const png = new PNG({ width: 40, height: 40 });
    png.data.fill(255);
    if (red) {
      for (let y = 10; y < 20; y++) {
        for (let x = 10; x < 20; x++) {
          const i = (y * 40 + x) * 4;
          png.data[i + 1] = 0;
          png.data[i + 2] = 0;
        }
      }
    }
    const path = join(dir, name);
    writeFileSync(path, PNG.sync.write(png));
    return path;
  }

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'bugpatrol-odiff-'));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('compares without masks and with a mask covering the change', async () => {
    const baselinePath = writePng('a.png', false);
    const actualPath = writePng('b.png', true);

    const unmasked = await diffWithOdiff({ baselinePath, actualPath });
    expect(unmasked.identical).toBe(false);
    expect(unmasked.changedPixels).toBe(100);

    const masked = await diffWithOdiff({
      baselinePath,
      actualPath,
      masks: [{ selector: '#banner', x: 5, y: 5, width: 20, height: 20 }],
    });
    expect(masked.identical).toBe(true);
  });
});
