import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { type Candidate, type FixProposal, type Issue, parseConfig, paths } from '@bugpatrol/core';
import { describe, expect, it } from 'vitest';
import { pullSource, runPatrol, sourceCommit } from './patrol.js';
import { runFixer } from './roles/fixer.js';
import { recheckMerged, retestFix, retestTargets, runFixCycle } from './roles/retest.js';
import { AgentSession } from './session.js';
import { FakeDriver } from './testing/fake-driver.js';
import type { Runtime } from './types.js';
import { Vars } from './vars.js';
import { Workspace } from './workspace.js';

const exec = promisify(execFile);
async function git(cwd: string, ...args: string[]) {
  return exec('git', args, { cwd });
}

async function repoFixture() {
  const root = await mkdtemp(join(tmpdir(), 'bugpatrol-fixer-'));
  const source = join(root, 'source');
  await exec('mkdir', ['-p', source]);
  await git(source, 'init');
  await git(source, 'config', 'user.email', 'test@example.com');
  await git(source, 'config', 'user.name', 'Bugpatrol Test');
  await git(source, 'config', 'commit.gpgsign', 'false');
  await git(source, 'config', 'core.hooksPath', '/dev/null');
  await writeFile(join(source, 'app.txt'), 'broken\n');
  await git(source, 'add', '-A');
  await git(source, 'commit', '-m', 'initial');
  const workspace = new Workspace(root);
  const issue: Issue = {
    version: 1,
    id: 'iss_1',
    fingerprint: 'fp',
    title: 'Screen is broken',
    body: 'What happened: broken\nExpected: fixed',
    severity: 'major',
    status: 'new',
    candidateIds: [],
    evidence: { steps: [{ kind: 'open', url: 'fake://home' }] },
    judgement: { by: 'judge', reason: 'visible', at: 'now' },
    occurrences: 1,
    firstSeenAt: 'now',
    lastSeenAt: 'now',
  };
  await workspace.saveIssue(issue);
  const config = parseConfig({
    version: 1,
    app: { source: 'source', connect: { url: 'fake://home' } },
    agents: { fixer: { enabled: true, use: { runtime: 'cli', command: 'fake' }, verify: 'test -f app.txt' } },
  });
  const record = await workspace.startSession('fixer');
  return { root, source, workspace, config, session: new AgentSession(root, config, new Vars(), record.id, 'fixer') };
}

