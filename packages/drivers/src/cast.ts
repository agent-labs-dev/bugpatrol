import { readFile, writeFile } from 'node:fs/promises';
import * as unicode11Module from '@xterm/addon-unicode11';
import * as xtermModule from '@xterm/headless';
import regular from 'bdf-fonts/fonts/Terminus/16.js';
import bold from 'bdf-fonts/fonts/Terminus/16-b.js';
import * as gifenc from 'gifenc';
import { PNG } from 'pngjs';
import { controlRanges, type SecretSpan, secretSpans, withoutEscapes } from './secret-spans.js';
import { GIF_MAX_BYTES } from './video.js';

/**
 * A terminal session: its size in characters, and each piece of output with
 * the second it came at. An event with `r` is a resize, and its text is the
 * new size, such as `60x20`. On disk it is an asciicast v2 file, which the
 * dashboard plays and asciinema reads.
 */
export type CastEvent = [at: number, text: string, kind?: 'r'];
export type Cast = { width: number; height: number; events: CastEvent[] };

export type TerminalRgb = readonly [number, number, number];

export type TerminalCell = {
  char: string;
  width: number;
  fg: TerminalRgb;
  bg: TerminalRgb;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  inverse: boolean;
  dim: boolean;
};

/** The xterm default palette, followed by the default text and background colors. */
const PALETTE: TerminalRgb[] = [
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
];
const TEXT: TerminalRgb = [0xd4, 0xd4, 0xd4];
const BACKGROUND: TerminalRgb = [0x1e, 0x1e, 0x1e];
const GLYPH = { width: 8, height: 16 };
/** What a screen row shows when a secret on it cannot be isolated. */
const HIDDEN = '\u2588';
/** GIFs remain indexed, but use the complete xterm 256-color palette. PNGs do not use this palette. */
const GIF_PALETTE: TerminalRgb[] = [
  ...PALETTE,
  ...Array.from({ length: 216 }, (_, index) => {
    const level = (value: number) => (value ? 55 + value * 40 : 0);
    return [level(Math.floor(index / 36)), level(Math.floor(index / 6) % 6), level(index % 6)] as TerminalRgb;
  }),
  ...Array.from({ length: 24 }, (_, index) => [8 + index * 10, 8 + index * 10, 8 + index * 10] as TerminalRgb),
];
/** gifenc ships CommonJS for Node and ESM for bundlers, so its encoder is a named export in one and on the default in the other. */
const GIFEncoder = gifenc.GIFEncoder ?? gifenc.default.GIFEncoder;

type XtermPackage = typeof xtermModule & { default?: typeof xtermModule };
const xtermPackage = xtermModule as XtermPackage;
const XtermTerminal = (xtermPackage.default ?? xtermPackage).Terminal;
type Unicode11Package = typeof unicode11Module & { default?: typeof unicode11Module };
const unicode11Package = unicode11Module as Unicode11Package;
const Unicode11Addon = (unicode11Package.default ?? unicode11Package).Unicode11Addon;

type UnifontGlyphs = Map<number, Uint8Array>;
let unifontGlyphs: UnifontGlyphs | undefined;
let unifontLoading: Promise<UnifontGlyphs> | undefined;

const XTERM_THEME = {
  foreground: '#d4d4d4',
  background: '#1e1e1e',
  cursor: '#d4d4d4',
  black: '#000000',
  red: '#cd3131',
  green: '#0dbc79',
  yellow: '#e5e510',
  blue: '#2472c8',
  magenta: '#bc3fbc',
  cyan: '#11a8cd',
  white: '#e5e5e5',
  brightBlack: '#666666',
  brightRed: '#f14c4c',
  brightGreen: '#23d18b',
  brightYellow: '#f5f543',
  brightBlue: '#3b8eea',
  brightMagenta: '#d670d6',
  brightCyan: '#29b8db',
  brightWhite: '#ffffff',
};

function isProceduralCode(code: number): boolean {
  return (code >= 0x2500 && code <= 0x259f) || (code >= 0x2800 && code <= 0x28ff);
}

/**
 * The Terminus arrays hold ASCII 0x20-0x7e, then Latin-1 from 0xa1: there is
 * no entry for the no-break space, so 0xa1 is index 95.
 */
function terminusIndex(code: number): number | undefined {
  if (code >= 0x20 && code <= 0x7e) return code - 0x20;
  if (code >= 0xa1 && code <= 0xff) return code - 0xa1 + 95;
  return undefined;
}

function hasTerminusGlyph(code: number): boolean {
  const index = code >= 0xa1 ? terminusIndex(code) : undefined;
  return index !== undefined && (regular[index]?.BITMAP.some((row) => row !== 0) ?? false);
}

function needsUnifont(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x7f || isProceduralCode(code) || hasTerminusGlyph(code)) continue;
    return true;
  }
  return false;
}

function loadUnifont(): Promise<UnifontGlyphs> {
  if (unifontGlyphs) return Promise.resolve(unifontGlyphs);
  unifontLoading ??= Promise.all([import('./unifont.js'), import('node:zlib')])
    .then(([asset, zlib]) => {
      const raw = zlib.gunzipSync(Buffer.from(asset.UNIFONT_GZIP_BASE64, 'base64'));
      if (raw.toString('ascii', 0, 4) !== 'UF16') throw new Error('Invalid embedded Unifont bitmap');
      const count = raw.readUInt32BE(4);
      const glyphs: UnifontGlyphs = new Map();
      let offset = 8;
      for (let index = 0; index < count; index++) {
        const code = raw.readUInt32BE(offset);
        offset += 4;
        glyphs.set(code, raw.subarray(offset, offset + 32));
        offset += 32;
      }
      unifontGlyphs = glyphs;
      return glyphs;
    })
    .catch((error) => {
      unifontLoading = undefined;
      throw error;
    });
  return unifontLoading;
}

