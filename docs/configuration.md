# Configuration

All settings live in `.bugpatrol/bugpatrol.yml`. Select another repository-owned profile with `bugpatrol explore --config .bugpatrol/api.yml`. Paths remain relative to the project root. Bugpatrol rejects a key that it does not read, such as `readyUrl` in a setup command, and names the key and the supported field, so a typo never turns a setting off.

## Profiles

A repo can test more than one app config, for example its desktop app with `bugpatrol.yml` and its command line tool with `cli.yml`. Each config file is a profile, named after the file without its extension: `--config .bugpatrol/cli.yml` is the `cli` profile. Each profile explores its own app, so it keeps its own committed agent files:

| File | Default config (`bugpatrol.yml`) | Profile `cli` (`cli.yml`) |
| --- | --- | --- |
| App map | `.bugpatrol/appmap.json` | `.bugpatrol/cli/appmap.json` |
| Routines | `.bugpatrol/routines/` | `.bugpatrol/cli/routines/` |
| Endpoint inventory | `.bugpatrol/endpoints.yml` | `.bugpatrol/cli/endpoints.yml` |
| Run state: sessions, issues, fixes, lessons, triage, coverage, reviews, worktrees | `.bugpatrol/runs/` | `.bugpatrol/runs/profiles/cli/` |
| State branch (`agents.patrol.state: branch`) | `bugpatrol-state` | `bugpatrol-state-cli` |

The default config keeps the paths it always had. A profile's run state stays inside the gitignored `.bugpatrol/runs/`. A profile cannot be named `runs` or `routines`. Every command that takes `--config` reads and writes the folders of that profile: `explore`, `judge`, `fix`, `retest`, `publish`, `patrol`, `review`, `promote`, `endpoints`, `sweep`, `issue`, `memory`, `doctor`, `github sync`, `worktrees clean`, and the dashboard. `bugpatrol doctor --config <file>` prints where the profile keeps them. The app source still resolves against the project root.

### Migrating an existing non-default config

Before profiles existed, a config such as `--config .bugpatrol/api.yml` kept its app map, routines and endpoint inventory in `.bugpatrol/` itself. No file says which config those files belong to, so selecting a config never moves them. When there is no default `bugpatrol.yml` and `.bugpatrol/<profile>/` does not exist yet, a command that uses the config prints a note. If the files are that config's, run `bugpatrol adopt --config .bugpatrol/api.yml` once: it moves `appmap.json`, `endpoints.yml` and the routines in `.bugpatrol/routines/` to `.bugpatrol/api/`, and prints what it moved. Commit that folder. Issues filed before the move name `bugpatrol:routine repro-x` without a profile, so they replay from `.bugpatrol/routines/`.

Run state is not moved either. Sessions, issues and lessons that a profile recorded in `.bugpatrol/runs/` stay there, where the default config reads them, and the profile starts with empty run state in `.bugpatrol/runs/profiles/<profile>/`.

## The `.bugpatrol/` folder

Bugpatrol keeps all of its files in one folder at the root of your project:

