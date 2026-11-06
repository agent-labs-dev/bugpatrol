# Commands

Run each command in your repo. Bugpatrol finds the `.bugpatrol/` folder in the current folder or in a folder above it, the same way that git finds `.git/`. Run `npx bugpatrol --help` for the full list, and `npx bugpatrol <command> --help` for the flags of one command.

## Global options

| Option | What it does |
| --- | --- |
| `--config <file>` | Read this config file in place of `.bugpatrol/bugpatrol.yml`, for example `bugpatrol --config .bugpatrol/cli.yml review 12`. It goes before or after the command. The file is a profile with its own app map, routines and run state ([Profiles](configuration.md#profiles)). Paths in it stay relative to the project root |

## Agents

| Command | What it does |
| --- | --- |
| `bugpatrol explore [--goal "..."] [--steps N]` | One explorer session: start the app, explore, report, stop the app |
| `bugpatrol judge [--session <id>]` | Judge the recent explorer sessions that have new candidates (or the sessions that you name). A session recorded at another commit of the source is skipped and named, since its findings may be fixed; `--session` judges it anyway. A patrol's judge reads an earlier session's candidates only when that session tested the same revision |
| `bugpatrol fix [--issue <id>]` | Fix the worst open issues, then retest each fix |
| `bugpatrol retest --issue <id>` | Retest one fix in the app, from its worktree |
| `bugpatrol retest --issue <id> --pr <n>` (or `--branch <ref>`, `--worktree <path>`) | Retest a fix that someone else wrote, for example with Claude Code. Bugpatrol only judges it: it never rewrites, pushes to, or opens a PR for it. After the fix merges, the patrol rechecks it on main and closes the issue |
| `bugpatrol review <pr> [--dry-run] [--force] [--claims] [--steps N]` | Review one pull request in the running app, and post a GitHub review of what it introduces. Refer to [GitHub](github.md#7-review-a-pull-request) |
| `bugpatrol promote <pr> <claim>...` | Keep the routine of each proven claim of a merged pull request as `.bugpatrol/routines/pr-<pr>-<claim>.json`. Commit it, and the patrol replays it. It refuses a pull request that is not merged, a review of another commit than the one that merged, and a claim that is not proven. Refer to [GitHub](github.md#7-review-a-pull-request) |
| `bugpatrol publish [--issue <id>] [--dry-run]` | Open PRs and issues on GitHub, or write them to local files. Refer to [GitHub](github.md) |
| `bugpatrol ci [--issue <id>] [--wait]` | Watch the CI checks of each Bugpatrol PR, and let the fixer fix a failed check. Refer to [GitHub](github.md#5-make-ci-green) |
| `bugpatrol [--once] [--force] [--state local\|branch]` (or `bugpatrol patrol`) | The full cycle, again and again. Explore and judge run only on a new commit; the fixes, retests, publish, and CI run in each cycle. `--once` runs one cycle and then puts the checkout back on the branch it started from; `--force` explores the same commit again; `--state branch` keeps the state on the `bugpatrol-state` branch |
| `bugpatrol replay <routine-id>` | Replay a learned routine, with no model. For a repro routine, it then checks the bug: it exits 1 while the bug still shows, and 0 once it no longer does |
| `bugpatrol endpoints [--spec URL\|file] [--json]` | Print the endpoints of an api contract and the operations that Bugpatrol skips. With no `--spec`, it reads `app.connect.spec` (or `.bugpatrol/endpoints.yml`) and writes the endpoints to `appmap.json` |
| `bugpatrol sweep [--json] [--max-requests N] [--dry-run]` | Test each endpoint and case of an api with no model, and check each response against the spec. It exits 1 on a failure that repeats. Refer to [Backend testing](backend-testing.md#the-sweep) |

## Issues, memory, and GitHub

| Command | What it does |
| --- | --- |
| `bugpatrol findings list [--session <id>]` | List the findings of the last explore or sweep session that has any, or of one session, with what became of each: filed as an issue, dismissed, ignored, or waiting for the judge |
| `bugpatrol issue list` | List the issues, worst first |
| `bugpatrol issue show <id>` | Print an issue: its body, the judge's reason, how it closed, and the paths of its evidence and repro routine |
| `bugpatrol issue dismiss <id> --reason "..." [--by name]` | Close an issue as not a bug; it does not come back |
| `bugpatrol issue fixed <id> --reason "..." [--commit sha] [--by name]` | Close an issue as fixed, for example after a fix by hand. It records who fixed it and the commit, and closes its GitHub issue as completed. Unlike a dismissal, its findings stay open: a later sighting reopens it as a regression |
| `bugpatrol issue reopen <id>` | Open a dismissed or fixed issue again |
| `bugpatrol memory list [--role r]` | Show the lessons that the agents learned |
| `bugpatrol memory add --role r "text" [--scope s]` | Add a lesson yourself |
| `bugpatrol memory remove <id>` · `retire <id> --reason "..."` | Delete or retire a lesson |
| `bugpatrol github sync` | Read the state of each PR and issue from GitHub |
| `bugpatrol worktrees clean` | Remove the worktrees of merged, closed, or finished fixes |

## Dashboard and setup

| Command | What it does |
| --- | --- |
| `bugpatrol adopt --config .bugpatrol/<name>.yml` | Move the app map, endpoint inventory and routines of `.bugpatrol/` into the folder of that config, for a config that kept them there before profiles existed. Refer to [Configuration](configuration.md#migrating-an-existing-non-default-config) |
| `bugpatrol dashboard [--port N]` | The local dashboard, on 127.0.0.1 |
| `bugpatrol doctor [--config <file>]` | Check that this machine can run the selected config: the config file, Node, the LLM of each agent, `gh` when `agents.github` is on, and what the platform needs. For web, Chromium for Playwright, with the install command for the pinned version. For web and api with no background setup command, that `connect.url` answers. For cli, `python3`; for desktop, Linux and the launch commands. A config with a `run` block also gets the pinned runner image and the AppModel. Exits 2 when a required check fails |
| `bugpatrol init [--yes] [--agent a]` | Detect the app and the LLMs, ask for each agent's provider, and write `.bugpatrol/bugpatrol.yml` and `.bugpatrol/instructions.md` |
| `bugpatrol init --platform api [--url <url>] [--spec <spec>]` | Write a starter config for an API that runs already. It asks for the URL and an optional spec, and detects no start command |
| `bugpatrol init --gate` | Write a starter `.bugpatrol/bugpatrol.yml` for the deterministic web gate |
| `bugpatrol --version` | Show the version |

## Deterministic gate (web)

| Command | What it does |
| --- | --- |
| `bugpatrol run [--all \| --smoke \| --screens /a,/b] [--no-models]` | Capture, compare with the baselines, and run the checks |

These commands are planned and not built yet: `recon`, `model`, `baseline`, `intent`, `report`, `export`, and `watch`.