/**
 * A headless xterm terminal. xterm owns VT parsing and its buffer is the
 * source of truth for scrollback, alternate screen state, widths, and SGR.
 */
export class Terminal {
  private readonly emulator: InstanceType<typeof XtermTerminal>;
  private pending = Promise.resolve();
  private cursorVisible = true;

  constructor(cols: number, rows: number) {
    this.emulator = new XtermTerminal({
      cols,
      rows,
      scrollback: 10_000,
      allowProposedApi: true,
      logLevel: 'off',
      theme: XTERM_THEME,
    });
    // xterm measures with Unicode 6 by default, where an emoji such as 🚀 is one column; terminals draw it in two.
    this.emulator.loadAddon(new Unicode11Addon());
    this.emulator.unicode.activeVersion = '11';
    this.emulator.parser.registerCsiHandler({ prefix: '?', final: 'h' }, (params) => {
      if (params.some((param) => param === 25)) this.cursorVisible = true;
      return false;
    });
    this.emulator.parser.registerCsiHandler({ prefix: '?', final: 'l' }, (params) => {
      if (params.some((param) => param === 25)) this.cursorVisible = false;
      return false;
    });
    this.emulator.parser.registerEscHandler({ final: 'c' }, () => {
      this.cursorVisible = true;
      return false;
    });
  }

  get cols(): number {
    return this.emulator.cols;
  }

  get rows(): number {
    return this.emulator.rows;
  }

  /** Queues output in order. Await flush before reading the terminal. */
  write(text: string): void {
    const font = needsUnifont(text) ? loadUnifont() : undefined;
    this.pending = this.pending
      .then(async () => {
        await font;
      })
      .then(
        () =>
          new Promise<void>((resolve) => {
            this.emulator.write(text, resolve);
          }),
      );
  }

  /** The program turned on application cursor mode, so the arrows send `ESC O`. Flush first. */
  get applicationCursor(): boolean {
    return this.emulator.modes.applicationCursorKeysMode;
  }

  /** What the terminal sends back to the program, such as its answer to a cursor-position query. */
  onData(listener: (data: string) => void): void {
    this.emulator.onData(listener);
  }

  /** Waits until all output queued through write has been parsed by xterm. */
  async flush(): Promise<void> {
    await this.pending;
  }

  resize(cols: number, rows: number): void {
    this.emulator.resize(cols, rows);
  }

  /** The lines that scrolled off, then the visible screen, with trailing spaces removed. */
  text(): string {
    const buffer =
      this.emulator.buffer.active.type === 'alternate' ? this.emulator.buffer.active : this.emulator.buffer.normal;
    return trimLines(
      Array.from({ length: buffer.length }, (_, index) => buffer.getLine(index)?.translateToString(true) ?? ''),
    );
  }

  /**
   * Parses `text` now, one character at a time, and says whether `leaks` held
   * after any of them for the visible rows and the rows just above them,
   * joined with no separator. A program can draw a secret and erase it again
   * within one write, and playback shows every step. Flush first.
   */
  writeWatching(text: string, leaks: (shown: string) => boolean): boolean {
    // xterm parses synchronously only through its core, which keeps writeSync off the public API.
    const core = (this.emulator as unknown as { _core: { writeSync(data: string): void } })._core;
    const buffer = this.emulator.buffer;
    let leaked = false;
    for (const char of text) {
      core.writeSync(char);
      if (leaked) continue;
      const active = buffer.active;
      const rows: string[] = [];
      for (let row = Math.max(0, active.baseY - this.rows); row < active.baseY + this.rows; row++) {
        rows.push(active.getLine(row)?.translateToString(true) ?? '');
      }
      leaked = leaks(rows.join(''));
    }
    return leaked;
  }

  /** The visible rows of the screen, with trailing spaces removed. */
  screenRows(): string[] {
    const buffer = this.emulator.buffer.active;
    const rows = Array.from(
      { length: this.rows },
      (_, row) => buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? '',
    ).map((row) => row.trimEnd());
    while (rows.length && !rows.at(-1)) rows.pop();
    return rows;
  }

  /** The visible screen only, including the alternate screen when it is active. */
  screenText(): string {
    return this.screenRows().join('\n');
  }

  /**
   * The visible screen as text with each secret replaced, read the way
   * `secretCells` reads the grid: the rows are joined with no separator, so a
   * secret that the app wrapped onto the next row is found. When the redacted
   * text cannot be lined up with the rows, every row is hidden.
   */
  screenTextRedacted(redact: (value: string) => string): string {
    const rows = this.screenRows();
    const text = rows.join('');
    const spans = secretSpans(text, redact);
    if (!spans) return rows.map((row) => HIDDEN.repeat(row.length)).join('\n');
    if (!spans.length) return rows.join('\n');
    const out: string[] = [];
    let offset = 0;
    for (const row of rows) {
      const start = offset;
      const end = offset + row.length;
      offset = end;
      let line = '';
      let at = start;
      for (const span of spans) {
        if (span.end <= start || span.start >= end) continue;
        const from = Math.max(span.start, at);
        if (from > at) line += text.slice(at, from);
        // The placeholder stands once, in the row where the secret starts.
        if (span.start >= start) line += span.placeholder;
        at = Math.min(span.end, end);
      }
      line += text.slice(at, end);
      out.push(line);
    }
    return out.join('\n');
  }

  /** Clears the screen and draws the rows of `buffer` on it. */
  private drawRows(buffer: xtermModule.IBuffer, hidden?: Set<number>): string {
    let out = '\u001b[0m\u001b[H\u001b[2J';
    for (let row = 0; row < this.rows; row++) {
      const line = buffer.getLine(buffer.viewportY + row);
      if (!line) continue;
      const cells: { sgr: string; chars: string }[] = [];
      for (let col = 0; col < this.cols; col++) {
        const cell = line.getCell(col);
        if (!cell || cell.getWidth() === 0) continue;
        cells.push({
          sgr: cellSgr(cell),
          chars: hidden?.has(row * this.cols + col) ? HIDDEN : cell.getChars() || ' ',
        });
      }
      while (cells.length && cells.at(-1)!.sgr === '0' && cells.at(-1)!.chars === ' ') cells.pop();
      if (!cells.length) continue;
      out += `\u001b[${row + 1};1H`;
      let sgr = '0';
      for (const cell of cells) {
        if (cell.sgr !== sgr) out += `\u001b[${cell.sgr}m`;
        sgr = cell.sgr;
        out += cell.chars;
      }
      out += '\u001b[0m';
    }
    return out;
  }

