import type { Routine } from '@bugpatrol/core';
import { describe, expect, it } from 'vitest';
import { outsidePaths, portabilityWarning } from './routine-paths.js';

const routine = (steps: Routine['steps']): Routine => ({
  version: 1,
  id: 'enter-app',
  description: 'Open the app',
  platform: 'cli',
  steps,
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
});

describe('outsidePaths', () => {
  it('finds absolute paths outside the project root, which a clean clone does not have', () => {
    const found = outsidePaths(
      routine([
        { kind: 'run', command: 'timeout 8 bun start', input: 'q\n' },
        { kind: 'run', command: "bash /tmp/kiln-qa/drive.sh --data '~/.config/kiln'" },
        { kind: 'session', op: 'start', command: 'HOME=/home/me/fixture ./bin/app' },
        { kind: 'type', value: 'cat ~/notes.txt' },
      ]),
      '/repo',
    );
    expect(found).toEqual(['/tmp/kiln-qa/drive.sh', '~/.config/kiln', '/home/me/fixture', '~/notes.txt']);
  });

  it('accepts paths in the project and the system paths every machine has', () => {
    const found = outsidePaths(
      routine([
        { kind: 'run', command: '/repo/scripts/seed.sh > /dev/null && /usr/bin/env node ./x.js' },
        { kind: 'open', url: 'http://localhost:3000/tmp/page' },
        { kind: 'type', value: 'a/b c' },
      ]),
      '/repo',
    );
    expect(found).toEqual([]);
  });

  it('words a warning that names the routine and the paths', () => {
    const warning = portabilityWarning(routine([{ kind: 'run', command: 'sh /tmp/x.sh' }]), '/repo');
    expect(warning).toBe(
      'The routine enter-app uses /tmp/x.sh, outside the project. A clean clone or CI cannot replay it: put the file in the project, or do the step without it.',
    );
    expect(portabilityWarning(routine([{ kind: 'run', command: 'ls' }]), '/repo')).toBeUndefined();
  });
});
