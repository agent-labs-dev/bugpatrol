import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Candidate, parseConfig } from '@bugpatrol/core';
import { expect, it } from 'vitest';
import { AgentSession } from './session.js';
import { judgeTools } from './tools/judge.js';
import { Vars } from './vars.js';
import { Workspace } from './workspace.js';

it('keeps an explorer candidate repro with its originating profile when judging recent shared sessions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'judge-profile-'));
  try {
    const cli = new Workspace(root, 'cli');
    const explored = await cli.startSession('explorer');
    const candidate: Candidate = {
      id: 'candidate-cli',
      sessionId: explored.id,
      source: 'explorer',
      fingerprint: 'cli-crash',
      summary: 'CLI crashes',
      severity: 'major',
      route: { to: 'judge', reason: 'CLI crashes on launch' },
      evidence: {
        capture: { kind: 'image', screenshot: 'cli.png' },
        steps: [{ kind: 'session', op: 'start', command: 'node app.cjs' }],
      },
      createdAt: new Date().toISOString(),
    };
    await cli.appendCandidate(explored.id, candidate);
    await cli.endSession(explored.id, { status: 'finished', candidates: 1 });
    const defaultWorkspace = new Workspace(root);
    const judged = await defaultWorkspace.startSession('judge');
    const config = parseConfig({ version: 1, app: { connect: { url: 'http://localhost:3000' } } });
    const session = new AgentSession(root, config, new Vars(), judged.id, 'judge');
    // This is the default judge command's recent-session selection, which is shared across profiles.
    const recent = (await defaultWorkspace.listSessions())
      .filter((item) => item.role === 'explorer' && item.candidates > 0 && item.status !== 'running')
      .slice(0, 5)
      .map((item) => item.id);
    const file = judgeTools(session, recent, 'test').find((tool) => tool.name === 'file_issue')!;
    await file.run({
      candidate_ids: [candidate.id],
      title: 'CLI crashes',
      body: 'The CLI crashes on launch.',
      severity: 'major',
      reason: 'A crash prevents use.',
    });
    const issues = await defaultWorkspace.listIssues();
    // Either reject candidates of a different profile or preserve their actual owner.
    for (const issue of issues) {
      expect(issue.evidence.reproProfile).toBe('cli');
      expect(await cli.readRoutine(issue.evidence.reproRoutineId!)).toMatchObject({ platform: 'cli' });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
