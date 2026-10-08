import { readFile, writeFile } from 'node:fs/promises';
import regular from 'bdf-fonts/fonts/Terminus/16.js';
import bold from 'bdf-fonts/fonts/Terminus/16-b.js';
import * as gifenc from 'gifenc';
import { PNG } from 'pngjs';
import { GIF_MAX_BYTES } from './video.js';

/**
 * A terminal session: its size in characters, and each piece of output with
 * the second it came at. On disk it is an asciicast v2 file, which the
 * dashboard plays and asciinema reads.
 */
export type Cast = { width: number; height: number; events: [number, string][] };

/** The 16 ANSI colors of xterm, then the default text and background of the terminal. */
const PALETTE = [
  [0x00, 0x00, 0x00],
  [0xcd, 0x31, 0x31],
  [0x0d, 0xbc, 0x79],
  [0xe5, 0xe5, 0x10],
  [0x24, 0x72, 0xc8],
  [0xbc, 0x3f, 0xbc],
  [0x11, 0xa8, 0xcd],
  [0xe5, 0xe5, 0xe5],
  [0x66, 0x66, 0x66],
  [0xf1, 0x4c, 0x4c],
  [0x23, 0xd1, 0x8b],
  [0xf5, 0xf5, 0x43],
  [0x3b, 0x8e, 0xea],
  [0xd6, 0x70, 0xd6],
  [0x29, 0xb8, 0xdb],
  [0xff, 0xff, 0xff],
  [0xd4, 0xd4, 0xd4],
  [0x1e, 0x1e, 0x1e],
];
const TEXT = 16;
const BACKGROUND = 17;
/** Terminus 16 is 8 by 16 pixels, so the 80 columns of a terminal are 640 px wide. */
const GLYPH = { width: 8, height: 16 };
/** gifenc ships CommonJS for Node and ESM for bundlers, so its encoder is a named export in one and on the default in the other. */
const GIFEncoder = gifenc.GIFEncoder ?? gifenc.default.GIFEncoder;

type Cell = { char: string; fg: number; bg: number; bold: boolean; inverse: boolean };
type Style = Omit<Cell, 'char'>;
const PLAIN: Style = { fg: TEXT, bg: BACKGROUND, bold: false, inverse: false };

/** The nearest ANSI color to a 256-color or a 24-bit color, since the palette has 16. */
function nearest(rgb: number[]): number {
  let best = 0;
  let distance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < 16; index++) {
    const color = PALETTE[index]!;
    const next = (color[0]! - rgb[0]!) ** 2 + (color[1]! - rgb[1]!) ** 2 + (color[2]! - rgb[2]!) ** 2;
    if (next < distance) [best, distance] = [index, next];
  }
  return best;
}

function color256(code: number): number {
  if (code < 16) return code;
  if (code >= 232) return nearest(Array(3).fill(8 + (code - 232) * 10));
  const cube = code - 16;
  const level = (value: number) => (value ? 55 + value * 40 : 0);
  return nearest([level(Math.floor(cube / 36)), level(Math.floor(cube / 6) % 6), level(cube % 6)]);
}

/**
 * The screen of a terminal that output is written to, and the lines that
 * scrolled off its top. It knows the escape sequences that command line
 * tools print: colors, cursor moves, and line and screen clears. It ignores
 * the others, so a cast of a full screen program draws roughly.
 */
export class Terminal {
  private grid: Cell[][];
  private history: string[] = [];
  private x = 0;
  private y = 0;
  /** At the last column, the next character goes to the next line. */
  private wrap = false;
  private style: Style = { ...PLAIN };
  private saved = { x: 0, y: 0 };
  /** An escape sequence that the end of the last write cut off. */
  private pending = '';

  constructor(
    readonly cols: number,
    readonly rows: number,
  ) {
    this.grid = Array.from({ length: rows }, () => this.blank());
  }

  private blank(): Cell[] {
    return Array.from({ length: this.cols }, () => ({ char: ' ', ...PLAIN }));
  }

