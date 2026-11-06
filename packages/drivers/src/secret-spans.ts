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

/**
 * Where the control sequences of `text` are: CSI and two-character escapes.
 * Their parameters are numbers and modes, never text a program shows, so
 * redaction leaves them whole. An OSC is not one: its payload, such as a
 * hyperlink target, can hold a secret.
 */
export function controlRanges(text: string): [start: number, end: number][] {
  const ranges: [number, number][] = [];
  for (const match of text.matchAll(ESCAPE)) {
    if (match[0][1] !== ']') ranges.push([match.index, match.index + match[0].length]);
  }
  return ranges;
}

/**
 * `text`, terminal output, with each secret replaced and every control
 * sequence kept as it came. A secret that a program breaks up with escape
 * codes is found in the text without them; a secret in an OSC payload is
 * found there. A short secret such as `18` therefore never turns
 * `ESC[2;18m` into broken output.
 */
export function redactTerminal(text: string, redact: (value: string) => string): string {
  const { plain, at } = withoutEscapes(text);
  if (redact(text) === text && redact(plain) === plain) return text;
  let joined = text;
  const spans = secretSpans(plain, redact);
  if (spans?.length) {
    joined = '';
    let from = 0;
    for (const span of spans) {
      // A secret broken up by escape codes loses them with it: they styled the secret.
      joined += text.slice(from, at[span.start]!) + span.placeholder;
      from = at[span.end - 1]! + 1;
    }
    joined += text.slice(from);
  }
  // What is left: secrets in OSC payloads, or all of the text when the spans could not be lined up.
  let out = '';
  let from = 0;
  for (const [start, end] of controlRanges(joined)) {
    out += redact(joined.slice(from, start)) + joined.slice(start, end);
    from = end;
  }
  return out + redact(joined.slice(from));
}
