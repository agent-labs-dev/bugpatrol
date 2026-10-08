import { z } from 'zod';
import type { AgentRole } from '../types/agents.js';
import { CLI_AGENTS, cliPreset } from './agents.js';

const secretRefString = z.string().describe('A ${ENV_VAR} reference. Never a literal credential (spec 11.4).');

export const viewportSchema = z.object({
  name: z.string(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  deviceScaleFactor: z.number().positive().default(1),
});

export const actionSchema: z.ZodType<Record<string, unknown>> = z.record(z.unknown());

export const runSchema = z.object({
  command: z.string(),
  url: z.string().url(),
  ready: z
    .object({
      selectors: z.array(z.string()).default([]),
      forbidConsoleErrors: z.boolean().default(true),
      timeoutMs: z.number().int().positive().default(60_000),
    })
    .default({}),
  seeds: z.array(z.string()).default([]),
});

export const authSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }),
  z.object({
    kind: z.literal('form'),
    loginUrl: z.string(),
    credentials: secretRefString.optional(),
    steps: z.array(actionSchema).default([]),
  }),
  z.object({ kind: z.literal('storageState'), path: z.string(), expiresAt: z.string().optional() }),
  z.object({
    kind: z.literal('seededUser'),
    seedCommand: z.string(),
    credentials: secretRefString.optional(),
  }),
  z.object({
    kind: z.literal('ssoBypass'),
    header: z.string().optional(),
    token: secretRefString.optional(),
  }),
  z.object({ kind: z.literal('manual'), path: z.string() }),
]);

export const maskSchema = z.object({
  selector: z.string(),
  screen: z.string().optional(),
  reason: z.string().optional(),
});

/**
 * Tolerance defaults to exact. Every existing tool in this category exposes a
 * global threshold knob and every one of them has a user who turned it up until
 * the build went green and it stopped catching anything (spec 7.6).
 */
export const toleranceSchema = z
  .object({
    default: z.literal('exact').default('exact'),
    regions: z
      .array(
        z.object({
          screen: z.string(),
          selector: z.string(),
          mode: z.enum(['exact', 'perceptual']).default('perceptual'),
          threshold: z.number().min(0).max(1).default(0.02),
          reason: z.string().optional(),
        }),
      )
      .default([]),
  })
  .default({});

export const decisionsSchema = z
  .object({
    model: z
      .object({
        via: z.enum(['auto', 'openrouter', 'vercel', 'openai', 'anthropic', 'custom']).default('auto'),
        name: z.string().default(''),
      })
      .default({}),
    confidence: z
      .object({ high: z.number().min(0).max(1).default(0.85), low: z.number().min(0).max(1).default(0.55) })
      .default({}),
    budget: z
      .object({
        perRunUsd: z.number().nonnegative().default(0.5),
        visionSampleRate: z.number().min(0).max(1).default(0.05),
        allowFrontier: z.boolean().default(true),
      })
      .default({}),
  })
  .default({});

export const crawlSchema = z
  .object({
    maxScreens: z.number().int().positive().default(500),
    maxDepth: z.number().int().positive().default(6),
    maxActionsPerScreen: z.number().int().positive().default(15),
    maxWallClockMs: z
      .number()
      .int()
      .positive()
      .default(60 * 60 * 1000),
    allowDestructive: z.boolean().default(false),
    /** Synthetic data only. */
    safeMode: z.boolean().default(true),
    /** The crawler may not leave the configured origin (spec 11.1). */
    confineToOrigin: z.boolean().default(true),
  })
  .default({});

export const surfacesSchema = z
  .object({
    checks: z.boolean().default(true),
    prComment: z.boolean().default(true),
    issues: z.boolean().default(true),
    questions: z.boolean().default(true),
    /** Opt-in. Requires contents:write on the GitHub App (spec 10.1). */
    fixPRs: z.boolean().default(false),
  })
  .default({});

export const productionSchema = z
  .object({
    detect: z.boolean().default(true),
    /** There is no flag that silently overrides this (spec 1.2). */
    allowMutations: z.boolean().default(false),
  })
  .default({});

