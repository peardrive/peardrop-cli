<!--
Title must follow Conventional Commits — it becomes the squash commit on develop:
  feat: add --json to peardrop get       fix: keep get from overwriting files
  docs: explain the sharelink format     chore: bump @opentui
Breaking change? Add "!" after the type: feat!: rename --out to --output
-->

Closes #

## What changed

<!-- What the CLI does now that it didn't before, and why. -->

## How to test

<!-- Commands you ran, e.g. `npm run e2e` or a manual share/get between two terminals. -->

## Checklist

- [ ] Branch is named `<type>/<issue>-<short-name>` and targets **develop**
- [ ] Changeset added (`npx changeset`) — or label `no-changeset` for repo-only changes (CI, tooling)
- [ ] `npm run typecheck` and `npm test` pass; `npm run e2e` if the engine or transfer path changed
- [ ] README / `docs/` updated if the CLI surface changed
- [ ] Breaking changes called out in the changeset with a migration note
- [ ] No `pearcore` references (the retired engine)
