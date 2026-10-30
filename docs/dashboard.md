# The dashboard

```bash
npx bugpatrol dashboard            # http://127.0.0.1:4311
npx bugpatrol dashboard --port 5000
npx bugpatrol dashboard --config .bugpatrol/api.yml
```

The dashboard shows agent activity and results. It reads the files under `.bugpatrol/runs/` and updates live. You can keep it open while a patrol runs.

The theme follows the system setting. The **Theme** button in the top bar changes it to Light, then Dark, then back to System. The browser keeps your choice.

## Surfaces

A surface is a part of the project that Bugpatrol tests: a client app (web, Electron, desktop, iOS, Android, CLI), which has screens, or an API, which has endpoints. Each config file in `.bugpatrol/` tests one surface. A monorepo can have two, for example `bugpatrol.yml` for the web app and `api.yml` for its backend. All configs write to the same `.bugpatrol/runs/`, so the dashboard shows the data of all surfaces.

The top bar shows each surface. The surface of the config that the dashboard reads has a border. `--config` selects that config. The dashboard uses it for the agent settings and the `logs:` sources, and each command that a page shows includes the same `--config`.

## Token usage

The dashboard shows the tokens that each agent used, so that you can control the cost, make a flow shorter, and compare models:

- Each agent card shows its tokens today.
- The **Token usage** table on the Overview shows the last 7 days for each agent and model: the sessions, the input, cached, and output tokens, the tokens per session, and the list price when the CLI reports one.
- Each session in **Activity** shows its tokens, for each model, and each model call in the timeline shows its own tokens.

`explore` and `judge` also print the tokens in the terminal. These runtimes report tokens:

| Runtime | Tokens |
| --- | --- |
| An API key (`runtime: model`) | From each API response |
| `claude` | From `--output-format json`, with the model name and the list price |
| `codex` | From `--json`, for each turn |
| `opencode` | From `--format json`, for each step, with the list cost |
| `kimi`, `pi` | Not reported |

To compare two models, run the same goal with each one, for example `explore --goal "Test the checkout flow"`, and compare the tokens per session.

The cost on the dashboard counts only the API calls that Bugpatrol makes: the agents on an API key. A local agent CLI (`claude`, `codex`, `kimi`, `opencode`, `pi`) uses your own plan, and Bugpatrol does not see its cost.

## Pages

- **Overview**: the status of the project and its numbers: the open issues, the findings that wait for the judge, the coverage of each surface, and the last session. Then the issues and findings that need attention, the recent sessions, the coverage of each surface, what each agent does now, and the token usage.
- **Issues**: each issue with its screenshots and steps, the judge's reason, the fix with its diff, and the PR or issue on GitHub with its state. The fix attempts follow, oldest first. Each shows its kind, outcome, and reason, with its diff and verify output one click away and its retests (before and after screenshots) under it. When the fixer reaches `agents.fixer.attempts` on an issue, the page says so.
- **Reviews**: each pull request that `bugpatrol review` reviewed, with its head and base commits. A review page lists each claim with its verdict, the evidence source, the reason, and what Bugpatrol saw on the base build and on the pull request build. The problems that the pull request introduced follow, with base and head screenshots.
- **Activity**: each session with its numbers first: the duration, the steps or the cases that it ran, and its findings. The findings follow in groups of the same failure, with a count. Open a finding to see its HTTP exchange or its screenshot. The timeline of the session is last.
- **Flow**: agent actions, failed requests and backend logs in time order. Nearby log entries are marked as correlated, rather than proven causes. Refer to [Flow](#flow).
- **Screens**: a graph shows how the screens of a client app connect. Switch to the grid to see each latest screenshot. An API has no screens: the page then points to Coverage.
- **Memory**: the lessons that the agents learned.
- **Coverage**: for each surface, the numbers at the top, then the details. For an API: the endpoints tested, the cases that passed, failed, were blocked, were skipped, or wait in the sweep cursor, and the endpoint × case matrix. The failures come first. Search the paths, or show the failed endpoints only. Click a cell to see its HTTP exchange. For a client app: the screens found and the open issues of each screen.
- **Checks**: the results of `bugpatrol run` (shown only when there are runs).

A page with no data says what it shows, why it is empty now, and the command to run next.

The dashboard listens on 127.0.0.1 only, because the screenshots can show real data. It is read-only.

## Flow

Flow needs a `logs:` source in the config. A patrol, `explore`, and `review` read the sources while a session runs, then write the flow of the session. `bugpatrol sweep` reads no logs, so a sweep session has no flow.

```yaml
logs:
  - name: api
    kind: file          # or stream (a command), or webhook
    path: logs/api.log
    match: 'ERROR|WARN' # optional: keep only the lines that match
```

## The files behind it

The dashboard shows the files that the agents write. You can also read them directly:

| Path | What it holds |
| --- | --- |
| `.bugpatrol/runs/issues/<id>.json` | One issue: title, severity, status, the judge's report and reason, and the evidence |
| `.bugpatrol/runs/fixes/<id>.json` | One fix record: branch, diff, fix attempts, retests, and PR |
| `.bugpatrol/runs/fixes/<id>/attempt-<n>.diff` | The full diff of one fix attempt |
| `.bugpatrol/runs/sessions/<id>/` | One explorer session: its actions and screenshots |
| `.bugpatrol/appmap.json` | The screens and how they connect. Committed |
| `.bugpatrol/routines/` | The learned routines and the issue repros. Committed |
| `.bugpatrol/runs/memory.json` | The lessons |
| `.bugpatrol/runs/agents.json` | What each agent does now |
| `.bugpatrol/runs/publish/` | The reports from `publish --dry-run` |
| `.bugpatrol/runs/reviews/pr-<number>.json` | The last review of one pull request: its claims, verdicts, and findings |
| `.bugpatrol/runs/reviews/pr-<number>/` | The claim routines, screenshots, and recordings of that review |

## Recordings

A review page plays the recordings in the run directory of the review. A recording belongs to a claim when its path names the claim and the build, for example `claim-1/head.mp4` or `claim-2-base.webm`. The page shows it on that side of the claim. A recording that names no claim shows under **Other recordings**.

For each build the page shows the first of these that exists:

1. A video (`.mp4`, `.webm`). It plays in the page and you can seek in it.
2. An animated image (`.gif`, `.webp`).
3. A terminal cast (`.cast`, asciicast v2 or v3). The page shows the final output as text. **Play** replays it, with each pause cut to one second at most.
4. The screenshots of each replay step.

When a build has a recording and screenshots, the screenshots sit one click below the recording.
