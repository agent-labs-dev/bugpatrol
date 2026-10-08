# The Bugpatrol command line

The app under test is `bugpatrol`, the command line of a QA team of AI agents. Each command runs from the root of the repo. `.review-smoke/` is a fixture workspace with made-up issues, fixes, and sessions.

Run Bugpatrol on the fixture like this:

```bash
cd .review-smoke && node ../packages/cli/dist/bin.js issue list
```

Commands to try:

- `--help`, `--version`, and `<command> --help`
- `issue list`, `issue dismiss <id> --reason "..."`, `issue reopen <id>`
- `memory list`, `memory add --role explorer "text"`, `memory remove <id>`
- `replay <routine-id>` with a routine in `.review-smoke/.bugpatrol/routines/`

Do not run `explore`, `judge`, `fix`, `retest`, `review`, `publish`, `ci`, `github`, `patrol`, the bare `bugpatrol`, `recon`, `run`, or `dashboard`. They start agents, call GitHub, need a running app, or never exit.

## What this app is made of

- `packages/cli/`: the commands and their output.
- The code in `packages/core/` and `packages/agents/` that the commands above run: the config, the workspace, issues, memory, and replay.

## What is not this app

The dashboard (`packages/dashboard/`), GitHub review comments, the agents' sessions (explore, judge, fix, review), `docs/`, `.github/`, and `examples/`. Other jobs review the dashboard (`review-smoke-dashboard`) and the fixture app (`review-smoke`). Do not start the dashboard or any server, and do not read the source to stand in for a test.

When the pull request changes nothing that this app is made of, run `--help` and `issue list`, then finish. In untested, write "The rest of the change: outside the CLI".
