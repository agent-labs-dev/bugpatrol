export const USAGE = `bugpatrol - a continuously-running QA engineer for your repo

Setup
  bugpatrol init [--yes] [--agent a]      detect the app and the LLMs, write .bugpatrol/
  bugpatrol init --gate                   write a starter config for the deterministic web gate
  bugpatrol doctor                        verify env: pinned image, fonts, browser, network, disk

Recon
  bugpatrol recon [--review] [--max-screens N] [--budget-usd X]
  bugpatrol recon resume                  continue an interrupted crawl
  bugpatrol model show|diff|approve       inspect and approve the AppModel

Running
  bugpatrol run                           changed-only (default)
  bugpatrol run --all                     full sweep
  bugpatrol run --smoke                   entry points only
  bugpatrol run --screens /a,/b           explicit selection
  bugpatrol run --no-models               deterministic tier only, fully offline

Agents
  bugpatrol explore [--goal "..."] [--steps N]
  bugpatrol judge [--session <id>...]
  bugpatrol fix [--issue <id>...]
  bugpatrol retest --issue <id>
  bugpatrol review <pr> [--dry-run] [--force] [--steps N]
  bugpatrol publish [--issue <id>] [--dry-run]
  bugpatrol ci [--issue <id>] [--wait]
  bugpatrol github sync
  bugpatrol worktrees clean
  bugpatrol [--once] [--force]            the patrol: explore, judge, fix, retest, publish (= bugpatrol patrol)
  bugpatrol replay <routine-id>
  bugpatrol issue list | dismiss <id> --reason "..." [--by name] | reopen <id>
  bugpatrol memory list [--role r] | add --role r "text" [--scope s]
  bugpatrol memory remove <id> | retire <id> --reason "..."

Baselines
  bugpatrol baseline capture              (re)capture baselines in the pinned image
  bugpatrol baseline pull|push            sync with object storage
  bugpatrol baseline accept <finding-id...>
  bugpatrol baseline accept --clean       bulk-accept everything non-blocking

Triage
  bugpatrol findings list [--route issue|question]
  bugpatrol findings explain <id>
  bugpatrol findings accept <id> --reason "intentional"
  bugpatrol intent list|export|prune

Dashboard
  bugpatrol dashboard [--port N]          local UI: run history, app map, live watch

Output
  bugpatrol report --open
  bugpatrol export --format junit|sarif|json

Local loop
  bugpatrol watch                         re-run affected screens on file change

Exit codes
  0  clean, or non-blocking findings only
  1  tier-1 regression detected
  2  configuration or usage error
  3  recon required, or the AppModel is unapproved
  4  infrastructure error - Bugpatrol could not test
`;

const DOCS = 'https://github.com/agent-labs-dev/bugpatrol/blob/main/docs/commands.md';

