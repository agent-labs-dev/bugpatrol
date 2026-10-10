import { describe, expect, it } from 'vitest';
import { opencodePreset } from './opencode.js';

describe('opencodePreset', () => {
  it('uses the v1 shape on v1: no --standalone, mcp keyed directly, permission map', () => {
    const tools = opencodePreset('tools', 1);
    expect(tools).not.toContain('--standalone');
    expect(tools).toContain('"mcp":{"bugpatrol"');
    expect(tools).toContain('"permission":{"*":"deny","bugpatrol_*":"allow"}');
    expect(opencodePreset('fixer', 1)).toBe('opencode run --auto --format json');
  });

  it('uses the v2 shape on v2 and on an unknown version', () => {
    for (const major of [2, undefined] as const) {
      const tools = opencodePreset('tools', major);
      expect(tools).toContain('--standalone');
      expect(tools).toContain('"mcp":{"servers":{"bugpatrol"');
      expect(opencodePreset('fixer', major)).toBe('opencode run --standalone --auto --format json');
    }
  });

  it('keeps the {mcpUrl} placeholder for the spawn-time substitution', () => {
    expect(opencodePreset('tools', 1)).toContain('{mcpUrl}');
    expect(opencodePreset('tools', 2)).toContain('{mcpUrl}');
  });
});
