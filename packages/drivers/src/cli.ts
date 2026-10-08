import { type ChildProcess, spawn } from 'node:child_process';
import type { ScreenSnapshot } from '@bugpatrol/invariants';
import { type Cast, Terminal, terminalPng, writeCast } from './cast.js';
import { nativeSnapshot } from './maestro.js';
import type { ActResult, Driver, DriverAction, Observation } from './types.js';

const COLS = 80;
const ROWS = 24;
/** The output of a command is read as text, not drawn, so its lines are as wide as the command prints them. */
const OUTPUT_COLS = 1024;

/**
 * Runs one command in a pseudo-terminal and copies its output to stdout. Node
 * has no pty of its own, and BSD `script` refuses the socket that Node gives
 * as stdin, so Python's pty module does it the same way on macOS and Linux.
 * The command leads its own session, so a stop kills every process it started.
 */
const PTY = `
import fcntl, os, pty, select, signal, struct, sys, termios
cols, rows, command = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3]
pid, fd = pty.fork()
if pid == 0:
    os.execv('/bin/sh', ['/bin/sh', '-c', command])
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
signal.signal(signal.SIGTERM, lambda *_: os.killpg(pid, signal.SIGKILL))
inputs = [fd, 0]
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

export type CliDriverOptions = {
  /** The directory each command runs in: the source of the build under test. */
  cwd: string;
  /** A command that runs longer is stopped, and its step fails. */
  timeoutMs: number;
  /** Applied to every byte of output before the screen, the cast, or the explorer sees it. */
  redact?: (value: string) => string;
};

/**
 * A command line app. Each `run` step runs one command in a terminal of 80
 * by 24 until it exits, and the screen shows the session like a shell does:
 * the command after a `$`, then its output. A recording is an asciicast of
 * that session. Output is redacted line by line, so a secret that arrives in
 * two pieces is still found.
 */
export class CliDriver implements Driver {
  readonly platform = 'cli' as const;
  private screen = new Terminal(COLS, ROWS);
  private last?: { command: string; exitCode?: number; output: Terminal };
  private child?: ChildProcess;
  private cast?: { start: number; events: Cast['events'] };
  private readonly redact: (value: string) => string;

  constructor(private readonly options: CliDriverOptions) {
    this.redact = options.redact ?? ((value) => value);
  }

  async connect(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const probe = spawn('python3', ['-c', 'import pty'], { stdio: 'ignore' });
      probe.on('error', () => reject(new Error('The cli driver needs python3 on the PATH, for its terminal')));
      probe.on('exit', (code) =>
        code === 0 ? resolve() : reject(new Error('The cli driver needs the pty module of python3')),
      );
    });
  }

  /** Text that the session shows. `output` is false for the command line itself. */
  private show(text: string, output = true): void {
    if (!text) return;
    this.screen.write(text);
    if (output) this.last?.output.write(text);
    this.cast?.events.push([(Date.now() - this.cast.start) / 1000, text]);
  }

  async act(action: DriverAction): Promise<ActResult> {
    if (action.kind === 'wait') {
      await new Promise((resolve) => setTimeout(resolve, action.ms));
      return { ok: true, step: { kind: 'wait', ms: action.ms } };
    }
    if (action.kind !== 'run') return { ok: false, retryable: false, error: 'A CLI app takes only run and wait' };
    const command = this.redact(action.command);
    this.show(`\u001b[1;32m$\u001b[0m ${command}\r\n`, false);
    this.last = { command, output: new Terminal(OUTPUT_COLS, ROWS) };
    const step = { kind: 'run' as const, command: action.command, ...(action.input ? { input: action.input } : {}) };
    const child = spawn('python3', ['-c', PTY, String(COLS), String(ROWS), action.command], {
      cwd: this.options.cwd,
      env: { ...process.env, TERM: 'xterm-256color', COLUMNS: String(COLS), LINES: String(ROWS) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    let partial = '';
    let errors = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      partial += chunk;
      const end = partial.lastIndexOf('\n') + 1;
      if (!end) return;
      this.show(this.redact(partial.slice(0, end)));
      partial = partial.slice(end);
    });
    child.stderr.on('data', (chunk) => {
      errors += chunk;
    });
    child.stdin.on('error', () => {});
    if (action.input) {
      const input = action.input.endsWith('\n') ? action.input : `${action.input}\n`;
      // Enter on a keyboard sends a carriage return.
      child.stdin.write(input.replaceAll('\n', '\r'));
    }
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2000).unref();
    }, this.options.timeoutMs);
    const code = await new Promise<number | null>((resolve) => {
      child.on('error', (error) => {
        errors += String(error);
        resolve(null);
      });
      child.on('close', resolve);
    });
    clearTimeout(timer);
    this.child = undefined;
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

  async observe(): Promise<Observation> {
    return {
      platform: 'cli',
      location: 'terminal',
      ...(this.last ? { title: this.last.command } : {}),
      screenshot: terminalPng(this.screen),
      viewport: { width: COLS * 8, height: ROWS * 16, scale: 1 },
      elements: [],
      volatileRegions: [],
      consoleErrors: [],
      at: new Date().toISOString(),
      ...(this.last
        ? {
            terminal: {
              command: this.last.command,
              ...(this.last.exitCode === undefined ? {} : { exitCode: this.last.exitCode }),
              output: this.last.output.text(),
            },
          }
        : {}),
    };
  }

  /** A step runs to its end, so the screen is still between steps. */
  async settle(): Promise<{ frames: number; stable: boolean }> {
    return { frames: 1, stable: true };
  }

  snapshot(observation: Observation, screenId: string): ScreenSnapshot {
    return nativeSnapshot(observation, screenId);
  }

  async startRecording(): Promise<void> {
    this.cast = { start: Date.now(), events: [] };
  }

  async stopRecording(name: string): Promise<string> {
    const cast = this.cast;
    if (!cast) throw new Error('No recording runs');
    this.cast = undefined;
    const file = `${name}.cast`;
    await writeCast(file, { width: COLS, height: ROWS, events: cast.events });
    return file;
  }

  async close(): Promise<void> {
    this.child?.kill('SIGTERM');
  }
}
