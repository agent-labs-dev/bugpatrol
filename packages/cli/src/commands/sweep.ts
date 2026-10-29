import { resolve } from 'node:path';
import {
  AgentSession,
  planSweep,
  runSweep,
  type SweepPlan,
  type SweepResult,
  startApp,
  Vars,
  Workspace,
} from '@bugpatrol/agents';
import { buildContract, projectDoc, requestPolicy, sweepCases } from '@bugpatrol/contract';
import { type BugpatrolConfig, ConfigError, type CoverageFile, ExitCode, type ExitCodeValue } from '@bugpatrol/core';
import { ApiDriver, createDriver } from '@bugpatrol/drivers';

type SweepFlags = { json: boolean; dryRun: boolean; maxRequests?: number };

export function parseSweepFlags(args: string[]): SweepFlags {
  const flags: SweepFlags = { json: false, dryRun: false };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--json') flags.json = true;
    else if (arg === '--dry-run') flags.dryRun = true;
    else if (arg === '--max-requests') {
      const value = Number(args[++index]);
      if (!Number.isInteger(value) || value <= 0) throw new ConfigError('--max-requests needs a positive integer');
      flags.maxRequests = value;
    } else throw new ConfigError(`Unknown argument for bugpatrol sweep: ${arg}`);
  }
  return flags;
}

/**
 * `bugpatrol sweep [--json] [--max-requests N] [--dry-run]`
 *
 * Runs the deterministic sweep of an api app with no model, and prints the
 * endpoint × case table. Exit 1 when a failure repeats on a second replay,
 * unless the judge dismissed its fingerprint before.
 * `--dry-run` runs no setup, sends nothing, and writes nothing: it prints
 * the planned requests and why each other case does not run.
 */
export async function runSweepCommand(
  args: string[],
  root: string,
  config: BugpatrolConfig,
  log: (line: string) => void,
): Promise<ExitCodeValue> {
  const flags = parseSweepFlags(args);
  if (config.app.platform !== 'api') throw new ConfigError('bugpatrol sweep needs app.platform: api');
  const workspace = new Workspace(root);
  const budget = { ...config.agents.sweep, ...(flags.maxRequests ? { maxRequests: flags.maxRequests } : {}) };
  if (flags.dryRun) {
    const vars = new Vars(config.app.secrets);
    const { connect } = config.app;
    const url = connect.url ?? config.run?.url;
    if (!url) throw new ConfigError('bugpatrol sweep needs app.connect.url');
    const doc = await projectDoc(root, {
      spec: connect.spec && vars.resolveConfig(connect.spec),
      url: vars.resolveConfig(url),
    });
    const contract = buildContract(doc ?? { openapi: '3.1.0', paths: {} }, connect);
    const policy = requestPolicy(contract, { ...connect, url: vars.resolveConfig(url) });
    const plan = planSweep(sweepCases(contract, { credentials: ['self'] }), policy, await workspace.readCoverage());
    printPlan(plan, budget.maxRequests, flags.json, log);
    return ExitCode.Clean;
  }

  const vars = new Vars(config.app.secrets);
  let app: Awaited<ReturnType<typeof startApp>> | undefined;
  let driver: ReturnType<typeof createDriver> | undefined;
  let session: AgentSession | undefined;
  const onSignal = () => {
    if (session) session.cancelled = true;
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    app = await startApp(config.app, { root, vars, emit: log });
    driver = createDriver(
      config,
      vars.resolve.bind(vars),
      (value) => vars.redact(value) as string,
      resolve(root, config.app.source),
      app.contract,
    );
    if (!(driver instanceof ApiDriver)) throw new ConfigError('bugpatrol sweep needs the api driver');
    await driver.connect();
    const record = await workspace.startSession('explorer');
    session = new AgentSession(root, config, vars, record.id, 'explorer', driver);
    const cases = sweepCases(driver.policy.contract, { credentials: ['self'] });
    const result = await runSweep(session, cases, budget);
    const blocking = result.findings.filter((finding) => finding.repeats && !finding.dismissed).length;
    await workspace.endSession(record.id, {
      summary: `Sweep: ${result.requests} request(s), ${result.findings.length} finding(s), ${blocking} that repeat`,
    });
    await session.idle();
    if (flags.json) log(JSON.stringify(result, null, 2));
    else printResult(result, await workspace.readCoverage(), record.id, log);
    return blocking ? ExitCode.Regression : ExitCode.Clean;
  } finally {
    try {
      try {
        await driver?.close();
      } finally {
        await app?.stop();
      }
    } finally {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
    }
  }
}