/** `bugpatrol <command> --help`. One entry for each command that a user runs by hand. */
export const COMMAND_HELP: Record<string, string> = {
  init: `bugpatrol init [flags]
  Find the app and the LLMs, and write .bugpatrol/bugpatrol.yml and .bugpatrol/instructions.md.
  --yes, -y              use the detected values, with no questions
  --platform <p>         web | electron | ios | android
  --start "<command>"    the command that starts the app
  --url <url>            web: the app URL
  --app-id <id>          ios, android: the bundle ID or the package name
  --agent <a>            the LLM for all agents: claude | codex | kimi | pi | openrouter | vercel | openai | anthropic
  --explorer, --judge, --fixer <a>   the LLM for one agent
  --gate                 write a starter config for the deterministic web gate
`,
  explore: `bugpatrol explore [--goal "..."] [--steps N]
  Run setup, let the explorer use the app and report problems, then run teardown.
  The reports are candidates. Run \`bugpatrol judge\` to file the real bugs as issues.
  --goal "..."    what to test, for example "Test the checkout flow"
  --steps N       the step limit (default: agents.explorer.maxSteps)
`,
  judge: `bugpatrol judge [--session <id>]...
  File the real bugs from the explorer's candidates as issues, and dismiss the rest.
  With no --session, the judge reads the recent explorer sessions that have candidates.
  It skips the candidates that it already decided.
  --session <id>  judge this session only. You can give the flag more than one time.
`,
  fix: `bugpatrol fix [--issue <id>]...
  Write a fix for the worst open issues, each in its own git worktree, then retest each fix in the app.
  Needs agents.fixer.enabled: true.
  --issue <id>    fix this issue only. You can give the flag more than one time.
`,
  retest: `bugpatrol retest --issue <id>
  Start the app from the fix worktree, repeat the flow, and let the judge compare before and after.
`,
  review: `bugpatrol review <pr> [--dry-run] [--force] [--allow-fork] [--steps N]
  Review one pull request in the running app. The explorer tests what the diff can affect on the pull request
  build. Bugpatrol repeats each reported flow on the base build, and the judge keeps what the pull request introduces.
  The result is a GitHub review: each introduced problem is a comment on the changed line that causes it.
  A new review replaces the review of an older commit. It never blocks the merge.
  Needs a logged-in gh CLI. To post the review, it also needs agents.github.enabled: true.
  <pr>            the number or the URL of the pull request
  --dry-run       write the review to .bugpatrol/runs/reviews/, and send nothing to GitHub
  --force         test the pull request again, also when the last review tested the same commit
  --allow-fork    review a pull request from a fork: its code runs on this machine, with the secrets of the app
  --steps N       the step limit of the explorer (default: agents.explorer.maxSteps)
`,
  publish: `bugpatrol publish [--issue <id>]... [--dry-run]
  Open a draft PR for each fix, and a GitHub issue for each bug at agents.github.issueMinSeverity or worse with no fix.
  Needs agents.github.enabled: true and a logged-in gh CLI.
  --dry-run       write the reports to .bugpatrol/runs/publish/, and open nothing
  --issue <id>    publish this issue only
`,
  ci: `bugpatrol ci [--issue <id>]... [--wait]
  Read the CI checks of each open Bugpatrol PR. When a check fails, the fixer gets its log,
  and Bugpatrol pushes the new commit to the PR branch. After agents.github.ci.attempts tries, it stops.
  The patrol runs this step after publish.
  --wait          wait for the running checks, up to agents.github.ci.waitMinutes
  --issue <id>    only the PR of this issue
`,
  patrol: `bugpatrol [--once] [--force]      (the same as: bugpatrol patrol)
  Run the full cycle again and again: setup, explore, judge, teardown, fix, retest, publish.
  The fixer and GitHub steps run only when you turn them on.
  Explore and judge run only when the commit changed since the last full cycle. The fixes, retests,
  publish, and CI checks run in each cycle.
  --once          run one cycle, then stop
  --force         explore and judge in the first cycle also when the commit did not change
`,
  github: `bugpatrol github sync
  Read the state of each PR and issue from GitHub. A closed PR becomes a lesson. An issue closed as not planned becomes a dismissal.
`,
  issue: `bugpatrol issue list | dismiss <id> --reason "..." [--by name] | reopen <id>
  List the issues, worst first, or change the state of one issue.
`,
  memory: `bugpatrol memory list [--role r] | add --role r "text" [--scope s] | remove <id> | retire <id> --reason "..."
  Look at and change the lessons that the agents learned.
`,
  dashboard: `bugpatrol dashboard [--port N]
  Serve the dashboard on http://127.0.0.1:4311. It updates live, and it does not stop by itself.
`,
  doctor: `bugpatrol doctor
  Check the config, Node, the browser, and the environment.
`,
};

export function commandHelp(command: string): string | undefined {
  const help = COMMAND_HELP[command];
  return help && `${help}\nDocs: ${DOCS}\n`;
}