  /**
   * Output that draws the visible screen on a blank terminal of the same
   * size: each cell with its colors and attributes, the scroll region, the
   * cursor, its visibility, and application cursor mode. When the alternate
   * screen is active, the normal screen is drawn first and the alternate one
   * over it, so leaving it shows what the app left there. Flush first. `hide`
   * names the cells of a screen's grid, as `row * cols + col`, drawn as a
   * block in place of their character.
   */
  serialize(hide?: (cells: TerminalCell[][]) => Set<number>): string {
    const buffer = this.emulator.buffer.active;
    const hidden = hide?.(this.cells(buffer));
    let out = '';
    if (buffer.type === 'alternate') {
      const normal = this.emulator.buffer.normal;
      out += this.drawRows(normal, hide?.(this.cells(normal)));
      // Entering the alternate screen saves this cursor, and leaving it restores it.
      out += `\u001b[${normal.cursorY + 1};${Math.min(normal.cursorX, this.cols - 1) + 1}H\u001b[?1049h`;
    }
    out += this.drawRows(buffer, hidden);
    // xterm keeps the scroll region off its public API. Setting it homes the cursor, so it goes first.
    const margins = (this.emulator as unknown as { _core?: { buffer?: { scrollTop: number; scrollBottom: number } } })
      ._core?.buffer;
    if (margins && (margins.scrollTop !== 0 || margins.scrollBottom !== this.rows - 1)) {
      out += `\u001b[${margins.scrollTop + 1};${margins.scrollBottom + 1}r`;
    }
    if (buffer.cursorX < this.cols) out += `\u001b[${buffer.cursorY + 1};${buffer.cursorX + 1}H`;
    else out += this.pendingWrap(buffer, hidden);
    // The attributes that output after the recording starts is drawn with. xterm keeps them off its public API.
    const pen = (this.emulator as unknown as { _core?: { _inputHandler?: { _curAttrData?: SgrSource } } })._core
      ?._inputHandler?._curAttrData;
    if (pen) out += `\u001b[${cellSgr(pen)}m`;
    if (!this.cursorVisible) out += '\u001b[?25l';
    if (this.applicationCursor) out += '\u001b[?1h';
    return out;
  }

  /**
   * A cursor past the last column waits to wrap on the next character. No
   * cursor move reaches that state, so redraw the row's last cell from just
   * before it, which leaves the cursor there as it was.
   */
  private pendingWrap(buffer: xtermModule.IBuffer, hidden?: Set<number>): string {
    const line = buffer.getLine(buffer.viewportY + buffer.cursorY);
    const last = line?.getCell(this.cols - 1);
    const wide = last?.getWidth() === 0 ? line?.getCell(this.cols - 2) : undefined;
    const cell = wide ?? last;
    const col = wide ? this.cols - 1 : this.cols;
    if (!cell) return `\u001b[${buffer.cursorY + 1};${this.cols}H`;
    const chars = hidden?.has(buffer.cursorY * this.cols + col - 1) ? HIDDEN : cell.getChars() || ' ';
    return `\u001b[${buffer.cursorY + 1};${col}H\u001b[${cellSgr(cell)}m${chars}\u001b[0m`;
  }

  /** Returns the visible grid with xterm colors resolved to RGB tuples. */
  cells(buffer: xtermModule.IBuffer = this.emulator.buffer.active): TerminalCell[][] {
    const cells: TerminalCell[][] = [];
    for (let row = 0; row < this.rows; row++) {
      const line = buffer.getLine(buffer.viewportY + row);
      const rowCells: TerminalCell[] = [];
      for (let col = 0; col < this.cols; col++) {
        const raw = line?.getCell(col);
        rowCells.push(raw ? readCell(raw) : blankCell());
      }
      cells.push(rowCells);
    }
    return cells;
  }

  /** The cursor position used by the PNG renderer. */
  cursor(): { x: number; y: number; visible: boolean } {
    const buffer = this.emulator.buffer.active;
    return {
      x: Math.min(this.cols - 1, Math.max(0, buffer.cursorX)),
      y: Math.min(this.rows - 1, Math.max(0, buffer.cursorY)),
      visible: this.cursorVisible,
    };
  }

  /** Indexed pixels for GIF encoding. PNG rendering keeps the original RGB values. */
  pixels(): Uint8Array {
    return indexedPixels(this);
  }
}

function trimLines(lines: string[]): string {
  const trimmed = lines.map((line) => line.trimEnd());
  while (trimmed.length && !trimmed.at(-1)) trimmed.pop();
  return trimmed.join('\n');
}

function blankCell(): TerminalCell {
  return {
    char: ' ',
    width: 1,
    fg: TEXT,
    bg: BACKGROUND,
    bold: false,
    italic: false,
    underline: false,
    inverse: false,
    dim: false,
  };
}

function readCell(raw: {
  getChars(): string;
  getWidth(): number;
  getFgColor(): number;
  getBgColor(): number;
  isFgRGB(): boolean;
  isBgRGB(): boolean;
  isFgPalette(): boolean;
  isBgPalette(): boolean;
  isBold(): number;
  isItalic(): number;
  isUnderline(): number;
  isInverse(): number;
  isDim(): number;
}): TerminalCell {
  const width = raw.getWidth();
  return {
    char: width === 0 ? '' : raw.getChars() || ' ',
    width,
    fg: cellColor(raw, true),
    bg: cellColor(raw, false),
    bold: raw.isBold() !== 0,
    italic: raw.isItalic() !== 0,
    underline: raw.isUnderline() !== 0,
    inverse: raw.isInverse() !== 0,
    dim: raw.isDim() !== 0,
  };
}

