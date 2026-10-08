import { execFile } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** One picture of the screen, PNG or JPEG, and when it was drawn in ms. */
export type Frame = { data: Buffer; at: number };

/** Recording needs ffmpeg on the PATH. Without it, Bugpatrol keeps screenshots. */
export function hasFfmpeg(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.PATH ?? '').split(delimiter).some((dir) => {
    try {
      accessSync(join(dir, 'ffmpeg'), constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

async function ffmpeg(args: string[]): Promise<void> {
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
  });
}

/** The last frame stays on screen at least this long, so the result of the last step shows. */
const HOLD_MS = 1000;

/**
 * Writes frames to an MP4, each shown until the next one was drawn. A screen
 * that does not change draws no frame, so the frames come at any pace.
 */
export async function encodeFrames(frames: Frame[], file: string, endAt: number): Promise<void> {
  if (!frames.length) throw new Error('The recording has no frame');
  const dir = await mkdtemp(join(tmpdir(), 'bugpatrol-frames-'));
  try {
    const lines: string[] = [];
    for (const [index, frame] of frames.entries()) {
      const name = `${String(index).padStart(5, '0')}.${frame.data[0] === 0x89 ? 'png' : 'jpg'}`;
      await writeFile(join(dir, name), frame.data);
      const next = frames[index + 1]?.at ?? Math.max(endAt, frame.at + HOLD_MS);
      lines.push(`file '${name}'`, `duration ${Math.max(next - frame.at, 1) / 1000}`);
    }
    // The concat demuxer drops the duration of the last entry, so it comes twice.
    lines.push(lines.at(-2)!);
    await writeFile(join(dir, 'frames.txt'), `${lines.join('\n')}\n`);
    await ffmpeg([
      ...['-f', 'concat', '-safe', '0', '-i', join(dir, 'frames.txt')],
      ...['-vf', 'fps=25,scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p'],
      ...['-c:v', 'libx264', '-movflags', '+faststart', '-an', file],
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * The tries for the GIF of a review, from #58: at most 15 s, 8 to 10 fps,
 * 640 px wide. The frame rate goes first, then the length. A shorter GIF
 * keeps the end of the video, where the result of the flow is.
 */
const GIF_TRIES = [
  { fps: 10, seconds: 15 },
  { fps: 8, seconds: 15 },
  { fps: 8, seconds: 10 },
  { fps: 8, seconds: 6 },
];
/** GitHub serves a GIF on the assets branch inline up to several MB. 2 MB keeps a before and after pair near 4 MB. */
export const GIF_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Converts a video to the GIF that a pull request review shows inline.
 * Returns false when no try fits the size budget, and then writes no GIF.
 * Throws when ffmpeg cannot read the video.
 */
export async function inlineGif(video: string, gif: string): Promise<boolean> {
  for (const { fps, seconds } of GIF_TRIES) {
    await ffmpeg([
      ...['-sseof', `-${seconds}`, '-i', video],
      ...[
        '-vf',
        `fps=${fps},scale='min(640,iw)':-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5`,
      ],
      ...['-loop', '0', gif],
    ]);
    if ((await stat(gif)).size <= GIF_MAX_BYTES) return true;
  }
  await rm(gif, { force: true });
  return false;
}
