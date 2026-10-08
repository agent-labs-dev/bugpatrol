import { describe, expect, it } from 'vitest';
import { fitLesson, LESSON_MAX_LENGTH, lessonTooLong } from './agents.js';

describe('fitLesson', () => {
  it('keeps a lesson that fits', () => {
    const text = 'a'.repeat(LESSON_MAX_LENGTH);
    expect(fitLesson(`  ${text} `)).toBe(text);
  });

  it('cuts a long lesson at the last word boundary and marks the cut', () => {
    const stderr = `error TS2322: Type 'string' is not assignable to type 'number' in ${'packages/app/src/'.repeat(12)}index.ts`;
    const text = fitLesson(`The verify command failed with: ${stderr}. Run it before you finish.`);
    expect(text.length).toBeLessThanOrEqual(LESSON_MAX_LENGTH);
    expect(text).toBe(
      "The verify command failed with: error TS2322: Type 'string' is not assignable to type 'number' in…",
    );
  });

  it('keeps a whole word that ends right before the ellipsis', () => {
    const text = fitLesson(`${'a'.repeat(199)} and more`);
    expect(text).toBe(`${'a'.repeat(199)}…`);
  });

  it('cuts mid-word only when one word is longer than the limit', () => {
    const text = fitLesson('x'.repeat(300));
    expect(text).toBe(`${'x'.repeat(LESSON_MAX_LENGTH - 1)}…`);
  });
});

describe('lessonTooLong', () => {
  it('names the length and the limit only for a lesson over the limit', () => {
    expect(lessonTooLong('a'.repeat(LESSON_MAX_LENGTH))).toBeUndefined();
    expect(lessonTooLong('a'.repeat(LESSON_MAX_LENGTH + 1))).toBe(
      'The lesson has 201 characters, and the limit is 200. Nothing was saved. Write it shorter.',
    );
  });
});