/** The SGR parameters that give a cell its colors and attributes, from a reset. */
/** What cellSgr reads: a buffer cell, or xterm's current text attributes. */
type SgrSource = Pick<
  xtermModule.IBufferCell,
  | 'isFgRGB'
  | 'isFgPalette'
  | 'getFgColor'
  | 'isBgRGB'
  | 'isBgPalette'
  | 'getBgColor'
  | 'isBold'
  | 'isDim'
  | 'isItalic'
  | 'isUnderline'
  | 'isBlink'
  | 'isInverse'
  | 'isInvisible'
  | 'isStrikethrough'
  | 'isOverline'
>;

function cellSgr(cell: SgrSource): string {
  const params = ['0'];
  const color = (rgb: boolean, palette: boolean, value: number, base: number, bright: number, extended: number) => {
    if (rgb) params.push(`${extended};2;${(value >> 16) & 255};${(value >> 8) & 255};${value & 255}`);
    else if (palette && value < 8) params.push(String(base + value));
    else if (palette && value < 16) params.push(String(bright + value - 8));
    else if (palette) params.push(`${extended};5;${value}`);
  };
  color(cell.isFgRGB(), cell.isFgPalette(), cell.getFgColor(), 30, 90, 38);
  color(cell.isBgRGB(), cell.isBgPalette(), cell.getBgColor(), 40, 100, 48);
  if (cell.isBold()) params.push('1');
  if (cell.isDim()) params.push('2');
  if (cell.isItalic()) params.push('3');
  if (cell.isUnderline()) params.push('4');
  if (cell.isBlink()) params.push('5');
  if (cell.isInverse()) params.push('7');
  if (cell.isInvisible()) params.push('8');
  if (cell.isStrikethrough()) params.push('9');
  if (cell.isOverline()) params.push('53');
  return params.join(';');
}

function cellColor(
  raw: {
    getFgColor(): number;
    getBgColor(): number;
    isFgRGB(): boolean;
    isBgRGB(): boolean;
    isFgPalette(): boolean;
    isBgPalette(): boolean;
  },
  foreground: boolean,
): TerminalRgb {
  const value = foreground ? raw.getFgColor() : raw.getBgColor();
  const isRgb = foreground ? raw.isFgRGB() : raw.isBgRGB();
  const isPalette = foreground ? raw.isFgPalette() : raw.isBgPalette();
  if (isRgb) return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
  if (isPalette) return PALETTE[value] ?? color256(value);
  return foreground ? TEXT : BACKGROUND;
}

function color256(code: number): TerminalRgb {
  if (code < 16) return PALETTE[code] ?? PALETTE[0]!;
  if (code >= 232) {
    const gray = 8 + (code - 232) * 10;
    return [gray, gray, gray];
  }
  const cube = code - 16;
  const level = (value: number) => (value ? 55 + value * 40 : 0);
  return [level(Math.floor(cube / 36)), level(Math.floor(cube / 6) % 6), level(cube % 6)];
}

type Mask = boolean[][];

function mask(width = GLYPH.width): Mask {
  return Array.from({ length: GLYPH.height }, () => Array<boolean>(width).fill(false));
}

function pixel(bits: Mask, x: number, y: number): void {
  if (y >= 0 && y < bits.length && x >= 0 && x < bits[y]!.length) bits[y]![x] = true;
}

function rectangle(bits: Mask, left: number, top: number, right: number, bottom: number, fill = true): void {
  for (let y = top; y <= bottom; y++) {
    for (let x = left; x <= right; x++) {
      if (fill || x === left || x === right || y === top || y === bottom) pixel(bits, x, y);
    }
  }
}

function stroke(bits: Mask, from: [number, number], to: [number, number]): void {
  const steps = Math.max(Math.abs(to[0] - from[0]), Math.abs(to[1] - from[1]));
  for (let step = 0; step <= steps; step++) {
    const progress = steps ? step / steps : 0;
    pixel(bits, Math.round(from[0] + (to[0] - from[0]) * progress), Math.round(from[1] + (to[1] - from[1]) * progress));
  }
}

function roundedCornerMask(char: string): Mask {
  const bits = mask();
  const arc: [number, number][] = [
    [3, 0],
    [2, 1],
    [2, 2],
    [1, 3],
    [1, 4],
    [0, 5],
    [0, 6],
  ];
  const mirrorX = char === '╮' || char === '╯';
  const mirrorY = char === '╰' || char === '╯';
  for (const [x, y] of arc) {
    const nextX = mirrorX ? 7 - x : x;
    const nextY = mirrorY ? 15 - y : y;
    pixel(bits, nextX, nextY);
    pixel(bits, nextX + (mirrorX ? -1 : 1), nextY);
  }
  const verticalTop = mirrorY ? 0 : 7;
  const verticalBottom = mirrorY ? 8 : 15;
  for (let y = verticalTop; y <= verticalBottom; y++) {
    pixel(bits, mirrorX ? 3 : 3, y);
    pixel(bits, mirrorX ? 4 : 4, y);
  }
  for (const y of [7, 8]) for (let x = 0; x < 8; x++) pixel(bits, x, y);
  return bits;
}

/**
 * The arms of each box drawing character U+2500 to U+257F, four digits each:
 * up, down, left, right, with 0 none, 1 light, 2 heavy, 3 double. Made from
 * the Unicode character names. Arcs and diagonals are 0000 and drawn apart.
 */
