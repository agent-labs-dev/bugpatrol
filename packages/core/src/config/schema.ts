import { z } from 'zod';
import type { AgentRole } from '../types/agents.js';
import { HTTP_METHODS } from '../types/endpoint.js';
import { CLI_AGENTS, cliPreset } from './agents.js';

function validRegex(value: string): boolean {
  try {
    new RegExp(value);
    return true;
  } catch {
    return false;
  }
}

export const viewportSchema = z.strictObject({
  name: z.string(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  deviceScaleFactor: z.number().positive().default(1),
});

export const actionSchema: z.ZodType<Record<string, unknown>> = z.record(z.string(), z.unknown());

export const runSchema = z.strictObject({
  command: z.string(),
  url: z.string().url(),
  ready: z
    .strictObject({
      selectors: z.array(z.string()).default([]),
      forbidConsoleErrors: z.boolean().default(true),
      timeoutMs: z.number().int().positive().default(60_000),
    })
    .prefault({}),
  seeds: z.array(z.string()).default([]),
});

export const maskSchema = z.strictObject({
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
  .strictObject({
    default: z.literal('exact').default('exact'),
    regions: z
      .array(
        z.strictObject({
          screen: z.string(),
          selector: z.string(),
          mode: z.enum(['exact', 'perceptual']).default('perceptual'),
          threshold: z.number().min(0).max(1).default(0.02),
          reason: z.string().optional(),
        }),
      )
      .default([]),
  })
  .prefault({});

/** The settings of the Jev decider, which Bugpatrol no longer has. They are ignored, not rejected. */
function withoutJev(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const { decider: _decider, jev: _jev, ...rest } = value as Record<string, unknown>;
  return rest;
}

export const decisionsSchema = z
  .preprocess(
    withoutJev,
    z.strictObject({
      model: z
        .strictObject({
          via: z.enum(['auto', 'openrouter', 'vercel', 'openai', 'anthropic', 'custom']).default('auto'),
          name: z.string().default(''),
        })
        .prefault({}),
      confidence: z
        .strictObject({ high: z.number().min(0).max(1).default(0.85), low: z.number().min(0).max(1).default(0.55) })
        .prefault({}),
      budget: z
        .strictObject({
          perRunUsd: z.number().nonnegative().default(0.5),
          visionSampleRate: z.number().min(0).max(1).default(0.05),
          allowFrontier: z.boolean().default(true),
        })
        .prefault({}),
    }),
  )
  .prefault({});

export const crawlSchema = z
  .strictObject({
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
  .prefault({});

export const surfacesSchema = z
  .strictObject({
    checks: z.boolean().default(true),
    prComment: z.boolean().default(true),
    issues: z.boolean().default(true),
    questions: z.boolean().default(true),
    /** Opt-in. Requires contents:write on the GitHub App (spec 10.1). */
    fixPRs: z.boolean().default(false),
  })
  .prefault({});

export const productionSchema = z
  .strictObject({
    detect: z.boolean().default(true),
    /** There is no flag that silently overrides this (spec 1.2). */
    allowMutations: z.boolean().default(false),
  })
  .prefault({});

export const determinismSchema = z
  .strictObject({
    /** Pinned by digest. A digest change invalidates baselines (spec 7.1). */
    image: z.string().default(''),
    freezeClockAt: z.string().default('2026-01-01T00:00:00.000Z'),
    timezone: z.string().default('UTC'),
    locale: z.string().default('en-US'),
    randomSeed: z.number().int().default(1),
    /** Capture only once two consecutive frames are byte-identical (spec 7.3). */
    stabilityGate: z
      .strictObject({
        consecutiveIdenticalFrames: z.number().int().min(2).default(2),
        intervalMs: z.number().int().positive().default(120),
        timeoutMs: z.number().int().positive().default(10_000),
      })
      .prefault({}),
    /** A glyph falling back to an unbundled family fails the run loudly. */
    failOnFontFallback: z.boolean().default(true),
    blockThirdPartyRequests: z.boolean().default(true),
  })
  .prefault({});

/**
 * One setup or teardown command (ADR 0005). `capture` pulls values out of the
 * command's output by regex, first group; later commands, `connect`, and the
 * explorer's `{{NAME}}` placeholders can use them. Captured values are treated
 * as secrets: they are redacted from every log and never sent to a model,
 * unless `public` names them.
 */
export const appCommandSchema = z
  .strictObject({
    run: z.string(),
    cwd: z.string().optional(),
    capture: z.record(z.string(), z.string()).prefault({}),
    /**
     * Captures that are not secrets, such as a port or a terminal size. They
     * are used like any capture, and redaction leaves them alone, so a short
     * number never turns into `{{NAME}}` across the app's output.
     */
    public: z.array(z.string()).default([]),
    /** Keep the process alive for the session instead of waiting for it to exit. */
    background: z.boolean().default(false),
    /** Background only: wait until this regex matches the output. */
    readyWhen: z.string().optional(),
    timeoutMs: z
      .number()
      .int()
      .positive()
      .default(10 * 60 * 1000),
  })
  .superRefine((command, ctx) => {
    for (const name of command.public)
      if (!(name in command.capture))
        ctx.addIssue({ code: 'custom', path: ['public'], message: `${name} is not a capture of this command` });
  });

export const appSchema = z
  .strictObject({
    platform: z.enum(['web', 'electron', 'ios', 'android', 'api', 'desktop', 'cli']).default('web'),
    /** The source repository the fixer edits. Relative to the config file. */
    source: z.string().default('.'),
    setup: z.array(appCommandSchema).default([]),
    teardown: z.array(appCommandSchema).default([]),
    connect: z
      .strictObject({
        /**
         * Web, API: defaults to run.url. `${NAME}` or `{{NAME}}` takes a setup
         * capture or a name in `secrets` (read from the environment). Any
         * other name is an error.
         */
        url: z.string().optional(),
        /**
         * API: default request headers; credentials should be placeholders,
         * with the same names as `url`.
         * They go into each credential set. Without `credentials`, they are
         * the only set.
         */
        headers: z.record(z.string(), z.string()).prefault({}),
        /**
         * API: two users (3b). Each set keeps its token and its workspace
         * header together. Without `other`, the cross-user cases are blocked.
         */
        credentials: z
          .strictObject({
            self: z.strictObject({ headers: z.record(z.string(), z.string()) }),
            other: z.strictObject({ headers: z.record(z.string(), z.string()) }).optional(),
          })
          .optional(),
        /**
         * API: the methods Bugpatrol may send. The request policy narrows them
         * further: a target that is not loopback or `disposable` gets no writes.
         */
        methods: z.array(z.enum(HTTP_METHODS)).default([...HTTP_METHODS]),
        /**
         * API: the target holds data that may be lost, so writes are on also
         * when it is not loopback.
         */
        disposable: z.boolean().default(false),
        /**
         * API: endpoints Bugpatrol never requests. Each glob matches a path
         * template of the spec, with an optional leading method: `*` is one
         * segment, `**` is any number of segments. Example: `POST /admin/**`.
         */
        deny: z.array(z.string().min(1)).default([]),
        /** API: the most requests in one minute. A 429 or a Retry-After also slows them. */
        perMinute: z.number().int().positive().default(60),
        timeoutMs: z.number().int().positive().max(120000).default(30000),
        /**
         * API: the OpenAPI spec. An http(s) URL, a path on connect.url such as
         * /openapi.json, a file relative to the project root, or an absolute
         * file as a file: URL. Bugpatrol never uses its `servers` value.
         */
        spec: z.string().optional(),
        /** API: the error statuses every endpoint may return, and the JSON Schema of their body. */
        errors: z
          .strictObject({
            statuses: z.array(z.number().int().min(400).max(599)).default([]),
            schema: z.record(z.string(), z.unknown()).optional(),
          })
          .optional(),
        /**
         * API: where the deployed commit is. `path` is a path on connect.url,
         * and `pointer` is a JSON pointer into its response, for example
         * `/result/commit`. For a fleet, a `*` segment takes each element of
         * an array (`/result`, then `*`, then `commit`). Every process must
         * report the same commit.
         */
        version: z
          .strictObject({
            path: z.string().startsWith('/'),
            pointer: z.string().startsWith('/'),
          })
          .optional(),
        /** API: the preview deploy of a pull request, with {{PR_NUMBER}}. Reserved; nothing reads it yet. */
        preview: z.string().optional(),
        /** Linux desktop: a private Xvfb/DBus session; never the host display. */
        cua: z
          .strictObject({
            command: z.string().default('cua-driver'),
            windowManager: z.string().default('openbox'),
            launch: z.string().min(1),
            deliveryMode: z.enum(['background', 'foreground']).default('background'),
            args: z.array(z.string()).default([]),
            windowTitle: z.string().optional(),
            viewer: z
              .strictObject({
                enabled: z.boolean().default(true),
                port: z.number().int().min(0).max(65535).default(0),
                allowTakeover: z.boolean().default(false),
              })
              .prefault({}),
          })
          .optional(),
        /**
         * Web and Electron: origins besides the app's that the explorer may
         * be on, e.g. https://accounts.example.com. A redirect, a tap or an
         * `open` that lands on any other website goes back to the app.
         */
        allowedOrigins: z.array(z.string()).default([]),
        /** Electron: the CDP endpoint, e.g. http://127.0.0.1:${CDP_PORT}. */
        cdp: z.string().optional(),
        /** Electron: launch the app in a private Xvfb display instead of connecting to an existing CDP endpoint. */
        launch: z
          .strictObject({
            /** The Electron executable or wrapper command. */
            command: z.string().min(1),
            /** Arguments passed to the app after Bugpatrol's private-profile and CDP arguments. */
            args: z.array(z.string()).default([]),
            /** An existing profile to copy into the private launch profile. */
            userDataDir: z.string().optional(),
            /** The CDP port, or `auto` to choose a free port. */
            cdp: z.union([z.literal('auto'), z.number().int().positive().max(65535)]).default('auto'),
            /** The private display size in pixels. */
            width: z.number().int().positive().default(1280),
            height: z.number().int().positive().default(800),
          })
          .optional(),
        /**
         * CLI: each command runs in a terminal of `cols` by `rows` from the
         * app source, and is stopped after `timeoutMs`; a session waits at
         * most that long. `env` is set for the app's processes only, never
         * for Bugpatrol or the agent CLIs. `command`, when set, is a
         * program that stays open, such as a full screen terminal UI, which
         * the driver starts on connect, so the explorer begins in it.
         */
        cli: z
          .strictObject({
            command: z.string().min(1).optional(),
            timeoutMs: z.number().int().positive().max(600_000).default(60_000),
            cols: z.number().int().min(20).max(500).default(80),
            rows: z.number().int().min(5).max(200).default(24),
            env: z.record(z.string(), z.string()).prefault({}),
          })
          .prefault({}),
        /** Mobile: the bundle id or package name. */
        appId: z.string().optional(),
        /** Mobile: the simulator UDID or emulator serial. Default: the booted one. */
        device: z.string().optional(),
      })
      .prefault({}),
    /**
     * Only GET, HEAD and OPTIONS reach the app's backend. `true` is short for
     * `{}`. Web and Electron: Bugpatrol aborts every other request of the
     * browser. API: the request policy sends reads only. Any platform: each
     * entry of `proxy` is a loopback proxy to that backend, as `{{NAME}}`, for
     * an app that talks to its backend itself; a CLI, desktop or mobile app
     * needs one. Every blocked write is logged and counted.
     */
    readOnly: z.preprocess(
      (value) => (value === true ? {} : value === false ? undefined : value),
      z
        .strictObject({
          /** NAME: the backend's base URL. `${NAME}` takes a secret or a variable of Bugpatrol's environment. */
          proxy: z
            .record(z.string().regex(/^[A-Z][A-Z0-9_]*$/, 'Use an UPPER_CASE name'), z.string().min(1))
            .prefault({}),
          /** `block` refuses every WebSocket. `pass` lets them through, less the client frames in `dropFrames`. */
          websockets: z.enum(['block', 'pass']).default('block'),
          /** Regular expressions: a text or binary frame from the app that matches one is dropped. */
          dropFrames: z.array(z.string().refine(validRegex, 'Use a valid regular expression')).default([]),
        })
        .optional(),
    ),
    /** Plain-English guide for the explorer: login, onboarding, never-do list. */
    instructions: z.string().optional(),
    /** Names of env vars the explorer may use as {{NAME}} placeholders. */
    secrets: z.array(z.string()).default([]),
  })
  .prefault({});

/**
 * One place Bugpatrol reads backend logs from. Kept generic on purpose: any
 * backend that can write a file, stream lines, or POST an event is covered,
 * with no assumption about the language or the log library.
 */
export const logSourceSchema = z.discriminatedUnion('kind', [
  z.strictObject({
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
  z.strictObject({
    name: z.string(),
    kind: z.literal('stream'),
    /** A shell command whose stdout is the log stream. */
    command: z.string(),
    /** Keep only lines matching this pattern. */
    match: z.string().optional(),
  }),
  z.strictObject({
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

const modelRuntimeSchema = z.strictObject({
  runtime: z.literal('model'),
  via: z.enum(['openrouter', 'vercel', 'openai', 'anthropic', 'custom']).default('openrouter'),
  model: z.string().default('z-ai/glm-5.3-flash'),
  /** Custom route only: an OpenAI-compatible chat-completions URL. */
  endpoint: z.string().optional(),
});

const cliRuntimeSchema = z.strictObject({
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
    .prefault(fallback)
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
  .strictObject({
    /** Automatic checks on each recorded screen, for example [usability/contrast, usability/tap-target]. */
    checks: z.array(z.enum(AGENT_CHECKS)).default([]),
    memory: z
      .strictObject({
        enabled: z.boolean().default(true),
        maxPerSession: z.number().int().positive().default(5),
        reflectMaxSteps: z.number().int().positive().default(10),
        reflectBudgetUsd: z.number().nonnegative().optional(),
      })
      .prefault({}),
    explorer: z
      .strictObject({
        ...roleBase,
        use: runtimeFor('explorer', { runtime: 'model' }),
        /** Full coverage needs many actions: one step is one tool call. */
        maxSteps: z.number().int().positive().default(150),
      })
      .prefault({}),
    judge: z
      .strictObject({
        ...roleBase,
        use: runtimeFor('judge', { runtime: 'model' }),
      })
      .prefault({}),
    fixer: z
      .strictObject({
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
          .strictObject({
            enabled: z.boolean().default(true),
            /** Shell command run in the worktree before the app starts, e.g. `bun install`. */
            prepare: z.string().optional(),
            /** Retest verdicts in total; a not-fixed verdict gets a refix with the verdict as feedback. */
            attempts: z.number().int().positive().default(2),
            maxSteps: z.number().int().positive().default(30),
            budgetUsd: z.number().nonnegative().optional(),
          })
          .prefault({}),
        minSeverity: z.enum(['cosmetic', 'minor', 'major', 'critical']).default('minor'),
        /**
         * The local commit on the fix branch. {title} is the issue title. Set a
         * scope when the repo's commit hook requires one, e.g. 'fix(app): {title}'.
         */
        commitMessage: z.string().default('fix: {title}'),
        /** At most this many fixes per patrol cycle, worst issues first. */
        maxPerCycle: z.number().int().positive().default(2),
      })
      .prefault({}),
    github: z
      .strictObject({
        enabled: z.boolean().default(false),
        repo: z.string().optional(),
        pullRequests: z.enum(['draft', 'ready']).default('ready'),
        issueMinSeverity: z.enum(['cosmetic', 'minor', 'major', 'critical']).default('major'),
        assetsBranch: z.string().default('bugpatrol-assets'),
        labels: z.array(z.string()).default(['bugpatrol']),
        /** The scope in PR titles, e.g. 'app'. Default: the scope in fixer.commitMessage. */
        prScope: z.string().optional(),
        /** After a PR opens, wait for its CI checks, and let the fixer fix a failed check. */
        ci: z
          .strictObject({
            enabled: z.boolean().default(true),
            /** Fixer attempts for each PR before Bugpatrol gives up and tells the team. */
            attempts: z.number().int().nonnegative().default(2),
            /** How long one cycle waits for pending checks. */
            waitMinutes: z.number().nonnegative().default(20),
          })
          .prefault({}),
      })
      .prefault({}),
    /** `bugpatrol review <pr>`. */
    review: z
      .strictObject({
        /**
         * Tells this review apart from another Bugpatrol review of the same pull
         * request, for example one per app of a monorepo. Each name keeps its own
         * review and its own check run, and never replaces the other's.
         */
        name: z
          .string()
          .regex(/^[a-z0-9][a-z0-9-]*$/, 'Use lowercase letters, digits and dashes')
          .optional(),
        /** The claim check: test what the pull request says it does. Off until a team opts in. */
        claims: z.boolean().default(false),
        /**
         * The benchmarks that can measure a speed claim. The judge picks from
         * these only. Each command runs in the worktree of a build, and starts
         * what it measures itself.
         */
        benches: z
          .array(
            z.strictObject({
              name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'Use lowercase letters, digits and dashes'),
              command: z.string().min(1),
              /** What the number means, with its unit: 'p99 latency in ms'. */
              metric: z.string().min(1),
              /** A regular expression whose first group is the number in the output of the command. */
              parse: z.string().refine(validRegex, 'Use a valid regular expression'),
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
      .prefault({}),
    /**
     * `bugpatrol sweep`, and the sweep that an api patrol runs before the
     * explorer. A run stops at either limit, and the next run resumes there.
     */
    sweep: z
      .strictObject({
        /** The most requests in one run. A second replay of a failure can go over by one case. */
        maxRequests: z.number().int().positive().default(600),
        timeoutMs: z
          .number()
          .int()
          .positive()
          .default(30 * 60 * 1000),
      })
      .prefault({}),
    patrol: z
      .strictObject({
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
        /**
         * `branch` shares the JSON state (`STATE_FILES`) through the
         * `bugpatrol-state` branch of `origin`: it pulls before each cycle and
         * pushes after it, so CI and a dev machine see the same issues. `local`
         * keeps the state only in `.bugpatrol/runs/`.
         */
        state: z.enum(['local', 'branch']).default('local'),
      })
      .prefault({}),
  })
  .prefault({});

export const bugpatrolConfigSchema = z
  .strictObject({
    version: z.literal(1),
    /** Web only: how to start and reach the app. Other platforms use `app`. */
    run: runSchema.optional(),
    app: appSchema,
    agents: agentsSchema,
    /** Never read. Accept the `kind: none` older `init` wrote; reject a login flow instead of ignoring it. */
    auth: z
      .object({
        kind: z.literal('none', {
          error: () => ({
            message: 'Bugpatrol does not read `auth`. Sign in through `app.setup` and `app.instructions`.',
          }),
        }),
      })
      .optional(),
    viewports: z
      .array(viewportSchema)
      .min(1)
      .default([
        { name: 'desktop', width: 1440, height: 900, deviceScaleFactor: 1 },
        { name: 'mobile', width: 390, height: 844, deviceScaleFactor: 1 },
      ]),
    scope: z
      .strictObject({
        include: z.array(z.string()).default(['src/**', 'app/**']),
        ignore: z.array(z.string()).default(['**/*.stories.tsx', '**/*.test.ts', '**/generated/**']),
      })
      .prefault({}),
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
    const { readOnly, platform } = config.app;
    if (readOnly && !['web', 'electron', 'api'].includes(platform) && !Object.keys(readOnly.proxy).length) {
      ctx.addIssue({
        code: 'custom',
        path: ['app', 'readOnly', 'proxy'],
        message: `Bugpatrol cannot see the requests of a ${platform} app. Name its backend in app.readOnly.proxy, and point the app at the proxy's {{NAME}}.`,
      });
    }
    if (readOnly?.dropFrames.length && readOnly.websockets !== 'pass') {
      ctx.addIssue({
        code: 'custom',
        path: ['app', 'readOnly', 'dropFrames'],
        message: 'dropFrames applies to WebSockets that pass: set app.readOnly.websockets to pass.',
      });
    }
  });

export type BugpatrolConfig = z.infer<typeof bugpatrolConfigSchema> & {
  /** Not read from YAML: loadConfig sets it from the `--config` file name (profileOf). */
  profile?: string;
};
export type AppConfig = z.infer<typeof appSchema>;
export type AppCommand = z.infer<typeof appCommandSchema>;
export type AgentsConfig = z.infer<typeof agentsSchema>;
export type RoleRuntime = z.infer<ReturnType<typeof runtimeFor>>;
export type ViewportConfig = z.infer<typeof viewportSchema>;
export type MaskConfig = z.infer<typeof maskSchema>;
export type ToleranceConfig = z.infer<typeof toleranceSchema>;
export type DecisionsConfig = z.infer<typeof decisionsSchema>;
export type DeterminismConfig = z.infer<typeof determinismSchema>;
