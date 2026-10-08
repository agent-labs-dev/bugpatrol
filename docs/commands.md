# Commands

Run each command in your repo. Bugpatrol finds the `.bugpatrol/` folder in the current folder or in a folder above it, the same way that git finds `.git/`. Run `npx bugpatrol --help` for the full list, and `npx bugpatrol <command> --help` for the flags of one command.

## Agents

| Command | What it does |
| --- | --- |
| `bugpatrol explore [--goal "..."] [--steps N]` | One explorer session: start the app, explore, report, stop the app |
| `bugpatrol judge [--session <id>]` | Judge the recent explorer sessions that have new candidates (or the sessions that you name) |
| `bugpatrol fix [--issue <id>]` | Fix the worst open issues, then retest each fix |
| `bugpatrol retest --issue <id>` | Retest one fix in the app, from its worktree |
| `bugpatrol review <pr> [--dry-run] [--force] [--claims] [--steps N]` | Review one pull request in the running app, and post a GitHub review of what it introduces. Refer to [GitHub](github.md#7-review-a-pull-request) |
| `bugpatrol promote <pr> <claim>...` | Keep the routine of each proven claim of a merged pull request as `.bugpatrol/routines/pr-<pr>-<claim>.json`. Commit it, and the patrol replays it. It refuses a pull request that is not merged and a claim that is not proven. Refer to [GitHub](github.md#7-review-a-pull-request) |
| `bugpatrol publish [--issue <id>] [--dry-run]` | Open PRs and issues on GitHub, or write them to local files. Refer to [GitHub](github.md) |
| `bugpatrol ci [--issue <id>] [--wait]` | Watch the CI checks of each Bugpatrol PR, and let the fixer fix a failed check. Refer to [GitHub](github.md#5-make-ci-green) |
| `bugpatrol [--once] [--force]` (or `bugpatrol patrol`) | The full cycle, again and again. Explore and judge run only on a new commit; the fixes, retests, publish, and CI run in each cycle. `--once` runs one cycle; `--force` explores the same commit again |
| `bugpatrol replay <routine-id>` | Replay a learned routine, with no model |

## Issues, memory, and GitHub

| Command | What it does |
| --- | --- |
| `bugpatrol issue list` | List the issues, worst first |
| `bugpatrol issue dismiss <id> --reason "..." [--by name]` | Close an issue as not a bug; it does not come back |
| `bugpatrol issue reopen <id>` | Open a dismissed issue again |
| `bugpatrol memory list [--role r]` | Show the lessons that the agents learned |
| `bugpatrol memory add --role r "text" [--scope s]` | Add a lesson yourself |
| `bugpatrol memory remove <id>` · `retire <id> --reason "..."` | Delete or retire a lesson |
| `bugpatrol github sync` | Read the state of each PR and issue from GitHub |
| `bugpatrol worktrees clean` | Remove the worktrees of merged, closed, or finished fixes |

## Dashboard and setup

| Command | What it does |
| --- | --- |
| `bugpatrol dashboard [--port N]` | The local dashboard, on 127.0.0.1 |
| `bugpatrol doctor` | Check that this machine can run the deterministic gate |
| `bugpatrol init [--yes] [--agent a]` | Detect the app and the LLMs, ask for each agent's provider, and write `.bugpatrol/bugpatrol.yml` and `.bugpatrol/instructions.md` |
| `bugpatrol init --gate` | Write a starter `.bugpatrol/bugpatrol.yml` for the deterministic web gate |
| `bugpatrol --version` | Show the version |

## Deterministic gate (web)

| Command | What it does |
| --- | --- |
| `bugpatrol run [--all \| --smoke \| --screens /a,/b] [--no-models]` | Capture, compare with the baselines, and run the checks |

These commands are planned and not built yet: `recon`, `model`, `baseline`, `findings`, `intent`, `report`, `export`, and `watch`.
