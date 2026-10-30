# The earlier name: Bughunters

Bugpatrol had the name Bughunters before. The old names continue to work:

- `npx bughunters` installs and runs the same version of Bugpatrol. `npx bughunters patrol` is the same as `npx bugpatrol`.
- A repo with `.bughunters/bughunters.yml` keeps that folder. Bugpatrol reads it when the repo has no `.bugpatrol/bugpatrol.yml`.
- The `BUGHUNTERS_*` environment variables work when the `BUGPATROL_*` variable with the same name is not set.
- The GitHub sync also finds the PRs and issues that have the `bughunters` label.
- `data-bughunters-safe` and `data-bughunters-destructive` have the same effect as the `data-bugpatrol-*` attributes.

## Move a repo to the new names

1. Rename `.bughunters/` to `.bugpatrol/`.
2. Rename `bughunters.yml` to `bugpatrol.yml`.
3. Change the `.gitignore` line to `.bugpatrol/runs/`.
