import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Candidate, parseConfig } from '@bugpatrol/core';
import { expect, it } from 'vitest';
import { AgentSession } from './session.js';
import { judgeTools } from './tools/judge.js';
import { Vars } from './vars.js';
import { Workspace } from './workspace.js';

it('retains the profile of an issue reported before any action in a configured TUI', async () => {
  const root = await mkdtemp(join(tmpdir(), 'initial-screen-profile-'));
  try {
    const config = {
      ...parseConfig({ version: 1, app: { platform: 'cli', connect: { cli: { command: 'node app.cjs' } } } }),
      profile: 'cli',
    };
    const workspace = new Workspace(root, config.profile);
    const explored = await workspace.startSession('explorer');
    const candidate: Candidate = {
      id: 'initial-screen-crash',
      sessionId: explored.id,
      source: 'explorer',
      fingerprint: 'initial-screen-crash',
      summary: 'The configured app crashes on launch',
      severity: 'major',
      route: { to: 'judge', reason: 'The app crashes on launch' },
      evidence: {
        capture: { kind: 'image', screenshot: 'initial.png' },
        steps: [],
        bug: { shows: 'TypeError' },
      },
      createdAt: new Date().toISOString(),
    };
    await workspace.appendCandidate(explored.id, candidate);
    await workspace.endSession(explored.id, { status: 'finished', candidates: 1 });
    const judged = await workspace.startSession('judge');
    const session = new AgentSession(root, config, new Vars(), judged.id, 'judge');
    const file = judgeTools(session, [explored.id], 'test').find((tool) => tool.name === 'file_issue')!;
    const result = await file.run({
      candidate_ids: [candidate.id],
      title: candidate.summary,
      body: 'The configured TUI shows TypeError on its initial screen.',
      severity: 'major',
      reason: 'The app is unusable on launch.',
    });
    expect(result.isError).toBeFalsy();
    const issues = await workspace.listIssues();
    expect(issues).toHaveLength(1);
    // runFixer and recheckMerged use reproProfile to select this profile's issues.
    expect(issues[0]!.evidence.reproProfile).toBe(config.profile);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
