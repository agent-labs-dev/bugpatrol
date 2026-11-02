/** The bytes that an xterm sends for each named key. */
const NAMED = new Map<string, string>([
  ['enter', '\r'],
  ['return', '\r'],
  ['escape', '\u001b'],
  ['esc', '\u001b'],
  ['tab', '\t'],
  ['shift+tab', '\u001b[Z'],
  ['backspace', '\u007f'],
  ['delete', '\u001b[3~'],
  ['insert', '\u001b[2~'],
  ['space', ' '],
  ['up', '\u001b[A'],
  ['down', '\u001b[B'],
  ['right', '\u001b[C'],
  ['left', '\u001b[D'],
  ['home', '\u001b[H'],
  ['end', '\u001b[F'],
  ['pageup', '\u001b[5~'],
  ['pagedown', '\u001b[6~'],
  ['f1', '\u001bOP'],
  ['f2', '\u001bOQ'],
  ['f3', '\u001bOR'],
  ['f4', '\u001bOS'],
  ['f5', '\u001b[15~'],
  ['f6', '\u001b[17~'],
  ['f7', '\u001b[18~'],
  ['f8', '\u001b[19~'],
  ['f9', '\u001b[20~'],
  ['f10', '\u001b[21~'],
  ['f11', '\u001b[23~'],
  ['f12', '\u001b[24~'],
]);

/**
 * The bytes that a terminal sends for one key: a named key such as `enter`
 * or `pagedown`, `ctrl+` a letter, `alt+` a key, or else the text as typed.
 * A single character is always text, so `j` is the letter. To type a word
 * that is also a key name, give it as single characters.
 */
export function keyBytes(key: string): string {
  const named = key.length > 1 ? NAMED.get(key.toLowerCase()) : undefined;
  if (named !== undefined) return named;
  const chord = key.length > 1 ? /^(ctrl|alt)\+(.+)$/i.exec(key) : null;
  // Enter on a keyboard sends a carriage return.
  if (!chord) return key.replaceAll('\n', '\r');
  const rest = chord[2]!;
  if (chord[1]!.toLowerCase() === 'alt') return `\u001b${keyBytes(rest)}`;
  if (rest.toLowerCase() === 'space') return '\u0000';
  if (/^[a-z@[\\\]^_]$/i.test(rest)) return String.fromCharCode(rest.toUpperCase().charCodeAt(0) & 0x1f);
  throw new Error(`A terminal has no key ${key}. Use ctrl+ and a letter`);
}
