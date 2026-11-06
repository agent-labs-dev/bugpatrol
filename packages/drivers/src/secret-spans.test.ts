import { describe, expect, it } from 'vitest';
import { redactTerminal, secretSpans } from './secret-spans.js';

const redact = (value: string) => value.replaceAll('s3cret', '{{A}}').replaceAll('tok', '{{B}}');

describe('secretSpans', () => {
  it('finds each secret that redaction replaces, also two in a row', () => {
    expect(secretSpans('plain', redact)).toEqual([]);
    expect(secretSpans('x s3cret y tok', redact)).toEqual([
      { start: 2, end: 8, placeholder: '{{A}}' },
      { start: 11, end: 14, placeholder: '{{B}}' },
    ]);
    expect(secretSpans('s3crettok!', redact)).toEqual([{ start: 0, end: 9, placeholder: '{{A}}{{B}}' }]);
  });

  it('covers a literal placeholder next to a secret, rather than miss the secret', () => {
    expect(secretSpans('{{A}}s3cret', redact)).toEqual([{ start: 0, end: 11, placeholder: '{{A}}{{A}}' }]);
  });

  it('gives up when redaction does more than put placeholders in place of secrets', () => {
    expect(secretSpans('a s3cret b', (value) => value.replaceAll('s3cret', ''))).toBeUndefined();
  });
});

describe('redactTerminal', () => {
  const rows = (value: string) => value.replaceAll('18', '{{ROWS}}');

  it('never alters a control sequence, and redacts the text around it', () => {
    expect(redactTerminal('\u001b[2;18mdim\u001b[0m 18 rows\u001b[18;1H\u001b8', rows)).toBe(
      '\u001b[2;18mdim\u001b[0m {{ROWS}} rows\u001b[18;1H\u001b8',
    );
  });

  it('still redacts a secret that colours break up, and one in a hyperlink target', () => {
    expect(redactTerminal('x s3\u001b[1mcr\u001b[0met y', redact)).toBe('x {{A}} y');
    expect(redactTerminal('\u001b]8;;https://a.test/?t=tok\u001b\\link\u001b]8;;\u001b\\', redact)).toBe(
      '\u001b]8;;https://a.test/?t={{B}}\u001b\\link\u001b]8;;\u001b\\',
    );
  });
});