const BOX_00110022110022000011002211002200001100221100220001010102020102020110012002100220100110022001200210101020201020201101110221011201220121021202220211101120211012102210212012202220011101210112012202110221021202221011102110121022201120212012202211111121111211222111121122112121211212211212212212222221221222220011002211002200003333000103030103030130031003301003300130031030301030301103330133031130331033300133031103331033301130331133331133330000000000000000000000000000001010000001010000202000000202000012120000212100 =
  '00110022110022000011002211002200001100221100220001010102020102020110012002100220100110022001200210101020201020201101110221011201220121021202220211101120211012102210212012202220011101210112012202110221021202221011102110121022201120212012202211111121111211222111121122112121211212211212212212222221221222220011002211002200003333000103030103030130031003301003300130031030301030301103330133031130331033300133031103331033301130331133331133330000000000000000000000000000001010000001010000202000000202000012120000212100';

/** The rows of a horizontal arm, and the columns of a vertical one, by weight. */
const BOX_ROWS = [[], [7, 8], [6, 7, 8, 9], [5, 6, 10, 11]];
const BOX_COLUMNS = [[], [3, 4], [2, 3, 4, 5], [1, 2, 5, 6]];

/** Dashed lines: the number of dashes of each. */
function boxDashes(code: number): number {
  if (code >= 0x2504 && code <= 0x2507) return 3;
  if (code >= 0x2508 && code <= 0x250b) return 4;
  if (code >= 0x254c && code <= 0x254f) return 2;
  return 0;
}

/** Every box drawing character, drawn so that the lines of neighbouring cells join. */
function boxMask(char: string): Mask {
  if (char === '╭' || char === '╮' || char === '╰' || char === '╯') return roundedCornerMask(char);
  if (char === '╱' || char === '╲' || char === '╳') {
    const bits = mask();
    if (char !== '╲') stroke(bits, [0, 15], [7, 0]);
    if (char !== '╱') stroke(bits, [0, 0], [7, 15]);
    return bits;
  }
  const at = (char.codePointAt(0)! - 0x2500) * 4;
  const [up, down, left, right] = [0, 1, 2, 3].map((arm) =>
    Number(
      BOX_00110022110022000011002211002200001100221100220001010102020102020110012002100220100110022001200210101020201020201101110221011201220121021202220211101120211012102210212012202220011101210112012202110221021202221011102110121022201120212012202211111121111211222111121122112121211212211212212212222221221222220011002211002200003333000103030103030130031003301003300130031030301030301103330133031130331033300133031103331033301130331133331133330000000000000000000000000000001010000001010000202000000202000012120000212100[
        at + arm
      ] ?? 0,
    ),
  );
  const bits = mask();
  const dashes = boxDashes(char.codePointAt(0)!);
  // Each dash ends in a gap of one pixel, so dashed lines in a row stay dashed.
  const gap = (position: number, length: number) =>
    dashes > 0 && position % Math.ceil(length / dashes) === Math.ceil(length / dashes) - 1;
  const horizontal = (weight = 0, from: number, to: number) => {
    for (const y of BOX_ROWS[weight]!) for (let x = from; x <= to; x++) if (!gap(x, 8)) pixel(bits, x, y);
  };
  const vertical = (weight = 0, from: number, to: number) => {
    for (const x of BOX_COLUMNS[weight]!) for (let y = from; y <= to; y++) if (!gap(y, 16)) pixel(bits, x, y);
  };
  horizontal(left, 0, 4);
  horizontal(right, 3, 7);
  vertical(up, 0, 8);
  vertical(down, 7, 15);
  return bits;
}

function blockMask(code: number): Mask {
  const bits = mask();
  if (code === 0x2580) rectangle(bits, 0, 0, 7, 7);
  else if (code >= 0x2581 && code <= 0x2587) rectangle(bits, 0, 16 - (code - 0x2580) * 2, 7, 15);
  else if (code === 0x2588) rectangle(bits, 0, 0, 7, 15);
  else if (code >= 0x2589 && code <= 0x258f) rectangle(bits, 0, 0, GLYPH.width - (code - 0x2588) - 1, 15);
  else if (code === 0x2590) rectangle(bits, 4, 0, 7, 15);
  else if (code === 0x2591 || code === 0x2592 || code === 0x2593) {
    const spacing = code === 0x2591 ? 3 : code === 0x2592 ? 2 : 1;
    for (let y = 0; y < 16; y++) for (let x = 0; x < 8; x++) if ((x + y) % spacing === 0) pixel(bits, x, y);
  } else if (code === 0x2594) rectangle(bits, 0, 0, 7, 1);
  else if (code === 0x2595) rectangle(bits, 6, 0, 7, 15);
  else if (code >= 0x2596 && code <= 0x259f) {
    const quadrants: Record<number, [boolean, boolean, boolean, boolean]> = {
      9622: [false, false, true, false],
      9623: [false, false, false, true],
      9624: [true, false, false, false],
      9625: [true, false, true, true],
      9626: [true, false, false, true],
      9627: [true, true, true, false],
      9628: [true, true, false, true],
      9629: [false, true, false, false],
      9630: [false, true, true, false],
      9631: [false, true, true, true],
    };
    const [topLeft, topRight, bottomLeft, bottomRight] = quadrants[code] ?? [true, true, true, true];
    if (topLeft) rectangle(bits, 0, 0, 3, 7);
    if (topRight) rectangle(bits, 4, 0, 7, 7);
    if (bottomLeft) rectangle(bits, 0, 8, 3, 15);
    if (bottomRight) rectangle(bits, 4, 8, 7, 15);
  } else rectangle(bits, 0, 0, 7, 15, false);
  return bits;
}

function brailleMask(code: number): Mask {
  const bits = mask();
  const dots = [
    [1, 1],
    [1, 5],
    [1, 9],
    [5, 1],
    [5, 5],
    [5, 9],
    [1, 13],
    [5, 13],
  ];
  for (let dot = 0; dot < dots.length; dot++) {
    if (code & (1 << dot)) {
      const position = dots[dot]!;
      const x = position[0]!;
      const y = position[1]!;
      rectangle(bits, x, y, x + 1, y + 2);
    }
  }
  return bits;
}

