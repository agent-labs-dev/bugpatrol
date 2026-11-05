import { expect, it } from 'vitest';
import { Terminal } from './cast.js';

it('keeps a double-width emoji from shifting or erasing the following terminal text', async () => {
  const terminal = new Terminal(20, 5);
  terminal.write('🚀 Ready\u001b[1;4HDone\u001b[K');
  await terminal.flush();
  // The rocket occupies columns 1 and 2, the space column 3, and the status starts at column 4.
  expect(terminal.screenText()).toBe('🚀 Done');
});
