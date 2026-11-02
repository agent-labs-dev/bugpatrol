// biome-ignore-all lint/suspicious/noControlCharactersInRegex: ANSI escape sequences are control characters
/** A part of a text that redaction replaces: `[start, end)` and the placeholder that stands for it. */
export type SecretSpan = { start: number; end: number; placeholder: string };

const PLACEHOLDER = /\{\{[A-Za-z_][A-Za-z_0-9]*\}\}/g;
/** One ANSI escape sequence: CSI, OSC (with BEL or ST), or a two-character escape. */
const ESCAPE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[@-Z\\-_])/g;

/**
 * `text` without its ANSI escape sequences, and where each remaining
 * character came from. A secret that a program breaks up with escape codes is
 * contiguous here, so redaction can find it, and `at` maps a match back to the
 * raw stream that a cast stores.
 */
export function withoutEscapes(text: string): { plain: string; at: number[] } {
  let plain = '';
  const at: number[] = [];
  let from = 0;
  for (const match of text.matchAll(ESCAPE)) {
    for (let index = from; index < match.index; index++) {
      plain += text[index];
      at.push(index);
    }
    from = match.index + match[0].length;
  }
  for (let index = from; index < text.length; index++) {
    plain += text[index];
    at.push(index);
  }
  return { plain, at };
}

/**
 * Where `redact` would replace a secret in `text`. Redaction only replaces
 * secrets with `{{NAME}}`, so the redacted text is the parts of the original
 * that stay, with a placeholder in each gap. Returns undefined when the two
 * cannot be lined up, or when the text with the spans blanked out still holds
 * a secret: the caller then hides everything that could hold one.
 */
export function secretSpans(text: string, redact: (value: string) => string): SecretSpan[] | undefined {
  const redacted = redact(text);
  if (redacted === text) return [];
  const literals = redacted.split(PLACEHOLDER);
  const placeholders = redacted.match(PLACEHOLDER) ?? [];
  if (!text.startsWith(literals[0]!)) return undefined;
  const spans: SecretSpan[] = [];
  let at = literals[0]!.length;
  let placeholder = '';
  for (let index = 1; index < literals.length; index++) {
    placeholder += placeholders[index - 1]!;
    const literal = literals[index]!;
    // Two placeholders in a row are one gap.
    if (!literal && index < literals.length - 1) continue;
    const end =
      index === literals.length - 1
        ? text.endsWith(literal)
          ? text.length - literal.length
          : -1
        : text.indexOf(literal, at + 1);
    if (end <= at) return undefined;
    spans.push({ start: at, end, placeholder });
    at = end + literal.length;
    placeholder = '';
  }
  let blanked = '';
  let from = 0;
  for (const span of spans) {
    blanked += text.slice(from, span.start) + ' '.repeat(span.end - span.start);
    from = span.end;
  }
  blanked += text.slice(from);
  return redact(blanked) === blanked ? spans : undefined;
}
