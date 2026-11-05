import { describe, expect, it } from 'vitest';
import { commandHelp, USAGE } from './usage.js';

describe('help', () => {
  it('documents the global --config selector in the full help and in each command help', () => {
    expect(USAGE).toMatch(/Global options\n {2}--config <file>/);
    for (const command of ['review', 'explore', 'issue', 'dashboard'])
      expect(commandHelp(command)).toContain('--config <file>');
  });
});
