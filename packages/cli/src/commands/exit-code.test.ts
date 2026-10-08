import { ConfigError, ExitCode, InfrastructureError } from '@bugpatrol/core';
import { describe, expect, it } from 'vitest';
import { exitCodeForError } from './run.js';

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
