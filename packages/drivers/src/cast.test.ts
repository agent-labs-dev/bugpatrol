import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { castGif, readCast, Terminal, terminalPng, writeCast } from './cast.js';

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

describe('Terminal', () => {
  it('draws what a terminal shows: overwritten lines, cleared lines, and wrapped lines', () => {
    const terminal = new Terminal(20, 4);
    terminal.write('progress 10%\rprogress 99%\r\n');
    terminal.write('\u001b[31mred\u001b[0m text\r\n');
    terminal.write('gone\u001b[2K\rkept\r\n');
    terminal.write('0123456789abcdefghijXYZ');
    // The first line scrolled off the top, and the text keeps it.
    expect(terminal.text()).toBe('progress 99%\nred text\nkept\n0123456789abcdefghij\nXYZ');
  });

  it('keeps the escape sequence that one chunk cuts in two', () => {
    const terminal = new Terminal(20, 2);
    terminal.write('a\u001b[3');
    terminal.write('2mb\u001b[0m');
    expect(terminal.text()).toBe('ab');
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

  it('draws the screen of a terminal as a PNG with text on it', () => {
    const blank = PNG.sync.read(terminalPng(new Terminal(80, 24)));
    const terminal = new Terminal(80, 24);
    terminal.write('hello');
    const png = PNG.sync.read(terminalPng(terminal));
    expect([png.width, png.height]).toEqual([640, 384]);
    expect(png.data.equals(blank.data)).toBe(false);
  });
});