export const determinismSchema = z
  .object({
    /** Pinned by digest. A digest change invalidates baselines (spec 7.1). */
    image: z.string().default(''),
    freezeClockAt: z.string().default('2026-01-01T00:00:00.000Z'),
    timezone: z.string().default('UTC'),
    locale: z.string().default('en-US'),
    randomSeed: z.number().int().default(1),
    /** Capture only once two consecutive frames are byte-identical (spec 7.3). */
    stabilityGate: z
      .object({
        consecutiveIdenticalFrames: z.number().int().min(2).default(2),
        intervalMs: z.number().int().positive().default(120),
        timeoutMs: z.number().int().positive().default(10_000),
      })
      .default({}),
    /** A glyph falling back to an unbundled family fails the run loudly. */
    failOnFontFallback: z.boolean().default(true),
    blockThirdPartyRequests: z.boolean().default(true),
  })
  .default({});

/**
 * One setup or teardown command (ADR 0005). `capture` pulls values out of the
 * command's output by regex, first group; later commands, `connect`, and the
 * explorer's `{{NAME}}` placeholders can use them. Captured values are treated
 * as secrets: they are redacted from every log and never sent to a model.
 */
export const appCommandSchema = z.object({
  run: z.string(),
  cwd: z.string().optional(),
  capture: z.record(z.string()).default({}),
  /** Keep the process alive for the session instead of waiting for it to exit. */
  background: z.boolean().default(false),
  /** Background only: wait until this regex matches the output. */
  readyWhen: z.string().optional(),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .default(10 * 60 * 1000),
});

export const appSchema = z
  .object({
    platform: z.enum(['web', 'electron', 'ios', 'android', 'api', 'desktop', 'cli']).default('web'),
    /** The source repository the fixer edits. Relative to the config file. */
    source: z.string().default('.'),
    setup: z.array(appCommandSchema).default([]),
    teardown: z.array(appCommandSchema).default([]),
    connect: z
      .object({
        /** Web: defaults to run.url. May use ${NAME} from env or captures. */
        url: z.string().optional(),
        /** API: default request headers; credentials should be placeholders. */
        headers: z.record(z.string()).default({}),
        /** API: writes require explicit opt-in in repository configuration. */
        methods: z
          .array(z.enum(['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE']))
          .default(['GET', 'HEAD', 'OPTIONS']),
        timeoutMs: z.number().int().positive().max(120000).default(30000),
        /** Linux desktop: a private Xvfb/DBus session; never the host display. */
        cua: z
          .object({
            command: z.string().default('cua-driver'),
            windowManager: z.string().default('openbox'),
            launch: z.string().min(1),
            deliveryMode: z.enum(['background', 'foreground']).default('background'),
            args: z.array(z.string()).default([]),
            windowTitle: z.string().optional(),
            viewer: z
              .object({
                enabled: z.boolean().default(true),
                port: z.number().int().min(0).max(65535).default(0),
                allowTakeover: z.boolean().default(false),
              })
              .default({}),
          })
          .optional(),
        /** Electron: the CDP endpoint, e.g. http://127.0.0.1:${CDP_PORT}. */
        cdp: z.string().optional(),
        /** CLI: each command runs in a terminal of 80 by 24 from the app source, and is stopped after this long. */
        cli: z
          .object({
            timeoutMs: z.number().int().positive().max(600_000).default(60_000),
          })
          .default({}),
        /** Mobile: the bundle id or package name. */
        appId: z.string().optional(),
        /** Mobile: the simulator UDID or emulator serial. Default: the booted one. */
        device: z.string().optional(),
      })
      .default({}),
    /** Plain-English guide for the explorer: login, onboarding, never-do list. */
    instructions: z.string().optional(),
    /** Names of env vars the explorer may use as {{NAME}} placeholders. */
    secrets: z.array(z.string()).default([]),
  })
  .default({});

/**
 * One place Bugpatrol reads backend logs from. Kept generic on purpose: any
 * backend that can write a file, stream lines, or POST an event is covered,
 * with no assumption about the language or the log library.
 */