/** Procedural symbols keep the pure JS bundle independent of native font libraries and make joined line art exact at cell boundaries. */
function glyphMask(char: string, heavy: boolean, width: number): Mask {
  const code = char.codePointAt(0) ?? 0;
  let bits: Mask;
  if (code >= 0x2500 && code <= 0x257f) bits = boxMask(char);
  else if (code >= 0x2580 && code <= 0x259f) bits = blockMask(code);
  else if (code >= 0x2800 && code <= 0x28ff) bits = brailleMask(code - 0x2800);
  else return fontMask(char, heavy, width);
  if (width !== 2) return bits;
  const wide = mask(16);
  for (let y = 0; y < GLYPH.height; y++) {
    for (let x = 0; x < bits[y]!.length; x++) if (bits[y]![x]) wide[y]![x + 4] = true;
  }
  if (!wide.some((row) => row.some(Boolean))) rectangle(wide, 0, 0, 15, 15, false);
  return wide;
}

/** Terminus covers ASCII and Latin-1. Unifont supplies the other glyphs that have bitmap coverage. */
function fontMask(char: string, heavy: boolean, width: number): Mask {
  if (char === ' ' || char === '\u00a0') return mask(width === 2 ? 16 : GLYPH.width);
  const font = heavy ? bold : regular;
  const code = char.codePointAt(0) ?? 0;
  const index = terminusIndex(code);
  const rows = index === undefined ? undefined : font[index]?.BITMAP;
  if (rows?.some((row) => row !== 0)) {
    const bits = mask();
    for (let y = 0; y < GLYPH.height; y++) {
      const row = rows[y] ?? 0;
      for (let x = 0; x < GLYPH.width; x++) bits[y]![x] = Boolean(row & (0x80 >> x));
    }
    return bits;
  }
  const glyph = unifontGlyphs?.get(code);
  if (glyph) return unifontMask(glyph, width);
  return placeholderMask(width);
}

function unifontMask(glyph: Uint8Array, width: number): Mask {
  const bits = mask(width === 2 ? 16 : GLYPH.width);
  for (let y = 0; y < GLYPH.height; y++) {
    const row = (glyph[y * 2]! << 8) | glyph[y * 2 + 1]!;
    for (let x = 0; x < bits[y]!.length; x++) {
      const sourceX = width === 2 ? x : x + 8;
      bits[y]![x] = Boolean(row & (0x8000 >> sourceX));
    }
  }
  return bits;
}

function placeholderMask(width: number): Mask {
  const bits = mask(width === 2 ? 16 : GLYPH.width);
  rectangle(bits, 0, 0, bits[0]!.length - 1, GLYPH.height - 1, false);
  return bits;
}

function effectiveColors(cell: TerminalCell): { fg: TerminalRgb; bg: TerminalRgb } {
  const fg = cell.inverse ? cell.bg : cell.fg;
  const bg = cell.inverse ? cell.fg : cell.bg;
  if (!cell.dim) return { fg, bg };
  return { fg: [Math.round(fg[0] * 0.55), Math.round(fg[1] * 0.55), Math.round(fg[2] * 0.55)], bg };
}

/** The color of a cell that hides a secret. */
const MASKED: TerminalRgb = [0x80, 0x80, 0x80];

/**
 * The cells of the screen that show a secret, as `row * cols + col`. The
 * rows are read as one text, so a secret that wraps onto the next row is
 * found. When the redacted text cannot be lined up with the screen, the
 * whole screen is hidden.
 */
function secretCells(terminal: Terminal, cells: TerminalCell[][], redact: (value: string) => string): Set<number> {
  let text = '';
  const owners: number[] = [];
  for (let row = 0; row < terminal.rows; row++) {
    for (let col = 0; col < terminal.cols; col++) {
      const cell = cells[row]![col]!;
      if (cell.width === 0) continue;
      const char = cell.char || ' ';
      text += char;
      for (let unit = 0; unit < char.length; unit++) owners.push(row * terminal.cols + col);
    }
  }
  const masked = new Set<number>();
  const spans = secretSpans(text, redact);
  if (spans) {
    for (const span of spans) for (let at = span.start; at < span.end; at++) masked.add(owners[at]!);
    return masked;
  }
  for (let index = 0; index < terminal.rows * terminal.cols; index++) masked.add(index);
  return masked;
}

function renderRgb(terminal: Terminal, redact?: (value: string) => string): Uint8Array {
  const width = terminal.cols * GLYPH.width;
  const height = terminal.rows * GLYPH.height;
  const out = new Uint8Array(width * height * 4);
  const cells = terminal.cells();
  const masked = redact ? secretCells(terminal, cells, redact) : undefined;
  const set = (x: number, y: number, color: TerminalRgb) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const index = (y * width + x) * 4;
    out[index] = color[0];
    out[index + 1] = color[1];
    out[index + 2] = color[2];
    out[index + 3] = 255;
  };
  for (let row = 0; row < terminal.rows; row++) {
    for (let col = 0; col < terminal.cols; col++) {
      const cell = cells[row]![col]!;
      if (cell.width === 0) continue;
      const hidden = masked?.has(row * terminal.cols + col);
      const colors = hidden ? { fg: MASKED, bg: MASKED } : effectiveColors(cell);
      const cellWidth = cell.width === 2 ? 2 : 1;
      for (let y = row * GLYPH.height; y < (row + 1) * GLYPH.height; y++) {
        for (let x = col * GLYPH.width; x < (col + cellWidth) * GLYPH.width; x++) set(x, y, colors.bg);
      }
      if (!cell.char || hidden) continue;
      const glyph = glyphMask(cell.char, cell.bold, cell.width);
      const left = col * GLYPH.width;
      for (let glyphY = 0; glyphY < glyph.length; glyphY++) {
        const italicShift = cell.italic ? Math.floor((GLYPH.height - glyphY) / 6) : 0;
        for (let glyphX = 0; glyphX < glyph[glyphY]!.length; glyphX++) {
          if (glyph[glyphY]![glyphX]) set(left + glyphX + italicShift, row * GLYPH.height + glyphY, colors.fg);
        }
      }
      if (cell.underline) {
        for (let x = left; x < left + cellWidth * GLYPH.width; x++) {
          set(x, row * GLYPH.height + 14, colors.fg);
          set(x, row * GLYPH.height + 15, colors.fg);
        }
      }
    }
  }
  const cursor = terminal.cursor();
  if (cursor.visible) {
    const row = cells[cursor.y] ?? [];
    let col = cursor.x;
    if (row[col]?.width === 0) col = Math.max(0, col - 1);
    const cursorWidth = row[col]?.width === 2 ? 2 : 1;
    const left = col * GLYPH.width;
    for (let y = cursor.y * GLYPH.height; y < (cursor.y + 1) * GLYPH.height; y++) {
      for (let x = left; x < left + cursorWidth * GLYPH.width; x++) {
        const index = (y * width + x) * 4;
        out[index] = 255 - out[index]!;
        out[index + 1] = 255 - out[index + 1]!;
        out[index + 2] = 255 - out[index + 2]!;
      }
    }
  }
  return out;
}

