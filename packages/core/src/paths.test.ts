import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config/load.js';
import {
  adoptHint,
  adoptSharedFiles,
  agentFiles,
  findProjectRoot,
  instructionsPath,
  legacyLayout,
  moveRoutines,
  paths,
  profileOf,
  stateFile,
} from './paths.js';

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

describe('profiles', () => {
  it('keeps the committed files of the default config where they were, and of another config in its own folder', () => {
    const root = project();
    const yaml = 'version: 1\nrun: { command: pnpm dev, url: http://localhost:3000 }\n';
    writeFileSync(paths.config(root), yaml);
    // A `profile:` key in the YAML is not read: the file name decides.
    writeFileSync(join(root, '.bugpatrol', 'cli.yml'), `${yaml}profile: other\n`);
    expect(profileOf(root)).toBeUndefined();
    expect(profileOf(root, '.bugpatrol/bugpatrol.yml')).toBeUndefined();
    const profile = profileOf(root, '.bugpatrol/cli.yml');
    expect(profile).toBe('cli');
    expect(loadConfig(root, {}, '.bugpatrol/cli.yml').profile).toBe('cli');
    expect(loadConfig(root).profile).toBeUndefined();
    expect(paths.appMap(root, profile)).toBe(join(root, '.bugpatrol', 'cli', 'appmap.json'));
    expect(paths.routine(root, 'enter-app', profile)).toBe(
      join(root, '.bugpatrol', 'cli', 'routines', 'enter-app.json'),
    );
    expect(paths.endpointInventory(root, profile)).toBe(join(root, '.bugpatrol', 'cli', 'endpoints.yml'));
    expect(paths.appMap(root)).toBe(join(root, '.bugpatrol', 'appmap.json'));
    expect(paths.memory(root)).toBe(join(root, '.bugpatrol', 'runs', 'memory.json'));
  });

  it('keeps the run state of another config in its own folder of the gitignored run directory', () => {
    const root = '/repo';
    const own = '/repo/.bugpatrol/runs/profiles/cli/';
    for (const file of [
      paths.issue(root, 'i', 'cli'),
      paths.fix(root, 'f', 'cli'),
      paths.session(root, 's', 'cli'),
      paths.sessionDecisions(root, 's', 'cli'),
      paths.memory(root, 'cli'),
      paths.triage(root, 'cli'),
      paths.agents(root, 'cli'),
      paths.worktrees(root, 'cli'),
      paths.review(root, 7, 'cli'),
      paths.stateBase(root, 'cli'),
    ])
      expect(file.startsWith(own)).toBe(true);
    // The default config keeps the paths it always had.
    expect(paths.issue(root, 'i')).toBe('/repo/.bugpatrol/runs/issues/i.json');
    expect(paths.memory(root)).toBe('/repo/.bugpatrol/runs/memory.json');
    // The state branch paths of a profile land in its two folders.
    expect(stateFile(root, 'appmap.json', 'cli')).toBe('/repo/.bugpatrol/cli/appmap.json');
    expect(stateFile(root, 'runs/issues/i.json', 'cli')).toBe(`${own}issues/i.json`);
    expect(stateFile(root, 'runs/issues/i.json')).toBe('/repo/.bugpatrol/runs/issues/i.json');
  });

  it('refuses a config name that would take a folder Bugpatrol uses, in any letter case', () => {
    const root = project();
    expect(() => profileOf(root, '.bugpatrol/runs.yml')).toThrow(/cannot use as a folder/);
    expect(() => profileOf(root, '.bugpatrol/routines.yml')).toThrow(/cannot use as a folder/);
    // macOS and Windows would resolve these to runs/ and routines/.
    expect(() => profileOf(root, '.bugpatrol/Runs.yml')).toThrow(/cannot use as a folder/);
    expect(() => profileOf(root, '.bugpatrol/Routines.yml')).toThrow(/cannot use as a folder/);
  });

  it('moves the shared app map, routines and endpoints into a profile only when adopted', () => {
    const root = project();
    // A repo that used only `--config .bugpatrol/api.yml` before profiles: no default config.
    rmSync(paths.config(root));
    mkdirSync(paths.routines(root), { recursive: true });
    writeFileSync(paths.appMap(root), '{}');
    writeFileSync(paths.endpointInventory(root), 'endpoints: []');
    writeFileSync(paths.routine(root, 'enter-app'), '{}');
    expect(adoptHint(root, 'api', '.bugpatrol/api.yml')).toMatch(/bugpatrol adopt --config \.bugpatrol\/api\.yml/);
    expect(existsSync(paths.appMap(root))).toBe(true);
    expect(adoptSharedFiles(root, 'api')).toMatch(/Moved the app map/);
    expect(existsSync(join(root, '.bugpatrol', 'api', 'appmap.json'))).toBe(true);
    expect(existsSync(join(root, '.bugpatrol', 'api', 'routines', 'enter-app.json'))).toBe(true);
    expect(existsSync(join(root, '.bugpatrol', 'api', 'endpoints.yml'))).toBe(true);
    expect(adoptHint(root, 'api', '.bugpatrol/api.yml')).toBeUndefined();
    expect(adoptSharedFiles(root, 'api')).toMatch(/Nothing to adopt/);
  });

  it('gives no adopt hint while a default config owns the shared files', () => {
    const root = project();
    writeFileSync(paths.appMap(root), '{}');
    expect(adoptHint(root, 'cli', '.bugpatrol/cli.yml')).toBeUndefined();
    expect(adoptHint(root, undefined, '.bugpatrol/bugpatrol.yml')).toBeUndefined();
  });

  it('lists the app maps and routine folders of every profile, and nothing in runs/', () => {
    const root = project();
    mkdirSync(join(root, '.bugpatrol', 'cli'));
    mkdirSync(join(root, '.bugpatrol', 'runs'));
    mkdirSync(paths.routines(root), { recursive: true });
    expect(agentFiles(root).sort()).toEqual(
      [paths.routines(root), paths.appMap(root), paths.routines(root, 'cli'), paths.appMap(root, 'cli')].sort(),
    );
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
  it('uses app.instructions, which is required, else .bugpatrol/instructions.md', () => {
    const root = project();
    expect(instructionsPath(root)).toEqual({ path: join(root, '.bugpatrol', 'instructions.md'), required: false });
    expect(instructionsPath(root, 'docs/guide.md')).toEqual({ path: join(root, 'docs', 'guide.md'), required: true });
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