export const logSourceSchema = z.discriminatedUnion('kind', [
  z.object({
    name: z.string(),
    kind: z.literal('file'),
    /** The log file, relative to the project root. */
    path: z.string(),
    /** Keep only lines matching this pattern. */
    match: z.string().optional(),
    /** How much of the file's tail to read. Older lines are dropped. Default: 1 MiB. */
    maxBytes: z
      .number()
      .int()
      .positive()
      .default(1024 * 1024),
  }),
  z.object({
    name: z.string(),
    kind: z.literal('stream'),
    /** A shell command whose stdout is the log stream. */
    command: z.string(),
    /** Keep only lines matching this pattern. */
    match: z.string().optional(),
  }),
  z.object({
    name: z.string(),
    kind: z.literal('webhook'),
    /** The loopback port to listen on. 0 picks a free one. Default: 0. */
    port: z.number().int().min(0).max(65535).default(0),
    /** The path the backend POSTs newline-delimited lines to. Default: /logs. */
    path: z.string().default('/logs'),
    /** Keep only lines matching this pattern. */
    match: z.string().optional(),
  }),
]);

const modelRuntimeSchema = z.object({
  runtime: z.literal('model'),
  via: z.enum(['openrouter', 'vercel', 'openai', 'anthropic', 'custom']).default('openrouter'),
  model: z.string().default('z-ai/glm-5.3-flash'),
  /** Custom route only: an OpenAI-compatible chat-completions URL. */
  endpoint: z.string().optional(),
});

const cliRuntimeSchema = z.object({
  runtime: z.literal('cli'),
  /** A local agent CLI. Bugpatrol fills in the command for the role. */
  agent: z.enum(CLI_AGENTS).optional(),
  /**
   * A shell command. Placeholders: {prompt} (a file holding the prompt),
   * {mcp} (an MCP config file for the Bugpatrol tools), {mcpUrl}, {workdir}.
   * The prompt also goes to stdin. Wins over `agent`.
   */
  command: z.string().optional(),
});

/**
 * One role's runtime. `use: claude` is short for `{ runtime: cli, agent: claude }`,
 * and a preset becomes the role's command here, so the roles only ever see a
 * model route or a command.
 */
function runtimeFor(role: AgentRole, fallback: z.input<typeof modelRuntimeSchema> | z.input<typeof cliRuntimeSchema>) {
  return z
    .preprocess(
      (value) => (typeof value === 'string' ? { runtime: 'cli', agent: value } : value),
      z.discriminatedUnion('runtime', [modelRuntimeSchema, cliRuntimeSchema]),
    )
    .default(fallback)
    .superRefine((use, ctx) => {
      if (use.runtime === 'cli' && !use.command && !use.agent) {
        ctx.addIssue({ code: 'custom', message: `Set \`agent\` (${CLI_AGENTS.join(', ')}) or \`command\`.` });
      }
    })
    .transform((use) =>
      use.runtime === 'model'
        ? use
        : {
            runtime: 'cli' as const,
            ...(use.agent ? { agent: use.agent } : {}),
            command: use.command ?? cliPreset(use.agent!, role),
          },
    );
}

const roleBase = {
  enabled: z.boolean().default(true),
  maxSteps: z.number().int().positive().default(60),
  /** A cost limit for one session, in USD. No default: the team decides. */
  budgetUsd: z.number().nonnegative().optional(),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .default(20 * 60 * 1000),
};

/**
 * The automatic checks that the agents can run on each recorded screen. They
 * are off by default: the explorer finds most real bugs, and each check
 * finding costs a judge step with screenshots.
 */
export const AGENT_CHECKS = [
  'usability/contrast',
  'usability/tap-target',
  'layout/overlap',
  'layout/overflow',
  'layout/occlusion',
  'layout/zero-size-interactive',
  'layout/off-viewport',
  'layout/horizontal-scroll',
  'layout/shift-versus-baseline',
  'rendering/broken-imagery',
  'rendering/unstyled-content',
  'pixel-diff',
] as const;
export type AgentCheck = (typeof AGENT_CHECKS)[number];

