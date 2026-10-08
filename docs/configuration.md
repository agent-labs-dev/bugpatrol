# Configuration

All settings live in `.bugpatrol/bugpatrol.yml`. Select another repository-owned profile with `bugpatrol explore --config .bugpatrol/api.yml`. Paths remain relative to the project root; choosing a profile never changes the artifact directory.

## The `.bugpatrol/` folder

Bugpatrol keeps all of its files in one folder at the root of your project:

| Path | What it is | Git |
| --- | --- | --- |
| `.bugpatrol/bugpatrol.yml` | The config | Commit it |
| `.bugpatrol/instructions.md` | The app guide for the explorer | Commit it |
| `.bugpatrol/appmap.json` | The screens that the explorer found | Commit it |
| `.bugpatrol/routines/` | The routines, and the repro routine of each issue. CI and a fresh clone replay them | Commit it |
| `.bugpatrol/runs/` | The local data: sessions, issues, fixes, worktrees, memory, and screenshots | `init` adds it to `.gitignore` |

The project root is the folder that holds `.bugpatrol/`. All paths in the config (`source`, `cwd`, `instructions`) are relative to the project root. You can run a command from any folder in the project: Bugpatrol finds `.bugpatrol/` in the current folder or in a folder above it.

Older versions kept `bugpatrol.yml` and `instructions.md` at the project root. If Bugpatrol finds a file there, it stops and shows the commands that move the files.

## The full file

```yaml
version: 1

app:
  platform: web                 # web | electron | ios | android | api | desktop
  source: .                     # the repo that the fixer edits, relative to the project root
  setup: []                     # commands: { run, cwd, capture, background, readyWhen, timeoutMs }
  teardown: []
  connect: { url: http://localhost:3000 }   # or cdp, or appId + device
  instructions: .bugpatrol/instructions.md
  secrets: [TEST_PASSWORD]      # environment variables the explorer may use as {{NAME}}

agents:
  explorer:
    maxSteps: 150               # one step is one tool call; full coverage needs many
    budgetUsd: 5                # optional: a cost limit for one session in USD; no limit by default
    use: claude                 # a local agent CLI: claude | codex | kimi | pi
  judge:
    use: { runtime: model, via: openrouter, model: z-ai/glm-5.3-flash }   # or an API key
  fixer:
    enabled: false              # off until you turn it on: the fixer writes code
    minSeverity: minor          # fix issues at this severity or worse
    maxPerCycle: 2              # at most this many new fixes in one cycle
    verify: pnpm test           # optional: a failed command marks the fix failed
    commitMessage: 'fix: {title}'
    retest:
      enabled: true
      prepare: pnpm install     # runs in the worktree before the app starts
      attempts: 2               # retest verdicts in total: not fixed gets a new fix, unclear a new retest
    use: claude
  github:
    enabled: false
    repo: owner/name            # optional: default is the repo of app.source
    pullRequests: draft         # draft | ready
    issueMinSeverity: major     # a bug with no fix becomes an issue at this severity or worse
    labels: [bugpatrol]
    assetsBranch: bugpatrol-assets # the orphan branch that holds report images
    prScope: app                # optional: the scope in PR titles
  review:
    claims: false               # the claim check of `bugpatrol review`: test what the pull request says it does
    maxSteps: 60                # the step limit of the claim check
    budgetUsd: 2                # optional: its cost limit in USD; no limit by default
    benches:                    # optional: benchmarks that can measure a speed claim
      - name: settings-load
        command: hyperfine --runs 10 'node scripts/load-settings.js' # runs in each build's worktree
        metric: mean time in ms
        parse: 'Time \(mean ± σ\):\s+([\d.]+) ms' # the first group is the number
        better: lower           # lower | higher
        runs: 5                 # runs on each build, alternating between the builds
  memory:
    enabled: true
  checks: []                    # optional automatic checks, for example [usability/contrast, usability/tap-target]
  patrol:
    intervalMinutes: 30         # wait between cycles; a cycle runs only on a new commit
    cycles: 0                   # 0 = run until stopped
    pull: origin/main           # remote/branch to pull before each cycle; false = no pull
```

