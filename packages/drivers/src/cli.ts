import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import type { SessionOp } from '@bugpatrol/core';
import type { ScreenSnapshot } from '@bugpatrol/invariants';
import { CastRecorder, Terminal, terminalPng } from './cast.js';
import { keyBytes } from './keys.js';
import { nativeSnapshot } from './maestro.js';
import type { ActResult, Driver, DriverAction, Observation } from './types.js';

/** The output of a command is read as text, not drawn, so its lines are as wide as the command prints them. */
const OUTPUT_COLS = 1024;
/** Replaced in `env` by a folder that the driver makes on connect and removes on close. */
export const PRIVATE_DIR = '{{PRIVATE_DIR}}';
/**
 * The pause between two keys. A terminal app reads an escape that comes with
 * the next key as alt and that key, so each key goes on its own, like a
 * person types.
 */
const KEY_GAP_MS = 50;
/**
 * The pause after a lone escape that another key follows. A program waits
 * this long for the rest of a sequence before it reads a lone escape:
 * ncurses waits 1000 ms unless it sets `ESCDELAY`, OpenTUI 20 ms.
 */
const ESCAPE_GAP_MS = 1000;
/** How long a program has to start answering a key. One that prints nothing by then is taken as still. */
const ANSWER_MS = 1000;
/**
 * A program whose screen did not change for this long is waiting for a key.
 * It grows with how slowly the program answered, up to the cap.
 */
const QUIET_MS = 150;
const QUIET_CAP_MS = 1000;
/** The longest that settling waits. */
const SETTLE_MS = 5000;

/**
 * The variables of the host that the app gets: where programs are, the user,
 * the locale and the time zone. Nothing else, so a token in Bugpatrol's
 * environment never reaches the app, and `printenv` in a command shows none.
 * Not the host's `HOME` or XDG folders either, where a CLI keeps its sign-in:
 * the app's `HOME` is the private folder unless `connect.cli.env` names one.
 * `connect.cli.env` adds the rest that the app needs.
 */
const HOST_ENV =
  /^(PATH|USER|LOGNAME|SHELL|LANG|LANGUAGE|LC_[A-Z]+|TZ|TMPDIR|COLORTERM|NO_COLOR|XDG_(DATA|CONFIG)_DIRS)$/;

/**
 * A command that would run a program outside the terminal Bugpatrol drives:
 * a terminal multiplexer, whose server keeps the host's environment and
 * sign-ins, or a program that leaves the process group a stop kills. Only a
 * program in the place of a command counts, so `grep screen` and
 * `grep "screen" app.log` run: a quote opens a command only after
 * `sh -c` (or bash, zsh, `-lc` and the like) or `eval`.
 */
