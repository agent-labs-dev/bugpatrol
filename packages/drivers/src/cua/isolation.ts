import { randomBytes } from 'node:crypto';
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// Xvfb -displayfd alone starts at :0 and unlinks the socket path of a host display that has no abstract
// socket (Hyprland's Xwayland), so the search starts at :100 and skips any number with a lock or a bound socket.
const DISPLAY_WRAPPER = [
  'export XAUTHORITY="$1/auth"; xauth -f "$XAUTHORITY" add :0 . "$2" || exit 1; n=99; xvfb=',
  'while [ -z "$xvfb" ]; do n=$((n+1)); [ "$n" -lt 200 ] || { cat "$1/xvfb.log" >&2; exit 1; }',
  '[ -e "/tmp/.X$n-lock" ] && continue; grep -q "/tmp/.X11-unix/X$n\\$" /proc/net/unix && continue',
  'Xvfb ":$n" -displayfd 3 -screen 0 "$3" -nolisten tcp -auth "$XAUTHORITY" 3>"$1/display" >"$1/xvfb.log" 2>&1 & xvfb=$!; i=0',
  'while [ ! -s "$1/display" ]; do kill -0 "$xvfb" 2>/dev/null || { wait "$xvfb"; xvfb=; break; }; i=$((i+1)); [ "$i" -lt 100 ] || { kill "$xvfb"; exit 1; }; sleep 0.05; done; done',
  'export DISPLAY=":$(cat "$1/display")"; xauth -f "$XAUTHORITY" add "$DISPLAY" . "$2" || { kill "$xvfb"; exit 1; }; shift 3',
  'dbus-run-session -- "$@"; status=$?; kill "$xvfb" 2>/dev/null; wait "$xvfb" 2>/dev/null; exit "$status"',
].join('; ');

/** Spawn `command` with `args(inner)` and `env`: the wrapper runs `inner` on its own display and session bus. */
export type IsolatedDisplay = {
  env: Record<string, string>;
  command: string;
  args: (inner: string[]) => string[];
};

/** Build the private display wrapper used by both Cua and Electron. */
export async function createIsolatedDisplay(
  directory: string,
  width: number,
  height: number,
): Promise<IsolatedDisplay> {
  if (process.platform !== 'linux') throw new Error('Private display isolation currently requires Linux/Xvfb');
  const home = join(directory, 'home');
  const runtime = join(directory, 'runtime');
  await mkdir(home, { mode: 0o700 });
  await mkdir(runtime, { mode: 0o700 });
  // An allowlist (HOME, PATH, USER and the like), so the host DISPLAY, WAYLAND_DISPLAY and XAUTHORITY never leak in.
  const env: Record<string, string> = {
    ...getDefaultEnvironment(),
    HOME: home,
    XDG_RUNTIME_DIR: runtime,
    XDG_CONFIG_HOME: join(home, 'config'),
    XDG_CACHE_HOME: join(home, 'cache'),
    XDG_DATA_HOME: join(home, 'data'),
    XDG_SESSION_TYPE: 'x11',
    GDK_BACKEND: 'x11',
    CUA_DRIVER_RS_ENABLE_WAYLAND: '0',
    GTK_USE_PORTAL: '0',
  };
  const cookie = randomBytes(32).toString('hex');
  return {
    env,
    command: 'setsid',
    args: (inner) => [
      'sh',
      '-c',
      DISPLAY_WRAPPER,
      'bugpatrol-xvfb',
      directory,
      cookie,
      `${width}x${height}x24`,
      ...inner,
    ],
  };
}

/**
 * A separate X server and bus isolate focus; no user profile or backend env is inherited.
 * The launcher stops Xvfb itself when the session ends, so a session that fails to start
 * leaves no display behind.
 */
export async function isolatedTransport(
  command: string,
  windowManager: string,
  width: number,
  height: number,
): Promise<{
  transport: StdioClientTransport;
  directory: string;
  remove: () => Promise<void>;
}> {
  if (process.platform !== 'linux') throw new Error('Cua desktop isolation currently requires Linux/Xvfb');
  const find = async (name: string): Promise<string> => {
    for (const prefix of ['/usr/lib', '/usr/libexec', '/usr/lib/at-spi2-core']) {
      const path = join(prefix, name);
      try {
        await access(path);
        return path;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    throw new Error(`Missing Linux prerequisite: ${name}`);
  };
  const bus = await find('at-spi-bus-launcher');
  const registry = await find('at-spi2-registryd');
  const directory = await mkdtemp(join(tmpdir(), 'bugpatrol-desktop-'));
  try {
    const display = await createIsolatedDisplay(directory, width, height);
    const transport = new StdioClientTransport({
      command: display.command,
      args: display.args([
        'sh',
        '-c',
        '"$1" --launch-immediately >/dev/null 2>&1 & shift; "$1" >/dev/null 2>&1 & shift; command -v "$1" >/dev/null || exit 127; "$1" --sm-disable >"$XDG_RUNTIME_DIR/wm.log" 2>&1 & wm=$!; sleep 0.2; kill -0 "$wm" || { cat "$XDG_RUNTIME_DIR/wm.log" >&2; exit 1; }; shift; exec "$@"',
        'bugpatrol-private',
        bus,
        registry,
        windowManager,
        command,
        'mcp',
        '--direct',
      ]),
      env: display.env,
      stderr: 'pipe',
    });
    return { transport, directory, remove: () => rm(directory, { recursive: true, force: true }) };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
