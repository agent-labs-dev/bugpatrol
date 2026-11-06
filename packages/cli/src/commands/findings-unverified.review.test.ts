import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Workspace } from '@bugpatrol/agents';
import { type Candidate, paths } from '@bugpatrol/core';
import { expect, it } from 'vitest';
import { runFindingsCommand } from './findings.js';

it('keeps an incomplete base comparison unverified in CLI findings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bugpatrol-findings-unverified-'));
  try {
    const workspace = new Workspace(root);
    const session = await workspace.startSession('explorer');
    const candidate: Candidate = {
      id: 'can_uncompared',
      sessionId: session.id,
      source: 'explorer',
      fingerprint: 'uncompared',
      summary: 'The window is blank',
      severity: 'major',
      evidence: { capture: { kind: 'image', screenshot: 'shot.png' } },
      route: { to: 'judge', reason: 'A visible bug' },
      createdAt: new Date().toISOString(),
    };
    await workspace.appendCandidate(session.id, candidate);
    // The exact decision shape produced by settleCandidates for an unclear PR comparison.
    await appendFile(
      paths.sessionDecisions(root, session.id),
      `${JSON.stringify({
        candidateId: candidate.id,
        decision: 'unverified',
        reason: 'Review of PR #164: not compared with the base build',
        at: candidate.createdAt,
      })}\n`,
    );
    const lines: string[] = [];
    await runFindingsCommand(['list', '--session', session.id], root, (line) => lines.push(line));
    const row = lines.find((line) => line.startsWith(candidate.id))!;
    expect(row).toContain('unverified');
    expect(row).not.toContain('dismissed');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
