import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { CastRecorder, castGif, readCast, Terminal, terminalPng, writeCast } from './cast.js';

/** The width, height, and frame count of a GIF, from its header and its image descriptors. */
function gifInfo(bytes: Buffer): { width: number; height: number; frames: number } {
  expect(bytes.subarray(0, 6).toString()).toBe('GIF89a');
  let frames = 0;
  for (let index = 0; index < bytes.length - 9; index++) {
    // A graphic control extension comes before each frame.
    if (bytes[index] === 0x21 && bytes[index + 1] === 0xf9 && bytes[index + 2] === 0x04) frames++;
  }
  return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8), frames };
}

function ink(png: PNG, x: number, y: number): boolean {
  const index = (y * png.width + x) * 4;
  return png.data[index] !== 0x1e || png.data[index + 1] !== 0x1e || png.data[index + 2] !== 0x1e;
}

describe('Terminal', () => {
  it('draws what a terminal shows: overwritten lines, cleared lines, and wrapped lines', async () => {
    const terminal = new Terminal(20, 4);
    terminal.write('progress 10%\rprogress 99%\r\n');
    terminal.write('\u001b[31mred\u001b[0m text\r\n');
    terminal.write('gone\u001b[2K\rkept\r\n');
    terminal.write('0123456789abcdefghijXYZ');
    await terminal.flush();
    // The first line scrolled off the top, and the text keeps it.
    expect(terminal.text()).toBe('progress 99%\nred text\nkept\n0123456789abcdefghij\nXYZ');
  });

  it('describes the cells of the screen as runs of one style, so a reader can compare surfaces', async () => {
    const terminal = new Terminal(16, 4);
    // A dialog surface, a bar, then the selected row's surface; then a plain row.
    terminal.write(
      '\u001b[48;2;41;46;66m \u001b[38;2;122;162;247m┃\u001b[48;2;59;66;97;1mHome  \u001b[0m\r\nplain\r\n',
    );
    await terminal.flush();
    expect(terminal.styleRuns()).toBe(
      [
        'row 1: 1 bg #292e42 | 2 fg #7aa2f7 bg #292e42 "┃" | 3-8 fg #7aa2f7 bg #3b4261 bold "Home"',
        'row 2: 1-5 fg #d4d4d4 bg #1e1e1e "plain"',
      ].join('\n'),
    );
    // A secret on the screen hides the text of every run, never the colours.
    expect(terminal.styleRuns((value) => value.replaceAll('Home', '{{A}}'))).toContain(
      'row 1: 1 bg #292e42 | 2 fg #7aa2f7 bg #292e42 | 3-8',
    );
    expect(terminal.styleRuns((value) => value.replaceAll('Home', '{{A}}'))).not.toContain('plain');
  });

  it('keeps the escape sequence that one chunk cuts in two', async () => {
    const terminal = new Terminal(20, 2);
    terminal.write('a\u001b[3');
    terminal.write('2mb\u001b[0m');
    await terminal.flush();
    expect(terminal.text()).toBe('ab');
  });

  it('keeps truecolor in cells and PNG pixels', async () => {
    const terminal = new Terminal(2, 1);
    terminal.write('\u001b[38;2;12;34;56m\u001b[48;2;78;90;123mX');
    await terminal.flush();
    expect(terminal.cells()[0]![0]).toMatchObject({ fg: [12, 34, 56], bg: [78, 90, 123] });
    const png = PNG.sync.read(terminalPng(terminal));
    const colors = new Set<string>();
    for (let index = 0; index < png.data.length; index += 4)
      colors.add(`${png.data[index]}:${png.data[index + 1]}:${png.data[index + 2]}`);
    expect(colors.has('12:34:56')).toBe(true);
    expect(colors.has('78:90:123')).toBe(true);
  });

  it('reads the visible alternate screen', async () => {
    const terminal = new Terminal(10, 2);
    terminal.write('normal');
    terminal.write('\u001b[?1049h\u001b[H\u001b[2JALT');
    await terminal.flush();
    expect(terminal.screenText()).toBe('ALT');
    expect(terminal.text()).toBe('ALT');
  });

  it('joins a heavy left bar across rows', async () => {
    const terminal = new Terminal(2, 2);
    terminal.write('\u001b[?25l\u001b[1;1H┃\u001b[2;1H┃');
    await terminal.flush();
    const png = PNG.sync.read(terminalPng(terminal));
    const x = 3;
    const rowBoundary = 16;
    expect(png.data[(rowBoundary - 1) * png.width * 4 + x * 4]).not.toBe(0x1e);
    expect(png.data[rowBoundary * png.width * 4 + x * 4]).not.toBe(0x1e);
  });

  it('draws Latin-1 glyphs from their own code points', async () => {
    // Terminus has no no-break space, so a lookup from 0xa0 draws » (0xbb) as ¼ (0xbc).
    const terminal = new Terminal(1, 1);
    terminal.write('\u001b[?25l»');
    await terminal.flush();
    const png = PNG.sync.read(terminalPng(terminal));
    // The sixth row of » is "#  #": the left edges of its two chevrons.
    expect([0, 1, 2, 3].map((x) => ink(png, x, 5))).toEqual([true, false, false, true]);
  });

  it('uses two cells for a wide character', async () => {
    const terminal = new Terminal(5, 1);
    terminal.write('界');
    await terminal.flush();
    expect(terminal.cells()[0]![0]).toMatchObject({ char: '界', width: 2 });
    expect(terminal.cells()[0]![1]).toMatchObject({ char: '', width: 0 });
  });

  it('does not leave common TUI glyphs blank', async () => {
    const chars = [
      '┃',
      '┏',
      '╬',
      '▏',
      '▌',
      '▐',
      '█',
      '▀',
      '▄',
      '░',
      '▒',
      '▓',
      '◐',
      '●',
      '○',
      '■',
      '□',
      '›',
      '»',
      '→',
      '←',
      '✓',
      '✗',
      '⠁',
      '…',
      '·',
    ];
    for (const char of chars) {
      const terminal = new Terminal(2, 1);
      terminal.write(`\u001b[?25l${char}`);
      await terminal.flush();
      const png = PNG.sync.read(terminalPng(terminal));
      let visible = false;
      for (let y = 0; y < 16 && !visible; y++) {
        for (let x = 0; x < 8; x++) {
          const index = (y * png.width + x) * 4;
          if (png.data[index] !== 0x1e || png.data[index + 1] !== 0x1e || png.data[index + 2] !== 0x1e) visible = true;
        }
      }
      expect(visible, char).toBe(true);
    }
  });

  it('draws braille dots from the code point bit pattern', async () => {
    const terminal = new Terminal(1, 1);
    terminal.write('\u001b[?25l⠋');
    await terminal.flush();
    const png = PNG.sync.read(terminalPng(terminal));
    for (const [x, y] of [
      [1, 1],
      [1, 5],
      [5, 1],
    ] as const)
      expect(ink(png, x, y)).toBe(true);
    for (const [x, y] of [
      [1, 9],
      [5, 5],
      [5, 9],
      [1, 13],
      [5, 13],
    ] as const)
      expect(ink(png, x, y)).toBe(false);
  });

  it('renders ◐ as a filled left half with a hollow right interior', async () => {
    const terminal = new Terminal(1, 1);
    terminal.write('\u001b[?25l◐');
    await terminal.flush();
    const png = PNG.sync.read(terminalPng(terminal));
    expect(ink(png, 2, 8)).toBe(true);
    expect(ink(png, 3, 8)).toBe(true);
    expect(ink(png, 4, 8)).toBe(false);
    expect(ink(png, 5, 8)).toBe(false);
  });

  it('renders a wide CJK glyph across both cell halves', async () => {
    const terminal = new Terminal(2, 1);
    terminal.write('\u001b[?25l界');
    await terminal.flush();
    const png = PNG.sync.read(terminalPng(terminal));
    expect(Array.from({ length: 8 }, (_, x) => ink(png, x, 4)).some(Boolean)).toBe(true);
    expect(Array.from({ length: 8 }, (_, x) => ink(png, x + 8, 4)).some(Boolean)).toBe(true);
  });
});