  write(text: string): void {
    const data = this.pending + text;
    this.pending = '';
    let index = 0;
    while (index < data.length) {
      const char = data[index]!;
      if (char === '\u001b') {
        const used = this.escape(data, index);
        if (used === undefined) {
          // Cut off. A sequence this long is not one, so it is dropped.
          if (data.length - index < 256) this.pending = data.slice(index);
          return;
        }
        index += used;
        continue;
      }
      const point = data.codePointAt(index)!;
      const next = String.fromCodePoint(point);
      index += next.length;
      if (char === '\r') [this.x, this.wrap] = [0, false];
      else if (char === '\n' || char === '\v' || char === '\f') this.lineFeed();
      else if (char === '\b') [this.x, this.wrap] = [Math.max(0, this.x - 1), false];
      else if (char === '\t') this.x = Math.min(this.cols - 1, (Math.floor(this.x / 8) + 1) * 8);
      else if (point >= 0x20 && point !== 0x7f) this.put(next);
    }
  }

  /** The lines that scrolled off, then the screen, with no trailing spaces or empty lines. */
  text(): string {
    const lines = [...this.history, ...this.grid.map((row) => row.map((cell) => cell.char).join(''))].map((line) =>
      line.trimEnd(),
    );
    while (lines.length && !lines.at(-1)) lines.pop();
    return lines.join('\n');
  }

  /** The palette index of each pixel of the screen, row by row. */
  pixels(): Uint8Array {
    const width = this.cols * GLYPH.width;
    const out = new Uint8Array(width * this.rows * GLYPH.height);
    for (let row = 0; row < this.rows; row++) {
      for (let col = 0; col < this.cols; col++) {
        const cell = this.grid[row]![col]!;
        const [fg, bg] = cell.inverse ? [cell.bg, cell.fg] : [cell.fg, cell.bg];
        const bits = glyph(cell.char, cell.bold);
        for (let line = 0; line < GLYPH.height; line++) {
          const start = (row * GLYPH.height + line) * width + col * GLYPH.width;
          for (let bit = 0; bit < GLYPH.width; bit++) out[start + bit] = (bits[line]! << bit) & 0x80 ? fg : bg;
        }
      }
    }
    return out;
  }

  private put(char: string): void {
    if (this.wrap) {
      this.x = 0;
      this.wrap = false;
      this.lineFeed();
    }
    this.grid[this.y]![this.x] = { char, ...this.style };
    if (this.x === this.cols - 1) this.wrap = true;
    else this.x++;
  }

  private lineFeed(): void {
    this.wrap = false;
    if (this.y < this.rows - 1) {
      this.y++;
      return;
    }
    this.history.push(
      this.grid
        .shift()!
        .map((cell) => cell.char)
        .join(''),
    );
    if (this.history.length > 10_000) this.history.shift();
    this.grid.push(this.blank());
  }

  private clear(row: number, from: number, to: number): void {
    for (let col = Math.max(0, from); col < Math.min(this.cols, to); col++)
      this.grid[row]![col] = { char: ' ', ...PLAIN, bg: this.style.bg };
  }

  /** Runs the escape sequence at `index` and returns its length, or undefined when the data ends inside it. */
  private escape(data: string, index: number): number | undefined {
    const kind = data[index + 1];
    if (kind === undefined) return undefined;
    if (kind === '[') {
      let end = index + 2;
      while (end < data.length && !/[\x40-\x7e]/.test(data[end]!)) end++;
      if (end >= data.length) return undefined;
      this.csi(data.slice(index + 2, end), data[end]!);
      return end + 1 - index;
    }
    if (kind === ']' || kind === 'P' || kind === '_') {
      // A title, a link, or another string: it draws nothing.
      const bell = data.indexOf('\u0007', index);
      const st = data.indexOf('\u001b\\', index + 1);
      const ends = [bell >= 0 ? bell + 1 : -1, st >= 0 ? st + 2 : -1].filter((end) => end > 0);
      return ends.length ? Math.min(...ends) - index : undefined;
    }
    if (kind === '(' || kind === ')') return data.length > index + 2 ? 3 : undefined;
    if (kind === '7') this.saved = { x: this.x, y: this.y };
    if (kind === '8') [this.x, this.y] = [this.saved.x, this.saved.y];
    if (kind === 'M') this.y = Math.max(0, this.y - 1);
    return 2;
  }