function nearest(rgb: TerminalRgb): number {
  let best = 0;
  let distance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < GIF_PALETTE.length; index++) {
    const color = GIF_PALETTE[index]!;
    const next = (color[0] - rgb[0]) ** 2 + (color[1] - rgb[1]) ** 2 + (color[2] - rgb[2]) ** 2;
    if (next < distance) [best, distance] = [index, next];
  }
  return best;
}

function indexedPixels(terminal: Terminal): Uint8Array {
  const rgba = renderRgb(terminal);
  const out = new Uint8Array(rgba.length / 4);
  const cache = new Map<number, number>();
  for (let index = 0; index < out.length; index++) {
    const offset = index * 4;
    const key = (rgba[offset]! << 16) | (rgba[offset + 1]! << 8) | rgba[offset + 2]!;
    let paletteIndex = cache.get(key);
    if (paletteIndex === undefined) {
      paletteIndex = nearest([rgba[offset]!, rgba[offset + 1]!, rgba[offset + 2]!]);
      cache.set(key, paletteIndex);
    }
    out[index] = paletteIndex;
  }
  return out;
}

/**
 * The screen of a terminal as a true-color PNG. Call terminal.flush first
 * after writes. With `redact`, each cell of a secret that it would replace is
 * a plain grey block.
 */
export function terminalPng(terminal: Terminal, redact?: (value: string) => string): Buffer {
  const png = new PNG({ width: terminal.cols * GLYPH.width, height: terminal.rows * GLYPH.height });
  png.data.set(renderRgb(terminal, redact));
  return PNG.sync.write(png);
}

/**
 * Records the output of a terminal session as an asciicast, while a recording
 * runs. With `redact`, the recording is redacted as one stream when it stops,
 * so a secret that came in two pieces of output is still found.
 */
export class CastRecorder {
  private cast?: { start: number; events: CastEvent[] };

  constructor(
    private readonly size: { width: number; height: number },
    private readonly redact?: (value: string) => string,
  ) {}

  start(): void {
    if (this.cast) throw new Error('A recording is already running');
    this.cast = { start: Date.now(), events: [] };
  }

  /** Output of the session. With no recording running, it goes nowhere. */
  push(text: string): void {
    this.cast?.events.push([(Date.now() - this.cast.start) / 1000, text]);
  }

  /** The terminal changed its size. */
  resize(cols: number, rows: number): void {
    this.cast?.events.push([(Date.now() - this.cast.start) / 1000, `${cols}x${rows}`, 'r']);
  }

  /** Ends the recording, and writes it to `<name>.cast`. */
  async stop(name: string): Promise<string> {
    const cast = this.cast;
    if (!cast) throw new Error('No recording is running');
    this.cast = undefined;
    const file = `${name}.cast`;
    await writeCast(file, {
      ...this.size,
      events: this.redact ? await redactEvents(cast.events, this.size, this.redact) : cast.events,
    });
    return file;
  }
}

/**
 * The output events with each secret replaced, across the events it spans:
 * its placeholder goes in the event where it starts. A program may break a
 * secret up with escape codes, so the match is made on the stream without
 * them and mapped back to the raw output. A secret inside an OSC payload
 * (a hyperlink target, a window title) is then found in the raw output, and
 * the parameters of a CSI or other control sequence are never altered. When
 * the redacted stream cannot be lined up with the output, the output is one
 * event, redacted whole.
 */
async function redactEvents(
  events: CastEvent[],
  size: { width: number; height: number },
  redact: (value: string) => string,
): Promise<CastEvent[]> {
  const visible = redactSpans(events, redact, (text) => {
    const { plain, at } = withoutEscapes(text);
    // A span in `plain` becomes the raw range that holds it, escape codes and all.
    return secretSpans(plain, redact)?.map((span) => ({
      start: at[span.start]!,
      end: at[span.end - 1]! + 1,
      placeholder: span.placeholder,
    }));
  });
  return hideScreenSecrets(
    redactSpans(visible, redact, (text) => {
      // A control sequence stays whole: a short secret such as `18` in `ESC[2;18m` is a parameter, not text.
      const controls = controlRanges(text);
      return secretSpans(text, redact)?.filter((span) =>
        controls.every(([start, end]) => span.end <= start || span.start >= end),
      );
    }),
    size,
    redact,
  );
}

/**
 * A program can put a secret on the screen with output that holds none, such
 * as by overwriting part of a field. The events are played on a terminal, and
 * on one fed what the recording keeps. An event that shows a secret on the
 * second at any character, on the screen or scrolled off it, even one it
 * erases again, is replaced by a reset and the screen it leads to, with the
 * cells of the secret hidden: the whole screen when they cannot be found.
 * The output that assembled the secret is not kept.
 */
