import type { FixProposal, Issue } from '@bugpatrol/core';
import { describe, expect, it } from 'vitest';
import { buildReport, reproRoutineId } from './report.js';

const issue: Issue = {
  version: 1,
  id: 'iss_1',
  fingerprint: 'fp',
  title: 'Broken screen',
  body: 'What happened: SECRET was shown.\nExpected: no error.',
  severity: 'major',
  status: 'new',
  screenId: 'home',
  candidateIds: [],
  evidence: { screenshot: 'before1.png' },
  judgement: { by: 'judge', reason: 'People cannot continue.', at: '2026-01-01' },
  occurrences: 2,
  firstSeenAt: '2026-01-01',
  lastSeenAt: '2026-01-02',
};
const fix: FixProposal = {
  version: 1,
  id: 'fix_1',
  issueId: issue.id,
  status: 'verified',
  runtime: 'fake',
  repo: '',
  worktree: '',
  branch: 'fix',
  startedAt: 'now',
  summary: 'Expanded the panel.',
  diffStat: 'app.ts | 2 +-',
  retests: [
    {
      attempt: 1,
      outcome: 'fixed',
      reason: 'Both screens work.',
      at: 'now',
      shots: [
        { screenId: 'home', before: 'before1.png', after: 'after1.png' },
        { screenId: 'settings', before: 'before2.png', after: 'after2.png' },
      ],
    },
  ],
};
const base = {
  summary: 'The panel blocked the next step.',
  issue,
  candidates: [],
  fix,
  imageUrl: (path: string) => `https://example.test/${path}`,
  redact: (text: string) => text.replaceAll('SECRET', '{{TOKEN}}'),
};

describe('buildReport', () => {
  it('includes verification shots, closing link, footer, and redacts secrets', () => {
    const body = buildReport({ ...base, kind: 'pr', closes: 7 });
    expect(body).toContain('✅ Fixed — Both screens work.');
    expect(body).toContain('| Screen | Before | After |');
    expect(body.match(/width="240"/g)).toHaveLength(4);
    expect(body).toContain('Closes #7');
    expect(body).toContain('<sub>Filed by Bugpatrol · iss_1 · fix_1</sub>');
    expect(body).not.toContain('SECRET');
    expect(body).toContain('{{TOKEN}}');
  });
  it('names the verify command that passed, or says that no checks ran', () => {
    expect(buildReport({ ...base, kind: 'pr', fix: { ...fix, checks: 'pnpm test' } })).toContain(
      '**Checks:** Bugpatrol ran `pnpm test` on this change, and it passed.',
    );
    expect(buildReport({ ...base, kind: 'pr' })).toContain('**Checks:** Bugpatrol ran no checks on this change.');
  });
  it('describes a declined attempt without a verified section', () => {
    const body = buildReport({ ...base, kind: 'issue', fix: { ...fix, status: 'declined' } });
    expect(body).toContain('## Fix attempt');
    expect(body).not.toContain('## Verified in the app');
  });
  it('cuts reports below the GitHub body limit', () => {
    const body = buildReport({ ...base, kind: 'issue', issue: { ...issue, body: 'x'.repeat(70_000) } });
    expect(body.length).toBeLessThan(65_536);
    expect(body).toContain('…(cut; the full report is in the Bugpatrol dashboard)');
  });
});

describe('repro marker', () => {
  it("hides the repro routine id in an issue body, where a cut can't drop it", () => {
    const withRepro = { ...issue, evidence: { ...issue.evidence, reproRoutineId: 'repro-1' } };
    const body = buildReport({ ...base, kind: 'issue', issue: { ...withRepro, body: 'x'.repeat(70_000) } });
    expect(body).toContain('<!-- bugpatrol:routine repro-1 -->');
    expect(reproRoutineId(body)).toBe('repro-1');
    expect(buildReport({ ...base, kind: 'issue' })).not.toContain('bugpatrol:routine');
    expect(reproRoutineId('Fixed it. <!-- bugpatrol:routine ../../etc -->')).toBeUndefined();
  });
});
