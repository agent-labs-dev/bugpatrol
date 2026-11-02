import { describe, expect, it } from 'vitest';
import { secretSpans } from './secret-spans.js';

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