| Path | What it is | Git |
| --- | --- | --- |
| `.bugpatrol/bugpatrol.yml` | The config | Commit it |
| `.bugpatrol/instructions.md` | The app guide for the explorer | Commit it |
| `.bugpatrol/appmap.json` | The screens that the explorer found | Commit it |
| `.bugpatrol/routines/` | The routines, and the repro routine of each issue. CI and a fresh clone replay them | Commit it |
| `.bugpatrol/<profile>/` | The app map, routines and endpoint inventory of another config ([Profiles](#profiles)) | Commit it |
| `.bugpatrol/runs/` | The local data: sessions, issues, fixes, worktrees, memory, and screenshots. `runs/profiles/<profile>/` holds the same for another config | `init` adds it to `.gitignore` |

The project root is the folder that holds `.bugpatrol/`. All paths in the config (`source`, `cwd`, `instructions`) are relative to the project root. You can run a command from any folder in the project: Bugpatrol finds `.bugpatrol/` in the current folder or in a folder above it.

Older versions kept `bugpatrol.yml` and `instructions.md` at the project root. If Bugpatrol finds a file there, it stops and shows the commands that move the files.

## The full file

```yaml
version: 1

app:
  platform: web                 # web | electron | ios | android | api | desktop | cli
  source: .                     # the repo that the fixer edits, relative to the project root
  setup: []                     # commands: { run, cwd, capture, background, readyWhen, timeoutMs }
  teardown: []
  connect: { url: http://localhost:3000 }   # or cdp, or appId + device, or cli: { command, timeoutMs, cols, rows, env }
  # connect.allowedOrigins: [https://accounts.example.com]   # web, Electron: other origins the explorer may be on
  instructions: .bugpatrol/instructions.md
  secrets: [TEST_PASSWORD]      # environment variables the explorer may use as {{NAME}}
  # readOnly: true              # only GET, HEAD and OPTIONS reach the backend; see Read-only mode

agents:
  explorer:
    maxSteps: 150               # one step is one tool call, a hard cap; full coverage needs many
    budgetUsd: 5                # optional: a cost limit for one session in USD; no limit by default
    use: claude                 # a local agent CLI: claude | codex | kimi | opencode | pi
  judge:
    use: { runtime: model, via: openrouter, model: z-ai/glm-5.3-flash }   # or an API key
  fixer:
    enabled: false              # off until you turn it on: the fixer writes code
    minSeverity: minor          # fix issues at this severity or worse
    maxPerCycle: 2              # at most this many new fixes in one cycle
    verify: pnpm test           # optional: a failed command marks the fix failed
    attempts: 3                 # fix attempts on one issue before the fixer gives up; CI fixes not counted
    commitMessage: 'fix: {title}'
    retest:
      enabled: true
      prepare: pnpm install     # runs in the worktree before the app starts
      attempts: 2               # retest verdicts in total: not fixed gets a new fix, unclear a new retest
    use: claude
  github:
    enabled: false
    repo: owner/name            # optional: default is the repo of app.source
    pullRequests: ready         # ready | draft
    issueMinSeverity: major     # a bug with no fix becomes an issue at this severity or worse
    labels: [bugpatrol]
    assetsBranch: bugpatrol-assets # the orphan branch that holds report images
    prScope: app                # optional: the scope in PR titles
  review:
    name: web                   # optional: tells two reviews of one pull request apart, each with its own review and check run
    claims: false               # the claim check of `bugpatrol review`: test what the pull request says it does
    block: false                # set a check run that fails on a disproof from a replay (needs `checks: write`)
    maxSteps: 150               # the model steps of one claim check, across all its sessions
    budgetUsd: 2                # optional: its cost limit in USD, across all its sessions; no limit by default
    timeoutMs: 1200000          # its time limit: its judges, its claim work in the explorer, its replays and benchmarks
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
  sweep:                        # api only: `bugpatrol sweep` and the sweep of each patrol cycle
    maxRequests: 600            # the most requests in one run; the next run continues from there
    timeoutMs: 1800000
  patrol:
    intervalMinutes: 30         # wait between cycles; a cycle runs only on a new commit
    cycles: 0                   # 0 = run until stopped
    pull: origin/main           # remote/branch to pull before each cycle; false = no pull
    state: local                # local | branch: branch shares the JSON state on the bugpatrol-state branch
```

## Setup and teardown commands

Each item in `app.setup` and `app.teardown` is one shell command:

| Field | What it does |
| --- | --- |
| `run` | The shell command |
| `cwd` | The folder for the command, relative to the project root |
| `capture` | A map from a name to a regex. The first group of the match becomes a value, for example `{ CDP_PORT: 'CDP :(\d+)' }` |
| `public` | Captures that are not secrets, such as a port or a terminal size, for example `[TUI_COLS, TUI_ROWS]` |
| `background` | `true` keeps the process alive for the session. Use it for a dev server |
| `readyWhen` | For a background command: Bugpatrol waits until the output matches this regex |
| `timeoutMs` | The time limit. The default is 10 minutes |

Later commands and `connect` can use a captured value as `${NAME}`. The explorer can use it as `{{NAME}}`. Bugpatrol treats each captured value as a secret, and replaces it with `{{NAME}}` wherever it shows in the app's output, except a name in `public`. A short secret such as `18` also matches ordinary numbers, so setup warns about a secret capture shorter than six characters: list it in `public` when it is not a secret. Redaction never changes a terminal's control sequences, so a short value can hide text but not break colours or layout.

## Secret interpolation

Agent actions and saved routines may expand `{{NAME}}` or `${NAME}` only when the
name is declared in `app.secrets` or captured by setup. An unknown `{{NAME}}` fails
before the action runs. An unknown `${name}` stays as it is, because it is also the
syntax of the shell: on a `cli` app, `for s in a b; do cat ${s}.txt; done` runs as
written. A declared name is still filled in, so give a shell variable a name that is
not a secret or a setup capture. Never put production credentials in a test
environment.

Repository-owned setup and teardown commands and their `cwd` may also expand
`${NAME}` from the host environment. Those values are redacted from text output
but do not become available to the agent. Review configuration before running an
untrusted repository: setup commands are executable code. Text redaction does
not mask screenshots.

## Read-only mode

Set `app.readOnly` when the app talks to a backend whose data must not change, such as a shared or production one. Bugpatrol then lets only GET, HEAD and OPTIONS reach the backend, whatever the explorer does, and the app guide's never-do list is no longer the only thing between a key press and a write. `readOnly: true` is short for `readOnly: {}`.

| Key | Default | What it does |
| --- | --- | --- |
| `proxy` | `{}` | `NAME: upstream URL` pairs. Each one starts a loopback proxy to that backend, as the variable `{{NAME}}` |
| `websockets` | `block` | `block` refuses every WebSocket. `pass` lets them through, less the frames in `dropFrames` |
| `dropFrames` | `[]` | Regular expressions. A frame that the app sends on a WebSocket and that matches one is dropped. Needs `websockets: pass` |

How Bugpatrol holds back the writes depends on the platform:

- **Web and Electron**: the driver aborts every request of the browser that is not a read, including form posts and beacons, and applies the WebSocket rules. A web context blocks service workers, whose own requests would bypass the rules. The WebSocket rules do not reach dedicated or shared workers, so while one applies (`websockets: block`, or `dropFrames`), a page that starts a worker gets an error and the worker is logged as a blocked write. When Bugpatrol attaches to an Electron app, it reloads each app page, so that a WebSocket the app opened before is opened again under the rules. A request the app sent before Bugpatrol attached has already left, and its service workers open WebSockets that these rules do not reach, so an Electron app, launched or attached, needs its backend in `proxy`, with the app pointed at it through `{{NAME}}`.
- **API**: the request policy sends only reads, also to a loopback or `disposable` target.
- **CLI, desktop, iOS and Android**: the app talks to its backend itself, so Bugpatrol cannot see the requests. Name the backend in `proxy` and point the app at `{{NAME}}`; the config is rejected without a `proxy`. The proxy forwards reads, answers each other method with a 405, and applies the WebSocket rules. It refuses WebSocket compression, so `dropFrames` sees the text of each frame. Traffic that does not go through the proxy is not covered.

Bugpatrol starts the proxies before setup, so setup commands, `connect` and the explorer can all use `{{NAME}}`. An upstream URL can use `${NAME}` for a secret or a variable of Bugpatrol's environment.

```yaml
app:
  platform: cli
  readOnly:
    proxy:
      API_URL: https://api.example.com
    websockets: pass
    dropFrames: ['"push"']       # the client's sync writes
  connect:
    cli:
      env:
        MY_APP_API_URL: '{{API_URL}}'
```

Each blocked write is logged with its method, its URL with the query values hidden, and the time. The explorer sees the writes blocked since its last step, each one is a `write-blocked` event in the session, and the session summary ends with `Read-only mode blocked N write(s).`

## Connect

| Platform | Field | Example |
| --- | --- | --- |
| `web` | `url` | `http://localhost:3000` |
| `electron` | `cdp` or `launch` | `http://127.0.0.1:${CDP_PORT}` or a private launch block |
| `ios`, `android` | `appId`, and optional `device` | `com.example.app` |
| `api` | `url`, and the keys below | `http://127.0.0.1:8000` |
| `cli` | `cli`, with the keys below | `{ cols: 120, rows: 40 }` |

For mobile, the default device is the booted simulator or the running emulator.

### Connect for Electron

Use exactly one of `connect.cdp` and `connect.launch`.

`cdp` connects to an Electron app that is already running, usually one started by
`app.setup`. It must be an HTTP CDP endpoint, such as
`http://127.0.0.1:${CDP_PORT}`.

`launch` starts the app in a private Linux Xvfb display, DBus session and profile,
so it cannot take over the user's screen. `command` is the Electron executable or
wrapper, and `args` are its app arguments. `userDataDir`, when set, is copied into
the private profile before launch. `cdp` is a positive port or `auto`, which picks
a free port. `width` and `height` set the private display size.

```yaml
app:
  platform: electron
  connect:
    launch:
      command: node_modules/.bin/electron
      args: ['.']
      userDataDir: .bugpatrol/electron-profile
      cdp: auto
      width: 1280
      height: 800
```

Private launch requires Linux with Xvfb, xauth, setsid and dbus-run-session.

### Connect for a command line app

With `platform: cli`, the explorer runs the app in a terminal from the root of `app.source`. It can run a command until it exits, or start a program that stays open, such as a full screen terminal UI, and drive it with keys. The terminal comes from the `pty` module of `python3`, so `python3` must be on the `PATH`.

Set `connect.cli.command` to a program that stays open, such as `bun src/entry.ts`, and Bugpatrol starts it in the terminal before the explorer begins, with the app's environment. The explorer then starts on its screen, and it needs no rule in the app guide on how to start it. When `bugpatrol explore` ends because the explorer could not test the app at all, it exits with code 4.

| Key | Default | What it does |
| --- | --- | --- |
| `timeoutMs` | `60000` | The time limit of one command. A program that stays open runs until the explorer stops it; this is then the longest that one wait for its screen can take |
| `cols` | `80` | The width of the terminal in characters |
| `rows` | `24` | The height of the terminal in characters |
| `env` | `{}` | Environment variables for the app, on top of the few that it gets from the host |

The app does not get the environment of Bugpatrol. It gets only these variables of the host: `PATH`, `USER`, `LOGNAME`, `SHELL`, `LANG`, `LANGUAGE`, the `LC_*` variables, `TZ`, `TMPDIR`, `COLORTERM`, `NO_COLOR`, `XDG_DATA_DIRS` and `XDG_CONFIG_DIRS`. Its `HOME` is `{{PRIVATE_DIR}}`, an empty folder that Bugpatrol makes for the session and removes after it, and Bugpatrol sets `TERM` to `xterm-256color`. So a token in your shell, such as `AWS_SECRET_ACCESS_KEY`, never reaches the app, `printenv` in a command shows none of them, and a CLI that keeps its sign-in under `~` starts signed out. Give the app each other variable that it needs in `env`.

`env` reaches each command and program that the explorer runs, and each replay of its routines. It never reaches Bugpatrol, the agent CLIs, `gh`, or the terminal helper, so they keep their logins. A value can use a declared secret or a setup capture as `${NAME}`, and `{{PRIVATE_DIR}}`:

```yaml
app:
  platform: cli
  connect:
    cli:
      cols: 120
      rows: 40
      env:
        XDG_CONFIG_HOME: '{{PRIVATE_DIR}}/config'
        API_TOKEN: '${API_TOKEN}'   # declared in app.secrets
```

A program does not create these folders itself in most cases, so create them first: start it with `mkdir -p "$XDG_CONFIG_HOME" && my-app`, or tell the explorer to in the app guide.

The explorer drives only its own terminal. A command that would start a program outside it, such as `tmux`, `screen` or `setsid`, is refused: a multiplexer's server keeps your environment and sign-ins, so the app would run as you. Each process that a command starts ends with it: when the command exits or times out, when a program that stays open is stopped, and when the session ends. On Linux this covers a daemon that left the process group, as a tmux server does, since it is reparented to Bugpatrol's terminal helper.

Each step saves a screenshot of the terminal, `NNN-<label>.png`, and its text beside it, `NNN-<label>.terminal.txt`: the command and everything it printed (or a session's screen), then the colours of each cell of the screenshot. A command's screenshot shows only its last screenful, so the judge reads the text to see output that scrolled off, and the cell colours to tell close shades apart. Characters that the bundled fonts lack, such as most emoji, draw as an outlined box of their width; the text names them.

### Connect for an API

| Key | Default | What it does |
| --- | --- | --- |
| `url` | none | The origin of the API. Each request goes here |
| `spec` | none | The OpenAPI spec: a URL, a path on `url` such as `/openapi.json`, a file in the project, or an absolute file as a `file:` URL. Without a spec, Bugpatrol sends only GET, HEAD, and OPTIONS |
| `headers` | `{}` | The headers that go into each credential set |
| `credentials` | none | `self` and an optional `other`, each with its `headers`. `other` enables the cross-user cases |
| `errors` | none | `statuses` that each endpoint can return, and the `schema` of their body |
| `deny` | `[]` | Globs of endpoints that Bugpatrol never requests, for example `POST /admin/**` |
| `methods` | all seven | The methods that Bugpatrol can send. The request policy can allow fewer |
| `disposable` | `false` | Allow writes also when `url` is not loopback. Set it only when the data can be lost |
| `perMinute` | `60` | The most requests in one minute |
| `timeoutMs` | `30000` | The time limit of one request |
| `version` | none | `path` and `pointer` of the deployed commit. The patrol explores again after each deploy |

[Backend testing](backend-testing.md#test-an-http-api) tells how the sweep, the
request policy, and the deploy check use these keys.

## Runtimes

Each agent (explorer, judge, fixer) runs on an LLM. Each agent can use a different provider:

- A local agent CLI: `use: claude`, `use: codex`, `use: kimi`, `use: opencode`, or `use: pi`. It uses your existing login.
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

The web gate (`bugpatrol run`) has more settings: `run`, `viewports`, `scope`, `crawl`, `mask`, `tolerance`, `determinism`, and `decisions` (an optional general model that reviews the gate findings). `bugpatrol init --gate` writes a starter file with all of them. Refer to [The deterministic gate](deterministic-gate.md) and to [bugpatrol.example.yml](../bugpatrol.example.yml).
