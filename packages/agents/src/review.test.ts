import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { type PrReview, parseConfig, paths, type ReviewVerdict, type Routine } from '@bugpatrol/core';
import type { UiElement } from '@bugpatrol/drivers';
import { describe, expect, it } from 'vitest';
import type { Gh } from './github.js';
import { numberDiff, REVIEW_MARKER, renderReview, SUPERSEDED_MARKER } from './review-comment.js';
import { reviewPullRequest } from './roles/review.js';
import { FakeDriver } from './testing/fake-driver.js';
import type { RoleTask, Runtime } from './types.js';
import { Workspace } from './workspace.js';

const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await exec('git', args, { cwd })).stdout.trim();

/** A source checkout on main, and an origin that has pull request 7 with one changed file. */
async function fixture(
  github: Record<string, unknown> = { enabled: true, repo: 'o/r' },
  review: Record<string, unknown> = {},
) {
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
    agents: { github, review },
  });
  return { root, source, head, base: await git(source, 'rev-parse', 'main'), config, workspace: new Workspace(root) };
}

/**
 * `reviews` and `comments` are the rows that the jq filters of the review print.
 * `issues` are the issues that the pull request closes.
 */
function fakeGh(
  state: {
    fork?: boolean;
    reviews?: string;
    comments?: string;
    body?: string;
    issues?: { number: number; title: string; body: string }[];
  } = {},
) {
  const calls: { args: string[]; input?: string }[] = [];
  const gh: Gh = async (args, opts) => {
    calls.push({ args, input: opts?.input });
    if (args[0] === '--version' || args[0] === 'auth') return '';
    if (args[0] === 'repo') return 'main';
    if (args[0] === 'pr')
      return JSON.stringify({
        number: 7,
        title: 'Change settings',
        body: state.body ?? 'Changes how the settings screen saves.',
        url: 'https://github.com/o/r/pull/7',
        baseRefName: 'main',
        isCrossRepository: Boolean(state.fork),
        closingIssuesReferences: (state.issues ?? []).map((issue) => ({
          number: issue.number,
          url: `https://github.com/o/r/issues/${issue.number}`,
        })),
      });
    if (args[0] === 'issue') {
      const issue = state.issues?.find((item) => String(item.number) === args[2]);
      if (!issue) throw new Error(`Unexpected gh ${args.join(' ')}`);
      return JSON.stringify(issue);
    }
    if (args.includes('--paginate')) return (args[2]!.endsWith('/reviews') ? state.reviews : state.comments) ?? '';
    if (args.includes('DELETE')) return '';
    if (args.some((arg) => arg.includes('/reviews')))
      return JSON.stringify({ html_url: 'https://github.com/o/r/pull/7#pullrequestreview-1' });
    if (args.includes('PUT')) return '{}';
    if (args[1]?.includes('/git/ref/heads/')) return '{}';
    // An image that the assets branch does not have yet.
    if (args[1]?.includes('/contents/')) throw Object.assign(new Error('HTTP 404'), { stderr: 'Not Found' });
    throw new Error(`Unexpected gh ${args.join(' ')}`);
  };
  const sent = (method: string, path: string) =>
    calls
      .filter((call) => call.args.includes(method) && call.args.some((arg) => arg.includes(path)))
      .map((call) => ({
        path: call.args.find((arg) => arg.startsWith('repos/'))!,
        input: call.input ? (JSON.parse(call.input) as Record<string, unknown>) : undefined,
      }));
  type Posted = {
    commit_id: string;
    event: string;
    body: string;
    comments: { path: string; line: number; side: string; body: string }[];
  };
  const posted = () => sent('POST', '/reviews').map((call) => call.input as Posted);
  return { gh, calls, sent, posted, state };
}

const tool = (task: RoleTask, name: string) => task.tools.find((item) => item.name === name)!;
const screens = () =>
  new FakeDriver({ home: { elements: [] }, settings: { elements: [], color: 40 } }, 'home') as FakeDriver;

/**
 * The three agents of a review, scripted: the explorer reports `reports` bugs, and the judge gives `verdict`.
 * With `line`, the judge puts the finding on that line of settings.txt.
 */
