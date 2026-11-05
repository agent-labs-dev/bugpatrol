import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Issue, parseConfig } from '@bugpatrol/core';
import { expect, it } from 'vitest';
import { recheckMerged } from './roles/retest.js';
import { FakeDriver } from './testing/fake-driver.js';
import { Workspace } from './workspace.js';

it('does not recheck or close the default web profile issue while running the CLI profile', async () => {
  const root = await mkdtemp(join(tmpdir(), 'merged-fix-profile-'));
  const workspace = new Workspace(root);
  try {
    await writeFile(join(root, 'before.png'), 'reported screenshot');
    const issue: Issue = {
      version: 1,
      id: 'iss_web',
      fingerprint: 'web-failure',
      title: 'The web app is broken',
      body: 'The web view fails.',
      severity: 'major',
      status: 'fix-proposed',
      candidateIds: [],
      evidence: {
        capture: { kind: 'image', screenshot: 'before.png' },
        steps: [{ kind: 'open', url: 'fake://home' }],
      },
      judgement: { by: 'judge', reason: 'Visible', at: 'now' },
      occurrences: 1,
      firstSeenAt: 'now',
      lastSeenAt: 'now',
    };
    await workspace.saveIssue(issue);
    await workspace.saveFix({
      version: 1,
      id: 'fix_web',
      issueId: issue.id,
      status: 'verified',
      runtime: 'scripted',
      repo: root,
      worktree: root,
      branch: 'fix-web',
      startedAt: 'now',
      pr: { number: 7, url: 'https://github.com/o/r/pull/7', draft: false, state: 'merged' },
    });
    const config = {
      ...parseConfig({
        version: 1,
        app: { platform: 'cli' },
        agents: { memory: { enabled: false } },
      }),
      profile: 'cli',
    };
    const result = await recheckMerged(root, config, {
      createDriver: () => new FakeDriver({ home: { elements: [] } }, 'home', 'cli'),
      createRuntime: () => ({
        label: 'scripted',
        async run(task) {
          if (task.role === 'explorer')
            await task.tools
              .find((tool) => tool.name === 'capture_after')!
              .run({
                target: 1,
                note: 'The CLI screen has no web failure',
                reached: true,
              });
          if (task.role === 'judge')
            await task.tools.find((tool) => tool.name === 'verdict')!.run({ outcome: 'fixed', reason: 'Gone' });
          return { stop: 'done', steps: 1, costUsd: 0 };
        },
      }),
    });
    expect(result.closed, 'the CLI patrol must leave the web issue to the web profile').toEqual([]);
    expect((await workspace.readIssue(issue.id))?.status).toBe('fix-proposed');
    expect((await workspace.readFix('fix_web'))?.retests ?? []).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
