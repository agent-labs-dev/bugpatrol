import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { describe, expect, it } from 'vitest';
import { ElectronDriver } from './electron.js';
import { GIF_MAX_BYTES, inlineGif } from './video.js';
import { WebDriver } from './web.js';

const run = promisify(execFile);
const SECRET = 'hunter2-very-secret';
const PAGE = `data:text/html,${encodeURIComponent(`
  <title>Login</title>
  <input type="password" aria-label="Password">
  <button onclick="document.body.style.background='tomato'; document.querySelector('p').textContent='Saved'">Save</button>
  <p>Not saved</p>
`)}`;

async function probe(file: string): Promise<{ width: number; seconds: number }> {
  const { stdout } = await run('ffprobe', [
    ...['-v', 'error', '-select_streams', 'v:0'],
    ...['-show_entries', 'stream=width:format=duration', '-of', 'json', file],
  ]);
  const info = JSON.parse(stdout);
  return { width: info.streams[0].width, seconds: Number(info.format.duration) };
}

async function frames(file: string): Promise<number> {
  const { stdout } = await run('ffprobe', [
    '-v',
    'error',
    '-count_frames',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=nb_read_frames',
    '-of',
    'csv=p=0',
    file,
  ]);
  return Number(stdout.trim());
}

describe('web recording', () => {
  it('records a real page into a video with frames and no secret', { timeout: 60_000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bugpatrol-recording-'));
    const driver = new WebDriver({ url: PAGE, viewport: { width: 640, height: 400 } });
    await driver.connect();
    try {
      await driver.startRecording!();
      const { elements } = await driver.observe();
      const password = elements.find((element) => element.name === 'Password')!;
      const save = elements.find((element) => element.name === 'Save')!;
      expect((await driver.act({ kind: 'type', ref: password.ref, value: SECRET })).ok).toBe(true);
      expect((await driver.act({ kind: 'tap', ref: save.ref })).ok).toBe(true);
      await driver.settle();
      const file = await driver.stopRecording!(join(dir, 'head'));
      expect(file).toBe(join(dir, 'head.mp4'));
      expect(await frames(file)).toBeGreaterThan(1);
      expect((await readFile(file)).includes(SECRET)).toBe(false);
    } finally {
      await driver.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('Electron recording', () => {
  it('records the context that the app opened, over CDP', { timeout: 60_000 }, async () => {
    // A Chromium with a debugging port stands in for Electron: one context, opened before Bugpatrol connects.
    const dir = await mkdtemp(join(tmpdir(), 'bugpatrol-recording-'));
    const app = await chromium.launchPersistentContext(join(dir, 'profile'), {
      args: ['--remote-debugging-port=9339', '--disable-gpu'],
    });
    const driver = new ElectronDriver('http://127.0.0.1:9339');
    try {
      await app.pages()[0]!.goto(PAGE);
      await driver.connect();
      await driver.startRecording!();
      const save = (await driver.observe()).elements.find((element) => element.name === 'Save')!;
      expect((await driver.act({ kind: 'tap', ref: save.ref })).ok).toBe(true);
      await driver.settle();
      const file = await driver.stopRecording!(join(dir, 'base'));
      expect(await frames(file)).toBeGreaterThan(1);
    } finally {
      await driver.close();
      await app.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('inline GIF', () => {
  it('cuts a long, wide video to the review budget', { timeout: 60_000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bugpatrol-gif-'));
    try {
      const video = join(dir, 'long.mp4');
      await run('ffmpeg', [
        ...['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=40:size=1280x800:rate=25'],
        ...['-c:v', 'libx264', '-pix_fmt', 'yuv420p', video],
      ]);
      const gif = join(dir, 'long.gif');
      expect(await inlineGif(video, gif)).toBe(true);
      const { width, seconds } = await probe(gif);
      expect(width).toBe(640);
      expect(seconds).toBeLessThanOrEqual(15);
      expect((await stat(gif)).size).toBeLessThanOrEqual(GIF_MAX_BYTES);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('throws on a file that is no video', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bugpatrol-gif-'));
    try {
      await writeFile(join(dir, 'bad.mp4'), 'not a video');
      await expect(inlineGif(join(dir, 'bad.mp4'), join(dir, 'bad.gif'))).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