function scripted(verdict: ReviewVerdict, reports = 1, line?: number) {
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
      } else if (tool(task, 'add_claim')) {
        // A source that the pull request does not have.
        const wrong = await tool(task, 'add_claim').run({
          text: 'Fixes the login.',
          platform: 'web',
          source: 'issue',
          issue: 99,
          testable: true,
        });
        expect(wrong.isError).toBe(true);
        // An untestable claim needs a reason.
        const bare = await tool(task, 'add_claim').run({
          text: 'Cleans up the settings code.',
          platform: 'web',
          source: 'body',
          testable: false,
        });
        expect(bare.isError).toBe(true);
        const commit = /commit ([0-9a-f]{40})/.exec(task.prompt)![1];
        await tool(task, 'add_claim').run({
          text: 'The save button saves the settings.',
          platform: 'web',
          source: 'commit',
          commit,
          testable: true,
        });
        await tool(task, 'add_claim').run({
          text: 'Saving works again after a reload.',
          platform: 'web',
          source: 'issue',
          issue: 12,
          testable: true,
        });
        await tool(task, 'add_claim').run({
          text: 'Cleans up the settings code.',
          platform: 'web',
          source: 'body',
          testable: false,
          reason: 'No screen or request shows how clean the code is.',
        });
        await tool(task, 'finish').run({ summary: 'Three claims.' });
      } else if (tool(task, 'capture_after')) {
        await tool(task, 'replay_issue_steps').run({ target: 1 });
        await tool(task, 'capture_after').run({ target: 1, note: 'Save works on this build.', reached: true });
        await tool(task, 'finish_retest').run({ summary: 'Captured.' });
      } else {
        const id = /can_[a-f0-9]+/.exec(task.prompt)![0];
        const view = await tool(task, 'view_finding').run({ id });
        expect(view.content.filter((item) => item.type === 'image')).toHaveLength(2);
        const input = {
          id,
          verdict,
          title: 'The save button does nothing on Settings',
          severity: 'major',
          reason: 'The base build saves, and this build does not: settings.txt changed the handler.',
        };
        // A line that the diff does not show would make GitHub refuse the whole review.
        const wrong = await tool(task, 'classify').run({ ...input, file: 'settings.txt', line: 99 });
        expect(wrong.isError).toBe(true);
        await tool(task, 'classify').run({ ...input, ...(line ? { file: 'settings.txt', line } : {}) });
        await tool(task, 'finish').run({ summary: 'Done.' });
      }
      return { stop: 'done', steps: 3, costUsd: 0.5, summary: 'Tested the settings screen.' };
    },
  };
  return { tasks, createRuntime: () => runtime };
}

