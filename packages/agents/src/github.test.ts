import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type FixProposal, type Issue, parseConfig } from '@bugpatrol/core';
import { afterEach, describe, expect, it } from 'vitest';
import { createIssue, createPr, ensureAssetsBranch, type Gh, listFiled, syncGitHub, uploadImage } from './github.js';
import { Workspace } from './workspace.js';

let dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  dirs = [];
});
const temp = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bugpatrol-gh-test-'));
  dirs.push(dir);
  return dir;
};
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

describe('GitHub client', () => {
  it('creates an orphan assets branch only when the ref is missing', async () => {
    const calls: string[][] = [];
    const gh: Gh = async (args) => {
      calls.push(args);
      if (args[1]?.endsWith('/git/ref/heads/assets')) throw new Error('404 Not Found');
      if (args[2]?.endsWith('/git/blobs')) return JSON.stringify({ sha: 'blob' });
      if (args[2]?.endsWith('/git/trees')) return JSON.stringify({ sha: 'tree' });
      if (args[2]?.endsWith('/git/commits')) return JSON.stringify({ sha: 'commit' });
      return '{}';
    };
    await ensureAssetsBranch(gh, 'o/r', 'assets');
    expect(calls.filter((args) => args.includes('POST'))).toHaveLength(4);
    const ref = calls.at(-1)!;
    expect(ref).toContain('repos/o/r/git/refs');
    calls.length = 0;
    await ensureAssetsBranch(
      async (args) => {
        calls.push(args);
        return '{}';
      },
      'o/r',
      'assets',
    );
    expect(calls).toHaveLength(1);
  });
  it('skips upload of an existing image', async () => {
    const dir = await temp();
    const path = join(dir, 'screen.png');
    await writeFile(path, 'png');
    const calls: string[][] = [];
    const url = await uploadImage(
      async (args) => {
        calls.push(args);
        return '{}';
      },
      'o/r',
      'assets',
      path,
      'iss_1',
    );
    expect(calls).toHaveLength(1);
    expect(url).toMatch(/iss_1\/[a-f0-9]{12}-screen\.png\?raw=true$/);
  });
  it('passes labels and a temporary body file to issue create', async () => {
    let body = '';
    const gh: Gh = async (args) => {
      body = await readFile(args[args.indexOf('--body-file') + 1]!, 'utf8');
      expect(args).toContain('--label');
      expect(args).toContain('bugpatrol');
      return 'https://github.com/o/r/issues/8';
    };
    expect(await createIssue(gh, { repo: 'o/r', title: 'Broken', body: 'Full report', labels: ['bugpatrol'] })).toEqual(
      { number: 8, url: 'https://github.com/o/r/issues/8' },
    );
    expect(body).toBe('Full report');
  });
  it('commits an uncommitted worktree, pushes it, and creates a PR', async () => {
    const dir = await temp();
    const remote = join(dir, 'remote.git');
    const source = join(dir, 'source');
    const worktree = join(dir, 'fix');
    execFileSync('git', ['init', '--bare', remote]);
    execFileSync('git', ['init', source]);
    git(source, 'config', 'user.email', 'test@example.com');
    git(source, 'config', 'user.name', 'Test');
    git(source, 'config', 'commit.gpgsign', 'false');
    await writeFile(join(source, 'app.txt'), 'broken');
    git(source, 'add', '-A');
    git(source, 'commit', '-m', 'initial');
    git(source, 'remote', 'add', 'origin', remote);
    git(source, 'push', '-u', 'origin', 'HEAD');
    git(source, 'worktree', 'add', '-b', 'fix-branch', worktree, 'HEAD');
    git(worktree, 'config', 'commit.gpgsign', 'false');
    await writeFile(join(worktree, 'app.txt'), 'fixed');
    const fix: FixProposal = {
      version: 1,
      id: 'fix_1',
      issueId: 'iss_1',
      status: 'proposed',
      runtime: 'fake',
      repo: source,
      branch: 'fix-branch',
      worktree,
      startedAt: 'now',
      error: 'Left uncommitted in the worktree: hook',
    };
    const issue = { id: 'iss_1', title: 'Broken screen' } as Issue;
    const gh: Gh = async (args) => {
      expect(args).toContain('--body-file');
      return 'https://github.com/o/r/pull/4';
    };
    const opened = await createPr(gh, {
      repo: 'o/r',
      defaultBranch: 'master',
      title: 'Fix screen',
      body: 'Report',
      labels: [],
      draft: true,
      fix,
      issue,
      commitMessage: 'fix: {title}',
    });
    expect(opened.number).toBe(4);
    expect(fix.commit).toBe(git(worktree, 'rev-parse', 'HEAD'));
    expect(fix.error).toBeUndefined();
    expect(git(worktree, 'status', '--porcelain')).toBe('');
    expect(git(source, 'ls-remote', 'origin', 'refs/heads/fix-branch')).toContain(fix.commit);
  });
});

