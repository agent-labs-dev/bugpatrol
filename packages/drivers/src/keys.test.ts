import { describe, expect, it } from 'vitest';
import { keyBytes, sessionKeyBytes } from './keys.js';

describe('keyBytes', () => {
  it('sends the bytes of an xterm for each named key, in any case', () => {
    expect(['enter', 'Escape', 'tab', 'backspace', 'space'].map(keyBytes)).toEqual([
      '\r',
      '\u001b',
      '\t',
      '\u007f',
      ' ',
    ]);
    expect(['up', 'down', 'right', 'left'].map(keyBytes)).toEqual(['\u001b[A', '\u001b[B', '\u001b[C', '\u001b[D']);
    expect(['home', 'end', 'pageup', 'pagedown', 'shift+tab'].map(keyBytes)).toEqual([
      '\u001b[H',
      '\u001b[F',
      '\u001b[5~',
      '\u001b[6~',
      '\u001b[Z',
    ]);
    expect(['f1', 'f4', 'f5', 'f12'].map(keyBytes)).toEqual(['\u001bOP', '\u001bOS', '\u001b[15~', '\u001b[24~']);
  });

  it('sends ctrl and alt chords', () => {
    expect(keyBytes('ctrl+p')).toBe('\u0010');
    expect(keyBytes('Ctrl+C')).toBe('\u0003');
    expect(keyBytes('ctrl+[')).toBe('\u001b');
    expect(keyBytes('ctrl+space')).toBe('\u0000');
    expect(keyBytes('alt+x')).toBe('\u001bx');
    expect(keyBytes('alt+enter')).toBe('\u001b\r');
    expect(() => keyBytes('ctrl+1')).toThrow('A terminal has no key ctrl+1');
  });

  it('types anything else as text, and a single character is always text', () => {
    expect(keyBytes('j')).toBe('j');
    expect(keyBytes('hello world')).toBe('hello world');
    expect(keyBytes('constructor')).toBe('constructor');
    expect(keyBytes('a+b')).toBe('a+b');
    expect(keyBytes('two\nlines')).toBe('two\rlines');
  });

  it('moves the cursor keys to ESC O in application cursor mode, and leaves the rest', () => {
    const keys = ['up', 'left', 'home', 'end', 'alt+home', 'pageup', 'f1', 'enter'];
    expect(keys.map((key) => sessionKeyBytes(key, true))).toEqual([
      '\u001bOA',
      '\u001bOD',
      '\u001bOH',
      '\u001bOF',
      '\u001b\u001bOH',
      '\u001b[5~',
      '\u001bOP',
      '\r',
    ]);
    expect(keys.map((key) => sessionKeyBytes(key, false))).toEqual(keys.map(keyBytes));
  });
});