export const agentsSchema = z
  .object({
    /** Automatic checks on each recorded screen, for example [usability/contrast, usability/tap-target]. */
    checks: z.array(z.enum(AGENT_CHECKS)).default([]),
    memory: z
      .object({
        enabled: z.boolean().default(true),
        maxPerSession: z.number().int().positive().default(5),
        reflectMaxSteps: z.number().int().positive().default(10),
        reflectBudgetUsd: z.number().nonnegative().optional(),
      })
      .default({}),
    explorer: z
      .object({
        ...roleBase,
        use: runtimeFor('explorer', { runtime: 'model' }),
        /** Full coverage needs many actions: one step is one tool call. */
        maxSteps: z.number().int().positive().default(150),
      })
      .default({}),
    judge: z
      .object({
        ...roleBase,
        use: runtimeFor('judge', { runtime: 'model' }),
      })
      .default({}),
    fixer: z
      .object({
        ...roleBase,
        use: runtimeFor('fixer', { runtime: 'cli', agent: 'claude' }),
        /** Off until a team opts in: a fixer writes code. */
        enabled: z.boolean().default(false),
        /** Run after the change; a non-zero exit marks the fix failed. */
        verify: z.string().optional(),
        /**
         * Fix attempts on one issue before the fixer gives up on it: first
         * fixes, reruns after a failure, and refixes. CI fixes have their own
         * limit. `bugpatrol fix --issue` still runs an issue at the limit.
         */
        attempts: z.number().int().positive().default(3),
        /** After a fix, start the app from the fix worktree and repeat the issue's flow. */
        retest: z
          .object({
            enabled: z.boolean().default(true),
            /** Shell command run in the worktree before the app starts, e.g. `bun install`. */
            prepare: z.string().optional(),
            /** Retest verdicts in total; a not-fixed verdict gets a refix with the verdict as feedback. */
            attempts: z.number().int().positive().default(2),
            maxSteps: z.number().int().positive().default(30),
            budgetUsd: z.number().nonnegative().optional(),
          })
          .default({}),
        minSeverity: z.enum(['cosmetic', 'minor', 'major', 'critical']).default('minor'),
        /**
         * The local commit on the fix branch. {title} is the issue title. Set a
         * scope when the repo's commit hook requires one, e.g. 'fix(app): {title}'.
         */
        commitMessage: z.string().default('fix: {title}'),
        /** At most this many fixes per patrol cycle, worst issues first. */
        maxPerCycle: z.number().int().positive().default(2),
      })
      .default({}),
    github: z
      .object({
        enabled: z.boolean().default(false),
        repo: z.string().optional(),
        pullRequests: z.enum(['draft', 'ready']).default('draft'),
        issueMinSeverity: z.enum(['cosmetic', 'minor', 'major', 'critical']).default('major'),
        assetsBranch: z.string().default('bugpatrol-assets'),
        labels: z.array(z.string()).default(['bugpatrol']),
        /** The scope in PR titles, e.g. 'app'. Default: the scope in fixer.commitMessage. */
        prScope: z.string().optional(),
        /** After a PR opens, wait for its CI checks, and let the fixer fix a failed check. */
        ci: z
          .object({
            enabled: z.boolean().default(true),
            /** Fixer attempts for each PR before Bugpatrol gives up and tells the team. */
            attempts: z.number().int().nonnegative().default(2),
            /** How long one cycle waits for pending checks. */
            waitMinutes: z.number().nonnegative().default(20),
          })
          .default({}),
      })
      .default({}),
    /** `bugpatrol review <pr>`. */
    review: z
      .object({
        /** The claim check: test what the pull request says it does. Off until a team opts in. */
        claims: z.boolean().default(false),
        /**
         * The benchmarks that can measure a speed claim. The judge picks from
         * these only. Each command runs in the worktree of a build, and starts
         * what it measures itself.
         */
        benches: z
          .array(
            z.object({
              name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'Use lowercase letters, digits and dashes'),
              command: z.string().min(1),
              /** What the number means, with its unit: 'p99 latency in ms'. */
              metric: z.string().min(1),
              /** A regular expression whose first group is the number in the output of the command. */
              parse: z.string().refine((value) => {
                try {
                  new RegExp(value);
                  return true;
                } catch {
                  return false;
                }
              }, 'Use a valid regular expression'),
              better: z.enum(['lower', 'higher']).default('lower'),
              /** Runs on each build, alternating between the builds. */
              runs: z.number().int().positive().default(5),
              timeoutMs: z
                .number()
                .int()
                .positive()
                .default(10 * 60 * 1000),
            }),
          )
          .default([])
          .refine(
            (benches) => new Set(benches.map((bench) => bench.name)).size === benches.length,
            'Give each benchmark its own name',
          ),
        /**
         * Set a check run on the pull request that fails on a deterministic
         * disproof: a replay or an assertion that a second replay repeats.
         * Off until a team trusts the comments (ADR 0007).
         */
        block: z.boolean().default(false),
        /** Limits for the claim check of one review, across its sessions. */
        maxSteps: z.number().int().positive().default(150),
        budgetUsd: z.number().nonnegative().optional(),
        timeoutMs: z
          .number()
          .int()
          .positive()
          .default(20 * 60 * 1000),
      })
      .default({}),
    patrol: z
      .object({
        intervalMinutes: z.number().positive().default(30),
        /** Stop after this many cycles; 0 means run until stopped. */
        cycles: z.number().int().nonnegative().default(0),
        /**
         * At the start of each cycle, fetch this `remote/branch` and check out its
         * latest commit (detached) in the source repository. false keeps the checkout.
         */
        pull: z
          .union([z.string().regex(/^[^/]+\/.+$/, 'Use remote/branch, e.g. origin/main'), z.literal(false)])
          .default('origin/main'),
      })
      .default({}),
  })
  .default({});

