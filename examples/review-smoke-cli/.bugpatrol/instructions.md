# The Bugpatrol command line

The app is `bugpatrol`, the command line of a QA team of AI agents. Each command runs from the root of the repo. `.review-smoke/` is a fixture workspace with made-up issues, fixes, and sessions.

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
