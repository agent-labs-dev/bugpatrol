import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config/load.js';
import { findProjectRoot, instructionsPath, legacyLayout, moveRoutines, paths } from './paths.js';

function project(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'bugpatrol-paths-')));
  mkdirSync(join(root, '.bugpatrol'));
  writeFileSync(paths.config(root), 'version: 1\n');
  return root;
}

describe('paths', () => {
  it('keeps the config in .bugpatrol/ and all local data in .bugpatrol/runs/', () => {
    const root = '/repo';
    expect(paths.config(root)).toBe('/repo/.bugpatrol/bugpatrol.yml');
    for (const file of [
      paths.issue(root, 'i'),
      paths.session(root, 's'),
      paths.worktrees(root),
      paths.memory(root),
      paths.run(root, 'r'),
      paths.baselines(root),
      paths.publish(root),
    ]) {
      expect(file.startsWith('/repo/.bugpatrol/runs/')).toBe(true);
    }
  });

  it('keeps routines and the app map in .bugpatrol/, outside the gitignored run directory', () => {
    expect(paths.routine('/repo', 'enter-app')).toBe('/repo/.bugpatrol/routines/enter-app.json');
    expect(paths.routines('/repo')).toBe('/repo/.bugpatrol/routines');
    expect(paths.appMap('/repo')).toBe('/repo/.bugpatrol/appmap.json');
  });
});

describe('findProjectRoot', () => {
  it('finds the project from a subfolder, the way git does', () => {
    const root = project();
    mkdirSync(join(root, 'src', 'deep'), { recursive: true });
    expect(findProjectRoot(join(root, 'src', 'deep'))).toBe(root);
    expect(findProjectRoot(root)).toBe(root);
  });

  it('returns the start folder when no project is above it', () => {
    const start = realpathSync(mkdtempSync(join(tmpdir(), 'bugpatrol-none-')));
    expect(findProjectRoot(start)).toBe(start);
  });
});

describe('instructionsPath', () => {
  it('uses app.instructions, else .bugpatrol/instructions.md when it exists', () => {
    const root = project();
    expect(instructionsPath(root)).toBeUndefined();
    writeFileSync(join(root, '.bugpatrol', 'instructions.md'), '# App\n');
    expect(instructionsPath(root)).toBe(join(root, '.bugpatrol', 'instructions.md'));
    expect(instructionsPath(root, 'docs/guide.md')).toBe(join(root, 'docs', 'guide.md'));
  });
});

describe('layout', () => {
  it('keeps .bughunters/bughunters.yml in a repo from before the rename', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'bugpatrol-legacy-')));
    mkdirSync(join(root, '.bughunters'));
    writeFileSync(join(root, '.bughunters', 'bughunters.yml'), 'version: 1\napp: { connect: { url: "http://x" } }\n');
    expect(paths.config(root)).toBe(join(root, '.bughunters', 'bughunters.yml'));
    expect(paths.memory(root)).toBe(join(root, '.bughunters', 'runs', 'memory.json'));
    mkdirSync(join(root, 'src'));
    expect(findProjectRoot(join(root, 'src'))).toBe(root);
    expect(loadConfig(root).app.connect?.url).toBe('http://x');
  });

  it('uses .bugpatrol/ when both folders have a config', () => {
    const root = project();
    mkdirSync(join(root, '.bughunters'));
    writeFileSync(join(root, '.bughunters', 'bughunters.yml'), 'version: 1\n');
    expect(paths.config(root)).toBe(join(root, '.bugpatrol', 'bugpatrol.yml'));
  });
});

describe('legacyLayout', () => {
  it('tells how to move a bughunters.yml at the root into .bugpatrol/', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'bugpatrol-old-')));
    expect(legacyLayout(root)).toBeUndefined();
    writeFileSync(join(root, 'bughunters.yml'), 'version: 1\n');
    expect(legacyLayout(root)).toContain('mv bughunters.yml .bugpatrol/bugpatrol.yml');
    expect(() => loadConfig(root)).toThrow(/now keeps its config in \.bugpatrol/);
  });
});

describe('moveRoutines', () => {
  it('moves routines and the app map out of the run directory once, and says so', () => {
    const root = project();
    const old = join(root, '.bugpatrol', 'runs');
    mkdirSync(join(old, 'routines'), { recursive: true });
    writeFileSync(join(old, 'routines', 'enter-app.json'), '{"id":"enter-app"}');
    writeFileSync(join(old, 'routines', 'open-settings.json'), '{"id":"open-settings"}');
    writeFileSync(join(old, 'appmap.json'), '{"screens":[]}');

    const message = moveRoutines(root);
    expect(message).toContain('Moved 2 routine(s) and the app map');
    expect(message).toContain('Commit them');
    expect(readFileSync(paths.routine(root, 'enter-app'), 'utf8')).toBe('{"id":"enter-app"}');
    expect(readFileSync(paths.appMap(root), 'utf8')).toBe('{"screens":[]}');
    expect(existsSync(join(old, 'routines'))).toBe(false);
    expect(existsSync(join(old, 'appmap.json'))).toBe(false);
    expect(moveRoutines(root)).toBeUndefined();
  });

  it('keeps a committed routine over an old copy with the same id', () => {
    const root = project();
    const old = join(root, '.bugpatrol', 'runs', 'routines');
    mkdirSync(old, { recursive: true });
    writeFileSync(join(old, 'enter-app.json'), 'old');
    mkdirSync(paths.routines(root));
    writeFileSync(paths.routine(root, 'enter-app'), 'committed');

    expect(moveRoutines(root)).toContain('Moved 0 routine(s)');
    expect(readFileSync(paths.routine(root, 'enter-app'), 'utf8')).toBe('committed');
    expect(existsSync(old)).toBe(false);
  });

  it('does nothing in a project with no old routines', () => {
    expect(moveRoutines(project())).toBeUndefined();
  });
});

it('rejects an id that is not one path segment at each file-backed record', () => {
  const readers = [
    paths.run,
    paths.session,
    paths.routine,
    paths.issue,
    paths.fix,
    paths.agentBaseline,
    paths.agentBaselineSnapshot,
  ];
  for (const reader of readers) {
    for (const value of ['../private', '/absolute', '..', '.', 'x/y', 'x\\y', 'x\0y', '']) {
      expect(() => reader('/project', value)).toThrow('Invalid workspace record');
    }
    for (const value of ['ses_20260927_ab12', '__start', 'settings.usage'])
      expect(reader('/project', value)).toContain(value);
  }
});