describe('cast', () => {
  it('writes an asciicast v2 file and reads it back', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bugpatrol-cast-'));
    try {
      const file = join(dir, 'run.cast');
      await writeCast(file, {
        width: 80,
        height: 24,
        events: [
          [0, '$ acme --json\r\n'],
          [0.5, '{"ok": true}\r\n'],
        ],
      });
      const lines = (await readFile(file, 'utf8')).trim().split('\n');
      expect(JSON.parse(lines[0]!)).toMatchObject({ version: 2, width: 80, height: 24 });
      expect(JSON.parse(lines[2]!)).toEqual([0.5, 'o', '{"ok": true}\r\n']);
      expect(await readCast(file)).toEqual({
        width: 80,
        height: 24,
        events: [
          [0, '$ acme --json\r\n'],
          [0.5, '{"ok": true}\r\n'],
        ],
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('renders a cast to a GIF of at most 640 px wide, with a frame for each change', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bugpatrol-cast-'));
    try {
      const events: [number, string][] = [[0, '$ acme export --json\r\n']];
      for (let line = 0; line < 30; line++) events.push([0.2 + line * 0.2, `\u001b[32mrow ${line}\u001b[0m done\r\n`]);
      await writeCast(join(dir, 'run.cast'), { width: 80, height: 24, events });
      expect(await castGif(join(dir, 'run.cast'), join(dir, 'run.gif'))).toBe(true);
      const info = gifInfo(await readFile(join(dir, 'run.gif')));
      expect(info.width).toBe(640);
      expect(info.height).toBe(24 * 16);
      expect(info.frames).toBeGreaterThan(10);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps a long cast inside 15 s by shortening its pauses', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bugpatrol-cast-'));
    try {
      const events: [number, string][] = [];
      for (let line = 0; line < 20; line++) events.push([line * 5, `line ${line}\r\n`]);
      await writeCast(join(dir, 'run.cast'), { width: 80, height: 24, events });
      expect(await castGif(join(dir, 'run.cast'), join(dir, 'run.gif'))).toBe(true);
      const gif = await readFile(join(dir, 'run.gif'));
      let centiseconds = 0;
      for (let index = 0; index < gif.length - 9; index++) {
        if (gif[index] === 0x21 && gif[index + 1] === 0xf9 && gif[index + 2] === 0x04)
          centiseconds += gif.readUInt16LE(index + 4);
      }
      expect(centiseconds / 100).toBeLessThanOrEqual(15);
      expect(gifInfo(gif).frames).toBe(20);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('gives no GIF for a file that is not a cast', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bugpatrol-cast-'));
    try {
      await writeFile(join(dir, 'run.cast'), 'not a cast');
      await expect(castGif(join(dir, 'run.cast'), join(dir, 'run.gif'))).rejects.toThrow(/not an asciicast/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('draws the screen of a terminal as a PNG with text on it', async () => {
    const blank = PNG.sync.read(terminalPng(new Terminal(80, 24)));
    const terminal = new Terminal(80, 24);
    terminal.write('hello');
    await terminal.flush();
    const png = PNG.sync.read(terminalPng(terminal));
    expect([png.width, png.height]).toEqual([640, 384]);
    expect(png.data.equals(blank.data)).toBe(false);
  });

  it('hides each cell of a secret on the PNG, also where the secret wraps onto the next row', async () => {
    const secret = 'hunter2-very-secret';
    const redact = (value: string) => value.replaceAll(secret, '{{TOKEN}}');
    const terminal = new Terminal(10, 3);
    // "hunter2-ve" fills row 1 from column 0, "ry-secret" starts row 2.
    terminal.write(`\u001b[?25l${secret} ok`);
    await terminal.flush();
    const png = PNG.sync.read(terminalPng(terminal, redact));
    const grey = (col: number, row: number) => {
      for (let y = row * 16; y < (row + 1) * 16; y++)
        for (let x = col * 8; x < (col + 1) * 8; x++) {
          const index = (y * png.width + x) * 4;
          if (png.data[index] !== 0x80 || png.data[index + 1] !== 0x80 || png.data[index + 2] !== 0x80) return false;
        }
      return true;
    };
    for (let col = 0; col < 10; col++) expect(grey(col, 0)).toBe(true);
    for (let col = 0; col < 9; col++) expect(grey(col, 1)).toBe(true);
    // " ok" after the secret is drawn as usual.
    expect(grey(9, 1)).toBe(false);
    expect(grey(0, 2)).toBe(false);
    const plain = PNG.sync.read(terminalPng(terminal));
    expect(plain.data.equals(png.data)).toBe(false);
  });

  it('redacts a secret that wraps onto the next row in the screen text, not only in the PNG', async () => {
    const secret = 'hunter2-very-secret';
    const redact = (value: string) => value.replaceAll(secret, '{{TOKEN}}');
    const terminal = new Terminal(10, 3);
    terminal.write(`\u001b[?25l${secret} ok`);
    await terminal.flush();
    const text = terminal.screenTextRedacted(redact);
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('very-secret');
    expect(text).toContain('{{TOKEN}}');
    // A secret on one line is redacted in place, and the rest of the screen is kept.
    const wide = new Terminal(40, 2);
    wide.write(`key: ${secret}\r\ndone`);
    await wide.flush();
    expect(wide.screenTextRedacted(redact)).toBe('key: {{TOKEN}}\ndone');
  });

  it('hides the whole screen text when a secret cannot be lined up with the rows', async () => {
    const terminal = new Terminal(20, 2);
    terminal.write('key: hunter2-very-secret');
    await terminal.flush();
    // Redaction that removes the secret instead of putting a placeholder in its place.
    const text = terminal.screenTextRedacted((value) => value.replaceAll('hunter2-very-secret', ''));
    expect(text).not.toContain('hunter2');
    expect(text.split('\n').every((row) => /^\u2588*$/.test(row))).toBe(true);
  });

  it('redacts a recording as one stream, so a secret split across chunks is still found', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bugpatrol-cast-'));
    try {
      const recorder = new CastRecorder({ width: 80, height: 24 }, (value) =>
        value.replaceAll('hunter2-very-secret', '{{TOKEN}}'),
      );
      recorder.start();
      recorder.push('key: hunter2-');
      recorder.push('very-secret\r\n');
      recorder.push('done\r\n');
      const file = await recorder.stop(join(dir, 'run'));
      const text = await readFile(file, 'utf8');
      expect(text).not.toContain('hunter2');
      expect(text).not.toContain('very-secret');
      expect((await readCast(file)).events.map(([, output]) => output)).toEqual(['key: {{TOKEN}}', '\r\n', 'done\r\n']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('redacts a secret that escape codes break up, in the recording and the GIF rendered from it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bugpatrol-cast-'));
    try {
      const recorder = new CastRecorder({ width: 80, height: 24 }, (value) =>
        value.replaceAll('hunter2-very-secret', '{{TOKEN}}'),
      );
      recorder.start();
      // The program colours each half of the secret, so the raw stream has escapes between its characters.
      recorder.push('key: \u001b[31mhunter2-\u001b[0m\u001b[32mvery-secret\u001b[0m\r\n');
      const file = await recorder.stop(join(dir, 'run'));
      const text = await readFile(file, 'utf8');
      expect(text).not.toContain('hunter2');
      expect(text).not.toContain('very-secret');
      const output = (await readCast(file)).events.map(([, chunk]) => chunk).join('');
      expect(output).toContain('{{TOKEN}}');
      expect(await castGif(file, join(dir, 'run.gif'))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('records a resize, and draws the GIF at the largest size the terminal had', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bugpatrol-cast-'));
    try {
      const recorder = new CastRecorder({ width: 20, height: 5 });
      recorder.start();
      recorder.push('small\r\n');
      recorder.resize(40, 8);
      recorder.push('large');
      const file = await recorder.stop(join(dir, 'run'));
      const lines = (await readFile(file, 'utf8')).trim().split('\n');
      expect(JSON.parse(lines[2]!)).toEqual([expect.any(Number), 'r', '40x8']);
      expect((await readCast(file)).events[1]).toEqual([expect.any(Number), '40x8', 'r']);
      expect(await castGif(file, join(dir, 'run.gif'))).toBe(true);
      const info = gifInfo(await readFile(join(dir, 'run.gif')));
      expect(info).toMatchObject({ width: 40 * 8, height: 8 * 16 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('draws each box drawing character from its own arms, not as a cross', async () => {
    const draw = async (char: string) => {
      const terminal = new Terminal(1, 1);
      terminal.write(`\u001b[?25l${char}`);
      await terminal.flush();
      const png = PNG.sync.read(terminalPng(terminal));
      return Array.from({ length: 16 }, (_, y) =>
        Array.from({ length: 8 }, (_, x) => (ink(png, x, y) ? '#' : '.')).join(''),
      );
    };
    const cross = await draw('┼');
    // U+2574 is LIGHT LEFT: the left arm only.
    const left = await draw('╴');
    expect(left[7]).toBe('#####...');
    expect(left[0]).toBe('........');
    // Dashed lines have gaps.
    expect((await draw('┄'))[7]).toMatch(/#\.#/);
    expect((await draw('┆')).map((row) => row[3]).join('')).toMatch(/#\.#/);
    // Heavy and double lines are not the light cross.
    for (const char of ['╋', '╬', '┽', '╪', '╼', '╍']) expect(await draw(char)).not.toEqual(cross);
    // A half heavy, half light line keeps each weight.
    const mixed = await draw('╼');
    expect(mixed[6]).toBe('...#####');
    expect(mixed[7]).toBe('########');
  });
});