function printPlan(plan: SweepPlan, maxRequests: number, json: boolean, log: (line: string) => void): void {
  let thisRun = 0;
  for (let sent = 0; thisRun < plan.order.length; thisRun++) {
    sent += plan.order[thisRun]!.steps.length;
    if (sent > maxRequests) break;
  }
  const planned = plan.order.map((item) => ({
    case: `${item.endpoint.key} ${item.case}`,
    requests: item.steps.map((step) =>
      step.kind === 'request' ? `${step.as ? `as ${step.as} ` : ''}${step.method} ${step.url}` : step.kind,
    ),
  }));
  const blocked = plan.blocked.map((item) => ({ case: `${item.endpoint.key} ${item.case}`, reason: item.blocked }));
  const totals = {
    cases: plan.order.length,
    requests: plan.order.reduce((sum, item) => sum + item.steps.length, 0),
    thisRun,
    skipped: plan.skipped.length,
    blocked: blocked.length,
  };
  if (json) {
    log(JSON.stringify({ planned, skipped: plan.skipped, blocked, totals }, null, 2));
    return;
  }
  for (const item of planned) log(`${item.case}\n  ${item.requests.join('\n  ')}`);
  for (const item of plan.skipped) log(`${item.key}  skipped: ${item.reason}`);
  for (const item of blocked) log(`${item.case}  blocked: ${item.reason}`);
  log(
    `\n${totals.cases} case(s) with ${totals.requests} request(s) planned; the next run takes ${thisRun} case(s). ` +
      `${totals.skipped} skipped by the request policy, ${totals.blocked} blocked. Nothing was sent.`,
  );
}

/** The columns of the table, after the `declared:<code>` ones of `ok`. */
const CASES = ['ok', 'declared', 'no-auth', 'invalid-input', 'missing-id', 'other-user', 'repeat-delete'];

/** The endpoint × case table of the whole coverage: the status, `!` for a failure, `-` for a blocked case. */
function printResult(
  result: SweepResult,
  coverage: CoverageFile | undefined,
  sessionId: string,
  log: (line: string) => void,
): void {
  const cells = Object.values(coverage?.cells ?? {});
  const order = (id: string) => `${CASES.indexOf(id.startsWith('declared:') ? 'declared' : id)}${id}`;
  const cases = [...new Set(cells.map((cell) => cell.case))].sort((a, b) => order(a).localeCompare(order(b)));
  const endpoints = [...new Set(cells.map((cell) => cell.endpoint))];
  const width = Math.max(8, ...endpoints.map((endpoint) => endpoint.length));
  log([''.padEnd(width), ...cases.map((id) => id.padEnd(14))].join('  '));
  for (const endpoint of endpoints) {
    const row = cases.map((id) => {
      const cell = cells.find((item) => item.endpoint === endpoint && item.case === id);
      const text = !cell ? '' : cell.blocked ? '-' : `${cell.status ?? '?'}${cell.ok ? '' : '!'}`;
      return text.padEnd(14);
    });
    log([endpoint.padEnd(width), ...row].join('  '));
  }
  if (result.findings.length) log('\nFindings:');
  for (const finding of result.findings)
    log(
      `${finding.dismissed ? 'known ' : finding.repeats ? 'BLOCKS' : 'flaky '}  ${finding.summary}` +
        `${finding.dismissed ? ' (dismissed before)' : finding.repeats ? '' : ' (did not repeat)'}`,
    );
  for (const item of result.skipped) log(`skipped  ${item.key}: ${item.reason}`);
  log(
    `\n${result.requests} request(s), ${result.cells.length} cell(s) written, ${result.remaining} case(s) left for the next run` +
      `${result.stopped ? ` (stopped: ${result.stopped})` : ''}.`,
  );
  if (result.findings.length)
    log(`Next: run \`bugpatrol judge --session ${sessionId}\` to file the findings as issues.`);
}