describe('fixer', () => {
  it('skips a fix rejected by the team unless explicitly selected', async () => {
    const f = await repoFixture();
    try {
      const issue = (await f.workspace.readIssue('iss_1'))!;
      await f.workspace.saveIssue({
        ...issue,
        status: 'filed',
        fixRejected: { pr: 7, url: 'https://github.com/o/r/pull/7', at: 'now' },
      });
      let calls = 0;
      const runtime: Runtime = {
        label: 'fake',
        async run() {
          calls++;
          return { stop: 'done', steps: 0, costUsd: 0 };
        },
      };
      expect(await runFixer(f.session, runtime)).toEqual([]);
      expect(calls).toBe(0);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
  it('creates a worktree branch, captures diff, verifies, and commits locally', async () => {
    const f = await repoFixture();
    try {
      const runtime: Runtime = {
        label: 'cli:fake',
        async run(task) {
          expect(task.system).toContain('You are a senior engineer on this codebase');
          expect(task.prompt).toContain('Run the routine (none), then:\n1. Open fake://home');
          await writeFile(join(task.workdir!, 'app.txt'), 'fixed\n');
          return { stop: 'done', steps: 1, costUsd: 0, summary: 'Fixed screen' };
        },
      };
      const [proposal] = await runFixer(f.session, runtime);
      expect(proposal).toMatchObject({ status: 'retesting', branch: 'bugpatrol/fix-iss_1' });
      expect(proposal?.diff).toContain('+fixed');
      expect(await f.workspace.readIssue('iss_1')).toMatchObject({ status: 'fix-proposed', fixId: 'fix_iss_1' });
      expect((await git(proposal!.worktree, 'log', '-1', '--pretty=%s')).stdout.trim()).toBe('fix: screen is broken');
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it('marks a proposal failed when the runtime changes nothing', async () => {
    const f = await repoFixture();
    try {
      const runtime: Runtime = {
        label: 'cli:fake',
        async run() {
          return { stop: 'done', steps: 0, costUsd: 0 };
        },
      };
      const [proposal] = await runFixer(f.session, runtime);
      expect(proposal).toMatchObject({ status: 'failed', error: 'The fixer made no change and gave no reason.' });
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it('records a declined fix when the runtime explains why nothing changed', async () => {
    const f = await repoFixture();
    try {
      const runtime: Runtime = {
        label: 'cli:fake',
        async run() {
          return { stop: 'done', steps: 1, costUsd: 0, summary: 'The overlay is hidden by design (app.txt:1).' };
        },
      };
      const [proposal] = await runFixer(f.session, runtime);
      expect(proposal).toMatchObject({ status: 'declined', summary: 'The overlay is hidden by design (app.txt:1).' });
      expect(proposal!.error).toBeUndefined();
      expect((await f.workspace.readMemory()).lessons).toMatchObject([
        {
          role: 'judge',
          source: 'fixer-decline',
          text: expect.stringContaining('The overlay is hidden by design'),
        },
      ]);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it('retries a failed proposal from a clean worktree', async () => {
    const f = await repoFixture();
    try {
      let attempts = 0;
      const runtime: Runtime = {
        label: 'cli:fake',
        async run(task) {
          attempts++;
          if (attempts === 1) {
            await writeFile(join(task.workdir!, 'scratch.txt'), 'leftover');
            return { stop: 'error', steps: 1, costUsd: 0, error: 'first attempt failed' };
          }
          await expect(readFile(join(task.workdir!, 'scratch.txt'), 'utf8')).rejects.toThrow();
          await writeFile(join(task.workdir!, 'app.txt'), 'fixed\n');
          return { stop: 'done', steps: 1, costUsd: 0, summary: '**Fixed** the screen' };
        },
      };
      expect((await runFixer(f.session, runtime))[0]?.status).toBe('failed');
      const [proposal] = await runFixer(f.session, runtime);
      expect(proposal?.status).toBe('retesting');
      expect(proposal?.summary).toBe('**Fixed** the screen');
      expect((await f.workspace.readIssue('iss_1'))?.status).toBe('fix-proposed');
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it('keeps a verified diff proposed when the commit hook rejects it', async () => {
    const f = await repoFixture();
    try {
      const hooks = join(f.root, 'hooks');
      await mkdir(hooks);
      const hook = join(hooks, 'pre-commit');
      await writeFile(hook, '#!/bin/sh\necho "error: rejected by test hook" >&2\nexit 1\n');
      await chmod(hook, 0o755);
      await git(f.source, 'config', 'core.hooksPath', hooks);
      const runtime: Runtime = {
        label: 'cli:fake',
        async run(task) {
          await writeFile(join(task.workdir!, 'app.txt'), 'fixed\n');
          return { stop: 'done', steps: 1, costUsd: 0, summary: 'Fixed' };
        },
      };
      const [proposal] = await runFixer(f.session, runtime);
      expect(proposal?.status).toBe('proposed');
      expect(proposal?.error).toContain('rejected by test hook');
      expect((await f.workspace.readMemory()).lessons[0]).toMatchObject({
        role: 'fixer',
        source: 'commit-hook',
        text: expect.stringContaining('rejected by test hook'),
      });
      expect((await f.workspace.readIssue('iss_1'))?.status).toBe('fix-proposed');
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
});

describe('fix attempts', () => {
  /** A verify command that passes only once app.txt says "fixed", like a type check. */
  function strict(f: Awaited<ReturnType<typeof repoFixture>>, attempts?: number) {
    const config = parseConfig({
      ...f.config,
      agents: {
        ...f.config.agents,
        fixer: {
          ...f.config.agents.fixer,
          verify: 'grep -q "^fixed$" app.txt || { echo "error TS2304: Cannot find name fixd." >&2; exit 2; }',
          ...(attempts ? { attempts } : {}),
        },
      },
    });
    return new AgentSession(f.root, config, new Vars(), f.session.sessionId, 'fixer');
  }

  it('records a failed verify as an attempt with its diff and output', async () => {
    const f = await repoFixture();
    try {
      const runtime: Runtime = {
        label: 'cli:fake',
        async run(task) {
          await writeFile(join(task.workdir!, 'app.txt'), 'fixd\n');
          return { stop: 'done', steps: 1, costUsd: 0.5, summary: 'Fixed' };
        },
      };
      const [proposal] = await runFixer(strict(f), runtime);
      expect(proposal?.status).toBe('failed');
      const fix = (await f.workspace.readFix('fix_iss_1'))!;
      expect(fix.attempts).toMatchObject([
        {
          n: 1,
          kind: 'first',
          outcome: 'verify-failed',
          verifyOutput: expect.stringContaining('error TS2304'),
          diffStat: expect.stringContaining('app.txt'),
          costUsd: 0.5,
        },
      ]);
      const diff = await readFile(paths.fixAttemptDiff(f.root, 'fix_iss_1', 1), 'utf8');
      expect(diff).toContain('-broken');
      expect(diff).toContain('+fixd');
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it('reruns after a failed verify on the kept change, with the verify output', async () => {
    const f = await repoFixture();
    try {
      const prompts: string[] = [];
      const runtime: Runtime = {
        label: 'cli:fake',
        async run(task) {
          prompts.push(task.prompt);
          const now = await readFile(join(task.workdir!, 'app.txt'), 'utf8');
          await writeFile(
            join(task.workdir!, 'app.txt'),
            prompts.length === 1 ? 'fixd\n' : now.replace('fixd', 'fixed'),
          );
          return { stop: 'done', steps: 1, costUsd: 0, summary: `Attempt ${prompts.length}` };
        },
      };
      const session = strict(f);
      expect((await runFixer(session, runtime))[0]?.status).toBe('failed');
      const [proposal] = await runFixer(session, runtime);
      expect(proposal?.status).toBe('retesting');
      expect(prompts[0]).not.toContain('Earlier fix attempts');
      expect(prompts[1]).toContain('Earlier fix attempts on this issue:\n1. first, verify-failed');
      expect(prompts[1]).toContain('app.txt | 2');
      expect(prompts[1]).toContain('error TS2304: Cannot find name fixd.');
      expect(prompts[1]).toContain('Your last change is still in the worktree');
      expect(proposal?.attempts?.map((item) => [item.n, item.kind, item.outcome])).toEqual([
        [1, 'first', 'verify-failed'],
        [2, 'rerun', 'proposed'],
      ]);
      expect(await f.workspace.readFixAttemptDiff('fix_iss_1', 2)).toContain('+fixed');
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it('saves the change of a killed fixer, then reruns from a clean worktree with that change in the prompt', async () => {
    const f = await repoFixture();
    try {
      const prompts: string[] = [];
      const runtime: Runtime = {
        label: 'cli:fake',
        async run(task) {
          prompts.push(task.prompt);
          if (prompts.length === 1) {
            await writeFile(join(task.workdir!, 'app.txt'), 'half done\n');
            return { stop: 'timeout', steps: 9, costUsd: 0 };
          }
          expect(await readFile(join(task.workdir!, 'app.txt'), 'utf8')).toBe('broken\n');
          await writeFile(join(task.workdir!, 'app.txt'), 'fixed\n');
          return { stop: 'done', steps: 1, costUsd: 0, summary: 'Fixed' };
        },
      };
      const [first] = await runFixer(f.session, runtime);
      expect(first?.attempts?.[0]).toMatchObject({ kind: 'first', outcome: 'timeout' });
      // A killed fixer leaves its attempt open and its fix running.
      const killed = (await f.workspace.readFix('fix_iss_1'))!;
      await f.workspace.saveFix({
        ...killed,
        status: 'running',
        startedAt: new Date(0).toISOString(),
        attempts: [...killed.attempts!, { n: 2, kind: 'rerun', startedAt: new Date(0).toISOString() }],
      });
      await writeFile(join(killed.worktree, 'app.txt'), 'killed midway\n');
      const [proposal] = await runFixer(f.session, runtime);
      expect(proposal?.status).toBe('retesting');
      expect(proposal?.attempts?.map((item) => [item.n, item.kind, item.outcome])).toEqual([
        [1, 'first', 'timeout'],
        [2, 'rerun', 'abandoned'],
        [3, 'rerun', 'proposed'],
      ]);
      expect(await f.workspace.readFixAttemptDiff('fix_iss_1', 1)).toContain('+half done');
      expect(await f.workspace.readFixAttemptDiff('fix_iss_1', 2)).toContain('+killed midway');
      expect(prompts[1]).toContain('2. rerun, abandoned');
      expect(prompts[1]).toContain('The worktree starts clean.');
      expect(prompts[1]).toContain('+killed midway');
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it('hands a long last change to the rerun as a file that stays out of the fix', async () => {
    const f = await repoFixture();
    try {
      const long = `${'x'.repeat(30_000)}\n`;
      let runs = 0;
      const runtime: Runtime = {
        label: 'cli:fake',
        async run(task) {
          if (++runs === 1) {
            await writeFile(join(task.workdir!, 'app.txt'), long);
            return { stop: 'error', steps: 1, costUsd: 0, error: 'crashed' };
          }
          expect(task.prompt).toContain('.bugpatrol-last-attempt.diff');
          expect(task.prompt).not.toContain('xxxxxxxxxx');
          expect(await readFile(join(task.workdir!, '.bugpatrol-last-attempt.diff'), 'utf8')).toContain(long.trim());
          await writeFile(join(task.workdir!, 'app.txt'), 'fixed\n');
          return { stop: 'done', steps: 1, costUsd: 0, summary: 'Fixed' };
        },
      };
      expect((await runFixer(f.session, runtime))[0]?.attempts?.[0]?.outcome).toBe('error');
      const [proposal] = await runFixer(f.session, runtime);
      expect(runs).toBe(2);
      expect(proposal?.status).toBe('retesting');
      expect(proposal?.diffStat).not.toContain('.bugpatrol-last-attempt.diff');
      expect((await git(proposal!.worktree, 'show', '--stat', 'HEAD')).stdout).not.toContain('last-attempt');
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it('counts a fix record from before attempts were kept as having none', async () => {
    const f = await repoFixture();
    try {
      await f.workspace.saveFix({
        version: 1,
        id: 'fix_iss_1',
        issueId: 'iss_1',
        status: 'failed',
        runtime: 'cli:fake',
        repo: f.source,
        branch: 'bugpatrol/fix-iss_1',
        worktree: join(paths.worktrees(f.root), 'iss_1'),
        startedAt: new Date(0).toISOString(),
        error: 'old failure',
      });
      const runtime: Runtime = {
        label: 'cli:fake',
        async run(task) {
          expect(task.prompt).not.toContain('Earlier fix attempts');
          await writeFile(join(task.workdir!, 'app.txt'), 'fixed\n');
          return { stop: 'done', steps: 1, costUsd: 0, summary: 'Fixed' };
        },
      };
      const [proposal] = await runFixer(strict(f, 1), runtime);
      expect(proposal?.status).toBe('retesting');
      expect(proposal?.attempts).toMatchObject([{ n: 1, outcome: 'proposed' }]);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it('gives up on an issue after the configured attempts unless the issue is named', async () => {
    const f = await repoFixture();
    try {
      let runs = 0;
      const runtime: Runtime = {
        label: 'cli:fake',
        async run() {
          runs++;
          return { stop: 'error', steps: 1, costUsd: 0, error: 'crashed' };
        },
      };
      const session = strict(f, 2);
      await runFixer(session, runtime);
      const [second] = await runFixer(session, runtime);
      expect(second?.error).toMatch(/^Gave up after 2 fix attempts\. The last one: .*crashed/);
      expect(await runFixer(session, runtime)).toEqual([]);
      expect(runs).toBe(2);
      const [named] = await runFixer(session, runtime, { issueIds: ['iss_1'] });
      expect(runs).toBe(3);
      expect(named?.attempts).toHaveLength(3);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
});

describe('fix cycle', () => {
  it('rechecks a merged fix on the main checkout and closes the issue', async () => {
    const f = await repoFixture();
    try {
      const worktree = join(f.root, 'worktree');
      await mkdir(worktree);
      const fix: FixProposal = {
        version: 1,
        id: 'fix_iss_1',
        issueId: 'iss_1',
        status: 'verified',
        runtime: 'scripted',
        repo: f.source,
        worktree,
        branch: 'fix-branch',
        startedAt: 'now',
        pr: { number: 7, url: 'https://github.com/o/r/pull/7', draft: false, state: 'merged' },
      };
      await f.workspace.saveFix(fix);
      const config = parseConfig({
        ...f.config,
        app: { ...f.config.app, setup: [{ run: 'pwd > main-source', cwd: 'source' }] },
        agents: { ...f.config.agents, fixer: { ...f.config.agents.fixer, retest: { prepare: 'touch prepare-ran' } } },
      });
      const result = await recheckMerged(f.root, config, {
        isMerged: async () => {
          throw new Error('PR state was ignored');
        },
        createDriver: () => new FakeDriver({ home: { elements: [] } }),
        createRuntime: () => ({
          label: 'scripted',
          async run(task) {
            if (task.role === 'explorer')
              await task.tools
                .find((tool) => tool.name === 'capture_after')!
                .run({ target: 1, note: 'Problem gone', reached: true });
            if (task.role === 'judge')
              await task.tools.find((tool) => tool.name === 'verdict')!.run({ outcome: 'fixed', reason: 'Gone' });
            return { stop: 'done', steps: 1, costUsd: 0 };
          },
        }),
      });
      expect(result.closed).toEqual(['iss_1']);
      expect((await f.workspace.readFix(fix.id))?.retests?.[0]).toMatchObject({ build: 'main', outcome: 'fixed' });
      expect(await f.workspace.readIssue('iss_1')).toMatchObject({ status: 'fixed', closedBy: { by: 'Bugpatrol' } });
      expect((await readFile(join(f.source, 'main-source'), 'utf8')).trim()).toBe(await realpath(f.source));
      expect(existsSync(join(worktree, 'prepare-ran'))).toBe(false);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
  it('records a fixed verdict and the explorer and judge sessions', async () => {
    const f = await repoFixture();
    try {
      const issue = (await f.workspace.readIssue('iss_1'))!;
      await f.workspace.saveIssue({ ...issue, evidence: { ...issue.evidence, routineId: 'enter-app' } });
      await f.workspace.saveRoutine({
        version: 1,
        id: 'enter-app',
        description: 'Enter app',
        platform: 'web',
        steps: [{ kind: 'open', url: 'fake://home' }],
        createdAt: 'now',
        updatedAt: 'now',
      });
      const config = parseConfig({
        ...f.config,
        app: {
          ...f.config.app,
          setup: [{ run: 'pwd > retest-cwd; echo "$BUGPATROL_SOURCE" > retest-source', cwd: 'source' }],
        },
      });
      const driver = new FakeDriver({ home: { elements: [] } });
      const roles: string[] = [];
      const [fix] = await runFixCycle(f.root, config, {
        createDriver: () => driver,
        createRuntime: () => ({
          label: 'scripted',
          async run(task) {
            roles.push(task.role);
            if (task.role === 'fixer') await writeFile(join(task.workdir!, 'app.txt'), 'fixed\n');
            if (task.role === 'explorer') {
              await task.tools.find((tool) => tool.name === 'run_routine')!.run({ id: 'enter-app' });
              await task.tools.find((tool) => tool.name === 'replay_issue_steps')!.run({ target: 1 });
              await task.tools
                .find((tool) => tool.name === 'capture_after')!
                .run({ target: 1, note: 'Reached home', reached: true });
            }
            if (task.role === 'judge')
              await task.tools
                .find((tool) => tool.name === 'verdict')!
                .run({ outcome: 'fixed', reason: 'The problem is gone.' });
            return { stop: 'done', steps: 1, costUsd: 0, summary: 'Done' };
          },
        }),
      });
      expect(roles).toEqual(['fixer', 'explorer', 'judge']);
      expect(fix?.status).toBe('verified');
      expect(fix?.retests?.[0]?.after).toContain('retest-after-1.png');
      expect((await f.workspace.listSessions()).map((item) => item.role)).toEqual(
        expect.arrayContaining(['explorer', 'judge']),
      );
      expect((await readFile(join(fix!.worktree, 'retest-cwd'), 'utf8')).trim()).toBe(await realpath(fix!.worktree));
      expect((await readFile(join(fix!.worktree, 'retest-source'), 'utf8')).trim()).toBe(fix!.worktree);
      expect((await f.workspace.readRoutine('enter-app'))?.lastReplay).toBeUndefined();
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it('feeds a not-fixed verdict into a second fixer attempt', async () => {
    const f = await repoFixture();
    try {
      let fixes = 0;
      let verdicts = 0;
      const [fix] = await runFixCycle(f.root, f.config, {
        createDriver: () => new FakeDriver({ home: { elements: [] } }),
        createRuntime: () => ({
          label: 'scripted',
          async run(task) {
            if (task.role === 'fixer') {
              fixes++;
              if (fixes === 2) {
                expect(task.prompt).toContain(
                  'Your last change did not fix the issue in the running app. The QA lead said: Still broken.',
                );
                expect(task.prompt).toContain('call save_lesson');
                expect(task.prompt).toContain('retest-after-1.png');
              }
              await writeFile(join(task.workdir!, 'app.txt'), `fix ${fixes}\n`);
            }
            if (task.role === 'explorer')
              await task.tools
                .find((tool) => tool.name === 'capture_after')!
                .run({ target: 1, note: 'Home', reached: true });
            if (task.role === 'judge')
              await task.tools
                .find((tool) => tool.name === 'verdict')!
                .run({
                  outcome: ++verdicts === 1 ? 'not-fixed' : 'fixed',
                  reason: verdicts === 1 ? 'Still broken.' : 'Fixed.',
                });
            return { stop: 'done', steps: 1, costUsd: 0, summary: 'Done' };
          },
        }),
      });
      expect(fixes).toBe(2);
      expect(fix?.status).toBe('verified');
      expect(fix?.retests?.map((item) => [item.outcome, item.fixAttempt])).toEqual([
        ['not-fixed', 1],
        ['fixed', 2],
      ]);
      expect(fix?.attempts?.map((item) => item.kind)).toEqual(['first', 'refix']);
      expect(fix?.diff).toContain('+fix 2');
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it('leaves a fix proposed when retest is disabled', async () => {
    const f = await repoFixture();
    try {
      const config = parseConfig({
        ...f.config,
        agents: { ...f.config.agents, fixer: { ...f.config.agents.fixer, retest: { enabled: false } } },
      });
      const [fix] = await runFixCycle(f.root, config, {
        createRuntime: () => ({
          label: 'scripted',
          async run(task) {
            await writeFile(join(task.workdir!, 'app.txt'), 'fixed\n');
            return { stop: 'done', steps: 1, costUsd: 0, summary: 'Done' };
          },
        }),
      });
      expect(fix?.status).toBe('proposed');
      expect(fix?.retests).toBeUndefined();
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it('stops after the configured number of not-fixed attempts', async () => {
    const f = await repoFixture();
    try {
      let fixes = 0;
      const [fix] = await runFixCycle(f.root, f.config, {
        createDriver: () => new FakeDriver({ home: { elements: [] } }),
        createRuntime: () => ({
          label: 'scripted',
          async run(task) {
            if (task.role === 'fixer') await writeFile(join(task.workdir!, 'app.txt'), `fix ${++fixes}\n`);
            if (task.role === 'explorer')
              await task.tools
                .find((tool) => tool.name === 'capture_after')!
                .run({ target: 1, note: 'Still broken', reached: true });
            if (task.role === 'judge')
              await task.tools
                .find((tool) => tool.name === 'verdict')!
                .run({ outcome: 'not-fixed', reason: 'Still broken.' });
            return { stop: 'done', steps: 1, costUsd: 0, summary: 'Done' };
          },
        }),
      });
      expect(fixes).toBe(2);
      expect(fix?.retests).toHaveLength(2);
      expect(fix?.status).toBe('proposed');
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it('ends with the change proposed when a not-fixed verdict finds no fix attempts left', async () => {
    const f = await repoFixture();
    try {
      const config = parseConfig({
        ...f.config,
        agents: { ...f.config.agents, fixer: { ...f.config.agents.fixer, attempts: 1 } },
      });
      let fixes = 0;
      const [fix] = await runFixCycle(f.root, config, {
        createDriver: () => new FakeDriver({ home: { elements: [] } }),
        createRuntime: () => ({
          label: 'scripted',
          async run(task) {
            if (task.role === 'fixer') await writeFile(join(task.workdir!, 'app.txt'), `fix ${++fixes}\n`);
            if (task.role === 'explorer')
              await task.tools
                .find((tool) => tool.name === 'capture_after')!
                .run({ target: 1, note: 'Still broken', reached: true });
            if (task.role === 'judge')
              await task.tools
                .find((tool) => tool.name === 'verdict')!
                .run({ outcome: 'not-fixed', reason: 'Still broken.' });
            return { stop: 'done', steps: 1, costUsd: 0, summary: 'Done' };
          },
        }),
      });
      expect(fixes).toBe(1);
      expect(fix?.status).toBe('proposed');
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it('captures a fallback screenshot when the explorer stops without capture_after', async () => {
    const f = await repoFixture();
    try {
      const [fix] = await runFixCycle(f.root, f.config, {
        createDriver: () => new FakeDriver({ home: { elements: [] } }),
        createRuntime: () => ({
          label: 'scripted',
          async run(task) {
            if (task.role === 'fixer') await writeFile(join(task.workdir!, 'app.txt'), 'fixed\n');
            if (task.role === 'judge') {
              expect(task.prompt).toContain('reached: false');
              await task.tools
                .find((tool) => tool.name === 'verdict')!
                .run({ outcome: 'unclear', reason: 'Could not confirm the screen.' });
            }
            return { stop: 'done', steps: 1, costUsd: 0, summary: 'Done' };
          },
        }),
      });
      expect(fix?.retests?.[0]).toMatchObject({
        outcome: 'unclear',
        note: expect.stringContaining('without capture_after'),
      });
      expect(fix?.retests?.[0]?.after).toContain('retest-after-1.png');
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
});

describe('multi-screen retest', () => {
  async function screensFixture() {
    const f = await repoFixture();
    const driver = new FakeDriver({ usage: { elements: [] }, memories: { elements: [] } }, 'usage');
    const beforeUsage = 'before-usage.png';
    const beforeMemories = 'before-memories.png';
    await writeFile(join(f.root, beforeUsage), (await driver.observe()).screenshot);
    driver.current = 'memories';
    await writeFile(join(f.root, beforeMemories), (await driver.observe()).screenshot);
    driver.current = 'usage';
    const record = await f.workspace.startSession('explorer');
    const issue = (await f.workspace.readIssue('iss_1'))!;
    issue.screenId = 'usage';
    issue.evidence = { screenshot: beforeUsage };
    issue.candidateIds = ['cand_usage', 'cand_memories'];
    for (const [id, screenId, screenshot] of [
      ['cand_usage', 'usage', beforeUsage],
      ['cand_memories', 'memories', beforeMemories],
    ] as [string, string, string][]) {
      const candidate: Candidate = {
        id,
        sessionId: record.id,
        screenId,
        source: 'explorer',
        fingerprint: id,
        summary: 'Broken',
        severity: 'major',
        evidence: { screenshot, steps: [{ kind: 'open', url: `fake://${screenId}` }] },
        createdAt: 'now',
      };
      await f.workspace.appendCandidate(record.id, candidate);
    }
    const fix: FixProposal = {
      version: 1,
      id: 'fix_iss_1',
      issueId: issue.id,
      status: 'retesting',
      runtime: 'scripted',
      repo: f.source,
      worktree: f.source,
      branch: 'test',
      startedAt: 'now',
    };
    return { ...f, driver, issue, fix };
  }

  it('captures both affected screens and gives the judge both image pairs', async () => {
    const f = await screensFixture();
    try {
      expect(await retestTargets(f.workspace, f.issue)).toMatchObject([
        { screenId: 'usage', before: 'before-usage.png' },
        { screenId: 'memories', before: 'before-memories.png' },
      ]);
      const retest = await retestFix(f.root, f.config, f.issue, f.fix, 1, {
        createDriver: () => f.driver,
        createRuntime: () => ({
          label: 'scripted',
          async run(task) {
            if (task.role === 'explorer') {
              expect(task.prompt).toContain('1. screen usage');
              expect(task.prompt).toContain('2. screen memories');
              expect(task.maxSteps).toBeGreaterThanOrEqual(24);
              for (const target of [1, 2]) {
                const before = await task.tools.find((tool) => tool.name === 'view_before')!.run({ target });
                expect(before.content.filter((item) => item.type === 'image')).toHaveLength(1);
                await task.tools.find((tool) => tool.name === 'replay_issue_steps')!.run({ target });
                const capture = await task.tools
                  .find((tool) => tool.name === 'capture_after')!
                  .run({ target, note: `Reached ${target}`, reached: true });
                expect(capture.done).toBeUndefined();
              }
              expect(
                (
                  await task.tools
                    .find((tool) => tool.name === 'finish_retest')!
                    .run({ summary: 'Reached both screens' })
                ).done,
              ).toBe(true);
            } else {
              const view = await task.tools.find((tool) => tool.name === 'view_retest')!.run({});
              expect(view.content.filter((item) => item.type === 'image')).toHaveLength(4);
              expect(view.content.map((item) => (item.type === 'text' ? item.text : '')).join('\n')).toContain(
                'Screen 2: memories — reached: true',
              );
              await task.tools
                .find((tool) => tool.name === 'verdict')!
                .run({ outcome: 'fixed', reason: 'Gone on both screens.' });
            }
            return { stop: 'done', steps: 1, costUsd: 0 };
          },
        }),
      });
      expect(retest.shots).toMatchObject([
        { screenId: 'usage', reached: true, note: 'Reached 1' },
        { screenId: 'memories', reached: true, note: 'Reached 2' },
      ]);
      expect(retest.shots?.every((shot) => Boolean(shot.after))).toBe(true);
      expect(retest.before).toBe(retest.shots?.[0]?.before);
      expect(retest.after).toBe(retest.shots?.[0]?.after);
      expect(retest.note).toBe(retest.shots?.[0]?.note);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it('gives the retest explorer the default app guide when app.instructions is unset', async () => {
    const f = await screensFixture();
    try {
      await mkdir(join(f.root, '.bugpatrol'), { recursive: true });
      await writeFile(join(f.root, '.bugpatrol', 'instructions.md'), 'You start signed in on the Home screen.\n');
      const systems: string[] = [];
      await retestFix(f.root, f.config, f.issue, f.fix, 1, {
        createDriver: () => f.driver,
        createRuntime: () => ({
          label: 'scripted',
          async run(task) {
            if (task.role === 'explorer') systems.push(task.system);
            return { stop: 'done', steps: 1, costUsd: 0 };
          },
        }),
      });
      expect(systems).toHaveLength(1);
      expect(systems[0]).toContain('You start signed in on the Home screen.');
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it('refuses the first finish with a missing target and accepts the second', async () => {
    const f = await screensFixture();
    try {
      const retest = await retestFix(f.root, f.config, f.issue, f.fix, 1, {
        createDriver: () => f.driver,
        createRuntime: () => ({
          label: 'scripted',
          async run(task) {
            if (task.role === 'explorer') {
              await task.tools
                .find((tool) => tool.name === 'capture_after')!
                .run({ target: 1, note: 'Usage reached', reached: true });
              const finish = task.tools.find((tool) => tool.name === 'finish_retest')!;
              const first = await finish.run({ summary: 'Could not reach memories' });
              expect(first.isError).toBe(true);
              expect(first.done).toBeUndefined();
              expect(first.content[0]).toMatchObject({ text: expect.stringContaining('2') });
              expect((await finish.run({ summary: 'Could not reach memories' })).done).toBe(true);
            } else {
              await task.tools
                .find((tool) => tool.name === 'verdict')!
                .run({ outcome: 'unclear', reason: 'Memories was not reached.' });
            }
            return { stop: 'done', steps: 1, costUsd: 0 };
          },
        }),
      });
      expect(retest.shots?.[1]).toMatchObject({ reached: false, note: 'The explorer did not reach this screen.' });
      expect(retest.shots?.[1]?.after).toBeUndefined();
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it('deduplicates candidates on the same screen', async () => {
    const f = await screensFixture();
    try {
      f.issue.candidateIds.push('cand_memories_again');
      const session = (await f.workspace.listSessions())[0]!;
      await f.workspace.appendCandidate(session.id, {
        id: 'cand_memories_again',
        sessionId: session.id,
        screenId: 'memories',
        source: 'pixel-diff',
        fingerprint: 'again',
        summary: 'Same screen',
        severity: 'major',
        evidence: { screenshot: 'another.png' },
        createdAt: 'now',
      });
      expect(await retestTargets(f.workspace, f.issue)).toHaveLength(2);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
});

describe('patrol', () => {
  const config = parseConfig({
    version: 1,
    app: { connect: { url: 'fake://home' } },
    agents: { fixer: { enabled: false }, patrol: { cycles: 1 } },
  });

  it('runs explorer then judge and closes the driver', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bugpatrol-patrol-'));
    const driver = new FakeDriver({ home: { elements: [] } });
    const roles: string[] = [];
    try {
      await runPatrol({
        root,
        config,
        once: true,
        createDriver: () => driver,
        createRuntime: () => ({
          label: 'scripted',
          async run(task) {
            roles.push(task.role);
            if (task.role === 'explorer') {
              expect(task.system).toContain('You are the explorer on an automated QA team');
              expect(task.prompt).toContain('KNOWN SCREENS');
              await task.tools
                .find((item) => item.name === 'report_bug')!
                .run({ title: 'Broken home', what_is_wrong: 'Blank', expected: 'Content', severity: 'major' });
            } else if (task.role === 'judge') {
              expect(task.system).toContain('You are the QA lead on an automated QA team');
              expect(task.prompt).toContain('CANDIDATES');
            }
            return { stop: 'done', steps: 1, costUsd: 0, summary: 'Done' };
          },
        }),
      });
      expect(roles).toEqual(['explorer', 'judge']);
      expect(driver.closed).toBe(true);
      expect((await new Workspace(root).readAgents()).patrol?.state).toBe('stopped');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('leaves known screen routines for the explorer to revisit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bugpatrol-patrol-'));
    const workspace = new Workspace(root);
    const now = new Date().toISOString();
    await workspace.saveRoutine({
      version: 1,
      id: 'screen-home',
      description: 'Home',
      platform: 'web',
      steps: [{ kind: 'press', key: 'Enter' }],
      createdAt: now,
      updatedAt: now,
    });
    await workspace.upsertScreen({
      id: 'home',
      name: 'Home',
      description: 'Home',
      platform: 'web',
      routineId: 'screen-home',
    });
    const driver = new FakeDriver({ home: { elements: [] } });
    try {
      await runPatrol({
        root,
        config,
        once: true,
        createDriver: () => driver,
        createRuntime: () => ({
          label: 'scripted',
          async run() {
            return { stop: 'done', steps: 0, costUsd: 0, summary: 'Done' };
          },
        }),
      });
      expect(driver.actions).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('tears down when explorer throws, and reports the problem without a crash', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bugpatrol-patrol-'));
    const driver = new FakeDriver({ home: { elements: [] } });
    const withTeardown = parseConfig({
      version: 1,
      app: { connect: { url: 'fake://home' }, teardown: [{ run: 'touch stopped.txt' }] },
      agents: { fixer: { enabled: false }, patrol: { cycles: 1 } },
    });
    try {
      const result = await runPatrol({
        root,
        config: withTeardown,
        once: true,
        createDriver: () => driver,
        createRuntime: () => ({
          label: 'scripted',
          async run() {
            throw new Error('boom');
          },
        }),
      });
      expect(result.problems).toEqual([expect.stringContaining('boom')]);
      expect(driver.closed).toBe(true);
      expect(await readFile(join(root, 'stopped.txt'), 'utf8')).toBe('');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('stops the patrol app before starting the worktree retest', async () => {
    const f = await repoFixture();
    try {
      const config = parseConfig({
        ...f.config,
        app: { ...f.config.app, teardown: [{ run: 'touch patrol-stopped' }] },
        agents: { ...f.config.agents, patrol: { cycles: 1 } },
      });
      let connections = 0;
      await runPatrol({
        root: f.root,
        config,
        once: true,
        createDriver: () => {
          connections++;
          if (connections === 2) expect(existsSync(join(f.root, 'patrol-stopped'))).toBe(true);
          return new FakeDriver({ home: { elements: [] } });
        },
        createRuntime: () => ({
          label: 'scripted',
          async run(task) {
            if (task.role === 'fixer') await writeFile(join(task.workdir!, 'app.txt'), 'fixed\n');
            if (task.role === 'explorer' && task.tools.some((tool) => tool.name === 'capture_after'))
              await task.tools
                .find((tool) => tool.name === 'capture_after')!
                .run({ target: 1, note: 'Home', reached: true });
            if (task.role === 'judge' && task.tools.some((tool) => tool.name === 'verdict'))
              await task.tools.find((tool) => tool.name === 'verdict')!.run({ outcome: 'fixed', reason: 'Gone.' });
            return { stop: 'done', steps: 1, costUsd: 0, summary: 'Done' };
          },
        }),
      });
      expect(connections).toBe(2);
      expect((await f.workspace.readFix('fix_iss_1'))?.status).toBe('verified');
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
});

describe('patrol pull', () => {
  async function remoteFixture() {
    const f = await repoFixture();
    const remote = join(f.root, 'remote.git');
    await git(f.root, 'clone', '-q', '--bare', f.source, remote);
    await git(f.source, 'remote', 'add', 'origin', remote);
    const other = join(f.root, 'other');
    await git(f.root, 'clone', '-q', remote, other);
    await git(other, 'config', 'user.email', 'test@example.com');
    await git(other, 'config', 'user.name', 'Bugpatrol Test');
    await git(other, 'config', 'commit.gpgsign', 'false');
    await writeFile(join(other, 'app.txt'), 'fixed\n');
    await git(other, 'commit', '-qam', 'fix');
    const branch = (await git(f.source, 'rev-parse', '--abbrev-ref', 'HEAD')).stdout.trim();
    await git(other, 'push', '-q', 'origin', `HEAD:${branch}`);
    const config = parseConfig({
      version: 1,
      app: { source: 'source', connect: { url: 'fake://home' } },
      agents: { patrol: { pull: `origin/${branch}` } },
    });
    return { ...f, config, branch };
  }

  it('checks out the latest remote commit and leaves the local branch as it is', async () => {
    const f = await remoteFixture();
    try {
      const before = (await git(f.source, 'rev-parse', f.branch)).stdout.trim();
      await git(f.source, 'checkout', '-q', '-b', 'feature');
      expect(await pullSource(f.root, f.config)).toBe(true);
      expect((await git(f.source, 'rev-parse', 'HEAD')).stdout.trim()).toBe(
        (await git(f.source, 'rev-parse', `origin/${f.branch}`)).stdout.trim(),
      );
      expect((await git(f.source, 'rev-parse', f.branch)).stdout.trim()).toBe(before);
      expect(await readFile(join(f.source, 'app.txt'), 'utf8')).toBe('fixed\n');
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it('pulls in a linked worktree while another worktree holds the branch', async () => {
    const f = await remoteFixture();
    try {
      const linked = join(f.root, 'linked');
      await git(f.source, 'worktree', 'add', '-q', '-b', 'feature', linked);
      const config = parseConfig({ ...f.config, app: { ...f.config.app, source: 'linked' } });
      expect(await pullSource(f.root, config)).toBe(true);
      expect(await readFile(join(linked, 'app.txt'), 'utf8')).toBe('fixed\n');
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it('keeps the checkout when it has uncommitted changes', async () => {
    const f = await remoteFixture();
    try {
      await writeFile(join(f.source, 'app.txt'), 'work in progress\n');
      const logs: string[] = [];
      expect(await pullSource(f.root, f.config, (message) => logs.push(message))).toBe(false);
      expect(logs[0]).toContain('uncommitted changes');
      expect(await readFile(join(f.source, 'app.txt'), 'utf8')).toBe('work in progress\n');
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it('pulls over routines and an app map that the patrol changed and did not commit', async () => {
    const f = await remoteFixture();
    try {
      const other = join(f.root, 'other');
      await mkdir(join(other, '.bugpatrol', 'routines'), { recursive: true });
      await writeFile(join(other, '.bugpatrol', 'appmap.json'), '{"screens":[]}\n');
      await writeFile(join(other, '.bugpatrol', 'routines', 'enter-app.json'), '{"id":"enter-app"}\n');
      await git(other, 'add', '-A');
      await git(other, 'commit', '-qm', 'routines');
      await git(other, 'push', '-q', 'origin', `HEAD:${f.branch}`);
      // The patrol checks out the source repo; config and routines sit in it.
      const config = parseConfig({ ...f.config, app: { ...f.config.app, source: '.' } });
      expect(await pullSource(f.source, config)).toBe(true);
      await writeFile(join(other, 'app.txt'), 'fixed again\n');
      await git(other, 'commit', '-qam', 'again');
      await git(other, 'push', '-q', 'origin', `HEAD:${f.branch}`);
      await writeFile(join(f.source, '.bugpatrol', 'appmap.json'), '{"screens":[{"id":"home"}]}\n');
      await writeFile(join(f.source, '.bugpatrol', 'routines', 'enter-app.json'), '{"id":"enter-app","steps":[]}\n');

      expect(await sourceCommit(f.source, config)).toBe((await git(f.source, 'rev-parse', 'HEAD')).stdout.trim());
      expect(await pullSource(f.source, config)).toBe(true);
      expect(await readFile(join(f.source, 'app.txt'), 'utf8')).toBe('fixed again\n');
      expect(await readFile(join(f.source, '.bugpatrol', 'appmap.json'), 'utf8')).toContain('home');
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it('skips a cycle when the commit did not change', async () => {
    const f = await repoFixture();
    try {
      const config = parseConfig({
        version: 1,
        app: { source: 'source', connect: { url: 'fake://home' } },
        agents: { judge: { enabled: false }, patrol: { pull: false, cycles: 3, intervalMinutes: 0.0001 } },
      });
      let runs = 0;
      const logs: string[] = [];
      await runPatrol({
        root: f.root,
        config,
        onLog: (message) => logs.push(message),
        createDriver: () => new FakeDriver({ home: { elements: [] } }),
        createRuntime: () => ({
          label: 'scripted',
          async run() {
            runs++;
            if (runs === 1) {
              await writeFile(join(f.source, 'app.txt'), 'fixed\n');
              await git(f.source, 'commit', '-qam', 'fix');
            }
            return { stop: 'done', steps: 0, costUsd: 0, summary: 'Done' };
          },
        }),
      });
      // Cycle 2 sees the new commit, and cycle 3 sees no change.
      expect(runs).toBe(2);
      expect(logs.some((message) => message.startsWith('No new commit'))).toBe(true);
      const head = (await git(f.source, 'rev-parse', 'HEAD')).stdout.trim();
      expect((await new Workspace(f.root).readAgents()).patrol?.commit).toBe(head);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it('still fixes on a tested commit, with no new explore', async () => {
    const f = await repoFixture();
    try {
      const second = {
        ...(await f.workspace.readIssue('iss_1'))!,
        id: 'iss_2',
        fingerprint: 'fp2',
        title: 'Other screen is broken',
      };
      await f.workspace.saveIssue(second);
      const config = parseConfig({
        version: 1,
        app: { source: 'source', connect: { url: 'fake://home' } },
        agents: {
          judge: { enabled: false },
          patrol: { pull: false, cycles: 2, intervalMinutes: 0.0001 },
          fixer: { enabled: true, maxPerCycle: 1, use: { runtime: 'cli', command: 'fake' }, verify: 'test -f app.txt' },
        },
      });
      const runs: string[] = [];
      const logs: string[] = [];
      await runPatrol({
        root: f.root,
        config,
        onLog: (message) => logs.push(message),
        createDriver: () => new FakeDriver({ home: { elements: [] } }),
        createRuntime: () => ({
          label: 'scripted',
          async run(task) {
            runs.push(task.role);
            if (task.role === 'fixer') await writeFile(join(task.workdir!, 'app.txt'), `fixed ${runs.length}\n`);
            return { stop: 'done', steps: 0, costUsd: 0, summary: 'Done' };
          },
        }),
      });
      // Cycle 1 explores and fixes one issue. Cycle 2 has the same commit: no explore, but the second fix.
      expect(runs.filter((role) => role === 'explorer')).toHaveLength(1);
      expect(runs.filter((role) => role === 'fixer')).toHaveLength(2);
      expect(logs.some((message) => message.includes('skipped explore and judge'))).toBe(true);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it.each([
    ['error', false],
    ['timeout', false],
    ['max-steps', true],
  ] as const)('caches the commit after an explorer %s outcome: %s', async (stop, cached) => {
    const f = await repoFixture();
    try {
      const config = parseConfig({
        version: 1,
        app: { source: 'source', connect: { url: 'fake://home' } },
        agents: { memory: { enabled: false }, judge: { enabled: false }, patrol: { pull: false } },
      });
      let runs = 0;
      const once = () =>
        runPatrol({
          root: f.root,
          config,
          once: true,
          createDriver: () => new FakeDriver({ home: { elements: [] } }),
          createRuntime: () => ({
            label: 'scripted',
            async run() {
              runs++;
              return { stop, steps: 0, costUsd: 0, error: 'synthetic failure' };
            },
          }),
        });
      expect((await once()).problems).toHaveLength(cached ? 0 : 1);
      await once();
      expect(runs).toBe(cached ? 1 : 2);
      expect(Boolean((await f.workspace.readAgents()).patrol?.commit)).toBe(cached);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it('skips --once on a tested commit unless forced, and shows no next patrol', async () => {
    const f = await repoFixture();
    try {
      const config = parseConfig({
        version: 1,
        app: { source: 'source', connect: { url: 'fake://home' } },
        agents: { judge: { enabled: false }, patrol: { pull: false } },
      });
      let runs = 0;
      const once = (force = false) =>
        runPatrol({
          root: f.root,
          config,
          once: true,
          force,
          createDriver: () => new FakeDriver({ home: { elements: [] } }),
          createRuntime: () => ({
            label: 'scripted',
            async run() {
              runs++;
              return { stop: 'done', steps: 0, costUsd: 0, summary: 'Done' };
            },
          }),
        });
      await once();
      await once();
      expect(runs).toBe(1);
      await once(true);
      expect(runs).toBe(2);
      const patrol = (await new Workspace(f.root).readAgents()).patrol;
      expect(patrol?.state).toBe('stopped');
      expect(patrol?.nextAt).toBeUndefined();
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it('does not start while another patrol runs', async () => {
    const f = await repoFixture();
    try {
      // The parent process is alive, and it is not this process.
      await f.workspace.setPatrol({ state: 'running', cycle: 1 });
      const file = await f.workspace.readAgents();
      await writeFile(paths.agents(f.root), JSON.stringify({ ...file, patrol: { ...file.patrol, pid: process.ppid } }));
      const logs: string[] = [];
      let runs = 0;
      await runPatrol({
        root: f.root,
        config: f.config,
        once: true,
        onLog: (message) => logs.push(message),
        createDriver: () => new FakeDriver({ home: { elements: [] } }),
        createRuntime: () => ({
          label: 'scripted',
          async run() {
            runs++;
            return { stop: 'done', steps: 0, costUsd: 0, summary: 'Done' };
          },
        }),
      });
      expect(runs).toBe(0);
      expect(logs[0]).toContain('A patrol already runs');
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it('does nothing when pull is false', async () => {
    const f = await repoFixture();
    try {
      const config = parseConfig({
        version: 1,
        app: { source: 'source', connect: { url: 'fake://home' } },
        agents: { patrol: { pull: false } },
      });
      expect(await pullSource(f.root, config)).toBe(false);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
});
