import { expect, it } from 'vitest';
import { Terminal } from './cast.js';

it('keeps delayed line wrapping when recording begins at the right margin', async () => {
  const live = new Terminal(20, 5);
  live.write('\u001b[?1049h12345678901234567890');
  await live.flush();
  const playback = new Terminal(20, 5);
  playback.write(live.serialize());
  await playback.flush();
  live.write('updated');
  playback.write('updated');
  await Promise.all([live.flush(), playback.flush()]);
  expect(playback.screenText()).toBe(live.screenText());
});

it('keeps the active text attributes for output after recording begins', async () => {
  const live = new Terminal(20, 5);
  live.write('\u001b[?1049h\u001b[38;2;12;34;56mready');
  await live.flush();
  const playback = new Terminal(20, 5);
  playback.write(live.serialize());
  await playback.flush();
  live.write('\r\nupdated');
  playback.write('\r\nupdated');
  await Promise.all([live.flush(), playback.flush()]);
  expect(playback.cells()[1]![0]!.fg).toEqual(live.cells()[1]![0]!.fg);
});
