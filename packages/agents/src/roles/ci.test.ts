import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { type FixProposal, parseConfig } from '@bugpatrol/core';
import { describe, expect, it } from 'vitest';
import type { Gh } from '../github.js';
import type { Runtime } from '../types.js';
import { Workspace } from '../workspace.js';
import { type Check, readChecks, watchCi } from './ci.js';

const git = async (cwd: string, ...args: string[]) => (await promisify(execFile)('git', args, { cwd })).stdout.trim();

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'bugpatrol-ci-'));
  await git(root, 'init', '-q', '--bare', 'origin.git');
  await git(root, 'clone', '-q', join(root, 'origin.git'), 'wt');
  const worktree = join(root, 'wt');
  await git(worktree, 'config', 'user.email', 'test@example.com');
  await git(worktree, 'config', 'user.name', 'Test');
  await writeFile(join(worktree, 'app.ts'), 'export const x = 0;\n');
  await git(worktree, 'add', '-A');
  await git(worktree, 'commit', '-q', '-m', 'initial');
  await git(worktree, 'push', '-q', '-u', 'origin', 'HEAD');
  await git(root, 'clone', '-q', join(root, 'origin.git'), 'source');
  await git(worktree, 'checkout', '-q', '-b', 'bugpatrol/fix-iss_1');
  await writeFile(join(worktree, 'app.ts'), 'export const x = 1;\n');
  await git(worktree, 'add', '-A');
  await git(worktree, 'commit', '-q', '-m', 'fix: the bug');
  await git(worktree, 'push', '-q', '-u', 'origin', 'bugpatrol/fix-iss_1');
  const fix: FixProposal = {
    version: 1,
    id: 'fix_iss_1',
    issueId: 'iss_1',
    status: 'proposed',
    runtime: 'cli:claude',
    repo: join(root, 'source'),
    branch: 'bugpatrol/fix-iss_1',
    worktree,
    startedAt: '',
    commit: await git(worktree, 'rev-parse', 'HEAD'),
    pr: { number: 7, url: 'https://github.com/o/r/pull/7', draft: true, state: 'open' },
    attempts: [{ n: 1, kind: 'first', outcome: 'proposed', startedAt: '' }],
  };
  await new Workspace(root).saveFix(fix);
  const config = parseConfig({
    version: 1,
    app: { connect: { url: 'http://x' } },
    agents: { fixer: { enabled: true, attempts: 1 }, github: { enabled: true, repo: 'o/r', ci: { attempts: 2 } } },
  });
  return { root, worktree, config };
}

/** A gh that answers the setup calls, and gives each `pr checks` call the next result. */
function fakeGh(results: Check[][], calls: string[][] = []): Gh {
  let index = 0;
  return async (args) => {
    calls.push(args);
    if (args[0] === 'repo') return 'main';
    if (args[0] === 'run') return 'step 1\nError: expected 2, got 1\n';
    if (args[0] === 'pr' && args[1] === 'checks') {
      const checks = results[Math.min(index++, results.length - 1)]!;
      const out = JSON.stringify(checks);
      if (checks.some((check) => check.bucket !== 'pass')) throw Object.assign(new Error('exit 1'), { stdout: out });
      return out;
    }
    return '';
  };
}

const failed: Check = { name: 'test', bucket: 'fail', link: 'https://github.com/o/r/actions/runs/42/job/1' };
const passed: Check = { name: 'test', bucket: 'pass' };

describe('watchCi', () => {
  it('reads the checks JSON also when gh exits with an error code', async () => {
    expect(await readChecks(fakeGh([[failed]]), 'o/r', 7)).toEqual([failed]);
  });

  it('gives a failed check to the fixer with its log, pushes the new commit, and waits for green', async () => {
    const f = await fixture();
    try {
      const prompts: string[] = [];
      const runtime: Runtime = {
        label: 'scripted',
        async run(task) {
          prompts.push(task.prompt);
          await writeFile(join(task.workdir!, 'app.ts'), 'export const x = 2;\n');
          return { stop: 'done', steps: 1, costUsd: 0, summary: 'Fixed the test.' };
        },
      };
      const result = await watchCi(f.root, f.config, {
        gh: fakeGh([[failed], [passed]]),
        createRuntime: () => runtime,
        wait: true,
        sleep: async () => {},
      });
      expect(result.problems).toEqual([]);
      expect(prompts[0]).toContain('Error: expected 2, got 1');
      const fix = (await new Workspace(f.root).listFixes())[0]!;
      expect(fix.ci).toMatchObject({ state: 'passed' });
      expect(fix.attempts?.map((item) => [item.n, item.kind, item.outcome])).toEqual([
        [1, 'first', 'proposed'],
        [2, 'ci', 'proposed'],
      ]);
      expect(await new Workspace(f.root).readFixAttemptDiff('fix_iss_1', 2)).toContain('+export const x = 2;');
      expect(await git(f.worktree, 'rev-parse', 'origin/bugpatrol/fix-iss_1')).toBe(fix.commit);
      expect(await git(f.worktree, 'log', '-1', '--format=%s')).toBe('fix: pass the CI checks');
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it('gives up after the attempts, and says that a person must look', async () => {
    const f = await fixture();
    try {
      let runs = 0;
      const runtime: Runtime = {
        label: 'scripted',
        async run(task) {
          runs++;
          await writeFile(join(task.workdir!, 'app.ts'), `export const x = ${runs + 2};\n`);
          return { stop: 'done', steps: 1, costUsd: 0, summary: 'Tried.' };
        },
      };
      const result = await watchCi(f.root, f.config, {
        gh: fakeGh([[failed]]),
        createRuntime: () => runtime,
        wait: true,
        sleep: async () => {},
      });
      expect(runs).toBe(2);
      expect(result.problems).toEqual([expect.stringContaining('A person must look')]);
      const fix = (await new Workspace(f.root).listFixes())[0]!;
      expect(fix.ci).toMatchObject({ state: 'gave-up' });
      expect(fix.attempts?.map((item) => item.kind)).toEqual(['first', 'ci', 'ci']);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it('gives up at once when the worktree of the fix is gone', async () => {
    const f = await fixture();
    try {
      await rm(f.worktree, { recursive: true, force: true });
      const result = await watchCi(f.root, f.config, {
        gh: fakeGh([[failed]]),
        createRuntime: () => {
          throw new Error('must not run');
        },
        wait: true,
        sleep: async () => {},
      });
      expect(result.problems).toEqual([expect.stringContaining('the worktree of iss_1 is gone')]);
      expect((await new Workspace(f.root).listFixes())[0]?.ci).toMatchObject({ state: 'gave-up' });
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it('leaves running checks for the next cycle when it does not wait', async () => {
    const f = await fixture();
    try {
      await watchCi(f.root, f.config, {
        gh: fakeGh([[{ name: 'test', bucket: 'pending' }]]),
        createRuntime: () => {
          throw new Error('no fixer');
        },
      });
      expect((await new Workspace(f.root).listFixes())[0]!.ci).toMatchObject({ state: 'pending' });
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it('does not run the fixer on a failed check when the fixer is off', async () => {
    const f = await fixture();
    try {
      f.config.agents.fixer.enabled = false;
      const logs: string[] = [];
      await watchCi(f.root, f.config, {
        gh: fakeGh([[failed]]),
        onLog: (line) => logs.push(line),
        createRuntime: () => {
          throw new Error('must not run');
        },
      });
      expect(logs.join('\n')).toContain('The fixer is off');
      expect((await new Workspace(f.root).listFixes())[0]?.ci).toMatchObject({ state: 'failed' });
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
});
