/** A part of a text that redaction replaces: `[start, end)` and the placeholder that stands for it. */
export type SecretSpan = { start: number; end: number; placeholder: string };

const PLACEHOLDER = /\{\{[A-Za-z_][A-Za-z_0-9]*\}\}/g;

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
