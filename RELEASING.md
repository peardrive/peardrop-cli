# Workflow and releases

peardrop-cli follows GitFlow. `main` only ever holds released, tagged versions; all work happens
on short-lived branches that land on `develop`; a release moves `develop` into `main`.

```
 issue #42 ─▶ feat/42-resume-download ─┐
 issue #57 ─▶ fix/57-stall-watchdog   ─┼─ squash ─▶ develop ─▶ release PR ─▶ main ─▶ tag v0.1.1
 issue #63 ─▶ chore/63-bump-opentui   ─┘                     (merge commit)        + GitHub Release
```

| Branch | Holds | Merged in by | Protected |
| --- | --- | --- | --- |
| `main` | Released versions only. Every commit is tagged `vX.Y.Z`. | Merge commit from `develop` (or `hotfix/*`) | Yes |
| `develop` | Everything finished and reviewed, waiting for the next release. | Squash merge | Yes |
| `<type>/<issue>-<name>` | One issue's work. Deleted after merge. | — | No |

Reading history:

- `git log --oneline develop` — one commit per issue, in Conventional Commit form.
- `git log --oneline --first-parent main` — one merge per release.

## 1. Start with an issue

Every change starts as an issue, using one of the templates:

- **Feature request** — the problem, the proposed command/flag/event, and whether it is additive or breaking.
- **Bug report** — version, Node version, platform, mode (`--json` or TUI), reproduction and logs.
- **Task / chore** — tooling, CI, dependencies, refactoring.

Triage it (`status: triage` → `status: ready`) and assign it to a milestone named after the release
it should ship in, e.g. `v0.2.0`.

## 2. Branch from develop

```bash
git switch develop && git pull --ff-only
git switch -c feat/42-resume-download
```

Branch types: `feat/` (new command, flag, event or behaviour), `fix/`, `docs/`, `refactor/`,
`perf/`, `test/`, `build/`, `ci/`, `chore/`. Commit as often as you like — they are squashed away.

## 3. Add a changeset

Before opening the PR, describe the change for the changelog:

```bash
npx changeset
```

Pick the bump (see [`.changeset/README.md`](.changeset/README.md)) and write a sentence or two for
people using the CLI. Commit the generated `.changeset/*.md` file. CI/tooling-only PRs can skip this
with the `no-changeset` label.

## 4. Open a pull request into develop

- **Title** in Conventional Commit form — it becomes the commit on `develop`:
  `feat: add --resume to peardrop get`, `fix: keep get from overwriting existing files`,
  `chore: bump @opentui to 0.5.12`.
  Breaking: `feat!: rename --out to --output`.
- **Body**: `Closes #42` so the issue closes on merge.
- CI runs on Linux: `verify` (install + build, typecheck, unit tests and the DHT roundtrip),
  `e2e` (two real CLI processes against a local bootstrapper), `pr-title`, and `changeset`.
- Merge with **Squash and merge**. Delete the branch.

## 5. Release

When `develop` has what the milestone needs:

```bash
git switch develop && git pull --ff-only
npm run release:prepare
```

This creates `release/vX.Y.Z`, runs `changeset version` (bumps `package.json`, writes
`CHANGELOG.md`, removes the consumed changesets), syncs `package-lock.json` and commits
`chore(release): vX.Y.Z`. Then:

1. `git push -u origin release/vX.Y.Z` and open a PR **into develop** titled `chore(release): vX.Y.Z`.
   Review the changelog, squash-merge.
2. Open a PR **develop → main** titled `release: vX.Y.Z`. CI's `release-source` check confirms it
   comes from `develop`, the version is new and no changesets are left. Merge with **Create a merge
   commit**.
3. The **Release** workflow tags the merge commit `vX.Y.Z`, builds and smoke-tests the package,
   and publishes a GitHub Release with that version's changelog section and the installable
   `peardrop-cli-X.Y.Z.tgz` attached.
4. Close the milestone.

GitHub will show `develop` as "1 commit behind main" after each release. That is the release merge
commit and is expected; don't merge `main` back into `develop`.

### The first release: v0.1.0

`0.1.0` is the first published version. The repo carried a pre-release placeholder version
(`0.2.0`) before anything was tagged, so the first release branch resets `package.json` and
`package-lock.json` to `0.1.0` and adds the initial `CHANGELOG.md` by hand. There are no changesets
to consume yet. From `0.1.1` onward the normal `npm run release:prepare` flow above applies.

## Hotfixes

Normally a fix just goes through `develop` and you cut a patch release right away. If `develop`
holds unreleased work that can't ship yet:

1. `git switch -c hotfix/71-stall-on-resume origin/main`, fix it, `npx changeset` (patch).
2. Run `npx changeset version`, then `npm install --package-lock-only`, and commit
   `chore(release): vX.Y.Z`.
3. PR `hotfix/71-stall-on-resume` → `main` titled `release: vX.Y.Z`, merge commit. The tag, the
   package and the Release are created automatically.
4. Bring the fix to develop: `git switch -c fix/71-port-hotfix origin/develop`,
   `git cherry-pick <hotfix commits>`, PR into `develop` with label `no-changeset`, squash-merge.

## Versioning

peardrop-cli follows [SemVer](https://semver.org). While it is `0.x`, a minor bump (`0.1 → 0.2`) is
the breaking one, because people pin to a release tag and expect only compatible changes within a
minor. Patch releases are bug fixes and internal work.

## Using a release

Releases are the supported points to install from. Each one carries the built package, so no
clone or build is needed:

```bash
# newest release
npm install -g https://github.com/peardrive/peardrop-cli/releases/latest/download/peardrop-cli.tgz

# or pin a version
npm install -g https://github.com/peardrive/peardrop-cli/releases/download/v0.1.0/peardrop-cli-0.1.0.tgz
```

The tarball is what `npm pack` produces from `bin/` and `dist/` (`files` in `package.json`); its
dependencies come from npm, and Node.js ≥ 26.4 is required. Every release also has the source
archives GitHub generates for the tag, if you want to read the code:

```bash
git clone --branch v0.1.0 https://github.com/peardrive/peardrop-cli.git peardrop-cli
cd peardrop-cli && npm install && npm link
```

Installing from `main` gets the latest release; installing from `develop` gets unreleased work and
is not supported for day-to-day use.

A release is published by the **Release** workflow (`.github/workflows/release.yml`) on every push
to `main`. It builds and smoke-tests the package before tagging, so a broken build leaves no tag
behind; if the version was not bumped, the job fails instead of moving the existing tag. Re-running
a failed job re-uploads the assets to the existing release.

## One-time GitHub setup (maintainer)

1. Rename the default branch to `main` (the old `master` baseline is `main` now), push `main` and
   create/push `develop`.
2. **Settings → General → Pull Requests**: allow *merge commits* and *squash merging*, disable
   *rebase merging*; set squash commit message to *Pull request title and description*; enable
   *Automatically delete head branches*.
3. **Settings → Rules → Rulesets → New ruleset → Import a ruleset**, once for each file in
   [`.github/rulesets/`](.github/rulesets): `main.json`, `develop.json`, `release-tags.json`.
4. **Settings → Actions → General → Workflow permissions**: *Read and write permissions* (the
   Release workflow pushes tags and creates releases).
5. **Actions → Repo setup (labels) → Run workflow** to create the labels.
6. Create a milestone for the next release (`v0.2.0`).

To add required reviews once more people are on the team, raise `required_approving_review_count`
in the `main` and `develop` rulesets.