async function hideScreenSecrets(
  events: CastEvent[],
  size: { width: number; height: number },
  redact: (value: string) => string,
): Promise<CastEvent[]> {
  const terminal = new Terminal(size.width, size.height);
  let playback = new Terminal(size.width, size.height);
  const result: CastEvent[] = [];
  for (const event of events) {
    const [at, text, kind] = event;
    if (kind === 'r') {
      await terminal.flush();
      await playback.flush();
      const [cols, rows] = text.split('x').map(Number);
      terminal.resize(cols!, rows!);
      playback.resize(cols!, rows!);
      result.push(event);
      continue;
    }
    terminal.write(text);
    await terminal.flush();
    await playback.flush();
    const leaks = (shown: string) => redact(shown) !== shown;
    const leaked = playback.writeWatching(text, leaks);
    // The rows are joined with no separator, so a secret that wraps is found.
    if (!leaked && !leaks(playback.text().replaceAll('\n', ''))) {
      result.push(event);
      continue;
    }
    let redrawn = `\u001bc${terminal.serialize((cells) => secretCells(terminal, cells, redact))}`;
    playback = new Terminal(terminal.cols, terminal.rows);
    playback.write(redrawn);
    await playback.flush();
    const left = playback.text().replaceAll('\n', '');
    if (redact(left) !== left) {
      // The cells of the secret did not hide it, so the whole screen is hidden.
      const every = new Set(Array.from({ length: terminal.cols * terminal.rows }, (_, cell) => cell));
      redrawn = `\u001bc${terminal.serialize(() => every)}`;
      playback = new Terminal(terminal.cols, terminal.rows);
      playback.write(redrawn);
    }
    result.push([at, redrawn]);
  }
  return result;
}

/** The output events with the spans that `find` locates in the joined output replaced. */
function redactSpans(
  events: CastEvent[],
  redact: (value: string) => string,
  find: (text: string) => SecretSpan[] | undefined,
): CastEvent[] {
  const output = events.filter(([, , kind]) => kind !== 'r');
  const text = output.map(([, chunk]) => chunk).join('');
  const spans = find(text);
  if (!spans) return [...events.filter(([, , kind]) => kind === 'r'), [output[0]?.[0] ?? 0, redact(text)]];
  const result: CastEvent[] = [];
  let offset = 0;
  for (const event of events) {
    if (event[2] === 'r') {
      result.push(event);
      continue;
    }
    const [at, chunk] = event;
    const end = offset + chunk.length;
    let kept = '';
    for (let index = offset; index < end; index++) {
      const span = spans.find((item) => item.start <= index && index < item.end);
      if (!span) kept += text[index];
      else if (span.start === index) kept += span.placeholder;
    }
    result.push([at, kept]);
    offset = end;
  }
  return result;
}

export async function writeCast(file: string, cast: Cast): Promise<void> {
  const lines = [
    { version: 2, width: cast.width, height: cast.height, env: { TERM: 'xterm-256color' } },
    ...cast.events.map(([at, text, kind]) => [Math.round(at * 1000) / 1000, kind ?? 'o', text]),
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
  const events: CastEvent[] = [];
  for (const line of rest) {
    try {
      const [at, kind, text] = JSON.parse(line);
      if (typeof at !== 'number' || typeof text !== 'string') continue;
      if (kind === 'o') events.push([at, text]);
      else if (kind === 'r' && /^\d+x\d+$/.test(text)) events.push([at, text, 'r']);
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
async function renderGif(cast: Cast, fps: number): Promise<Uint8Array> {
  const terminal = new Terminal(cast.width, cast.height);
  // A GIF has one size: the largest that the terminal had. A smaller screen sits at the top left.
  const sizes = cast.events.flatMap(([, text, kind]) => (kind === 'r' ? [text.split('x').map(Number)] : []));
  const width = Math.max(cast.width, ...sizes.map(([cols]) => cols!)) * GLYPH.width;
  const height = Math.max(cast.height, ...sizes.map(([, rows]) => rows!)) * GLYPH.height;
  const background = nearest(BACKGROUND);
  const frame = () => {
    const pixels = terminal.pixels();
    const screenWidth = terminal.cols * GLYPH.width;
    if (screenWidth === width && terminal.rows * GLYPH.height === height) return pixels;
    const out = new Uint8Array(width * height).fill(background);
    for (let y = 0; y < terminal.rows * GLYPH.height; y++)
      out.set(pixels.subarray(y * screenWidth, (y + 1) * screenWidth), y * width);
    return out;
  };
  const times = timeline(cast.events);
  const groups: { at: number; end: number }[] = [];
  for (let index = 0; index < times.length; ) {
    const at = times[index]!;
    while (index < times.length && times[index]! < at + 1 / fps) index++;
    groups.push({ at, end: index });
  }
  if (!groups.length || groups[0]!.at > 0) groups.unshift({ at: 0, end: 0 });
  const gif = GIFEncoder();
  const palette = GIF_PALETTE.map((color) => [...color]);
  const centiseconds = (seconds: number) => Math.round(seconds * 100);
  let written = 0;
  for (const [index, group] of groups.entries()) {
    while (written < group.end) {
      const [, text, kind] = cast.events[written++]!;
      if (kind !== 'r') terminal.write(text);
      else {
        await terminal.flush();
        const [cols, rows] = text.split('x').map(Number);
        terminal.resize(cols!, rows!);
      }
    }
    await terminal.flush();
    const next = groups[index + 1]?.at ?? group.at + HOLD_SECONDS;
    gif.writeFrame(frame(), width, height, {
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
    const bytes = await renderGif(cast, fps);
    if (bytes.length <= GIF_MAX_BYTES) {
      await writeFile(gif, bytes);
      return true;
    }
  }
  return false;
}
