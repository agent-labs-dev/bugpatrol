import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import type { BugpatrolConfig, Platform } from '@bugpatrol/core';
import { onPath } from './runtime/index.js';

const exec = promisify(execFile);

/** Why the machine cannot run a platform, for each platform that it cannot run. */
export type Capabilities = Partial<Record<Platform, string>>;

/** The programs that a private Cua desktop session runs. */
export function desktopCommands(config: BugpatrolConfig): string[] {
  const cua = config.app.connect.cua;
  return ['setsid', 'Xvfb', 'xauth', 'dbus-run-session', cua?.command ?? 'cua-driver', cua?.windowManager ?? 'openbox'];
}

const output = async (command: string, args: string[]) => {
  try {
    return (await exec(command, args, { timeout: 15_000 })).stdout;
  } catch {
    return undefined;
  }
};

/**
 * Finds which of `platforms` this machine can run. It looks for what is
 * running already: Bugpatrol never starts an emulator or a simulator.
 */
export async function detectCapabilities(config: BugpatrolConfig, platforms: Platform[]): Promise<Capabilities> {
  const found: Capabilities = {};
  for (const platform of new Set(platforms)) {
    const missing = await missingFor(config, platform);
    if (missing) found[platform] = missing;
  }
  return found;
}

async function missingFor(config: BugpatrolConfig, platform: Platform): Promise<string | undefined> {
  const linux = process.platform === 'linux';
  const env = process.env;
  switch (platform) {
    case 'electron':
      // macOS and Windows always have a display.
      if (!linux || env.DISPLAY || env.WAYLAND_DISPLAY || onPath('Xvfb')) return;
      return 'The Electron app needs a display, and this machine has no display and no Xvfb.';
    case 'desktop': {
      if (!linux) return `The desktop app needs Linux and Xvfb, and this machine runs ${process.platform}.`;
      const missing = desktopCommands(config).filter((command) => !command.includes('${') && !onPath(command));
      if (missing.length)
        return `The desktop app needs programs that this machine does not have: ${missing.join(', ')}.`;
      return;
    }
    case 'ios': {
      if (process.platform !== 'darwin')
        return `iOS needs macOS and a booted simulator, and this machine runs ${process.platform}.`;
      if (config.app.connect.device) return;
      const booted = await output('xcrun', ['simctl', 'list', 'devices', 'booted', '-j']);
      if (booted?.includes('"Booted"')) return;
      return 'No iOS simulator runs on this machine.';
    }
    case 'android': {
      const devices = await output('adb', ['devices']);
      if (devices === undefined) return 'No Android emulator runs on this machine: it has no adb.';
      if (devices.split('\n').some((line) => /^\S+\s+device$/.test(line.trim()))) return;
      if (linux && !existsSync('/dev/kvm'))
        return 'No Android emulator runs on this machine, and it has no KVM to run one.';
      return 'No Android emulator runs on this machine.';
    }
    default:
      return;
  }
}
