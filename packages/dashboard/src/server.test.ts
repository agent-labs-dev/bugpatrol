import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveArtifactPath } from './server.js';

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
