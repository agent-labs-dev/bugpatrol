import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Workspace } from '@bugpatrol/agents';
import type { Candidate, Issue } from '@bugpatrol/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runIssueCommand } from './issue.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'bugpatrol-issue-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function seed(): Promise<{ workspace: Workspace; issue: Issue; candidate: Candidate }> {
  const workspace = new Workspace(root);
  const session = await workspace.startSession('explorer');
  const candidate: Candidate = {
    id: 'can_1',
    sessionId: session.id,
    source: 'explorer',
    fingerprint: 'fp-candidate',
    summary: 'The window is blank',
    severity: 'major',
    evidence: { capture: { kind: 'image', screenshot: 'shot.png' } },
    createdAt: '2026-01-01T00:00:00.000Z',
  };
  await workspace.appendCandidate(session.id, candidate);
  const issue: Issue = {
    version: 1,
    id: 'iss_1',
    fingerprint: 'fp-issue',
    title: 'The window is blank',
    body: '...',
    severity: 'major',
    status: 'new',
    candidateIds: ['can_1'],
    evidence: { capture: { kind: 'image', screenshot: 'shot.png' } },
    judgement: { by: 'model', reason: 'It is blank.', at: '2026-01-01T00:00:00.000Z' },
    occurrences: 1,
    firstSeenAt: '2026-01-01T00:00:00.000Z',
    lastSeenAt: '2026-01-01T00:00:00.000Z',
  };
  await workspace.saveIssue(issue);
  return { workspace, issue, candidate };
}

describe('bugpatrol issue', () => {
  it('dismisses an issue and records its fingerprints so it does not come back', async () => {
    const { workspace } = await seed();
    const lines: string[] = [];
    await runIssueCommand(['dismiss', 'iss_1', '--reason', 'By design', '--by', 'reviewer'], root, (line) =>
      lines.push(line),
    );

    expect(await workspace.readIssue('iss_1')).toMatchObject({
      status: 'dismissed',
      closedBy: { by: 'reviewer', reason: 'By design' },
    });
    const triage = await workspace.readTriage();
    expect(triage.fingerprints['fp-issue']).toMatchObject({ decision: 'dismissed' });
    expect(triage.fingerprints['fp-candidate']).toMatchObject({ decision: 'dismissed', issueId: 'iss_1' });
    expect(lines[0]).toMatch(/^Dismissed iss_1/);
    expect((await workspace.readMemory()).lessons).toMatchObject([
      {
        role: 'judge',
        source: 'human',
        text: 'Not a bug: The window is blank — By design',
      },
    ]);
  });

  it('refuses a dismissal with no reason', async () => {
    await seed();
    await expect(runIssueCommand(['dismiss', 'iss_1'], root, () => {})).rejects.toThrow(/--reason/);
  });

  it('reopens a dismissed issue', async () => {
    const { workspace } = await seed();
    await runIssueCommand(['dismiss', 'iss_1', '--reason', 'x', '--by', 'r'], root, () => {});
    await runIssueCommand(['reopen', 'iss_1'], root, () => {});
    expect(await workspace.readIssue('iss_1')).toMatchObject({ status: 'new' });
    expect((await workspace.readIssue('iss_1'))!.closedBy).toBeUndefined();
  });
});
