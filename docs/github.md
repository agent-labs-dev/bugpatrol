# GitHub

Bugpatrol can publish its results to your GitHub repo:

- A **pull request** for each fix that the fixer wrote.
- A **GitHub issue** for each bug at `issueMinSeverity` or worse that has no fix.

It uses the [`gh`](https://cli.github.com) CLI, with your own login. GitHub is off until you turn it on.

## 1. Check gh

```bash
gh auth status
```

The account must be able to push branches, and open PRs and issues, in the repo. The default `gh auth login` scopes (`repo`) are enough.

`bugpatrol doctor` also checks gh when GitHub is on.

## 2. Turn it on

```yaml
agents:
  github:
    enabled: true
    pullRequests: draft          # draft | ready
    issueMinSeverity: major      # a bug with no fix becomes an issue at this severity or worse
```

All the settings:

| Setting | Default | What it does |
| --- | --- | --- |
| `enabled` | `false` | Turns publish and sync on |
| `repo` | the repo of `app.source` | The repo, as `owner/name` |
| `pullRequests` | `draft` | Open PRs as drafts, or as ready for review |
| `issueMinSeverity` | `major` | The lowest severity that becomes a GitHub issue |
| `labels` | `[bugpatrol]` | The labels on each PR and issue. The first label also finds them again for sync |
| `assetsBranch` | `bugpatrol-assets` | The branch that holds the report images |
| `prScope` | from `fixer.commitMessage` | The scope in PR titles, for example `app` in `fix(app): ...` |
| `ci.enabled` | `true` | Watch the CI checks of each PR, and fix a failed check |
| `ci.attempts` | `2` | The fixer attempts for each PR before Bugpatrol stops |
| `ci.waitMinutes` | `20` | How long one cycle waits for the running checks |

For PRs, also turn on the fixer. Refer to [Getting started](getting-started.md#6-let-it-fix-bugs).

## 3. Look at the reports first

```bash
npx bugpatrol publish --dry-run
```

The judge writes each report to `.bugpatrol/runs/publish/<issue>.md`. Nothing goes to GitHub. The command lists each draft:

```text
  issue draft iss_a366e07f8376  .bugpatrol/runs/publish/iss_a366e07f8376.md
  PR draft    iss_c72d694ed42f  .bugpatrol/runs/publish/iss_c72d694ed42f.md
Wrote 1 PR(s) and 1 issue(s); skipped 0.
```

## 4. Publish

```bash
npx bugpatrol publish                 # all the items that are ready
npx bugpatrol publish --issue <id>    # one item
```

The command lists each URL:

```text
  issue       iss_a366e07f8376  https://github.com/acme/app/issues/2156
  PR          iss_c72d694ed42f  https://github.com/acme/app/pull/2157
Opened 1 PR(s) and 1 issue(s); skipped 0.
```

Each issue has a repro routine in `.bugpatrol/routines/repro-<hash>.json`. The judge saves it when it files the issue, and the issue body names it in a hidden line, `<!-- bugpatrol:routine repro-<hash> -->`. Commit the routine. Then any clone of the repo can replay the bug from the issue number alone, for example to check a pull request that closes the issue.

`patrol` runs the same step at the end of each cycle.

### What Bugpatrol publishes

| Item | When |
| --- | --- |
| A PR | The issue has a fix that the retest verified, and no PR yet. A fix that no retest can judge (the retest is off, or the issue has no flow to replay) also gets a PR |
| A GitHub issue | The issue is at `issueMinSeverity` or worse, has no fix (or its fix failed), and has no GitHub issue yet |
| Nothing | A dismissed issue, a fixed issue, an issue whose PR the team closed, or a fix that the retest did not verify (❔ unclear or ⚠️ not fixed). The dashboard shows that fix as "Fix not verified" |

The judge reads each item before it publishes it. It can skip an item that is clearly not a product bug, and it gives the reason. The judge also sees the Bugpatrol PRs and issues on GitHub, from every machine that runs a patrol on the repo. It skips an item that one of them already covers.

### What Bugpatrol changes in the repo

- It makes the labels in `labels`, if they do not exist.
- It pushes the orphan branch `bugpatrol-assets`, with the screenshots of each report. The images never enter a PR diff. Do not merge this branch.
- For each PR, it commits the fix on `bugpatrol/fix-<issue>`, and it pushes that branch. The commit runs your hooks. Bugpatrol never uses `--no-verify`, and it never force-pushes.

### What a report contains

- A short summary by the judge.
- What happened, what was expected, and the steps.
- The screenshots.
- For a PR: the cause, the change, the diff stat, the `verify` command that passed, and the retest: before and after screenshots, with the judge's verdict.
- The severity, and how many times Bugpatrol saw the bug.

Review each PR as you review a PR from a person.

## 5. Make CI green

After a PR opens, Bugpatrol watches its CI checks:

```bash
npx bugpatrol ci --wait             # wait for the checks, and fix a failed one
npx bugpatrol ci --issue <id>       # one PR
```

1. Bugpatrol reads the checks with `gh pr checks`.
2. When a check fails, the fixer gets the end of the failed log (`gh run view --log-failed`). It fixes the cause in the fix worktree, and it runs `fixer.verify`.
3. Bugpatrol commits the change on the same branch, and pushes it. It never force-pushes. The PR then runs its checks again.
4. After `ci.attempts` tries, Bugpatrol stops. The dashboard shows `CI red` on the PR, and `patrol --once` exits with code 1. A person must then look at the PR.

`patrol` runs this step after publish, and it waits up to `ci.waitMinutes`. A check that still runs goes to the next cycle. The PR chip on the dashboard shows the state: `CI running`, `CI green`, `CI failed, fixing`, or `CI red`.

## 6. Sync the state back

```bash
npx bugpatrol github sync
```

Bugpatrol reads each PR and issue that has the first label, and it updates its own issues:

| On GitHub | In Bugpatrol |
| --- | --- |
| The PR is merged | The fix shows the PR as merged |
| The PR is closed with no merge | The fix is rejected. The judge and the fixer get a lesson, so they do not propose that change again |
| The issue is closed as completed | The issue is `fixed` |
| The issue is closed as not planned | The issue is `dismissed`, and the finding does not come back |
| The issue is opened again | The issue is `filed` again |

`publish` runs a sync after it publishes. While the dashboard runs, it syncs every 5 minutes. The Issues page shows the PR or issue number and its state. `bugpatrol issue list` shows the numbers too.

## 7. Review a pull request

```bash
npx bugpatrol review 123                # the number or the URL of the pull request
npx bugpatrol review 123 --dry-run      # write the review to a local file, and send nothing to GitHub
```

`review` tests a pull request of your team in the running app, and it posts a GitHub review of the problems that the pull request introduces. It does not open a PR or an issue.

1. Bugpatrol fetches the pull request and its base branch. It compares the pull request commit with the merge base: the base branch as it was when the pull request left it.
2. It starts the app from the pull request commit, in its own worktree. The explorer reads the diff, and it tests the screens and the flows that the change can affect. It does not test the rest of the app.
3. If the explorer reports nothing, the review ends here. If not, Bugpatrol starts the app from the merge base, and the explorer repeats the flow of each report on that build.
4. The judge compares the two screenshots of each report, and it reads the diff. It gives each report one verdict:

   | Verdict | Meaning | In the review |
   | --- | --- | --- |
   | Introduced | The pull request build shows the problem, and the base build does not | A comment on the changed line that causes it, with both screenshots and the steps. When the judge finds no such line in the diff, a section of the review body |
   | Already on the base branch | The base build shows the problem too | A folded list. A later `bugpatrol judge` can file it as a normal issue |
   | Could not compare | The flow did not reach the same screen on the base build, and the diff does not show the cause | A folded list |
   | Not a bug | The difference is what the pull request intends, or the explorer made a mistake | A folded list |

5. Bugpatrol posts a pull request review with the event `COMMENT`. It never approves and never requests changes, so it does not block the merge. `review` sets no check.
6. A new test of the pull request posts a new review. Bugpatrol then replaces the body of each older review with one line, and it deletes the line comments of that review. A comment that a person answered stays.

`.bugpatrol/runs/reviews/pr-<number>.json` holds the last review of each pull request. When you run `review` again on the same commit, Bugpatrol tests nothing: it updates the body of the review that the commit has, or it posts the review when the commit has none. Use `--force` to test the same commit again.

What you must know before you run it:

- **The code of the pull request runs on your machine, with the secrets of the app.** Bugpatrol refuses a pull request from a fork. Read the diff first. If you trust it, add `--allow-fork`.
- **One machine runs one app.** `review` does not start while a patrol runs on the same machine.
- **Each build needs its dependencies.** Set `agents.fixer.retest.prepare` to the install command of your repo, for example `pnpm install --frozen-lockfile`. Bugpatrol runs it in each of the two worktrees. Bugpatrol removes the worktrees after the review.
- **The pull request build changes nothing that the patrol knows.** The explorer of a review records no screen, no routine, and no lesson.
- **Bugpatrol finds its reviews by a marker in the body, not by the account.** So the review can come from your `gh` login on one day and from a CI token on the next, and the older review is still replaced. In GitHub Actions, give `gh` a token in `GH_TOKEN` that has `pull-requests: write`, and `contents: write` for the screenshots on the assets branch.
- The step limit of the explorer is `agents.explorer.maxSteps`. Use `--steps N` for a different limit. The base build uses `agents.fixer.retest.maxSteps`, or 12 steps for each report when that is more.
- When the app does not start from the pull request commit, `review` stops with an error and posts no review.

## Troubleshooting

| Message | Action |
| --- | --- |
| `GitHub is off` | Set `agents.github.enabled: true`, or use `publish --dry-run` |
| `the gh CLI is not installed` | Install it from https://cli.github.com |
| `gh is not logged in` | Run `gh auth login` |
| `PR #<n> comes from a fork` | A review runs the code of the pull request. Read the diff, then add `--allow-fork` |
| `A patrol runs (pid <n>)` | Stop the patrol, or run `review` when the patrol waits for a new commit |
| `Nothing to publish` | No item matches the table in [What Bugpatrol publishes](#what-bugpatrol-publishes). Run `bugpatrol issue list`, and check the severities and the fixes |
| The commit hook rejected a commit | The fixer gets a lesson with the hook error. Fix the hook error in the worktree, or run `bugpatrol fix --issue <id>` again |
| The images do not show | The repo is private, and the reader is not signed in to GitHub, or has no access |
