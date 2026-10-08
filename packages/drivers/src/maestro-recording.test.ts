import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MaestroDriver } from './maestro.js';

function output(command: string, args: string[]): string | undefined {
  try {
    return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 });
  } catch {
    return undefined;
  }
}

/** Bugpatrol never starts a simulator or emulator, so the test runs only where one is already up. */
function missing(platform: 'ios' | 'android'): string | undefined {
  if (output('maestro', ['--version']) === undefined) return 'no maestro on the PATH';
  if (platform === 'ios') {
    if (process.platform !== 'darwin') return 'iOS simulators need macOS';
    const booted = output('xcrun', ['simctl', 'list', 'devices', 'booted', '-j']);
    if (!booted?.includes('"Booted"')) return 'no booted iOS simulator';
    return undefined;
  }
  const devices = output('adb', ['devices']);
  if (devices === undefined) return 'no adb on the PATH';
  if (!/^\S+\s+device$/m.test(devices)) return 'no Android device in adb devices';
  return undefined;
}

// The settings app ships with every simulator and emulator.
const SETTINGS = { ios: 'com.apple.Preferences', android: 'com.android.settings' } as const;

describe.each(['ios', 'android'] as const)('%s recording', (platform) => {
  const reason = missing(platform);
  it.skipIf(reason)(
    `records a flow through the device into an MP4${reason ? ` (skipped: ${reason})` : ''}`,
    { timeout: 120_000 },
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'bugpatrol-maestro-recording-'));
      const driver = new MaestroDriver(platform, { appId: SETTINGS[platform] });
      await driver.connect();
      try {
        await driver.startRecording!();
        await driver.observe();
        expect((await driver.act({ kind: 'scroll', direction: 'down' })).ok).toBe(true);
        await driver.settle();
        const file = await driver.stopRecording!(join(dir, 'head'));
        expect(file).toBe(join(dir, 'head.mp4'));
        if (output('ffprobe', ['-version']) === undefined) {
          expect((await stat(file)).size).toBeGreaterThan(0);
        } else {
          const frames = output('ffprobe', [
            ...['-v', 'error', '-count_frames', '-select_streams', 'v:0'],
            ...['-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', file],
          ]);
          expect(Number(frames?.trim())).toBeGreaterThan(1);
        }
      } finally {
        await driver.close();
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
});
