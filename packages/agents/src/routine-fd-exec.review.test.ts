import { expect, it } from 'vitest';
import { showsOnly } from './tools/explorer.js';

it.each(['fd -x touch state.txt', 'fd -X rm'])('preserves the state-changing execution option in %s', (command) => {
  // -x and -X are fd's short aliases for --exec and --exec-batch.
  expect(showsOnly({ kind: 'run', command })).toBe(false);
});
