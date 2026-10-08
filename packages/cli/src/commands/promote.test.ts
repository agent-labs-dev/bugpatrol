import { describe, expect, it } from 'vitest';
import { parsePromoteArgs } from './promote.js';

describe('promote arguments', () => {
  it('takes a pull request number or URL, then one or more claims', () => {
    expect(parsePromoteArgs(['7', 'claim-1'])).toEqual({ pr: 7, claims: ['claim-1'] });
    expect(parsePromoteArgs(['https://github.com/o/r/pull/12', 'claim-2', 'claim-3'])).toEqual({
      pr: 12,
      claims: ['claim-2', 'claim-3'],
    });
  });

  it('rejects a missing pull request, a missing claim, and a flag', () => {
    expect(() => parsePromoteArgs([])).toThrow(/pull request number or URL/);
    expect(() => parsePromoteArgs(['7'])).toThrow(/at least one claim/);
    expect(() => parsePromoteArgs(['7', '--force'])).toThrow(/Unknown flag for promote: --force/);
  });
});