## Setup and teardown commands

Each item in `app.setup` and `app.teardown` is one shell command:

| Field | What it does |
| --- | --- |
| `run` | The shell command |
| `cwd` | The folder for the command, relative to the project root |
| `capture` | A map from a name to a regex. The first group of the match becomes a value, for example `{ CDP_PORT: 'CDP :(\d+)' }` |
| `background` | `true` keeps the process alive for the session. Use it for a dev server |
| `readyWhen` | For a background command: Bugpatrol waits until the output matches this regex |
| `timeoutMs` | The time limit. The default is 10 minutes |

Later commands and `connect` can use a captured value as `${NAME}`. The explorer can use it as `{{NAME}}`. Bugpatrol treats each captured value as a secret.

## Secret interpolation

Agent actions and saved routines may expand `{{NAME}}` or `${NAME}` only when the
name is declared in `app.secrets` or captured by setup. Unknown names fail before
an action runs. Never put production credentials in a test environment.

Repository-owned setup and teardown commands and their `cwd` may also expand
`${NAME}` from the host environment. Those values are redacted from text output
but do not become available to the agent. Review configuration before running an
untrusted repository: setup commands are executable code. Text redaction does
not mask screenshots.

## Connect

| Platform | Field | Example |
| --- | --- | --- |
| `web` | `url` | `http://localhost:3000` |
| `electron` | `cdp` | `http://127.0.0.1:${CDP_PORT}` |
| `ios`, `android` | `appId`, and optional `device` | `com.example.app` |

For mobile, the default device is the booted simulator or the running emulator.

## Runtimes

Each agent (explorer, judge, fixer) runs on an LLM. Each agent can use a different provider:

- A local agent CLI: `use: claude`, `use: codex`, `use: kimi`, or `use: pi`. It uses your existing login.
- An API key: `use: { runtime: model, via: openrouter, model: <id> }`. `via` is `openrouter`, `vercel`, `openai`, `anthropic`, or `custom`.
- A full command: `use: { runtime: cli, command: '...' }`, for extra flags.

[LLMs](models.md#llm-providers-for-each-agent) has the presets, the keys, and the placeholders for a command.

## Automatic checks

The automatic checks are off by default. The explorer finds most real bugs, and it also reads the console errors and the failed requests of the app. Each check finding costs the judge a step with screenshots, and most check findings are not real bugs.

To run an accessibility audit, turn on some checks:

```yaml
agents:
  checks: [usability/contrast, usability/tap-target]
```

When a check is on, it runs on each screen that the explorer records. Each finding goes to the judge.

| Check | What it finds |
| --- | --- |
| `usability/contrast` | Text with a contrast below 4.5:1 |
| `usability/tap-target` | Controls smaller than 24 px |
| `layout/overlap` | Controls on top of each other |
| `layout/overflow` | Text that is cut off |
| `layout/occlusion` | Controls that something covers |
| `layout/zero-size-interactive` | Controls with no size |
| `layout/off-viewport` | Controls outside the screen |
| `layout/horizontal-scroll` | A page wider than the screen |
| `layout/shift-versus-baseline` | Elements that moved since the first visit |
| `rendering/broken-imagery` | Images that did not load |
| `rendering/unstyled-content` | A page with no styles |
| `pixel-diff` | A screen that changed since the first visit |

The layout checks can report controls that are correct, for example text hidden for screen readers. Try them on your app before you keep them on.

## The deterministic gate

The web gate (`bugpatrol run`) has more settings: `run`, `auth`, `viewports`, `scope`, `crawl`, `mask`, `tolerance`, `determinism`, and `decisions` (an optional general model that reviews the gate findings). `bugpatrol init --gate` writes a starter file with all of them. Refer to [The deterministic gate](deterministic-gate.md) and to [bugpatrol.example.yml](../bugpatrol.example.yml).
