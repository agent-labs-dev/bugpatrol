import { PNG } from 'pngjs';
import { expect, it } from 'vitest';
import { Terminal, terminalPng } from './cast.js';

it.each([
  ['▉', 7],
  ['▊', 6],
  ['▋', 5],
  ['▌', 4],
  ['▍', 3],
  ['▎', 2],
  ['▏', 1],
] as const)('renders %s with its Unicode left-block width of %i pixels', async (glyph, filled) => {
  const terminal = new Terminal(2, 1);
  terminal.write(`\u001b[?25l${glyph}`);
  await terminal.flush();
  const png = PNG.sync.read(terminalPng(terminal));
  // In an eight-pixel cell, a left half block fills four columns and leaves four as background.
  const row = Array.from({ length: 8 }, (_, x) => png.data[(8 * png.width + x) * 4] !== 0x1e);
  expect(row).toEqual(Array.from({ length: 8 }, (_, x) => x < filled));
});
