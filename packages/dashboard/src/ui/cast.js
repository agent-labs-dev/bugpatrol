// Asciicast reader for the review page. Pure, so it is tested from Node.
// The page shows a cast as plain text, so colors and cursor moves are dropped.

// CSI sequences (colors, cursor moves), OSC sequences (titles), and other escapes.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal escapes is the point.
const ESCAPES = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;

/** Reads an asciicast v2 or v3 file. v2 times are from the start; v3 times are from the previous event. */
export function parseCast(source) {
  const rows = source.split('\n').flatMap((line) => {
    try {
      return line.trim() ? [JSON.parse(line)] : [];
    } catch {
      return [];
    }
  });
  const header = rows[0];
  if (!header || Array.isArray(header) || ![2, 3].includes(header.version)) return undefined;
  let clock = 0;
  const events = [];
  for (const row of rows.slice(1)) {
    if (!Array.isArray(row) || typeof row[0] !== 'number') continue;
    clock = header.version === 3 ? clock + row[0] : row[0];
    if (row[1] !== 'o' || typeof row[2] !== 'string') continue;
    events.push({ at: Math.round(clock * 1000) / 1000, text: row[2].replace(ESCAPES, '').replace(/\r\n/g, '\n') });
  }
  return {
    width: header.width ?? header.term?.cols ?? 80,
    height: header.height ?? header.term?.rows ?? 24,
    events,
  };
}
