# Getting started

For backend services with a web frontend, see [backend testing](backend-testing.md)
for disposable stack setup and coverage limits.

This guide adds Bugpatrol to your repo, step by step. For a faster setup, install the [Bugpatrol skill](../skills/bugpatrol/SKILL.md) with `npx skills add agent-labs-dev/bugpatrol`, and ask your coding agent to set up Bugpatrol. The skill does these steps for you.

## Requirements

- Node 22 or later.
- `git`, and your app in a git repo with an `origin` remote. Each patrol cycle pulls `origin/main`, and the fixer works in git worktrees.
- An LLM for the agents: an agent CLI (Claude Code, Codex, Kimi CLI, or pi), or an API key.
- For web apps: Chromium for Playwright. Install it one time:

  ```bash
  PLAYWRIGHT_SKIP_BROWSER_GC=1 npx -y playwright@1.48.2 install chromium
  ```

- For iOS: Xcode and a booted simulator. For Android: the Android SDK and a running emulator. For both: [Maestro](https://maestro.mobile.dev).
- For Electron: an app build that opens a CDP port (`--remote-debugging-port`).
- For GitHub: a logged-in [`gh`](https://cli.github.com) CLI.

You do not need to install Bugpatrol. Run each command with `npx bugpatrol`. You can also add it to your project:

```bash
npm install --save-dev bugpatrol     # then: npx bugpatrol ...
```

## Before you start: launch and sign in

Bugpatrol needs two things from you:

1. **A way to launch the app on this machine.** This is usually the command that you use for local work, for example `npm run dev`. The app must start with no manual steps. For mobile, the app must be installed on the simulator or the emulator.
2. **A way to sign in**, if the app has a sign-in. Use one of these, best first:
   - The app starts signed in: a dev auth bypass, a seeded session, or a deep link that installs a session.
   - A setup command makes a test user: a seed script, or a test-only login endpoint.
   - A test account: put the email and the password in environment variables, and list them in `app.secrets`.

The explorer cannot get through a one-time code, a CAPTCHA, or a third-party SSO page. If your sign-in has one of these, add a test bypass for development. Never use a production system or a real user's account.

## 1. Run init

Run this command in your repo:

```bash
npx bugpatrol init
```

`init` finds your app and the LLMs on your machine, and it asks you some questions. It puts each detected value on the input line. Push Enter to keep the value, or edit it:

1. The kind of app (web, Electron, iOS, or Android), the command that starts it, and its URL or app ID. `init` reads these from `package.json`, the Vite config, `.env`, `app.json`, `app.config.ts`, the Xcode project, and the Gradle files.
2. The LLM for each agent: the explorer, the judge, and the fixer. An installed agent CLI (Claude Code, Codex, Kimi CLI, or pi) comes first, because it needs no API key. If you have no CLI, `init` recommends an OpenRouter or a Vercel AI Gateway key, and shows where to get one.

`init` puts all the Bugpatrol files in one `.bugpatrol/` folder, and it never overwrites a file:

```text
.bugpatrol/
  bugpatrol.yml     # the config: commit it
  instructions.md    # the app guide for the explorer: commit it
  appmap.json        # the screens the explorer found: commit it
  routines/          # the routines Bugpatrol replays with no model: commit them
  runs/              # the local data and screenshots: init adds it to .gitignore
```

To use the detected values with no questions, add `--yes`. To select the LLM, add `--agent`:

```bash
npx bugpatrol init --yes --agent claude     # claude | codex | kimi | pi | openrouter | vercel | openai | anthropic
npx bugpatrol init --yes --explorer claude --judge claude --fixer codex
```

## 2. Check how Bugpatrol starts your app

Open `.bugpatrol/bugpatrol.yml`, and correct the values that `init` could not know. All paths in the file are relative to the project root, the folder that holds `.bugpatrol/`. You can run Bugpatrol from any folder in the project.

This example is a web app with a dev server:

```yaml
version: 1

app:
  platform: web                      # web | electron | ios | android
  source: .                          # the repo that the fixer edits
  setup:
    - run: npm run dev
      background: true               # keep it alive for the session
      readyWhen: 'Local:|ready'      # wait until the output matches this regex
  connect:
    url: http://localhost:3000
  instructions: .bugpatrol/instructions.md
```

This example is an Electron app:

```yaml
version: 1

app:
  platform: electron
  source: .
  setup:                             # your commands: build, start, sign in a test user
    - run: ./scripts/start-test-app.sh
      capture: { CDP_PORT: 'CDP :(\d+)' }   # a value from the output, for later steps
  teardown:
    - run: ./scripts/stop-test-app.sh
  connect:
    cdp: http://127.0.0.1:${CDP_PORT}
  instructions: .bugpatrol/instructions.md
```

For iOS and Android, set `platform: ios` or `platform: android`, and set `connect.appId` to the bundle ID or the package name. Bugpatrol uses the booted simulator or the running emulator. To select a different device, set `connect.device`. The [examples](development.md#examples) show a full Electron setup and a full iOS setup.

## 3. Write the app guide

`.bugpatrol/instructions.md` is plain English for the explorer. `init` writes a template. Write it like a note to a new tester:

```markdown
# My App
My App is a chat workspace. The sidebar lists the channels.

## Sign in
Sign in with the email {{TEST_EMAIL}} and the password {{TEST_PASSWORD}}.

## Onboarding
Type `Bugpatrol` as the first name. For the username, type `bugpatrol-{{RUN_TAG}}`.

## Never do these things
- Do not delete the workspace. Do not invite a person by email.
```

To give the explorer a secret, list its environment variable in `app.secrets`:

```yaml
app:
  secrets: [TEST_EMAIL, TEST_PASSWORD]
```

Secrets and captured values reach the model only as `{{NAME}}` placeholders. Bugpatrol puts in the real value only when it acts on the app. It hides the value in all logs.

## 4. Check the model keys

If an agent uses an API key, set the key in your shell:

```bash
export OPENROUTER_API_KEY=...
```

Before an agent command starts the app, Bugpatrol checks each agent's LLM. If a key or a CLI is missing, it stops and tells you what to do. Refer to [LLMs](models.md) for all the providers.

## 5. Explore, and look at the results

```bash
npx bugpatrol explore        # one explorer session: it signs in, maps screens, reports problems
npx bugpatrol judge          # the judge decides which reports are real and files the issues
npx bugpatrol dashboard      # http://127.0.0.1:4311
npx bugpatrol issue list     # the same issues, in the terminal
```

The first session maps the app and learns **routines**. A routine is a path that Bugpatrol can replay later with no model, for example `enter-app`. Each later session starts from what it already knows.

## 6. Let it fix bugs

```yaml
agents:
  fixer:
    enabled: true
    commitMessage: 'fix(app): {title}'     # match your commit hook
    retest: { prepare: npm ci }            # installs the dependencies in each new worktree
    verify: npm run typecheck && npm test  # Bugpatrol runs this after each fix
    use: claude                            # or codex, kimi, pi, or an API key
```

Set `verify` to the checks that a fix must pass. Bugpatrol runs the command itself after the fixer stops, so a fix never depends on the agent to run it. If `verify` fails, the fix fails, and the fixer gets a lesson with the error.

```bash
npx bugpatrol fix            # fix the worst open issues, then retest each fix in the app
```

Each fix gets a branch `bugpatrol/fix-<issue>` and a git worktree under `.bugpatrol/runs/worktrees/`. Bugpatrol links your ignored `.env` files into each worktree. Then it starts the app from the worktree, and the explorer repeats the flow. The judge compares the before and after screenshots. If the bug is still there, the fixer tries again with the judge's feedback.

## 7. Publish to GitHub

```yaml
agents:
  github: { enabled: true }
```

```bash
npx bugpatrol publish --dry-run   # write the reports to .bugpatrol/runs/publish/ and look at them
npx bugpatrol publish             # open the PRs and issues
```

[GitHub](github.md) tells what Bugpatrol publishes, what it changes in the repo, and how it syncs the state back.

## 8. Run it all day

```bash
npx bugpatrol                     # setup → explore → judge → teardown → fix → retest → publish, then repeat
npx bugpatrol --once              # one cycle
```

## Next steps

- [LLMs](models.md): what each agent does, and the providers for each agent.
- [Configuration](configuration.md): all the settings.
- [Commands](commands.md): all the commands.
- [The dashboard](dashboard.md): what each page shows.
- [How it works](how-it-works.md): the cycle, noise control, memory, and safety.
