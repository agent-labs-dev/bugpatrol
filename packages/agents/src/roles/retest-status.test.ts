import { bugpatrolConfigSchema, type FixProposal, type Retest } from '@bugpatrol/core';
import { describe, expect, it } from 'vitest';
import { applyRetest } from './retest.js';

const config = bugpatrolConfigSchema.parse({ version: 1, app: { platform: 'electron' } });
const fix = (): FixProposal => ({
  version: 1,
  id: 'fix_1',
  issueId: 'iss_1',
  status: 'retesting',
  runtime: 'cli',
  repo: '/repo',
  branch: 'b',
  worktree: '/wt',
  startedAt: '2026-01-01T00:00:00.000Z',
});
const retest = (outcome: Retest['outcome']): Retest => ({
  attempt: 1,
  outcome,
  reason: '',
  at: '2026-01-01T00:00:00.000Z',
});

describe('applyRetest', () => {
  it('keeps a fix in retesting after a setup error, and the error is not an attempt', () => {
    const item = fix();
    for (let i = 0; i < 5; i++) applyRetest(config, item, retest('error'));
    expect(item.status).toBe('retesting');
    applyRetest(config, item, retest('not-fixed'));
    expect(item.status).toBe('retesting');
    applyRetest(config, item, retest('not-fixed'));
    expect(item.status).toBe('proposed');
    expect(item.retests).toHaveLength(7);
  });

  it('retests an unclear fix again, and keeps it unpublished after the last attempt', () => {
    const item = fix();
    applyRetest(config, item, retest('unclear'));
    expect(item.status).toBe('retesting');
    applyRetest(config, item, retest('unclear'));
    expect(item.status).toBe('proposed');
  });

  it('never sends an external fix back to the fixer', () => {
    const item = {
      ...fix(),
      runtime: 'external',
      external: { kind: 'pr' as const, ref: 'https://github.com/o/r/pull/9' },
    };
    applyRetest(config, item, retest('not-fixed'));
    expect(item.status).toBe('proposed');
  });

  it('marks a fix verified when the judge says fixed', () => {
    const item = fix();
    applyRetest(config, item, retest('fixed'));
    expect(item.status).toBe('verified');
  });
});