describe('listFiled', () => {
  it('lists open items and recent merged or closed PRs from every label', async () => {
    const config = parseConfig({
      version: 1,
      app: { connect: { url: 'http://localhost' } },
      agents: { github: { enabled: true, repo: 'o/r' } },
    });
    const recent = new Date().toISOString();
    const gh: Gh = async (args) => {
      const label = args[args.indexOf('--label') + 1];
      if (args[0] === 'issue') return label === 'bughunters' ? '[]' : '[{"number":9,"title":"Search shows Markdown"}]';
      if (label === 'bughunters')
        return JSON.stringify([
          {
            number: 5,
            title: 'fix: make Private clickable',
            state: 'MERGED',
            mergedAt: recent,
            files: [{ path: 'a.tsx' }],
          },
          { number: 3, title: 'fix: an old change', state: 'CLOSED', closedAt: '2020-01-01T00:00:00Z' },
        ]);
      return JSON.stringify([{ number: 6, title: 'fix: select Private', state: 'OPEN', files: [{ path: 'a.tsx' }] }]);
    };
    expect(await listFiled(gh, 'o/r', config)).toEqual([
      '- PR #6 [open]: fix: select Private (files: a.tsx)',
      '- PR #5 [merged]: fix: make Private clickable (files: a.tsx)',
      '- issue #9 [open]: Search shows Markdown',
    ]);
  });
});

