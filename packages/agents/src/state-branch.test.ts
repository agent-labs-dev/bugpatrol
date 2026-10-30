import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseConfig } from '@bugpatrol/core';
import { afterEach, describe, expect, it } from 'vitest';
import { runPatrol } from './patrol.js';
import { pullState, pushState, STATE_BRANCH } from './state-branch.js';
import { FakeDriver } from './testing/fake-driver.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

let temp: string;

/** A bare remote with one commit on main, and `count` clones of it. */
function clones(count: number): string[] {
  temp = mkdtempSync(join(tmpdir(), 'bugpatrol-state-'));
  const remote = join(temp, 'remote.git');
  git(temp, 'init', '-q', '--bare', '-b', 'main', remote);
  const seed = join(temp, 'seed');
  git(temp, 'init', '-q', '-b', 'main', seed);
  git(seed, 'remote', 'add', 'origin', remote);
  write(seed, 'bugpatrol.yml', 'version: 1\n');
  writeFileSync(join(seed, '.gitignore'), '.bugpatrol/runs/\n');
  git(seed, 'add', '.');
  git(seed, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-qm', 'init');
  git(seed, 'push', '-q', 'origin', 'main');
  return Array.from({ length: count }, (_, index) => {
    const clone = join(temp, `clone-${index}`);
    git(temp, 'clone', '-q', remote, clone);
    return clone;
  });
}

function write(root: string, path: string, value: unknown): void {
  const file = join(root, '.bugpatrol', path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
}

const read = (root: string, path: string) => JSON.parse(readFileSync(join(root, '.bugpatrol', path), 'utf8'));
const onBranch = (root: string) => git(root, 'ls-tree', '-r', '--name-only', `origin/${STATE_BRANCH}`).split('\n');

const issue = (id: string, extra: object = {}) => ({ version: 1, id, title: id, status: 'new', ...extra });

afterEach(() => rmSync(temp, { recursive: true, force: true }));

describe('the state branch', () => {
  it('round-trips coverage, issues, triage', async () => {
    const [a, b] = clones(2) as [string, string];
    const coverage = { version: 1, cells: { 'GET /items': { at: '2026-10-01T00:00:00Z' } }, cursor: 'k' };
    const triage = { version: 1, fingerprints: { f1: { decision: 'filed', issueId: 'i1', reason: 'r', at: 't' } } };
    write(a, 'runs/coverage.json', coverage);
    write(a, 'runs/issues/i1.json', issue('i1'));
    write(a, 'runs/triage.json', triage);
    write(a, 'runs/agents.json', { version: 1, patrol: { state: 'running', pid: 42, commit: 'abc' }, agents: [] });
    write(a, 'appmap.json', { version: 1, screens: [{ id: 'home' }] });
    write(a, 'routines/login.json', { id: 'login' });
    expect((await pushState(a, STATE_BRANCH)).commit).toBeTruthy();

    write(b, 'runs/agents.json', { version: 1, patrol: { state: 'running', pid: 7 }, agents: [] });
    await pullState(b, STATE_BRANCH);
    expect(read(b, 'runs/coverage.json')).toEqual(coverage);
    expect(read(b, 'runs/issues/i1.json')).toEqual(issue('i1'));
    expect(read(b, 'runs/triage.json')).toEqual(triage);
    expect(read(b, 'appmap.json')).toEqual({ version: 1, screens: [{ id: 'home' }] });
    expect(read(b, 'routines/login.json')).toEqual({ id: 'login' });
    // Only the tested commit is shared: the pid and the live state stay this machine's.
    expect(read(b, 'runs/agents.json').patrol).toEqual({ state: 'running', pid: 7, commit: 'abc' });
    // The state branch never touches main or the checkout.
    expect(git(b, 'status', '--porcelain')).toBe('?? .bugpatrol/appmap.json\n?? .bugpatrol/routines/');
    expect(git(b, 'ls-remote', 'origin', 'main').split('\t')[0]).toBe(git(b, 'rev-parse', 'HEAD'));
    expect(await pushState(b, STATE_BRANCH)).toEqual({});
  });

  it('never pushes a png', async () => {
    const [a] = clones(1) as [string];
    write(a, 'runs/issues/i1.json', issue('i1'));
    write(a, 'runs/issues/i1.png', 'png');
    write(a, 'runs/sessions/s1/session.json', { id: 's1' });
    write(a, 'runs/sessions/s1/shot.png', 'png');
    write(a, 'runs/baselines/home.png', 'png');
    write(a, 'runs/agent-baselines/home.png', 'png');
    write(a, 'runs/fixes/f1/attempt-1.diff', 'diff');
    write(a, 'routines/login.png', 'png');
    await pushState(a, STATE_BRANCH);
    git(a, 'fetch', '-q', 'origin');
    expect(onBranch(a)).toEqual(['runs/issues/i1.json']);
  });

  it('two writers keep both new issues', async () => {
    const [a, b] = clones(2) as [string, string];
    write(a, 'runs/issues/shared.json', issue('shared'));
    await pushState(a, STATE_BRANCH);
    await pullState(b, STATE_BRANCH);
    // Both writers work from the same pull and push at once. The one that loses the race merges and pushes again.
    write(a, 'runs/issues/from-a.json', issue('from-a'));
    write(a, 'runs/memory.json', { version: 1, lessons: [{ id: 'la', text: 'a' }] });
    write(b, 'runs/issues/from-b.json', issue('from-b'));
    write(b, 'runs/memory.json', { version: 1, lessons: [{ id: 'lb', text: 'b' }] });
    await Promise.all([pushState(a, STATE_BRANCH), pushState(b, STATE_BRANCH)]);
    await pullState(a, STATE_BRANCH);
    await pullState(b, STATE_BRANCH);
    for (const root of [a, b]) {
      git(root, 'fetch', '-q', 'origin');
      expect(onBranch(root)).toEqual([
        'runs/issues/from-a.json',
        'runs/issues/from-b.json',
        'runs/issues/shared.json',
        'runs/memory.json',
      ]);
      expect(read(root, 'runs/issues/from-a.json').id).toBe('from-a');
      expect(read(root, 'runs/issues/from-b.json').id).toBe('from-b');
      expect(
        read(root, 'runs/memory.json')
          .lessons.map((lesson: { id: string }) => lesson.id)
          .sort(),
      ).toEqual(['la', 'lb']);
    }
  });

  it('no pending failure or fix transition is lost', async () => {
    const [a, b] = clones(2) as [string, string];
    const fix = {
      version: 1,
      id: 'f1',
      issueId: 'i1',
      status: 'proposed',
      retests: [{ outcome: 'not-fixed', at: '1' }],
    };
    write(a, 'runs/fixes/f1.json', fix);
    write(a, 'runs/issues/i1.json', issue('i1', { status: 'fix-proposed' }));
    await pushState(a, STATE_BRANCH);
    await pullState(b, STATE_BRANCH);
    // A opens the PR. B, from the same pull, records a retest that failed and a new title.
    write(a, 'runs/fixes/f1.json', { ...fix, status: 'opened', pr: { number: 3 } });
    write(b, 'runs/fixes/f1.json', { ...fix, retests: [...fix.retests, { outcome: 'error', at: '2' }] });
    write(b, 'runs/issues/i1.json', issue('i1', { status: 'fix-proposed', title: 'better' }));
    await pushState(a, STATE_BRANCH);
    await pushState(b, STATE_BRANCH);
    await pullState(a, STATE_BRANCH);
    for (const root of [a, b]) {
      expect(read(root, 'runs/fixes/f1.json')).toEqual({
        ...fix,
        status: 'opened',
        pr: { number: 3 },
        retests: [
          { outcome: 'not-fixed', at: '1' },
          { outcome: 'error', at: '2' },
        ],
      });
      expect(read(root, 'runs/issues/i1.json').title).toBe('better');
    }
  });

  it('fails on a file it cannot merge, and overwrites nothing', async () => {
    const [a, b] = clones(2) as [string, string];
    write(a, 'runs/issues/i1.json', issue('i1'));
    write(a, 'runs/triage.json', { version: 1, fingerprints: {} });
    await pushState(a, STATE_BRANCH);
    const tip = git(a, 'ls-remote', 'origin', STATE_BRANCH);
    write(b, 'runs/issues/i1.json', '{ torn');
    write(b, 'runs/triage.json', { version: 1, fingerprints: { f: {} } });
    await expect(pullState(b, STATE_BRANCH)).rejects.toThrow(/i1\.json .*not valid JSON/);
    await expect(pushState(b, STATE_BRANCH)).rejects.toThrow(/not valid JSON/);
    expect(readFileSync(join(b, '.bugpatrol/runs/issues/i1.json'), 'utf8')).toBe('{ torn');
    expect(read(b, 'runs/triage.json').fingerprints).toEqual({ f: {} });
    expect(git(a, 'ls-remote', 'origin', STATE_BRANCH)).toBe(tip);
  });

  it('a patrol on another clone skips the commit that the first patrol tested', async () => {
    const [a, b] = clones(2) as [string, string];
    const config = parseConfig({
      version: 1,
      app: { source: '.', connect: { url: 'fake://home' } },
      agents: { judge: { enabled: false }, patrol: { pull: false, state: 'branch' } },
    });
    let explores = 0;
    const patrol = (root: string) =>
      runPatrol({
        root,
        config,
        once: true,
        createDriver: () => new FakeDriver({ home: { elements: [] } }),
        createRuntime: () => ({
          label: 'scripted',
          async run() {
            explores++;
            return { stop: 'done', steps: 0, costUsd: 0, summary: 'Done' };
          },
        }),
      });
    expect((await patrol(a)).problems).toEqual([]);
    expect((await patrol(b)).problems).toEqual([]);
    expect(explores).toBe(1);
    expect(read(b, 'runs/agents.json').patrol.commit).toBe(git(b, 'rev-parse', 'HEAD'));
    expect(git(b, 'ls-remote', 'origin', 'main').split('\t')[0]).toBe(git(b, 'rev-parse', 'HEAD'));
  });
});
