import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { type PrReview, parseConfig, paths, type ReviewVerdict } from '@bugpatrol/core';
import { describe, expect, it } from 'vitest';
import type { Gh } from './github.js';
import { REVIEW_MARKER, renderReviewComment } from './review-comment.js';
import { reviewPullRequest } from './roles/review.js';
import { FakeDriver } from './testing/fake-driver.js';
import type { RoleTask, Runtime } from './types.js';
import { Workspace } from './workspace.js';

const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await exec('git', args, { cwd })).stdout.trim();

/** A source checkout on main, and an origin that has pull request 7 with one changed file. */
async function fixture(github: Record<string, unknown> = { enabled: true, repo: 'o/r' }) {
  const root = await mkdtemp(join(tmpdir(), 'bugpatrol-review-'));
  const origin = join(root, 'origin.git');
  const source = join(root, 'source');
  await git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  await git(root, 'init', '-q', '-b', 'main', source);
  for (const [key, value] of [
    ['user.email', 'test@example.com'],
    ['user.name', 'Bugpatrol Test'],
    ['commit.gpgsign', 'false'],
    ['core.hooksPath', '/dev/null'],
  ])
    await git(source, 'config', key!, value!);
  await writeFile(join(source, 'settings.txt'), 'save works\n');
  await git(source, 'add', '-A');
  await git(source, 'commit', '-q', '-m', 'initial');
  await git(source, 'remote', 'add', 'origin', origin);
  await git(source, 'push', '-q', 'origin', 'main');
  await git(source, 'checkout', '-q', '-b', 'feature');
  await writeFile(join(source, 'settings.txt'), 'save is broken\n');
  await git(source, 'commit', '-q', '-am', 'change settings');
  const head = await git(source, 'rev-parse', 'HEAD');
  await git(source, 'push', '-q', 'origin', 'feature:refs/pull/7/head');
  await git(source, 'checkout', '-q', 'main');
  const config = parseConfig({
    version: 1,
    app: { source: 'source', connect: { url: 'fake://home' } },
    agents: { github },
  });
  return { root, source, head, base: await git(source, 'rev-parse', 'main'), config, workspace: new Workspace(root) };
}

function fakeGh(state: { fork?: boolean; comment?: string } = {}) {
  const calls: { args: string[]; input?: string }[] = [];
  const gh: Gh = async (args, opts) => {
    calls.push({ args, input: opts?.input });
    if (args[0] === '--version' || args[0] === 'auth') return '';
    if (args[0] === 'repo') return 'main';
    if (args[0] === 'pr')
      return JSON.stringify({
        number: 7,
        title: 'Change settings',
        body: 'Changes how the settings screen saves.',
        url: 'https://github.com/o/r/pull/7',
        baseRefName: 'main',
        isCrossRepository: Boolean(state.fork),
      });
    if (args.includes('--paginate')) return state.comment ?? '';
    if (args.includes('PUT')) return '{}';
    if (args.includes('POST') || args.includes('PATCH'))
      return JSON.stringify({ html_url: 'https://github.com/o/r/pull/7#issuecomment-1' });
    if (args[1]?.includes('/git/ref/heads/')) return '{}';
    // An image that the assets branch does not have yet.
    if (args[1]?.includes('/contents/')) throw Object.assign(new Error('HTTP 404'), { stderr: 'Not Found' });
    throw new Error(`Unexpected gh ${args.join(' ')}`);
  };
  const posted = () => {
    const call = calls.find((item) => item.args.includes('POST') || item.args.includes('PATCH'));
    return call ? { args: call.args, body: (JSON.parse(call.input!) as { body: string }).body } : undefined;
  };
  return { gh, calls, posted };
}

const tool = (task: RoleTask, name: string) => task.tools.find((item) => item.name === name)!;
const screens = () =>
  new FakeDriver({ home: { elements: [] }, settings: { elements: [], color: 40 } }, 'home') as FakeDriver;

/** The three agents of a review, scripted: the explorer reports `reports` bugs, and the judge gives `verdict`. */
function scripted(verdict: ReviewVerdict, reports = 1) {
  const tasks: RoleTask[] = [];
  const runtime: Runtime = {
    label: 'scripted',
    async run(task) {
      tasks.push(task);
      if (tool(task, 'report_bug')) {
        await tool(task, 'open').run({ url: 'fake://settings' });
        for (let index = 0; index < reports; index++)
          await tool(task, 'report_bug').run({
            screen_id: 'unrecorded',
            title: `Save does nothing ${index}`,
            what_is_wrong: 'The save button does not save.',
            expected: 'The settings are saved.',
            severity: 'major',
          });
        await tool(task, 'finish').run({ summary: 'Tested the settings screen.' });
      } else if (tool(task, 'capture_after')) {
        await tool(task, 'replay_issue_steps').run({ target: 1 });
        await tool(task, 'capture_after').run({ target: 1, note: 'Save works on this build.', reached: true });
        await tool(task, 'finish_retest').run({ summary: 'Captured.' });
      } else {
        const id = /can_[a-f0-9]+/.exec(task.prompt)![0];
        const view = await tool(task, 'view_finding').run({ id });
        expect(view.content.filter((item) => item.type === 'image')).toHaveLength(2);
        await tool(task, 'classify').run({
          id,
          verdict,
          title: 'The save button does nothing on Settings',
          severity: 'major',
          reason: 'The base build saves, and this build does not: settings.txt changed the handler.',
        });
        await tool(task, 'finish').run({ summary: 'Done.' });
      }
      return { stop: 'done', steps: 3, costUsd: 0.5, summary: 'Tested the settings screen.' };
    },
  };
  return { tasks, createRuntime: () => runtime };
}