describe('GitHub state sync', () => {
  const issue = (): Issue => ({
    version: 1,
    id: 'iss_1',
    fingerprint: 'issue-fp',
    title: 'Broken screen',
    body: 'Broken',
    severity: 'major',
    status: 'fix-proposed',
    screenId: 'home',
    candidateIds: [],
    evidence: {},
    judgement: { by: 'judge', reason: 'Broken', at: 'now' },
    occurrences: 1,
    firstSeenAt: 'now',
    lastSeenAt: 'now',
  });
  const fix = (): FixProposal => ({
    version: 1,
    id: 'fix_1',
    issueId: 'iss_1',
    status: 'verified',
    runtime: 'fake',
    repo: '',
    branch: 'fix',
    worktree: '',
    startedAt: 'now',
    pr: { number: 7, url: 'https://github.com/o/r/pull/7', draft: false },
  });
  async function fixture() {
    const root = await temp();
    const workspace = new Workspace(root);
    const config = parseConfig({
      version: 1,
      app: { source: '.', connect: { url: 'http://localhost' } },
      agents: { github: { enabled: true, repo: 'o/r' } },
    });
    let prs: unknown[] = [];
    let issues: unknown[] = [];
    const calls: string[][] = [];
    const gh: Gh = async (args) => {
      calls.push(args);
      if (args[0] === 'repo') return 'main';
      if (args[0] === 'pr') return JSON.stringify(prs);
      if (args[0] === 'issue') return JSON.stringify(issues);
      return '';
    };
    return {
      root,
      workspace,
      config,
      gh,
      calls,
      setPrs: (value: unknown[]) => {
        prs = value;
      },
      setIssues: (value: unknown[]) => {
        issues = value;
      },
    };
  }
  it('rejects a closed PR once and records lessons and an event', async () => {
    const f = await fixture();
    await f.workspace.saveIssue(issue());
    await f.workspace.saveFix(fix());
    const pr = { number: 7, url: 'https://github.com/o/r/pull/7', state: 'OPEN' };
    f.setPrs([pr]);
    await syncGitHub(f.root, f.config, { gh: f.gh });
    f.setPrs([{ ...pr, state: 'CLOSED', closedAt: '2026-09-25T01:00:00Z' }]);
    expect((await syncGitHub(f.root, f.config, { gh: f.gh })).changed).toEqual(['fix_1', 'iss_1']);
    expect(await f.workspace.readFix('fix_1')).toMatchObject({ status: 'rejected', pr: { state: 'closed' } });
    expect(await f.workspace.readIssue('iss_1')).toMatchObject({
      status: 'filed',
      fixRejected: { pr: 7, at: '2026-09-25T01:00:00Z' },
    });
    expect((await f.workspace.readMemory()).lessons).toMatchObject([
      { role: 'judge', source: 'rejected-pr' },
      { role: 'fixer', source: 'rejected-pr' },
    ]);
    expect((await f.workspace.listSessions())[0]?.id).toBeDefined();
    expect((await syncGitHub(f.root, f.config, { gh: f.gh })).changed).toEqual([]);
    expect((await f.workspace.readMemory()).lessons.map((item) => item.hits)).toEqual([1, 1]);
    expect(await f.workspace.listSessions()).toHaveLength(1);
    expect(f.calls.filter((args) => args[0] === 'repo')).toHaveLength(3);
  });
  it('records merged PR state without changing the fix', async () => {
    const f = await fixture();
    await f.workspace.saveIssue(issue());
    await f.workspace.saveFix(fix());
    f.setPrs([{ number: 7, url: 'https://github.com/o/r/pull/7', state: 'MERGED', mergedAt: '2026-09-25T01:00:00Z' }]);
    await syncGitHub(f.root, f.config, { gh: f.gh });
    expect(await f.workspace.readFix('fix_1')).toMatchObject({
      status: 'verified',
      pr: { state: 'merged', stateAt: '2026-09-25T01:00:00Z' },
    });
  });
  it('restores a reopened PR and issue', async () => {
    const f = await fixture();
    await f.workspace.saveIssue({
      ...issue(),
      status: 'dismissed',
      closedBy: { by: 'GitHub', reason: 'Closed on GitHub as not planned.', at: 'now' },
      fixRejected: { pr: 7, url: 'https://github.com/o/r/pull/7', at: 'now' },
      github: { number: 8, url: 'https://github.com/o/r/issues/8', at: 'now', state: 'closed' },
    });
    await f.workspace.saveFix({
      ...fix(),
      status: 'rejected',
      pr: { ...fix().pr!, state: 'closed' },
      retests: [
        { attempt: 1, outcome: 'fixed', reason: 'Gone', at: 'now' },
        { attempt: 2, outcome: 'error', reason: 'Setup failed', at: 'now' },
      ],
    });
    f.setPrs([{ number: 7, url: 'https://github.com/o/r/pull/7', state: 'OPEN' }]);
    f.setIssues([{ number: 8, url: 'https://github.com/o/r/issues/8', state: 'OPEN', stateReason: 'REOPENED' }]);
    await syncGitHub(f.root, f.config, { gh: f.gh });
    expect(await f.workspace.readFix('fix_1')).toMatchObject({ status: 'verified', pr: { state: 'open' } });
    expect(await f.workspace.readIssue('iss_1')).toMatchObject({ status: 'filed', github: { state: 'open' } });
    expect((await f.workspace.readIssue('iss_1'))?.fixRejected).toBeUndefined();
    expect((await f.workspace.readIssue('iss_1'))?.closedBy).toBeUndefined();
  });
  it.each([
    ['NOT_PLANNED', 'dismissed'],
    ['COMPLETED', 'fixed'],
  ] as const)('handles a GitHub issue closed as %s', async (stateReason, status) => {
    const f = await fixture();
    await f.workspace.saveIssue({
      ...issue(),
      status: 'filed',
      candidateIds: ['cand_1'],
      github: { number: 8, url: 'https://github.com/o/r/issues/8', at: 'now' },
    });
    const session = await f.workspace.startSession('explorer');
    await f.workspace.appendCandidate(session.id, {
      id: 'cand_1',
      sessionId: session.id,
      source: 'explorer',
      fingerprint: 'candidate-fp',
      summary: 'Broken',
      severity: 'major',
      evidence: {},
      createdAt: 'now',
    });
    f.setIssues([
      {
        number: 8,
        url: 'https://github.com/o/r/issues/8',
        state: 'CLOSED',
        stateReason,
        closedAt: '2026-09-25T01:00:00Z',
      },
    ]);
    await syncGitHub(f.root, f.config, { gh: f.gh });
    expect(await f.workspace.readIssue('iss_1')).toMatchObject({
      status,
      closedBy: { by: 'GitHub', at: '2026-09-25T01:00:00Z' },
    });
    if (stateReason === 'NOT_PLANNED') {
      expect(Object.keys((await f.workspace.readTriage()).fingerprints).sort()).toEqual(['candidate-fp', 'issue-fp']);
      expect((await f.workspace.readMemory()).lessons[0]).toMatchObject({ role: 'judge', source: 'human' });
    }
  });
});
