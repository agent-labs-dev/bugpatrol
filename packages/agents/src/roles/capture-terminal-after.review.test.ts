import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type FixProposal, type Issue, parseConfig } from '@bugpatrol/core';
import { CliDriver } from '@bugpatrol/drivers';
import { expect, it } from 'vitest';
import { retestFix } from './retest.js';

it('gives the retest judge the new terminal transcript as well as the reported one', { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'bugpatrol-after-terminal-'));
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
    await writeFile(join(root, 'reported.terminal.txt'), 'Reported build: EARLY_FAILURE');
    await original.close();
    const issue: Issue = {
      version: 1,
      id: 'iss_terminal',
      fingerprint: 'terminal',
      title: 'Early failure before passing cases',
      body: 'The command must have no early failure.',
      severity: 'major',
      status: 'fix-proposed',
      candidateIds: [],
      evidence: {
        capture: { kind: 'image', screenshot: 'reported.png', terminal: 'reported.terminal.txt' },
        steps: [
          {
            kind: 'run',
            command: `python3 -c "print('AFTER_' + 'FAILURE'); [print('passing case', i) for i in range(30)]"`,
          },
        ],
      },
      judgement: { by: 'judge', reason: 'Observed failure', at: 'now' },
      occurrences: 1,
      firstSeenAt: 'now',
      lastSeenAt: 'now',
    };
    const fix: FixProposal = {
      version: 1,
      id: 'fix_terminal',
      issueId: issue.id,
      status: 'retesting',
      runtime: 'scripted',
      repo: root,
      worktree: root,
      branch: 'test',
      startedAt: 'now',
    };
    let judgeText = '';
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
              await call('replay_issue_steps', { target: 1 });
              await call('capture_after', { target: 1, reached: true, note: 'Command completed' });
              await call('finish_retest', { summary: 'Captured the command' });
            } else {
              const view = await call('view_retest', {});
              judgeText = view.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n');
              await call('verdict', { outcome: 'not-fixed', reason: 'Failure remains' });
            }
            return { stop: 'done', steps: 3, costUsd: 0 };
          },
        }),
      },
      { build: 'main' },
    );
    expect(result.outcome).toBe('not-fixed');
    // Confirm the new evidence exists; the bug is its omission from the judge's input.
    expect(await readFile(join(root, result.after!.replace(/\.png$/, '.terminal.txt')), 'utf8')).toContain(
      'AFTER_FAILURE',
    );
    expect(judgeText).toContain('EARLY_FAILURE');
    expect(judgeText).toContain('AFTER_FAILURE');
  } finally {
    await original.close();
    await rm(root, { recursive: true, force: true });
  }
});
