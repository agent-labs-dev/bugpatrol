import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Workspace } from '@bugpatrol/agents';
import { type Candidate, type Issue, paths } from '@bugpatrol/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runFindingsCommand } from './findings.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'bugpatrol-findings-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const candidate = (id: string, extra: Partial<Candidate> = {}): Candidate => ({
  id,
  sessionId: '',
  source: 'sweep',
  fingerprint: `fp-${id}`,
  summary: `Finding ${id}`,
  severity: 'major',
  evidence: { capture: { kind: 'image', screenshot: 'shot.png' } },
  route: { to: 'judge', reason: 'repeats' },
  createdAt: '2026-01-01T00:00:00.000Z',
  ...extra,
});

describe('bugpatrol findings list', () => {
  it('lists the findings of the last session with what became of each', async () => {
    const workspace = new Workspace(root);
    const older = await workspace.startSession('explorer');
    await workspace.appendCandidate(older.id, candidate('can_old', { sessionId: older.id }));
    await new Promise((done) => setTimeout(done, 5));
    const last = await workspace.startSession('explorer');
    for (const each of [
      candidate('can_filed', { sessionId: last.id }),
      candidate('can_dismissed', { sessionId: last.id, severity: 'minor' }),
      candidate('can_waiting', { sessionId: last.id }),
      candidate('can_ignored', { sessionId: last.id, route: { to: 'ignore', reason: 'flaky once' } }),
    ])
      await workspace.appendCandidate(last.id, each);
    const issue = { id: 'iss_1', candidateIds: ['can_filed'], status: 'new' } as Issue;
    await workspace.saveIssue(issue);
    await appendFile(
      paths.sessionDecisions(root, last.id),
      `${JSON.stringify({ candidateId: 'can_dismissed', decision: 'dismiss', reason: 'expected', at: '' })}\n`,
    );

    const lines: string[] = [];
    await runFindingsCommand(['list'], root, (line) => lines.push(line));
    expect(lines[0]).toBe(`Findings of session ${last.id} (explorer):`);
    const rows = lines.slice(1, 5);
    expect(rows.find((row) => row.startsWith('can_filed'))).toContain('filed as iss_1');
    expect(rows.find((row) => row.startsWith('can_dismissed'))).toContain('dismissed: expected');
    expect(rows.find((row) => row.startsWith('can_waiting'))).toContain('waits for the judge');
    expect(rows.find((row) => row.startsWith('can_ignored'))).toContain('ignored: flaky once');
    expect(lines.join('\n')).not.toContain('can_old');

    const named: string[] = [];
    await runFindingsCommand(['list', '--session', older.id], root, (line) => named.push(line));
    expect(named[1]).toMatch(/^can_old/);
  });

  it('says so when no session has findings', async () => {
    const lines: string[] = [];
    await runFindingsCommand(['list'], root, (line) => lines.push(line));
    expect(lines).toEqual(['No findings. Run `bugpatrol explore` or `bugpatrol sweep`.']);
  });
});
