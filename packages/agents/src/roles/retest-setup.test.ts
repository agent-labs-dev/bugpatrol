import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type FixProposal, type Issue, parseConfig } from '@bugpatrol/core';
import { CliDriver } from '@bugpatrol/drivers';
import { expect, it } from 'vitest';
import { retestFix } from './retest.js';

it('gives no verdict when the routine that builds the issue state failed', { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'bugpatrol-retest-setup-'));
  const config = parseConfig({
    version: 1,
    app: { platform: 'cli', connect: { cli: { cols: 40, rows: 6 } } },
    agents: { memory: { enabled: false } },
  });
  const original = new CliDriver({ cwd: root, cols: 40, rows: 6, timeoutMs: 10_000 });
  try {
    await original.connect();
    const observation = await original.observe();
    if (observation.capture.kind !== 'image') throw new Error('Expected terminal image');
    await writeFile(join(root, 'reported.png'), observation.capture.png);
    await original.close();
    const issue: Issue = {
      version: 1,
      id: 'iss_setup',
      fingerprint: 'setup',
      title: 'A new item is missing from the list',
      body: 'The item the routine creates must show in the list.',
      severity: 'major',
      status: 'fix-proposed',
      candidateIds: [],
      evidence: {
        capture: { kind: 'image', screenshot: 'reported.png' },
        // The routine that creates the item; it is not saved, so its replay fails.
        routineId: 'create-item',
        steps: [{ kind: 'run', command: 'echo list: (empty)' }],
      },
      judgement: { by: 'judge', reason: 'Observed', at: 'now' },
      occurrences: 1,
      firstSeenAt: 'now',
      lastSeenAt: 'now',
    };
    const fix: FixProposal = {
      version: 1,
      id: 'fix_setup',
      issueId: issue.id,
      status: 'retesting',
      runtime: 'scripted',
      repo: root,
      worktree: root,
      branch: 'test',
      startedAt: 'now',
    };
    let judged = false;
    const result = await retestFix(
      root,
      config,
      issue,
      fix,
      1,
      {
        createRuntime: () => ({
          label: 'scripted',
          async run(task) {
            const call = (name: string, input: Record<string, unknown>) =>
              task.tools.find((tool) => tool.name === name)!.run(input);
            if (task.role === 'explorer') {
              await call('run_routine', { id: 'create-item' });
              await call('replay_issue_steps', { target: 1 });
              await call('capture_after', { target: 1, reached: true, note: 'The list is still empty' });
              await call('finish_retest', { summary: 'Captured the list' });
            } else {
              judged = true;
              await call('verdict', { outcome: 'not-fixed', reason: 'The item is still missing' });
            }
            return { stop: 'done', steps: 3, costUsd: 0 };
          },
        }),
      },
      { build: 'main' },
    );
    expect(result.outcome).toBe('unclear');
    expect(result.reason).toContain('create-item');
    expect(judged).toBe(false);
  } finally {
    await original.close();
    await rm(root, { recursive: true, force: true });
  }
});
