import { ConfigError, ExitCode, InfrastructureError, type PrReview } from '@bugpatrol/core';
import { describe, expect, it } from 'vitest';
import { exitCodeForError, exitCodeForReview } from './run.js';

// The GitHub Action passes the exit code of `bugpatrol review` through, so a
// broken runner must give the infrastructure code and never the regression code.
describe('the exit code of a failed review', () => {
  it('is the infrastructure code when the app does not start', () => {
    expect(exitCodeForError(new InfrastructureError('Setup command `pnpm dev` failed: exit 1'))).toBe(4);
  });

  it('is the infrastructure code when a driver throws an error that Bugpatrol does not know', () => {
    expect(exitCodeForError(new Error('browserType.launch: Executable does not exist'))).toBe(4);
  });

  it('is the usage code when the review refuses a pull request from a fork', () => {
    expect(exitCodeForError(new ConfigError('PR #7 comes from a fork.'))).toBe(2);
  });

  it('is never the regression code', () => {
    for (const error of [new Error('x'), new InfrastructureError('x'), new ConfigError('x'), 'thrown string']) {
      expect(exitCodeForError(error)).not.toBe(ExitCode.Regression);
    }
  });
});

describe('the exit code of a finished review', () => {
  const review = (check?: PrReview['check']): PrReview => ({
    version: 1,
    pr: { number: 7, url: 'https://github.com/o/r/pull/7', title: 'x' },
    head: 'a',
    base: 'b',
    baseRef: 'main',
    status: 'finished',
    startedAt: '2026-10-08T00:00:00.000Z',
    sessions: {},
    findings: [],
    costUsd: 0,
    ...(check ? { check } : {}),
  });

  it('is the regression code when the claim check fails', () => {
    expect(exitCodeForReview(review({ conclusion: 'failure', title: '1 claim disproved', summary: 'x' }))).toBe(1);
  });

  it('is clean when the claim check is neutral, and when the review sets no check', () => {
    expect(exitCodeForReview(review({ conclusion: 'neutral', title: 'No claim disproved', summary: 'x' }))).toBe(0);
    expect(exitCodeForReview(review())).toBe(0);
  });
});