// Each test runs real git and one or more whole reviews.
describe('pull request review', { timeout: 30_000 }, () => {
  it('tests the pull request build, repeats the flow on the base, and comments on the line that causes the problem', async () => {
    const f = await fixture();
    try {
      const { gh, posted } = fakeGh();
      const agents = scripted('introduced', 1, 1);
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
          file: 'settings.txt',
          line: 1,
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
      expect(explorer!.prompt).toContain('+    1 save is broken');
      expect(base!.system).toContain('The app now runs the base build');
      expect(judge!.prompt).toContain('Base build: reached.');

      // A review that comments: it can never block the merge.
      const [sent] = posted();
      expect(posted()).toHaveLength(1);
      expect(sent).toMatchObject({ commit_id: f.head, event: 'COMMENT' });
      expect(sent!.body).toContain(REVIEW_MARKER);
      expect(sent!.body).toContain('**1 problem that this pull request introduces.**');
      expect(sent!.body).toContain('Each one is a comment on the changed line that causes it.');
      expect(sent!.body).not.toContain('<img');
      expect(sent!.comments).toMatchObject([{ path: 'settings.txt', line: 1, side: 'RIGHT' }]);
      expect(sent!.comments[0]!.body).toContain('**The save button does nothing on Settings**');
      expect(
        sent!.comments[0]!.body.match(/<img src="https:\/\/github\.com\/o\/r\/blob\/bugpatrol-assets\/pr-7\//g),
      ).toHaveLength(2);
      expect(await f.workspace.readReview(7)).toMatchObject({
        posted: { url: 'https://github.com/o/r/pull/7#pullrequestreview-1' },
      });

      // A later `bugpatrol judge` must not file this as an issue of the main branch.
      const decisions = await readFile(
        join(paths.session(f.root, review.sessions.explorer!), 'decisions.jsonl'),
        'utf8',
      );
      expect(decisions).toContain(review.findings[0]!.candidateId);
      expect((await git(f.source, 'worktree', 'list')).split('\n')).toHaveLength(1);
      expect(await git(f.source, 'for-each-ref', 'refs/bugpatrol')).toBe('');
      expect(await f.workspace.readAppMap()).toBeUndefined();
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it('keeps an introduced problem in the review body when the judge names no line', async () => {
    const f = await fixture();
    try {
      const { gh, posted } = fakeGh();
      await reviewPullRequest(f.root, f.config, 7, {
        gh,
        createRuntime: scripted('introduced').createRuntime,
        createDriver: screens,
      });
      const [sent] = posted();
      expect(sent!.comments).toEqual([]);
      expect(sent!.body).toContain('#### 1. The save button does nothing on Settings');
      expect(sent!.body.match(/<img /g)).toHaveLength(2);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it('leaves a problem of the base build to the normal judge, and replaces the review of an older commit', async () => {
    const f = await fixture();
    try {
      // Review 55 is of an older commit. A person answered its comment 2.
      const { gh, posted, sent } = fakeGh({
        reviews: '55 0000000000000000000000000000000000000000',
        comments: ['1 55 null', '2 55 null', '3 55 2', '4 77 null'].join('\n'),
      });
      const review = await reviewPullRequest(f.root, f.config, 7, {
        gh,
        createRuntime: scripted('pre-existing', 1, 1).createRuntime,
        createDriver: screens,
      });
      // A line is for an introduced problem only.
      expect(review.findings).toMatchObject([{ verdict: 'pre-existing' }]);
      expect(review.findings[0]!.file).toBeUndefined();
      expect(existsSync(join(paths.session(f.root, review.sessions.explorer!), 'decisions.jsonl'))).toBe(false);
      expect(posted()).toHaveLength(1);
      expect(posted()[0]!.comments).toEqual([]);
      expect(posted()[0]!.body).toContain('**No problem found that this pull request introduces.**');
      expect(posted()[0]!.body).toContain('Already on `main`, not from this pull request (1)');
      const replaced = sent('PUT', '/reviews/');
      expect(replaced.map((call) => call.path)).toEqual(['repos/o/r/pulls/7/reviews/55']);
      expect(replaced[0]!.input!.body).toContain(SUPERSEDED_MARKER);
      expect(sent('DELETE', '/comments/').map((call) => call.path)).toEqual(['repos/o/r/pulls/comments/1']);
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
      expect(posted()[0]!.body).toContain('tested what the diff can affect');
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it('on the same commit, updates the body of its review and tests nothing', async () => {
    const f = await fixture();
    try {
      const github = fakeGh();
      const agents = scripted('introduced', 1, 1);
      const run = () =>
        reviewPullRequest(f.root, f.config, 7, {
          gh: github.gh,
          createRuntime: agents.createRuntime,
          createDriver: screens,
        });
      await run();
      github.state.reviews = `90 ${f.head}`;
      await run();
      expect(agents.tasks).toHaveLength(3);
      // A second review of the same commit would notify the author again for nothing.
      expect(github.posted()).toHaveLength(1);
      expect(github.sent('PUT', '/reviews/').map((call) => call.path)).toEqual(['repos/o/r/pulls/7/reviews/90']);
      expect(github.sent('DELETE', '/comments/')).toEqual([]);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it('writes a dry run to a file, publishes it again on the same commit, and tests again with force', async () => {
    const f = await fixture({ enabled: false });
    try {
      const { gh, calls, posted } = fakeGh();
      const agents = scripted('introduced', 1, 1);
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
      expect(posted()).toEqual([]);
      expect(calls.some((call) => call.args.includes('PUT'))).toBe(false);
      const file = await readFile(join(f.root, '.bugpatrol', 'runs', 'reviews', 'pr-7.md'), 'utf8');
      expect(file).toContain('On `settings.txt` line 1:\n\n**The save button does nothing on Settings**');
      await run();
      expect(agents.tasks).toHaveLength(3);
      await run({ force: true });
      expect(agents.tasks).toHaveLength(6);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it('takes the claims of the author-written claims section as written', async () => {
    const f = await fixture({ enabled: false }, { claims: true });
    try {
      const body = [
        'Changes how the settings screen saves.',
        '',
        '## Claims',
        '',
        '- The save button saves the settings.',
        '* A saved setting shows after a reload.',
        '',
        '## Notes',
        '',
        '- Not a claim.',
      ].join('\n');
      const { gh } = fakeGh({ body });
      const agents = scripted('introduced', 0);
      const review = await reviewPullRequest(f.root, f.config, 7, {
        gh,
        createRuntime: agents.createRuntime,
        createDriver: screens,
        dryRun: true,
      });
      // The author wrote the claims, so no model writes them.
      expect(agents.tasks).toHaveLength(1);
      expect(review.claims).toEqual([
        {
          claim: {
            id: 'claim-1',
            text: 'The save button saves the settings.',
            platform: 'web',
            source: { kind: 'section' },
            testable: true,
          },
          verdict: 'untested',
          reason: 'The explorer did not reach this claim.',
        },
        {
          claim: {
            id: 'claim-2',
            text: 'A saved setting shows after a reload.',
            platform: 'web',
            source: { kind: 'section' },
            testable: true,
          },
          verdict: 'untested',
          reason: 'The explorer did not reach this claim.',
        },
      ]);
      expect((await f.workspace.readReview(7))!.claims).toEqual(review.claims);
      const file = await readFile(join(f.root, '.bugpatrol', 'runs', 'reviews', 'pr-7.md'), 'utf8');
      expect(file).toContain('The save button saves the settings.');
      expect(file).not.toContain('Not a claim.');
      // Claims first, then the problems that the pull request introduces.
      expect(file.indexOf('A saved setting shows after a reload.')).toBeLessThan(
        file.indexOf('No problem found that this pull request introduces.'),
      );
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it('lets the judge write the claims from the pull request, and lists an untestable claim with its reason', async () => {
    const f = await fixture();
    try {
      const { gh, posted } = fakeGh({
        body: 'Changes how the settings screen saves, and cleans up the settings code.',
        issues: [{ number: 12, title: 'Settings do not save', body: 'Saving does nothing after a reload.' }],
      });
      const agents = scripted('introduced', 1);
      const review = await reviewPullRequest(f.root, f.config, 7, {
        gh,
        createRuntime: agents.createRuntime,
        createDriver: screens,
        claims: true,
      });
      const [claims, explorer] = agents.tasks;
      // The judge reads the title, the body, the commits, the closed issues and the diff.
      expect(claims!.role).toBe('judge');
      expect(claims!.prompt).toContain('PULL REQUEST #7: Change settings');
      expect(claims!.prompt).toContain('cleans up the settings code');
      expect(claims!.prompt).toContain(`commit ${f.head}`);
      expect(claims!.prompt).toContain('change settings');
      expect(claims!.prompt).toContain('ISSUE #12: Settings do not save');
      expect(claims!.prompt).toContain('Saving does nothing after a reload.');
      expect(claims!.prompt).toContain('+    1 save is broken');
      expect(review.sessions.claims).toBeDefined();
      expect(review.claims).toMatchObject([
        {
          claim: {
            id: 'claim-1',
            text: 'The save button saves the settings.',
            source: { kind: 'commit', commit: f.head },
            testable: true,
          },
          verdict: 'untested',
        },
        { claim: { id: 'claim-2', source: { kind: 'issue', number: 12 }, testable: true }, verdict: 'untested' },
        {
          claim: {
            id: 'claim-3',
            text: 'Cleans up the settings code.',
            source: { kind: 'body' },
            testable: false,
            untestable: 'No screen or request shows how clean the code is.',
          },
          verdict: 'untested',
          reason: 'No screen or request shows how clean the code is.',
        },
      ]);
      // An untestable claim is never explored.
      expect(explorer!.prompt).not.toContain('Cleans up the settings code.');
      expect(review.findings).toHaveLength(1);

      // One review: the claims first, then the problems that the pull request introduces.
      expect(posted()).toHaveLength(1);
      const [sent] = posted();
      expect(sent).toMatchObject({ commit_id: f.head, event: 'COMMENT' });
      expect(sent!.body.startsWith(REVIEW_MARKER)).toBe(true);
      expect(sent!.body).toContain(`From commit \`${f.head.slice(0, 7)}\``);
      expect(sent!.body).toContain('Claims that Bugpatrol could not test (3)');
      expect(sent!.body).toContain('No screen or request shows how clean the code is.');
      expect(sent!.body.indexOf('The save button saves the settings.')).toBeLessThan(
        sent!.body.indexOf('**1 problem that this pull request introduces.**'),
      );
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it('with the claim check off, reads no claim and asks GitHub for nothing more', async () => {
    const f = await fixture();
    try {
      const { gh, calls, posted } = fakeGh({ body: '## Claims\n\n- The save button saves the settings.' });
      const agents = scripted('introduced', 1);
      const review = await reviewPullRequest(f.root, f.config, 7, {
        gh,
        createRuntime: agents.createRuntime,
        createDriver: screens,
      });
      expect(review.claims).toBeUndefined();
      expect(review.sessions.claims).toBeUndefined();
      expect(agents.tasks.map((task) => task.role)).toEqual(['explorer', 'explorer', 'judge']);
      expect(calls.some((call) => call.args[0] === 'issue')).toBe(false);
      expect(calls.find((call) => call.args[0] === 'pr')!.args.join(' ')).not.toContain('closingIssuesReferences');
      expect(posted()[0]!.body).not.toContain('What this pull request says it does');
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it('on the same commit, tests again when the last review had no claim check', async () => {
    const f = await fixture({ enabled: false });
    try {
      const { gh } = fakeGh({ body: '## Claims\n\n- The save button saves the settings.' });
      const agents = scripted('introduced', 0);
      const run = (claims?: boolean) =>
        reviewPullRequest(f.root, f.config, 7, {
          gh,
          createRuntime: agents.createRuntime,
          createDriver: screens,
          dryRun: true,
          claims,
        });
      expect((await run()).claims).toBeUndefined();
      expect((await run(true)).claims).toMatchObject([{ claim: { text: 'The save button saves the settings.' } }]);
      expect(agents.tasks).toHaveLength(2);
      await run(true);
      expect(agents.tasks).toHaveLength(2);
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
      expect(await git(f.source, 'for-each-ref', 'refs/bugpatrol')).toBe('');
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

/**
 * A dark mode switch. On the pull request build it makes the page dark; on
 * the base build it does nothing. `extra` adds elements to the home screen.
 */
function darkApp(build: 'head' | 'base', extra: UiElement[] = []) {
  const toggle: UiElement = {
    ref: 'e1',
    role: 'switch',
    name: 'Dark mode',
    testId: 'dark-mode',
    box: { x: 0, y: 0, width: 10, height: 10 },
    interactive: true,
    enabled: true,
  };
  return new FakeDriver(
    {
      home: { elements: [toggle, ...extra], ...(build === 'head' ? { next: { e1: 'dark' } } : {}) },
      dark: { elements: [toggle], color: 5 },
    },
    'home',
  );
}

/**
 * Each build runs a prepare command that names the build in a file, so the
 * fake driver knows which build it drives, whatever the order of the builds.
 * `drivers` keeps each driver by build. `make` can change one.
 */
function builds(root: string, make: (build: 'head' | 'base', index: number) => FakeDriver = (build) => darkApp(build)) {
  const drivers: { head: FakeDriver[]; base: FakeDriver[] } = { head: [], base: [] };
  const prepare = `cat settings.txt > ${JSON.stringify(join(root, 'build.txt'))}`;
  const createDriver = () => {
    const build = readFileSync(join(root, 'build.txt'), 'utf8').includes('broken') ? 'head' : 'base';
    const driver = make(build, drivers[build].length);
    drivers[build].push(driver);
    return driver;
  };
  return { drivers, prepare, createDriver };
}

const claimConfig = (
  prepare: string,
  github: Record<string, unknown> = { enabled: false },
  review: Record<string, unknown> = {},
) =>
  parseConfig({
    version: 1,
    app: { source: 'source', connect: { url: 'fake://home' } },
    agents: { github, review: { claims: true, ...review }, fixer: { retest: { prepare } } },
  });

type ClaimPlan = {
  /** `flow` turns on the dark mode switch and saves the flow. `skip` and `note` save no flow. */
  explore: Record<string, 'flow' | 'skip' | 'note'>;
  /** The declared benchmark that the judge picks for each claim. */
  benches?: Record<string, string>;
  verdicts: Record<string, { verdict: string; reason: string; saw?: string }>;
};

/** The explorer and the judge of a claim check, scripted. The explorer reports no bug. */
function claimAgents(plan: ClaimPlan, before?: (task: RoleTask) => Promise<void>) {
  const tasks: RoleTask[] = [];
  const runtime: Runtime = {
    label: 'scripted',
    async run(task) {
      tasks.push(task);
      if (tool(task, 'report_bug')) {
        await before?.(task);
        for (const [claim, how] of Object.entries(plan.explore)) {
          if (how === 'flow') {
            // A claim routine starts with start_claim.
            expect((await tool(task, 'save_claim').run({ claim, did: 'x', saw: 'y' })).isError).toBe(true);
            await tool(task, 'start_claim').run({ claim });
            await tool(task, 'open').run({ url: 'fake://home' });
            await tool(task, 'tap').run({ ref: 'e1' });
            await tool(task, 'save_claim').run({
              claim,
              did: 'Opened the home page and turned on the dark mode switch.',
              saw: 'The page went dark.',
            });
          } else if (how === 'skip') {
            await tool(task, 'skip_claim').run({ claim, reason: 'The export needs a paid account.' });
          } else {
            await tool(task, 'note_claim').run({
              claim,
              did: 'Saved the settings and waited for the toast.',
              saw: 'The toast showed for about two seconds.',
              reason: 'The toast hides on a timer, so a replay cannot catch it.',
            });
          }
        }
        await tool(task, 'finish').run({ summary: 'Tested the dark mode switch.' });
      } else if (tool(task, 'pick_bench')) {
        // The judge cannot name a benchmark that the config does not declare.
        const invented = await tool(task, 'pick_bench').run({ claim: 'claim-1', bench: 'invented' });
        expect(invented.isError).toBe(true);
        for (const [claim, bench] of Object.entries(plan.benches ?? {}))
          expect((await tool(task, 'pick_bench').run({ claim, bench })).isError).toBeFalsy();
        await tool(task, 'finish').run({ summary: 'Picked.' });
      } else if (tool(task, 'view_claim')) {
        for (const [claim, verdict] of Object.entries(plan.verdicts)) {
          expect((await tool(task, 'view_claim').run({ claim })).isError).toBeFalsy();
          if (verdict.verdict === 'not-proven') {
            // A not-proven verdict says what Bugpatrol saw.
            const bare = await tool(task, 'verdict').run({ claim, verdict: 'not-proven', reason: verdict.reason });
            expect(bare.isError).toBe(true);
          }
          await tool(task, 'verdict').run({ claim, ...verdict });
        }
        await tool(task, 'finish').run({ summary: 'Done.' });
      } else {
        throw new Error(`Unexpected task with tools ${task.tools.map((item) => item.name).join(', ')}`);
      }
      return { stop: 'done', steps: 3, costUsd: 0.5, summary: 'Tested the dark mode switch.' };
    },
  };
  return { tasks, createRuntime: () => runtime };
}

const claimsBody = (...claims: string[]) =>
  `Adds dark mode.\n\n## Claims\n\n${claims.map((claim) => `- ${claim}`).join('\n')}`;

describe('claim check', { timeout: 30_000 }, () => {
  it('replays the flow of a claim on both builds with no model, and shows both builds in the review', async () => {
    const f = await fixture();
    try {
      const app = builds(f.root);
      const config = claimConfig(app.prepare, { enabled: true, repo: 'o/r' });
      const github = fakeGh({ body: claimsBody('The dark mode switch makes the page dark.') });
      const agents = claimAgents({
        explore: { 'claim-1': 'flow' },
        verdicts: {
          'claim-1': { verdict: 'proven', reason: 'The pull request build goes dark, and the base build stays light.' },
        },
      });
      const run = () =>
        reviewPullRequest(f.root, config, 7, {
          gh: github.gh,
          createRuntime: agents.createRuntime,
          createDriver: app.createDriver,
        });
      const review = await run();

      // The explorer and the judge are the only models. The replays use none.
      expect(agents.tasks.map((task) => task.role)).toEqual(['explorer', 'judge']);
      expect(agents.tasks[0]!.prompt).toContain('claim-1: The dark mode switch makes the page dark.');
      expect(review.claims).toMatchObject([
        {
          claim: { id: 'claim-1' },
          verdict: 'proven',
          evidence: 'replay',
          reason: 'The pull request build goes dark, and the base build stays light.',
          did: 'Opened the home page and turned on the dark mode switch.',
          routine: '.bugpatrol/runs/reviews/pr-7/routines/claim-1.json',
          head: { ok: true },
          base: { ok: true },
        },
      ]);
      const [finding] = review.claims!;
      // A screenshot before the first step, and one after each step.
      expect(finding!.head!.shots).toHaveLength(3);
      expect(finding!.base!.shots).toHaveLength(3);
      for (const shot of [...finding!.head!.shots, ...finding!.base!.shots])
        expect(existsSync(join(f.root, shot))).toBe(true);

      // Both builds follow the same steps, each from a fresh driver.
      expect(app.drivers.head).toHaveLength(2);
      expect(app.drivers.base).toHaveLength(1);
      expect(app.drivers.base[0]!.actions).toEqual(app.drivers.head[1]!.actions);
      expect(app.drivers.head[1]!.current).toBe('dark');
      expect(app.drivers.base[0]!.current).toBe('home');

      // The judge sees the last screen of each build.
      const view = await tool(agents.tasks[1]!, 'view_claim').run({ claim: 'claim-1' });
      expect(view.content.filter((item) => item.type === 'image')).toHaveLength(2);

      // The claim routine stays with this review: the patrol knows nothing new.
      const routine = JSON.parse(await readFile(join(f.root, finding!.routine!), 'utf8')) as Routine;
      expect(routine.steps.map((step) => step.kind)).toEqual(['open', 'tap']);
      expect(await f.workspace.listRoutines()).toEqual([]);
      expect(await f.workspace.readAppMap()).toBeUndefined();

      const [sent] = github.posted();
      expect(sent!.body).toContain('#### The dark mode switch makes the page dark.');
      expect(sent!.body).toContain('`proven`');
      expect(sent!.body).toContain('Evidence: a replay of the same steps on both builds, with no model.');
      expect(sent!.body).toContain('Opened the home page and turned on the dark mode switch.');
      expect(sent!.body).toContain(`\`${f.head.slice(0, 7)}\``);
      expect(sent!.body).toContain(`\`${f.base.slice(0, 7)}\``);
      expect(
        sent!.body.match(/<img src="https:\/\/github\.com\/o\/r\/blob\/bugpatrol-assets\/pr-7\//g)!.length,
      ).toBeGreaterThanOrEqual(2);

      // The same commit with no --force tests nothing, and updates the review.
      github.state.reviews = `90 ${f.head}`;
      await run();
      expect(agents.tasks).toHaveLength(2);
      expect(app.drivers.head).toHaveLength(2);
      expect(github.posted()).toHaveLength(1);
      expect(github.sent('PUT', '/reviews/').map((call) => call.path)).toEqual(['repos/o/r/pulls/7/reviews/90']);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it('says what Bugpatrol saw on a not-proven claim, and lists the claims it could not test with the reason', async () => {
    const f = await fixture();
    try {
      // Only the explorer's build shows a tip to close, so the replay of claim-2 fails partway.
      const tip: UiElement = {
        ref: 'e2',
        role: 'button',
        name: 'Close tip',
        box: { x: 0, y: 20, width: 10, height: 10 },
        interactive: true,
        enabled: true,
      };
      const app = builds(f.root, (build, index) => darkApp(build, build === 'head' && index === 0 ? [tip] : []));
      const { gh, calls } = fakeGh({
        body: claimsBody(
          'The dark mode switch makes the header dark.',
          'Closing the tip keeps the page light.',
          'Export works for free accounts.',
          'A save shows a toast.',
          'The settings page loads faster.',
        ),
      });
      const agents = claimAgents(
        {
          explore: { 'claim-1': 'flow', 'claim-3': 'skip', 'claim-4': 'note' },
          verdicts: {
            'claim-1': {
              verdict: 'not-proven',
              reason: 'The page goes dark on this build, and the header stays light.',
              saw: 'The header kept its light background.',
            },
            'claim-4': { verdict: 'partly-proven', reason: 'The toast shows, and the explorer saw it once only.' },
          },
        },
        async (task) => {
          await tool(task, 'start_claim').run({ claim: 'claim-2' });
          await tool(task, 'open').run({ url: 'fake://home' });
          await tool(task, 'tap').run({ ref: 'e2' });
          await tool(task, 'save_claim').run({
            claim: 'claim-2',
            did: 'Closed the tip.',
            saw: 'The page stayed light.',
          });
        },
      );
      const review = await reviewPullRequest(f.root, claimConfig(app.prepare), 7, {
        gh,
        createRuntime: agents.createRuntime,
        createDriver: app.createDriver,
        dryRun: true,
        // A step whose target never shows gives up fast.
        replayWindowMs: 50,
      });
      const byId = Object.fromEntries(review.claims!.map((finding) => [finding.claim.id, finding]));
      expect(byId['claim-1']).toMatchObject({
        verdict: 'not-proven',
        evidence: 'replay',
        saw: 'The header kept its light background.',
      });
      // A replay that fails partway is untested, never not-proven.
      expect(byId['claim-2']).toMatchObject({ verdict: 'untested', head: { ok: false, failedStep: 1 } });
      expect(byId['claim-2']!.evidence).toBeUndefined();
      expect(byId['claim-2']!.reason).toContain('The replay on the pull request build stopped at step 2');
      expect(byId['claim-3']).toMatchObject({ verdict: 'untested', reason: 'The export needs a paid account.' });
      expect(byId['claim-4']).toMatchObject({
        verdict: 'partly-proven',
        evidence: 'explored',
        saw: 'The toast showed for about two seconds.',
      });
      expect(byId['claim-5']).toMatchObject({ verdict: 'untested', reason: 'The explorer did not reach this claim.' });
      // claim-2 stopped on the pull request build, so the base build does not replay it.
      expect(app.drivers.head).toHaveLength(3);
      expect(app.drivers.base).toHaveLength(1);

      // The dry run writes the review and the screenshots locally, and calls nothing on GitHub.
      expect(calls.some((call) => call.args.includes('POST') || call.args.includes('PUT'))).toBe(false);
      const file = await readFile(join(f.root, '.bugpatrol', 'runs', 'reviews', 'pr-7.md'), 'utf8');
      expect(file).toContain(`<img src="${join(f.root, byId['claim-1']!.head!.shots.at(-1)!)}"`);
      expect(file).toContain('Bugpatrol saw: The header kept its light background.');
      expect(file).toContain('Evidence: the explorer and the judge, with no replay.');
      expect(file).toContain('Claims that Bugpatrol could not test (3)');
      expect(file).toContain('Bugpatrol saw: The toast showed for about two seconds.');
      const untested = file.slice(file.indexOf('Claims that Bugpatrol could not test'));
      expect(untested).toContain('Export works for free accounts.');
      expect(untested).toContain('The export needs a paid account.');
      expect(untested).toContain('The explorer did not reach this claim.');
      expect(untested).not.toContain('The dark mode switch makes the header dark.');
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it('stops with an error when a build does not start for a claim replay, and gives no verdict', async () => {
    const f = await fixture();
    try {
      const app = builds(f.root);
      // The base build does not install.
      const config = claimConfig(`${app.prepare} && grep -q broken settings.txt`);
      const { gh } = fakeGh({ body: claimsBody('The dark mode switch makes the page dark.') });
      const agents = claimAgents({ explore: { 'claim-1': 'flow' }, verdicts: {} });
      await expect(
        reviewPullRequest(f.root, config, 7, {
          gh,
          createRuntime: agents.createRuntime,
          createDriver: app.createDriver,
          dryRun: true,
        }),
      ).rejects.toThrow();
      const record = await f.workspace.readReview(7);
      expect(record).toMatchObject({ status: 'failed' });
      expect(record!.claims?.some((finding) => finding.verdict !== 'untested') ?? false).toBe(false);
      expect(existsSync(join(f.root, '.bugpatrol', 'runs', 'reviews', 'pr-7.md'))).toBe(false);
      expect(agents.tasks.map((task) => task.role)).toEqual(['explorer']);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
});

/** Reads `time: <n> ms` from the output of a benchmark. */
const TIME = 'time: (\\d+(?:\\.\\d+)?) ms';

describe('claim check with benchmarks', { timeout: 30_000 }, () => {
  it('runs a picked benchmark on the two builds in turn, and overlapping spreads give at most partly-proven', async () => {
    const f = await fixture();
    try {
      const app = builds(f.root);
      // Each run prints the next number of a counter that both builds share, so the order of the runs shows.
      const counter = JSON.stringify(join(f.root, 'counter.txt'));
      const config = claimConfig(
        app.prepare,
        { enabled: true, repo: 'o/r' },
        {
          benches: [
            {
              name: 'settings-load',
              command: `n=$(cat ${counter} 2>/dev/null || echo 0); echo $((n + 1)) > ${counter}; echo "time: $((10 + n)) ms"`,
              metric: 'load time in ms',
              parse: TIME,
              runs: 3,
            },
            { name: 'broken', command: 'echo "no timing here"', metric: 'load time in ms', parse: TIME },
          ],
        },
      );
      const github = fakeGh({
        body: claimsBody('The settings page loads faster.', 'The home page loads faster.', 'Dark mode works.'),
      });
      const agents = claimAgents({
        explore: { 'claim-3': 'flow' },
        benches: { 'claim-1': 'settings-load', 'claim-2': 'broken' },
        verdicts: {
          'claim-1': { verdict: 'proven', reason: 'The pull request build is faster.' },
          'claim-3': { verdict: 'proven', reason: 'The page goes dark.' },
        },
      });
      const review = await reviewPullRequest(f.root, config, 7, {
        gh: github.gh,
        createRuntime: agents.createRuntime,
        createDriver: app.createDriver,
      });

      // The judge picks the benchmarks before the explorer runs, and the explorer gets only the other claims.
      expect(agents.tasks.map((task) => task.role)).toEqual(['judge', 'explorer', 'judge']);
      expect(agents.tasks[0]!.prompt).toContain('settings-load: load time in ms');
      const toTest = agents.tasks[1]!.prompt.slice(agents.tasks[1]!.prompt.indexOf('CLAIMS TO TEST'));
      expect(toTest).toContain('claim-3: Dark mode works.');
      expect(toTest).not.toContain('claim-1');

      const byId = Object.fromEntries(review.claims!.map((finding) => [finding.claim.id, finding]));
      // A, B, A, B: the base build runs first, then the pull request build, three times.
      expect(byId['claim-1']).toMatchObject({
        verdict: 'partly-proven',
        evidence: 'bench',
        bench: {
          name: 'settings-load',
          runs: 3,
          base: { values: [10, 12, 14], median: 12, min: 10, max: 14 },
          head: { values: [11, 13, 15], median: 13, min: 11, max: 15 },
        },
      });
      expect(byId['claim-1']!.reason).toContain('The spreads of the two builds overlap');
      // A benchmark whose output does not match its parse rule tests nothing.
      expect(byId['claim-2']).toMatchObject({ verdict: 'untested' });
      expect(byId['claim-2']!.evidence).toBeUndefined();
      expect(byId['claim-2']!.reason).toContain('broken');
      expect(byId['claim-3']).toMatchObject({ verdict: 'proven', evidence: 'replay' });

      // The judge sees the numbers of both builds.
      const view = await tool(agents.tasks[2]!, 'view_claim').run({ claim: 'claim-1' });
      const text = view.content.map((item) => (item.type === 'text' ? item.text : '')).join('\n');
      expect(text).toContain('median 12');
      expect(text).toContain('median 13');

      const [sent] = github.posted();
      expect(sent!.body).toContain('#### The settings page loads faster.');
      expect(sent!.body).toContain('Evidence: a benchmark on both builds.');
      expect(sent!.body).toContain('| Median | 12 | 13 |');
      expect(sent!.body).toContain('| Spread | 10 to 14 | 11 to 15 |');
      expect((await git(f.source, 'worktree', 'list')).split('\n')).toHaveLength(1);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it('keeps the verdict of the judge when one build is slower beyond the noise', async () => {
    const f = await fixture();
    try {
      const app = builds(f.root);
      // A real timing: the pull request build waits 150 ms more.
      const script = join(f.root, 'bench.mjs');
      await writeFile(
        script,
        [
          "import { readFileSync } from 'node:fs';",
          'const start = performance.now();',
          "if (readFileSync('settings.txt', 'utf8').includes('broken')) await new Promise((done) => setTimeout(done, 150));",
          'console.log(`time: ${(performance.now() - start).toFixed(1)} ms`);',
        ].join('\n'),
      );
      const config = claimConfig(app.prepare, undefined, {
        benches: [{ name: 'settings-load', command: `node ${JSON.stringify(script)}`, metric: 'ms', parse: TIME }],
      });
      const { gh } = fakeGh({ body: claimsBody('The settings page loads faster.') });
      const agents = claimAgents({
        explore: {},
        benches: { 'claim-1': 'settings-load' },
        verdicts: {
          'claim-1': { verdict: 'not-proven', reason: 'The pull request build is slower.', saw: 'About 150 ms more.' },
        },
      });
      const review = await reviewPullRequest(f.root, config, 7, {
        gh,
        createRuntime: agents.createRuntime,
        createDriver: app.createDriver,
        dryRun: true,
      });
      const [finding] = review.claims!;
      expect(finding).toMatchObject({ verdict: 'not-proven', evidence: 'bench', saw: 'About 150 ms more.' });
      // The default count of runs.
      expect(finding!.bench!.head.values).toHaveLength(5);
      expect(finding!.bench!.head.min).toBeGreaterThan(finding!.bench!.base.max);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
});

describe('numbered diff', () => {
  it('numbers the lines of the new file, and lists the lines that take a comment', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -10,3 +10,3 @@ function a() {',
      ' keep',
      '-old',
      '+new',
      ' end',
      'diff --git a/gone.ts b/gone.ts',
      '--- a/gone.ts',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-bye',
    ].join('\n');
    const { text, lines } = numberDiff(diff);
    expect(text.split('\n').slice(4, 8)).toEqual(['    10 keep', '-      old', '+   11 new', '    12 end']);
    expect([...lines.keys()]).toEqual(['src/a.ts']);
    expect([...lines.get('src/a.ts')!]).toEqual([10, 11, 12]);
  });
});

describe('review rendering', () => {
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
        file: 'src/a.ts',
        line: 11,
        steps: [],
        head: 'head2.png',
        base: 'base2.png',
      },
      {
        candidateId: 'can_5',
        verdict: 'introduced',
        title: 'A problem on a line outside the diff',
        severity: 'major',
        reason: 'Major reason.',
        file: 'src/a.ts',
        line: 400,
        steps: [],
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
  const render = () =>
    renderReview(
      review,
      (path) => `https://img/${path}`,
      (file, line) => file === 'src/a.ts' && line === 11,
    );

  it('puts a problem on its line, and keeps the others in the body, worst first', () => {
    const { body, comments } = render();
    expect(comments).toEqual([{ path: 'src/a.ts', line: 11, body: expect.stringContaining('**A critical problem**') }]);
    expect(comments[0]!.body).toContain(
      '| <img src="https://img/base2.png" width="360"> | <img src="https://img/head2.png" width="360"> |',
    );
    expect(body.startsWith(REVIEW_MARKER)).toBe(true);
    expect(body).toContain('**3 problems that this pull request introduces.**');
    expect(body).toContain('1 of them is a comment on the changed line that causes it. The others are below.');
    expect(body).toContain('(`aaaaaaa`) and from its base (`bbbbbbb` on `main`)');
    expect(body).not.toContain('A critical problem');
    // A line that the diff does not show would make GitHub refuse the review.
    expect(body.indexOf('#### 1. A problem on a line outside the diff')).toBeLessThan(
      body.indexOf('#### 2. A minor problem'),
    );
    // With no base screenshot, the cell says why.
    expect(body).toContain('| _Not reached on the base build. The screen is new._ | <img src="https://img/head.png"');
    expect(body).toContain(
      '<details><summary>Steps</summary>\n\n1. Run the routine enter-app\n2. Tap Save\n\n</details>',
    );
    expect(body).toContain('<details><summary>Could not compare (1)</summary>');
    expect(body).toContain('<details><summary>Reported, then judged not a bug (1)</summary>');
    expect(body).not.toContain('Already on `main`');
    expect(body).toContain('This review does not block the merge.');
  });
});
