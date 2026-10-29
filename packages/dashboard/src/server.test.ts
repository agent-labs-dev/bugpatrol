import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeCoverageFixture } from './fixtures/coverage.js';
import { resolveArtifactPath, startDashboard } from './server.js';

let root: string;
let outside: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bugpatrol-dash-'));
  outside = mkdtempSync(join(tmpdir(), 'bugpatrol-secret-'));
  mkdirSync(join(root, '.bugpatrol', 'runs', 'latest'), { recursive: true });
  writeFileSync(join(root, '.bugpatrol', 'runs', 'latest', 'shot.png'), 'png');
  writeFileSync(join(root, '.bugpatrol', 'runs', 'latest', 'run.json'), '{}');
  writeFileSync(join(root, '.bugpatrol', 'notes.txt'), 'plain text');
  writeFileSync(join(root, '.env'), 'SECRET=1');
  writeFileSync(join(outside, 'id_rsa'), 'PRIVATE KEY');
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe('resolveArtifactPath', () => {
  it('serves an artifact inside .bugpatrol', () => {
    expect(resolveArtifactPath(root, '.bugpatrol/runs/latest/shot.png')).toBeDefined();
  });

  it('rejects a relative traversal out of the project', () => {
    expect(resolveArtifactPath(root, '../../../etc/passwd')).toBeUndefined();
  });

  it('rejects a traversal that starts inside .bugpatrol', () => {
    expect(resolveArtifactPath(root, '.bugpatrol/runs/../../../etc/passwd')).toBeUndefined();
  });

  it('rejects an absolute path', () => {
    expect(resolveArtifactPath(root, join(outside, 'id_rsa'))).toBeUndefined();
  });

  it('rejects a file inside the project but outside .bugpatrol', () => {
    // The project root holds .env and source; only the artifact directory is served.
    expect(resolveArtifactPath(root, '.env')).toBeUndefined();
  });

  it('serves the recordings of a review', () => {
    for (const name of ['clip.mp4', 'clip.webm', 'clip.gif', 'clip.cast']) {
      writeFileSync(join(root, '.bugpatrol', 'runs', 'latest', name), 'x');
      expect(resolveArtifactPath(root, `.bugpatrol/runs/latest/${name}`)).toBeDefined();
    }
  });

  it('serves the diff of a fix attempt', () => {
    mkdirSync(join(root, '.bugpatrol', 'runs', 'fixes', 'fix_a'), { recursive: true });
    writeFileSync(join(root, '.bugpatrol', 'runs', 'fixes', 'fix_a', 'attempt-1.diff'), 'diff --git a/x b/x');
    expect(resolveArtifactPath(root, '.bugpatrol/runs/fixes/fix_a/attempt-1.diff')).toBeDefined();
  });

  it('rejects a diff outside .bugpatrol', () => {
    writeFileSync(join(outside, 'secret.diff'), 'diff');
    expect(resolveArtifactPath(root, join(outside, 'secret.diff'))).toBeUndefined();
    expect(resolveArtifactPath(root, `.bugpatrol/../../${outside.split('/').pop()}/secret.diff`)).toBeUndefined();
  });

  it('rejects a non-artifact extension even inside .bugpatrol', () => {
    expect(resolveArtifactPath(root, '.bugpatrol/notes.txt')).toBeUndefined();
  });

  it('rejects a symlink that escapes the artifact directory', () => {
    // Containment is checked on the RESOLVED path, so a symlink pointing at a
    // key outside the tree does not become a readable "artifact".
    const link = join(root, '.bugpatrol', 'escape.png');
    symlinkSync(join(outside, 'id_rsa'), link);
    expect(resolveArtifactPath(root, '.bugpatrol/escape.png')).toBeUndefined();
  });

  it('rejects a directory', () => {
    expect(resolveArtifactPath(root, '.bugpatrol/runs')).toBeUndefined();
  });

  it('rejects a path that does not exist', () => {
    expect(resolveArtifactPath(root, '.bugpatrol/runs/latest/missing.png')).toBeUndefined();
  });
});

describe('GET /api/coverage', () => {
  it('coverage route reads coverage.json', async () => {
    const dashboard = await startDashboard({ root, port: 0 });
    try {
      const get = (path: string) => fetch(`${dashboard.url}${path}`);
      // Before the first sweep, the UI hides the tab.
      expect((await (await get('/api/state')).json()).hasCoverage).toBe(false);
      expect((await get('/api/coverage')).status).toBe(404);

      writeCoverageFixture(root);
      expect((await (await get('/api/state')).json()).hasCoverage).toBe(true);
      const matrix = await (await get('/api/coverage')).json();
      // A status column only for a status that a case got and the contract declares.
      expect(matrix.cases).toEqual([
        'ok',
        'declared:401',
        'declared:404',
        'declared:422',
        'no-auth',
        'invalid-input',
        'missing-id',
        'other-user',
        'repeat-delete',
      ]);
      expect(matrix.endpoints).toContain('POST /notify');
      expect(matrix.remaining).toBe(2);
      const cells = matrix.cells;
      expect(cells['GET /items/{id} invalid-input']).toMatchObject({ state: 'fail', status: 500 });
      expect(cells['GET /items/{id} missing-id']).toMatchObject({ state: 'fail', status: 404 });
      expect(cells['GET /items/{id} declared:404']).toBeUndefined();
      expect(cells['GET /events ok']).toMatchObject({
        state: 'blocked',
        reason: expect.stringContaining('event stream'),
      });
      expect(cells['POST /notify ok']).toEqual({ state: 'skip', reason: 'the spec marks it x-bugpatrol-skip' });
      expect(cells['GET /export ok']).toEqual({ state: 'untested' });

      // A click on a cell opens its exchange through the exchange route.
      const text = await (
        await get(`/api/exchange?path=${encodeURIComponent(cells['GET /items/{id} invalid-input'].exchange)}`)
      ).text();
      expect(text).toMatch(/^GET \/items\/0/);
      expect(text).toContain('HTTP 500');
    } finally {
      await dashboard.close();
    }
  });
});