describe('pull request review', () => {
  it('tests the pull request build, repeats the flow on the base, and comments what the PR introduces', async () => {
    const f = await fixture();
    try {
      const { gh, posted } = fakeGh();
      const agents = scripted('introduced');
      const drivers: FakeDriver[] = [];
      const review = await reviewPullRequest(f.root, f.config, 7, {
        gh,
        createRuntime: agents.createRuntime,
        createDriver: () => {
          drivers.push(screens());
          return drivers.at(-1)!;
        },
      });
      expect(review).toMatchObject({ status: 'finished', head: f.head, base: f.base, baseRef: 'main', costUsd: 1.5 });
      expect(review.findings).toMatchObject([
        {
          verdict: 'introduced',
          title: 'The save button does nothing on Settings',
          steps: ['Open fake://settings'],
          baseNote: 'Save works on this build.',
        },
      ]);
      expect(review.findings[0]!.head).not.toBe(review.findings[0]!.base);
      expect(drivers).toHaveLength(2);
      expect(drivers.every((driver) => driver.closed)).toBe(true);

      // The pull request build writes nothing to the map of the main branch.
      const [explorer, base, judge] = agents.tasks;
      const names = explorer!.tools.map((item) => item.name);
      expect(names).toEqual(expect.arrayContaining(['open', 'run_routine', 'report_bug', 'finish']));
      for (const name of ['record_screen', 'save_routine', 'save_lesson']) expect(names).not.toContain(name);
      expect(explorer!.prompt).toContain('PULL REQUEST #7: Change settings');
      expect(explorer!.prompt).toContain('+save is broken');
      expect(base!.system).toContain('The app now runs the base build');
      expect(judge!.prompt).toContain('Base build: reached.');

      const comment = posted()!;
      expect(comment.args).toContain('repos/o/r/issues/7/comments');
      expect(comment.body).toContain(REVIEW_MARKER);
      expect(comment.body).toContain('**1 problem that this pull request introduces.**');
      expect(comment.body.match(/<img src="https:\/\/github\.com\/o\/r\/blob\/bugpatrol-assets\/pr-7\//g)).toHaveLength(
        2,
      );
      expect(await f.workspace.readReview(7)).toMatchObject({
        comment: { url: 'https://github.com/o/r/pull/7#issuecomment-1' },
      });

      // A later `bugpatrol judge` must not file this as an issue of the main branch.
      const decisions = await readFile(
        join(paths.session(f.root, review.sessions.explorer!), 'decisions.jsonl'),
        'utf8',
      );
      expect(decisions).toContain(review.findings[0]!.candidateId);
      expect((await git(f.source, 'worktree', 'list')).split('\n')).toHaveLength(1);
      expect(await f.workspace.readAppMap()).toBeUndefined();
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it('leaves a problem of the base build to the normal judge, and edits the comment of the last review', async () => {
    const f = await fixture();
    try {
      const { gh, posted } = fakeGh({ comment: '99' });
      const review = await reviewPullRequest(f.root, f.config, 7, {
        gh,
        createRuntime: scripted('pre-existing').createRuntime,
        createDriver: screens,
      });
      expect(review.findings).toMatchObject([{ verdict: 'pre-existing' }]);
      expect(existsSync(join(paths.session(f.root, review.sessions.explorer!), 'decisions.jsonl'))).toBe(false);
      const comment = posted()!;
      expect(comment.args).toEqual(expect.arrayContaining(['PATCH', 'repos/o/r/issues/comments/99']));
      expect(comment.body).toContain('**No problem found that this pull request introduces.**');
      expect(comment.body).toContain('Already on `main`, not from this pull request (1)');
      expect(comment.body).not.toContain('<img');
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it('does not start the base build when the explorer reports nothing', async () => {
    const f = await fixture();
    try {
      const { gh, posted } = fakeGh();
      const agents = scripted('introduced', 0);
      let drivers = 0;
      const review = await reviewPullRequest(f.root, f.config, 7, {
        gh,
        createRuntime: agents.createRuntime,
        createDriver: () => {
          drivers++;
          return screens();
        },
      });
      expect(drivers).toBe(1);
      expect(agents.tasks).toHaveLength(1);
      expect(review).toMatchObject({ status: 'finished', findings: [], tested: 'Tested the settings screen.' });
      expect(review.sessions.base).toBeUndefined();
      expect(posted()!.body).toContain('tested what the diff can affect');
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it('publishes the last review again on the same commit, and tests again with force', async () => {
    const f = await fixture({ enabled: false });
    try {
      const { gh, calls, posted } = fakeGh();
      const agents = scripted('introduced');
      const run = (opts: { force?: boolean } = {}) =>
        reviewPullRequest(f.root, f.config, 7, {
          gh,
          createRuntime: agents.createRuntime,
          createDriver: screens,
          dryRun: true,
          ...opts,
        });
      await run();
      expect(agents.tasks).toHaveLength(3);
      // A dry run reads the pull request, and writes to a local file only.
      expect(posted()).toBeUndefined();
      expect(calls.some((call) => call.args.includes('PUT'))).toBe(false);
      const file = join(f.root, '.bugpatrol', 'runs', 'reviews', 'pr-7.md');
      expect(await readFile(file, 'utf8')).toContain('The save button does nothing on Settings');
      await run();
      expect(agents.tasks).toHaveLength(3);
      await run({ force: true });
      expect(agents.tasks).toHaveLength(6);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it('refuses a fork, GitHub turned off, and a running patrol before it runs any code', async () => {
    const f = await fixture();
    try {
      const agents = scripted('introduced');
      const run = (config = f.config, fork = true) =>
        reviewPullRequest(f.root, config, 7, {
          gh: fakeGh({ fork }).gh,
          createRuntime: agents.createRuntime,
          createDriver: screens,
        });
      await expect(run()).rejects.toThrow(/comes from a fork/);
      const off = parseConfig({ version: 1, app: { source: 'source', connect: { url: 'fake://home' } } });
      await expect(run(off)).rejects.toThrow(/GitHub is off/);
      await mkdir(join(f.root, '.bugpatrol', 'runs'), { recursive: true });
      await f.workspace.setPatrol({ state: 'running' });
      const agentsFile = paths.agents(f.root);
      const file = JSON.parse(await readFile(agentsFile, 'utf8')) as { patrol: { pid: number } };
      // The parent process is alive and is not this one.
      file.patrol.pid = process.ppid;
      await writeFile(agentsFile, JSON.stringify(file));
      await expect(run(f.config, false)).rejects.toThrow(/A patrol runs/);
      expect(agents.tasks).toHaveLength(0);
      expect(existsSync(paths.worktrees(f.root))).toBe(false);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
});

describe('review comment', () => {
  const review: PrReview = {
    version: 1,
    pr: { number: 7, url: 'https://github.com/o/r/pull/7', title: 'Change settings' },
    head: 'aaaaaaa1111',
    base: 'bbbbbbb2222',
    baseRef: 'main',
    status: 'finished',
    startedAt: 'now',
    sessions: { explorer: 'ses_1', base: 'ses_2', judge: 'ses_3' },
    tested: 'Tested the settings screen.',
    costUsd: 0,
    findings: [
      {
        candidateId: 'can_1',
        screenId: 'settings',
        verdict: 'introduced',
        title: 'A minor problem',
        severity: 'minor',
        reason: 'Minor reason.',
        steps: ['Run the routine enter-app', 'Tap Save'],
        head: 'head.png',
        baseNote: 'Not reached on the base build. The screen is new.',
      },
      {
        candidateId: 'can_2',
        verdict: 'introduced',
        title: 'A critical problem',
        severity: 'critical',
        reason: 'Critical reason.',
        steps: [],
        head: 'head2.png',
        base: 'base2.png',
      },
      { candidateId: 'can_3', verdict: 'unclear', title: 'Unclear', severity: 'minor', reason: 'No base.', steps: [] },
      {
        candidateId: 'can_4',
        verdict: 'not-a-bug',
        title: 'Intended',
        severity: 'minor',
        reason: 'By design.',
        steps: [],
      },
    ],
  };

  it('puts the worst introduced problem first, and folds the rest', () => {
    const body = renderReviewComment(review, (path) => `https://img/${path}`);
    expect(body.startsWith(REVIEW_MARKER)).toBe(true);
    expect(body).toContain('**2 problems that this pull request introduces.**');
    expect(body).toContain('(`aaaaaaa`) and from its base (`bbbbbbb` on `main`)');
    expect(body.indexOf('#### 1. A critical problem')).toBeLessThan(body.indexOf('#### 2. A minor problem'));
    expect(body).toContain(
      '| <img src="https://img/base2.png" width="360"> | <img src="https://img/head2.png" width="360"> |',
    );
    // With no base screenshot, the cell says why.
    expect(body).toContain('| _Not reached on the base build. The screen is new._ | <img src="https://img/head.png"');
    expect(body).toContain(
      '<details><summary>Steps</summary>\n\n1. Run the routine enter-app\n2. Tap Save\n\n</details>',
    );
    expect(body).toContain('<details><summary>Could not compare (1)</summary>');
    expect(body).toContain('<details><summary>Reported, then judged not a bug (1)</summary>');
    expect(body).not.toContain('Already on `main`');
    expect(body).toContain('This comment does not block the merge.');
  });
});
