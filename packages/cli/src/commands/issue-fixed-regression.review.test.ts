import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentSession, Vars, Workspace } from '@bugpatrol/agents';
import { type Candidate, type Issue, parseConfig } from '@bugpatrol/core';
import { expect, it } from 'vitest';
import { pendingCandidates } from '../../../agents/src/tools/judge.js';
import { runIssueCommand } from './issue.js';

it('lets the judge see a regression after issue fixed on a normally filed issue', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bugpatrol-fixed-regression-'));
  try {
    const workspace = new Workspace(root);
    const before = await workspace.startSession('explorer');
    const candidate: Candidate = {
      id: 'can_before',
      sessionId: before.id,
      source: 'explorer',
      fingerprint: 'same-bug',
      summary: 'The window is blank',
      severity: 'major',
      evidence: { capture: { kind: 'image', screenshot: 'shot.png' } },
      route: { to: 'judge', reason: 'A visible bug' },
      createdAt: new Date().toISOString(),
    };
    await workspace.appendCandidate(before.id, candidate);
    const issue: Issue = {
      version: 1,
      id: 'iss_blank',
      fingerprint: candidate.fingerprint,
      title: candidate.summary,
      body: 'The window has no content',
      severity: 'major',
      status: 'new',
      candidateIds: [candidate.id],
      evidence: candidate.evidence,
      judgement: { by: 'judge', reason: 'Confirmed', at: candidate.createdAt },
      occurrences: 1,
      firstSeenAt: candidate.createdAt,
      lastSeenAt: candidate.createdAt,
    };
    await workspace.saveIssue(issue);
    // file_issue records this triage entry for every normally filed explorer issue.
    await workspace.recordTriage({
      [candidate.fingerprint]: {
        decision: 'filed',
        issueId: issue.id,
        reason: 'Confirmed',
        at: candidate.createdAt,
      },
    });
    await runIssueCommand(['fixed', issue.id, '--reason', 'Fixed by hand'], root, () => {});
    expect((await workspace.readIssue(issue.id))?.status).toBe('fixed');
    const after = await workspace.startSession('explorer');
    await workspace.appendCandidate(after.id, { ...candidate, id: 'can_regression', sessionId: after.id });
    const judge = await workspace.startSession('judge');
    const config = parseConfig({ version: 1, app: { platform: 'cli' } });
    const session = new AgentSession(root, config, new Vars(), judge.id, 'judge');
    expect((await pendingCandidates(session, [after.id])).map((entry) => entry.id)).toEqual(['can_regression']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
