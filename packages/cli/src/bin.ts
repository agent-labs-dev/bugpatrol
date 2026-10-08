#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { cleanWorktrees, syncGitHub } from '@bugpatrol/agents';
import { BugpatrolError, ExitCode, findProjectRoot, loadConfig, moveRoutines } from '@bugpatrol/core';
import { startDashboard } from '@bugpatrol/dashboard';
import { configArgs, legacyEnv, withDefaultCommand } from './argv.js';
import { runAgentCommand } from './commands/agents.js';
import { doctorExitCode, runChecks } from './commands/doctor.js';
import { runInit } from './commands/init.js';
import { runIssueCommand } from './commands/issue.js';
import { runMemoryCommand } from './commands/memory.js';
import { runPromoteCommand } from './commands/promote.js';
import { exitCodeForError, runCommand } from './commands/run.js';
import { formatRunSummary, parseRunFlags } from './commands/run-cli.js';
import { commandHelp, USAGE } from './usage.js';

legacyEnv(process.env);

// The folder that holds .bugpatrol/, found from any subfolder the way git does.
const root = findProjectRoot(process.cwd());

declare const __BUGPATROL_VERSION__: string | undefined;

function version(): string {
  if (typeof __BUGPATROL_VERSION__ !== 'undefined') return __BUGPATROL_VERSION__;
  try {
    return (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string })
      .version;
  } catch {
    return '0.0.0-dev';
  }
}

try {
  const selected = configArgs(process.argv.slice(2));
  const [command, ...args] = withDefaultCommand(selected.args);
  const readConfig = () => loadConfig(root, {}, selected.configFile);
  const optionalConfig = () => (selected.configFile ? readConfig() : tryLoadConfig(root));
  if (command && (args.includes('--help') || args.includes('-h'))) {
    process.stdout.write(commandHelp(command) ?? USAGE);
    process.exit(ExitCode.Clean);
  }
  const moved = moveRoutines(root);
  if (moved) process.stderr.write(`${moved}\n`);
  switch (command) {
    case '--version':
    case '-v':
      process.stdout.write(`${version()}\n`);
      process.exit(ExitCode.Clean);
      break;

    case undefined:
    case '--help':
    case '-h':
    case 'help':
      process.stdout.write(USAGE);
      process.exit(ExitCode.Clean);
      break;

    case 'init': {
      await runInit(root, args, (line) => process.stdout.write(`${line}\n`));
      process.exit(ExitCode.Clean);
      break;
    }

    case 'doctor': {
      const config = optionalConfig();
      const checks = runChecks(root, config);
      for (const check of checks) {
        process.stdout.write(`${check.ok ? 'ok  ' : check.fatal ? 'FAIL' : 'warn'}  ${check.name}: ${check.detail}\n`);
      }
      process.exit(doctorExitCode(checks));
      break;
    }

    case 'run': {
      const config = readConfig();
      const flags = parseRunFlags(args);
      const result = await runCommand({
        root,
        config,
        mode: flags.mode,
        commit: flags.commit,
        noModels: flags.noModels,
        only: flags.only,
        onProgress: (m) => process.stdout.write(`  ${m}\n`),
      });
      process.stdout.write(formatRunSummary(result));
      process.exit(result.exitCode);
      break;
    }

    case 'explore':
    case 'judge':
    case 'fix':
    case 'retest':
    case 'review':
    case 'publish':
    case 'ci':
    case 'patrol':
    case 'replay': {
      const config = readConfig();
      await runAgentCommand(
        command,
        args,
        root,
        config,
        (message) => process.stdout.write(`${message}\n`),
        selected.configFile,
      );
      break;
    }

    case 'promote': {
      await runPromoteCommand(args, root, readConfig(), (line) => process.stdout.write(`${line}\n`));
      break;
    }

    case 'issue': {
      await runIssueCommand(args, root, (line) => process.stdout.write(`${line}\n`), optionalConfig());
      break;
    }

    case 'memory': {
      await runMemoryCommand(args, root, (line) => process.stdout.write(`${line}\n`));
      break;
    }

    case 'github': {
      if (args.length !== 1 || args[0] !== 'sync') throw new Error('Use bugpatrol github sync');
      const config = readConfig();
      const result = await syncGitHub(root, config, { onLog: console.error });
      await cleanWorktrees(root, config, { onLog: console.error });
      process.stdout.write(`Synced: ${result.changed.length} change(s)\n`);
      for (const id of result.changed) process.stdout.write(`${id}\n`);
      break;
    }

    case 'worktrees': {
      if (args.length !== 1 || args[0] !== 'clean') throw new Error('Use bugpatrol worktrees clean');
      const result = await cleanWorktrees(root, readConfig(), { onLog: console.error });
      process.stdout.write(`Removed: ${result.removed.length} worktree(s)\n`);
      for (const id of result.removed) process.stdout.write(`${id}\n`);
      for (const item of result.kept) process.stdout.write(`Kept ${item.id}: ${item.reason}\n`);
      break;
    }

    case 'dashboard': {
      const portFlag = args.indexOf('--port');
      const port = portFlag >= 0 ? Number(args[portFlag + 1]) : undefined;
      if (portFlag >= 0 && !Number.isInteger(port)) {
        process.stderr.write('--port needs an integer\n');
        process.exit(ExitCode.Usage);
      }
      const config = optionalConfig();
      let timer: ReturnType<typeof setInterval> | undefined;
      if (config?.agents.github.enabled) {
        const sync = () =>
          void syncGitHub(root, config, { onLog: console.error }).catch((error) =>
            console.error(`GitHub sync failed: ${String(error)}`),
          );
        await syncGitHub(root, config, { onLog: console.error }).catch((error) =>
          console.error(`GitHub sync failed: ${String(error)}`),
        );
        timer = setInterval(sync, 5 * 60_000);
        timer.unref();
      }
      const dashboard = await startDashboard({
        root,
        configFile: selected.configFile,
        port,
        onReady: (url) => {
          process.stdout.write(`Bugpatrol dashboard on ${url}\n`);
          process.stdout.write('Watching .bugpatrol/runs/ — runs appear as they finish. Ctrl-C to stop.\n');
        },
      });
      // Deliberately does not exit: this is a server, and the watcher is the
      // whole point.
      const stop = () => {
        if (timer) clearInterval(timer);
        void dashboard.close().then(() => process.exit(ExitCode.Clean));
      };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      break;
    }

    // M1-M6. Each command exists in the surface now so the contract is fixed
    // and the exit codes are honest about what is not built yet.
    case 'recon':
    case 'model':
    case 'baseline':
    case 'findings':
    case 'intent':
    case 'report':
    case 'export':
    case 'watch':
      process.stderr.write(
        `\`bugpatrol ${command}${args.length ? ` ${args.join(' ')}` : ''}\` is not implemented yet.\n`,
      );
      process.stderr.write(
        'See https://github.com/agent-labs-dev/bugpatrol/blob/main/docs/commands.md for the commands that work now.\n',
      );
      process.exit(ExitCode.Usage);
      break;

    default:
      process.stderr.write(`Unknown command: ${command}\n\n${USAGE}`);
      process.exit(ExitCode.Usage);
  }
} catch (error) {
  if (error instanceof BugpatrolError) {
    process.stderr.write(`${error.message}\n`);
    process.exit(error.exitCode);
  }
  // Anything unrecognised is treated as "Bugpatrol could not test", never as a
  // product regression.
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(exitCodeForError(error));
}

function tryLoadConfig(cwd: string) {
  try {
    return loadConfig(cwd);
  } catch {
    return undefined;
  }
}