  private csi(params: string, final: string): void {
    const privateMode = /^[?>=]/.test(params);
    const numbers = params
      .replace(/^[?>=]/, '')
      .split(';')
      .map((value) => Number.parseInt(value, 10));
    const n = (at = 0, fallback = 1) => (Number.isNaN(numbers[at]) ? fallback : numbers[at]!);
    const clampX = (x: number) => Math.min(this.cols - 1, Math.max(0, x));
    const clampY = (y: number) => Math.min(this.rows - 1, Math.max(0, y));
    if (privateMode) {
      // The alternate screen of a full screen program starts blank.
      if (numbers[0] === 1049 && (final === 'h' || final === 'l'))
        this.grid = Array.from({ length: this.rows }, () => this.blank());
      return;
    }
    if (final !== 'm') this.wrap = false;
    switch (final) {
      case 'm':
        this.sgr(params ? numbers.map((value) => (Number.isNaN(value) ? 0 : value)) : [0]);
        return;
      case 'K': {
        const mode = n(0, 0);
        if (mode === 0) this.clear(this.y, this.x, this.cols);
        else if (mode === 1) this.clear(this.y, 0, this.x + 1);
        else this.clear(this.y, 0, this.cols);
        return;
      }
      case 'J': {
        const mode = n(0, 0);
        const rows =
          mode === 0
            ? Array.from({ length: this.rows - this.y - 1 }, (_, i) => this.y + 1 + i)
            : mode === 1
              ? Array.from({ length: this.y }, (_, i) => i)
              : Array.from({ length: this.rows }, (_, i) => i);
        if (mode === 0) this.clear(this.y, this.x, this.cols);
        if (mode === 1) this.clear(this.y, 0, this.x + 1);
        for (const row of rows) this.clear(row, 0, this.cols);
        return;
      }
      case 'H':
      case 'f':
        [this.y, this.x] = [clampY(n(0) - 1), clampX(n(1) - 1)];
        return;
      case 'A':
        this.y = clampY(this.y - n());
        return;
      case 'B':
        this.y = clampY(this.y + n());
        return;
      case 'C':
        this.x = clampX(this.x + n());
        return;
      case 'D':
        this.x = clampX(this.x - n());
        return;
      case 'E':
      case 'F':
        [this.x, this.y] = [0, clampY(this.y + (final === 'E' ? n() : -n()))];
        return;
      case 'G':
        this.x = clampX(n() - 1);
        return;
      case 'd':
        this.y = clampY(n() - 1);
        return;
      case 's':
        this.saved = { x: this.x, y: this.y };
        return;
      case 'u':
        [this.x, this.y] = [this.saved.x, this.saved.y];
        return;
      case 'X':
        this.clear(this.y, this.x, this.x + n());
        return;
      case 'P': {
        const row = this.grid[this.y]!;
        row.splice(this.x, n());
        while (row.length < this.cols) row.push({ char: ' ', ...PLAIN });
        return;
      }
      case '@': {
        const row = this.grid[this.y]!;
        row.splice(this.x, 0, ...Array.from({ length: n() }, () => ({ char: ' ', ...PLAIN })));
        row.length = this.cols;
        return;
      }
    }
  }

  private sgr(codes: number[]): void {
    for (let index = 0; index < codes.length; index++) {
      const code = codes[index]!;
      if (code === 0) this.style = { ...PLAIN };
      else if (code === 1) this.style.bold = true;
      else if (code === 22) this.style.bold = false;
      else if (code === 7) this.style.inverse = true;
      else if (code === 27) this.style.inverse = false;
      else if (code >= 30 && code <= 37) this.style.fg = code - 30;
      else if (code >= 90 && code <= 97) this.style.fg = code - 90 + 8;
      else if (code === 39) this.style.fg = TEXT;
      else if (code >= 40 && code <= 47) this.style.bg = code - 40;
      else if (code >= 100 && code <= 107) this.style.bg = code - 100 + 8;
      else if (code === 49) this.style.bg = BACKGROUND;
      else if (code === 38 || code === 48) {
        const mode = codes[index + 1];
        let value: number | undefined;
        if (mode === 5) {
          value = color256(codes[index + 2] ?? 0);
          index += 2;
        } else if (mode === 2) {
          value = nearest(codes.slice(index + 2, index + 5));
          index += 4;
        }
        if (value !== undefined) this.style[code === 38 ? 'fg' : 'bg'] = value;
      }
    }
  }
}

/** The rows of bits of a character. Terminus has ASCII and Latin-1; any other character draws as `?`. */
function glyph(char: string, heavy: boolean): number[] {
  const font = heavy ? bold : regular;
  const code = char.codePointAt(0)!;
  const index = code >= 32 && code <= 126 ? code - 32 : code >= 160 && code <= 255 ? code - 160 + 95 : 31;
  return font[index]!.BITMAP;
}

