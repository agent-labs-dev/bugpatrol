import { describe, expect, it } from 'vitest';
import { parseCast } from './ui/cast.js';

const lines = (...values: unknown[]): string => `${values.map((value) => JSON.stringify(value)).join('\n')}\n`;

describe('parseCast', () => {
  it('reads an asciicast v2 file into timed output without terminal colors', () => {
    const cast = parseCast(
      lines(
        { version: 2, width: 60, height: 8 },
        [0.1, 'o', '$ acme export --json\r\n'],
        [0.4, 'i', 'typed'],
        [0.6, 'o', '\u001b[32m{"ok": true}\u001b[0m\r\n'],
      ),
    );
    expect(cast).toEqual({
      width: 60,
      height: 8,
      events: [
        { at: 0.1, text: '$ acme export --json\n' },
        { at: 0.6, text: '{"ok": true}\n' },
      ],
    });
  });

  it('adds up the intervals of an asciicast v3 file', () => {
    const cast = parseCast(
      lines({ version: 3, term: { cols: 100, rows: 30 } }, [0.5, 'o', 'a'], [0.25, 'o', 'b'], [1, 'x', '0']),
    );
    expect(cast).toEqual({
      width: 100,
      height: 30,
      events: [
        { at: 0.5, text: 'a' },
        { at: 0.75, text: 'b' },
      ],
    });
  });

  it('skips a torn last line and gives nothing for a file that is not a cast', () => {
    expect(parseCast(`${lines({ version: 2, width: 1, height: 1 }, [1, 'o', 'x'])}[2, "o`)?.events).toEqual([
      { at: 1, text: 'x' },
    ]);
    expect(parseCast('not json')).toBeUndefined();
  });
});