const ESCAPE =
  /(^|[;|&(`]|\n|(?:\b(?:ba|z|da|k)?sh\s+(?:-\w+\s+)*-\w*c|\beval)\s+['"])\s*((exec|command|sudo|env|nice|time)\s+)*([A-Za-z_]\w*=\S*\s+)*(\S*\/)?(tmux|screen|byobu|zellij|abduco|dtach|setsid|systemd-run|daemonize|start-stop-daemon)(?=$|[\s;|&)'"`])/;

const OUTSIDE =
  'Bugpatrol refuses a command that starts a program outside its own terminal, such as tmux, screen or setsid: start the program with start_session, and drive it with press';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs one command in a pseudo-terminal and copies its output to stdout. Node
 * has no pty of its own, and BSD `script` refuses the socket that Node gives
 * as stdin, so Python's pty module does it the same way on macOS and Linux.
 *
 * fd 3 is a control channel. Its first line is the JSON of the command and
 * of its environment, so neither shows in the process list and the app's
 * variables never reach Python. The helper then writes the pid of the
 * command there, reads `resize <cols> <rows>` lines from it, and kills the
 * command's process group when it closes. The command leads its own session,
 * so a stop, or the end of Bugpatrol, kills every process it started.
 */
const PTY = `
import fcntl, json, os, pty, select, signal, struct, sys, termios
cols, rows = int(sys.argv[1]), int(sys.argv[2])
lines = b''
while b'\\n' not in lines:
    data = os.read(3, 65536)
    if not data:
        sys.exit(1)
    lines += data
first, lines = lines.split(b'\\n', 1)
spec = json.loads(first)
def size(fd, cols, rows):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
pid, fd = pty.fork()
if pid == 0:
    size(0, cols, rows)
    os.execve('/bin/sh', ['/bin/sh', '-c', spec['command']], spec['env'])
def stop(*_):
    try:
        os.killpg(pid, signal.SIGKILL)
    except OSError:
        pass
signal.signal(signal.SIGTERM, stop)
os.write(3, b'%d\\n' % pid)
inputs = [fd, 0, 3]
def control(data):
    global lines
    lines += data
    while b'\\n' in lines:
        line, lines = lines.split(b'\\n', 1)
        words = line.split()
        if len(words) == 3 and words[0] == b'resize':
            size(fd, int(words[1]), int(words[2]))
control(b'')
while True:
    try:
        ready = select.select(inputs, [], [])[0]
    except InterruptedError:
        continue
    if 0 in ready:
        data = os.read(0, 4096)
        if data:
            os.write(fd, data)
        else:
            inputs.remove(0)
    if 3 in ready:
        data = os.read(3, 4096)
        if data:
            control(data)
        else:
            inputs.remove(3)
            stop()
    if fd in ready:
        try:
            data = os.read(fd, 65536)
        except OSError:
            data = b''
        if not data:
            break
        os.write(1, data)
status = os.waitpid(pid, 0)[1]
sys.exit(os.WEXITSTATUS(status) if os.WIFEXITED(status) else 128 + os.WTERMSIG(status))
`;

/** A command in the pty helper. */
type Helper = {
  child: ChildProcess;
  control: Duplex;
  /** The process group of the command, once the helper has sent it. */
  pid?: number;
  /** The exit code of the command, or null when the helper did not start. Settles once both exited. */
  closed: Promise<number | null>;
};

export type CliDriverOptions = {
  /** The directory each command runs in: the source of the build under test. */
  cwd: string;
  /** A command that runs longer is stopped, and its step fails. A session waits at most this long. */
  timeoutMs: number;
  /** Applied to every byte of output before the screen, the cast, or the explorer sees it. */
  redact?: (value: string) => string;
  /** The size of the terminal in characters. Default: 80 by 24. */
  cols?: number;
  rows?: number;
  /**
   * Variables for the app's processes, on top of the few of the host that
   * the app gets (see `HOST_ENV`). `{{PRIVATE_DIR}}` in a value becomes a
   * folder that the driver makes on connect and removes on close.
   */
  env?: Record<string, string>;
  /** A program that stays open, started on connect, so the first look is at it. */
  command?: string;
};

/** A program that stays open across steps, such as a full screen terminal UI. */
type Session = {
  /** Redacted. */
  command: string;
  helper: Helper;
  /** The visible screen of the program. */
  screen: Terminal;
  running: boolean;
  exitCode?: number;
  /** Resolves once the program and its helper exited. */
  closed: Promise<void>;
  /** When the program last printed. */
  printed: number;
  /** When it last got a key, or started. */
  sent: number;
  /** When it first printed after the last key. */
  answered: number;
};

const prompt = (command: string) => `\u001b[1;32m$\u001b[0m ${command}\r\n`;

/**
 * A command line app. Each `run` step runs one command in a terminal until it
 * exits, and the screen shows the session like a shell does: the command
 * after a `$`, then its output. A `session` step drives a program that stays
 * open, such as a full screen terminal UI: it starts it, sends it keys, waits
 * for text on its screen, resizes it, and stops it, and the screen is what
 * the program shows now. A recording is an asciicast of both.
 *
 * The output of a `run` is redacted line by line, so a secret that arrives
 * in two pieces is still found. A session's screen text is redacted whole,
 * the cells of a secret on its screenshot are blanked, and the recording is
 * redacted as one stream when it stops.
 */
export class CliDriver implements Driver {
  readonly platform = 'cli' as const;
  private readonly cols: number;
  private readonly rows: number;
  private readonly screen: Terminal;
  private last?: { command: string; exitCode?: number; output: Terminal };
  /** The helper of the `run` step in progress. */
  private running?: Helper;
  private session?: Session;
  /** What `observe` shows: the shell of the `run` steps, or the screen of the session. */
  private view: 'shell' | 'session' = 'shell';
  private privateDir?: string;
  private appEnv: Record<string, string> = {};
  private readonly cast: CastRecorder;
  private readonly redact: (value: string) => string;

  constructor(private readonly options: CliDriverOptions) {
    this.redact = options.redact ?? ((value) => value);
    this.cols = options.cols ?? 80;
    this.rows = options.rows ?? 24;
    this.screen = new Terminal(this.cols, this.rows);
    this.cast = new CastRecorder({ width: this.cols, height: this.rows }, this.redact);
  }

  async connect(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const probe = spawn('python3', ['-I', '-c', 'import pty'], { stdio: 'ignore', env: this.helperEnv() });
      probe.on('error', () => reject(new Error('The cli driver needs python3 on the PATH, for its terminal')));
      probe.on('exit', (code) =>
        code === 0 ? resolve() : reject(new Error('The cli driver needs the pty module of python3')),
      );
    });
    const privateDir = await mkdtemp(join(tmpdir(), 'bugpatrol-app-'));
    this.privateDir = privateDir;
    this.appEnv = Object.fromEntries(
      Object.entries(this.options.env ?? {}).map(([name, value]) => [name, value.replaceAll(PRIVATE_DIR, privateDir)]),
    );
    if (this.options.command) await this.start(this.options.command);
  }

  /** The helper runs in isolated mode with only the host PATH, so nothing of the app's environment changes it. */
  private helperEnv(): NodeJS.ProcessEnv {
    return { PATH: process.env.PATH ?? '/usr/bin:/bin' };
  }

  /**
   * The environment of the app's processes: the allowed host variables, the
   * private `HOME`, the terminal, then `connect.cli.env`. A session can be resized, and curses
   * apps prefer COLUMNS and LINES to the size of the terminal, so a session
   * gets neither.
   */
  private environment(session: boolean): Record<string, string> {
    const host = Object.entries(process.env).filter(
      (entry): entry is [string, string] => HOST_ENV.test(entry[0]) && entry[1] !== undefined,
    );
    return {
      ...Object.fromEntries(host),
      ...(this.privateDir ? { HOME: this.privateDir } : {}),
      TERM: 'xterm-256color',
      ...(session ? {} : { COLUMNS: String(this.cols), LINES: String(this.rows) }),
      ...this.appEnv,
    };
  }

  /** Starts `command` in the pty helper. */
  private spawnHelper(command: string, session: boolean): Helper {
    const child = spawn('python3', ['-I', '-c', PTY, String(this.cols), String(this.rows)], {
      cwd: this.options.cwd,
      env: this.helperEnv(),
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    });
    const control = child.stdio[3] as Duplex;
    const helper: Helper = {
      child,
      control,
      closed: new Promise((resolve) => {
        child.on('error', () => resolve(null));
        child.on('close', resolve);
      }),
    };
    child.stdin?.on('error', () => {});
    control.on('error', () => {});
    control.write(`${JSON.stringify({ command, env: this.environment(session) })}\n`);
    let said = '';
    control.setEncoding('utf8');
    control.on('data', (chunk: string) => {
      said += chunk;
      const pid = /^(\d+)\n/.exec(said)?.[1];
      if (pid && helper.pid === undefined) helper.pid = Number(pid);
    });
    return helper;
  }

  /** Kills the command of a helper and every process it started, and waits until the helper exited. */
  private async kill(helper: Helper): Promise<void> {
    if (helper.pid !== undefined) {
      try {
        process.kill(-helper.pid, 'SIGKILL');
      } catch {
        // It exited on its own.
      }
    }
    // The helper kills the group too, when its control channel closes or on SIGTERM.
    helper.control.end();
    helper.child.kill('SIGTERM');
    const timer = setTimeout(() => helper.child.kill('SIGKILL'), 2000);
    await helper.closed;
    clearTimeout(timer);
  }

  /** Text that the shell shows. `output` is false for the command line itself. */
  private show(text: string, output = true): void {
    if (!text) return;
    this.screen.write(text);
    if (output) this.last?.output.write(text);
    this.cast.push(text);
  }

  async act(action: DriverAction): Promise<ActResult> {
    if (action.kind === 'wait') {
      await sleep(action.ms);
      return { ok: true, step: { kind: 'wait', ms: action.ms } };
    }
    if (action.kind === 'session') {
      const { kind: _kind, ...op } = action;
      return this.sessionStep(op);
    }
    if (action.kind !== 'run')
      return { ok: false, retryable: false, error: 'A CLI app takes only run, session and wait' };
    if (ESCAPE.test(action.command)) return { ok: false, retryable: false, error: OUTSIDE };
    this.view = 'shell';
    const command = this.redact(action.command);
    this.show(prompt(command), false);
    this.last = { command, output: new Terminal(OUTPUT_COLS, this.rows) };
    const step = { kind: 'run' as const, command: action.command, ...(action.input ? { input: action.input } : {}) };
    const helper = this.spawnHelper(action.command, false);
    this.running = helper;
    const { child } = helper;
    let partial = '';
    let errors = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      partial += chunk;
      const end = partial.lastIndexOf('\n') + 1;
      if (!end) return;
      this.show(this.redact(partial.slice(0, end)));
      partial = partial.slice(end);
    });
    child.stderr?.on('data', (chunk) => {
      errors += chunk;
    });
    child.on('error', (error) => {
      errors += String(error);
    });
    if (action.input) {
      const input = action.input.endsWith('\n') ? action.input : `${action.input}\n`;
      // Enter on a keyboard sends a carriage return.
      child.stdin?.write(input.replaceAll('\n', '\r'));
    }
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      void this.kill(helper);
    }, this.options.timeoutMs);
    const code = await helper.closed;
    clearTimeout(timer);
    this.running = undefined;
    this.show(this.redact(partial));
    if (timedOut) {
      this.show('\r\n\u001b[33m[stopped by Bugpatrol]\u001b[0m\r\n', false);
      return {
        ok: false,
        retryable: false,
        error: `The command is still running after ${Math.round(this.options.timeoutMs / 1000)} s`,
        step,
      };
    }
    if (code === null) return { ok: false, retryable: false, error: this.redact(errors.trim()), step };
    this.last.exitCode = code;
    return { ok: true, step };
  }

  private async sessionStep(op: SessionOp): Promise<ActResult> {
    const step = { kind: 'session' as const, ...op };
    const fail = (error: string): ActResult => ({ ok: false, retryable: false, error: this.redact(error) });
    if (op.op === 'start') {
      if (ESCAPE.test(op.command)) return fail(OUTSIDE);
      await this.start(op.command);
      return { ok: true, step };
    }
    const session = this.session;
    if (!session) return fail('No session is running. Start one first');
    this.view = 'session';
    const exited = () => `The program exited with code ${session.exitCode ?? 'none'}`;
    if (op.op === 'stop') {
      await this.stopSession();
      return { ok: true, step };
    }
    if (op.op === 'wait') {
      const limit = Math.min(op.timeoutMs, this.options.timeoutMs);
      const deadline = Date.now() + limit;
      const seconds = `${Math.round(limit / 1000)} s`;
      if (op.text === undefined) {
        return (await this.quiet(session, 500, deadline))
          ? { ok: true, step }
          : fail(`The screen still changes after ${seconds}`);
      }
      while (true) {
        await session.screen.flush();
        if (session.screen.screenText().includes(op.text)) return { ok: true, step };
        if (!session.running) return fail(`${exited()} before "${op.text}" was on the screen`);
        if (Date.now() >= deadline) return fail(`"${op.text}" is not on the screen after ${seconds}`);
        await sleep(50);
      }
    }
    if (!session.running) return fail(exited());
    if (op.op === 'resize') {
      await session.screen.flush();
      session.screen.resize(op.cols, op.rows);
      this.cast.resize(op.cols, op.rows);
      session.helper.control.write(`resize ${op.cols} ${op.rows}\n`);
      session.sent = Date.now();
      return { ok: true, step };
    }
    let keys: string[];
    try {
      keys = op.keys.map(keyBytes);
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
    for (const [index, bytes] of keys.entries()) {
      if (index) await sleep(keys[index - 1] === '\u001b' ? ESCAPE_GAP_MS : KEY_GAP_MS);
      session.helper.child.stdin?.write(bytes);
      session.sent = Date.now();
    }
    return { ok: true, step };
  }

  /** Starts a program in a terminal that stays open, in place of the session before. */
  private async start(command: string): Promise<void> {
    await this.stopSession();
    const shown = this.redact(command);
    this.show(prompt(shown), false);
    const helper = this.spawnHelper(command, true);
    const now = Date.now();
    const session: Session = {
      command: shown,
      helper,
      screen: new Terminal(this.cols, this.rows),
      running: true,
      printed: now,
      sent: now,
      answered: 0,
      closed: helper.closed.then((code) => {
        session.running = false;
        if (code !== null) session.exitCode = code;
      }),
    };
    helper.child.stdout?.setEncoding('utf8');
    helper.child.stdout?.on('data', (chunk: string) => {
      session.screen.write(chunk);
      // Raw here: the recording is redacted as one stream when it stops.
      this.cast.push(chunk);
      session.printed = Date.now();
      if (session.answered < session.sent) session.answered = session.printed;
    });
    helper.child.stderr?.resume();
    this.session = session;
    this.view = 'session';
  }

  /** Kills the program of the session and every process it started. */
  private async stopSession(): Promise<void> {
    const session = this.session;
    if (!session?.running) return;
    await this.kill(session.helper);
    await session.closed;
    // A program that was killed never left its alternate screen.
    this.cast.push('\u001b[?1049l\u001b[?25h');
    if (session.screen.cols !== this.cols || session.screen.rows !== this.rows) this.cast.resize(this.cols, this.rows);
  }

  /** Waits until the program printed nothing for `ms`. False when the deadline came first. */
  private async quiet(session: Session, ms: number, deadline: number): Promise<boolean> {
    while (session.running && Date.now() - Math.max(session.printed, session.sent) < ms) {
      if (Date.now() >= deadline) return false;
      await sleep(25);
    }
    return true;
  }

  async observe(): Promise<Observation> {
    const session = this.view === 'session' ? this.session : undefined;
    const screen = session?.screen ?? this.screen;
    await screen.flush();
    await this.last?.output.flush();
    const terminal: Observation['terminal'] = session
      ? {
          command: session.command,
          ...(session.exitCode === undefined ? {} : { exitCode: session.exitCode }),
          output: this.redact(session.screen.screenText()),
          screen: true,
        }
      : this.last && {
          command: this.last.command,
          ...(this.last.exitCode === undefined ? {} : { exitCode: this.last.exitCode }),
          output: this.last.output.text(),
        };
    return {
      platform: 'cli',
      location: 'terminal',
      ...(terminal ? { title: terminal.command, terminal } : {}),
      // The shell screen holds only redacted text; a session's screen holds what the program drew.
      capture: { kind: 'image', png: terminalPng(screen, session ? this.redact : undefined) },
      viewport: { width: screen.cols * 8, height: screen.rows * 16, scale: 1 },
      elements: [],
      volatileRegions: [],
      consoleErrors: [],
      at: new Date().toISOString(),
    };
  }

  /**
   * A `run` step runs to its end, so only a session's screen can still
   * change. After a key, it waits up to a second for the program to start
   * answering, then until the screen is quiet for twice as long as the
   * program took to answer (150 ms to 1 s). Not stable when the screen
   * still changed at the deadline.
   */
  async settle(options: { timeoutMs?: number } = {}): Promise<{ frames: number; stable: boolean }> {
    const session = this.view === 'session' ? this.session : undefined;
    if (!session?.running) return { frames: 1, stable: true };
    const deadline = Date.now() + (options.timeoutMs ?? SETTLE_MS);
    while (session.running && session.answered < session.sent && Date.now() - session.sent < ANSWER_MS) {
      if (Date.now() >= deadline) return { frames: 1, stable: false };
      await sleep(10);
    }
    const latency = session.answered >= session.sent ? session.answered - session.sent : 0;
    const window = Math.min(QUIET_CAP_MS, Math.max(QUIET_MS, latency * 2));
    return { frames: 1, stable: await this.quiet(session, window, deadline) };
  }

  snapshot(observation: Observation, screenId: string): ScreenSnapshot {
    return nativeSnapshot(observation, screenId);
  }

  async startRecording(): Promise<void> {
    this.cast.start();
  }

  async stopRecording(name: string): Promise<string> {
    return this.cast.stop(name);
  }

  async close(): Promise<void> {
    if (this.running) await this.kill(this.running);
    await this.stopSession();
    if (this.privateDir) await rm(this.privateDir, { recursive: true, force: true });
    this.privateDir = undefined;
  }
}