export const bugpatrolConfigSchema = z
  .object({
    version: z.literal(1),
    /** Web only: how to start and reach the app. Other platforms use `app`. */
    run: runSchema.optional(),
    app: appSchema,
    agents: agentsSchema,
    auth: authSchema.default({ kind: 'none' }),
    viewports: z
      .array(viewportSchema)
      .min(1)
      .default([
        { name: 'desktop', width: 1440, height: 900, deviceScaleFactor: 1 },
        { name: 'mobile', width: 390, height: 844, deviceScaleFactor: 1 },
      ]),
    scope: z
      .object({
        include: z.array(z.string()).default(['src/**', 'app/**']),
        ignore: z.array(z.string()).default(['**/*.stories.tsx', '**/*.test.ts', '**/generated/**']),
      })
      .default({}),
    crawl: crawlSchema,
    mask: z.array(maskSchema).default([]),
    tolerance: toleranceSchema,
    decisions: decisionsSchema,
    determinism: determinismSchema,
    surfaces: surfacesSchema,
    production: productionSchema,
    logs: z.array(logSourceSchema).default([]),
  })
  .superRefine((config, ctx) => {
    if ((config.app.platform === 'web' || config.app.platform === 'api') && !config.run && !config.app.connect.url) {
      ctx.addIssue({
        code: 'custom',
        path: ['run'],
        message: 'A web or API app needs `run` (command and url) or `app.connect.url`.',
      });
    }
  });

export type BugpatrolConfig = z.infer<typeof bugpatrolConfigSchema>;
export type AppConfig = z.infer<typeof appSchema>;
export type AppCommand = z.infer<typeof appCommandSchema>;
export type AgentsConfig = z.infer<typeof agentsSchema>;
export type RoleRuntime = z.infer<ReturnType<typeof runtimeFor>>;
export type ViewportConfig = z.infer<typeof viewportSchema>;
export type MaskConfig = z.infer<typeof maskSchema>;
export type ToleranceConfig = z.infer<typeof toleranceSchema>;
export type DecisionsConfig = z.infer<typeof decisionsSchema>;
export type DeterminismConfig = z.infer<typeof determinismSchema>;