/** The screen of a terminal as a PNG. */
export function terminalPng(terminal: Terminal): Buffer {
  const png = new PNG({ width: terminal.cols * GLYPH.width, height: terminal.rows * GLYPH.height });
  const pixels = terminal.pixels();
  for (let index = 0; index < pixels.length; index++) {
    const color = PALETTE[pixels[index]!]!;
    png.data.set([color[0]!, color[1]!, color[2]!, 255], index * 4);
  }
  return PNG.sync.write(png);
}

export async function writeCast(file: string, cast: Cast): Promise<void> {
  const lines = [
    { version: 2, width: cast.width, height: cast.height, env: { TERM: 'xterm-256color' } },
    ...cast.events.map(([at, text]) => [Math.round(at * 1000) / 1000, 'o', text]),
  ];
  await writeFile(file, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
}

/** Reads the output of an asciicast v2 file. A torn last line, from a session that was killed, is skipped. */
export async function readCast(file: string): Promise<Cast> {
  const [first, ...rest] = (await readFile(file, 'utf8')).split('\n');
  let header: { version?: unknown; width?: unknown; height?: unknown };
  try {
    header = JSON.parse(first ?? '');
  } catch {
    header = {};
  }
  if (header.version !== 2 || typeof header.width !== 'number' || typeof header.height !== 'number')
    throw new Error(`${file} is not an asciicast v2 file`);
  const events: [number, string][] = [];
  for (const line of rest) {
    try {
      const [at, kind, text] = JSON.parse(line);
      if (kind === 'o' && typeof at === 'number' && typeof text === 'string') events.push([at, text]);
    } catch {}
  }
  return { width: header.width, height: header.height, events };
}

/** Limits from #58, the same as for the GIF of a video. */
const GIF_SECONDS = 15;
/** The last screen stays this long, so the result of the command shows. */
const HOLD_SECONDS = 2;
/** A pause longer than this shows as this long: a reader waits for nothing. */
const MAX_PAUSE = 2;

/**
 * The times at which each event shows. Pauses are cut to 2 s, then every
 * time is scaled down when the cast is still longer than the GIF may be.
 * Unlike the GIF of a video, it never cuts the start, since that is where
 * the command is.
 */
function timeline(events: Cast['events']): number[] {
  const times: number[] = [];
  let previous = 0;
  let now = 0;
  for (const [at] of events) {
    now += Math.min(Math.max(at - previous, 0), MAX_PAUSE);
    previous = at;
    times.push(now);
  }
  const room = GIF_SECONDS - HOLD_SECONDS;
  const scale = now > room ? room / now : 1;
  return times.map((at) => at * scale);
}

/** Draws a cast at a given frame rate: one frame for each change of the screen, at most `fps` a second. */
function renderGif(cast: Cast, fps: number): Uint8Array {
  const terminal = new Terminal(cast.width, cast.height);
  const times = timeline(cast.events);
  const groups: { at: number; end: number }[] = [];
  for (let index = 0; index < times.length; ) {
    const at = times[index]!;
    while (index < times.length && times[index]! < at + 1 / fps) index++;
    groups.push({ at, end: index });
  }
  if (!groups.length || groups[0]!.at > 0) groups.unshift({ at: 0, end: 0 });
  const gif = GIFEncoder();
  const palette = [...PALETTE, ...Array(32 - PALETTE.length).fill([0, 0, 0])];
  const centiseconds = (seconds: number) => Math.round(seconds * 100);
  let written = 0;
  for (const [index, group] of groups.entries()) {
    while (written < group.end) terminal.write(cast.events[written++]![1]);
    const next = groups[index + 1]?.at ?? group.at + HOLD_SECONDS;
    gif.writeFrame(terminal.pixels(), cast.width * GLYPH.width, cast.height * GLYPH.height, {
      ...(index ? {} : { palette, repeat: 0 }),
      delay: (centiseconds(next) - centiseconds(group.at)) * 10,
    });
  }
  gif.finish();
  return gif.bytes();
}

/** The frame rates to try, from the best: a cast that streams output can make a GIF over the budget. */
const GIF_FPS = [10, 8, 5, 2];

/**
 * Renders a cast to the GIF that a pull request review shows inline, with
 * no browser and no ffmpeg. Returns false when no try fits the size budget,
 * and then writes no GIF. Throws when the file is not a cast.
 */
export async function castGif(file: string, gif: string): Promise<boolean> {
  const cast = await readCast(file);
  for (const fps of GIF_FPS) {
    const bytes = renderGif(cast, fps);
    if (bytes.length <= GIF_MAX_BYTES) {
      await writeFile(gif, bytes);
      return true;
    }
  }
  return false;
}
