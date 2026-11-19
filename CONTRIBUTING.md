# Contributing

## How work flows

Every change starts as a GitHub issue (feature request, bug report or task), is built on its own
branch off `develop`, and lands through a pull request. `main` only receives releases.

```
issue #42 ─▶ feat/42-resume-download ─▶ PR into develop (squash) ─▶ release PR develop → main ─▶ v0.1.1
```

In short:

1. Pick up an issue marked `status: ready`.
2. `git switch develop && git pull --ff-only && git switch -c feat/42-resume-download`
3. Build it, with tests. Commit as often as you like.
4. `npx changeset` to describe the change for the changelog, and commit the file.
5. Open a PR **into develop** with a Conventional Commit title (`feat: add --resume to peardrop get`)
   and `Closes #42` in the body.
6. Once CI is green, **Squash and merge**.

Branch types: `feat/`, `fix/`, `docs/`, `refactor/`, `perf/`, `test/`, `build/`, `ci/`, `chore/` —
always followed by the issue number. Releases, hotfixes, versioning and the one-time GitHub setup
are in [RELEASING.md](RELEASING.md).

## Setup

Requires Node.js ≥ 26.4 (OpenTUI's Node build uses `node:ffi`).

```bash
npm install       # installs native modules and builds dist/ (prepare)
npm run typecheck # strict TypeScript over the CLI and the engine
npm test          # unit tests + in-process DHT roundtrip
npm run e2e       # two real CLI processes + local bootstrapper + byte comparison
npm link          # optional: puts `peardrop` on your PATH
```

`npm run e2e:tui` drives the real TUI and needs `tmux`; it is local-only. See the [README](README.md)
for usage, the `--json` event surface and local testing against a private bootstrapper.

## Project layout

```
bin/                    launcher: Node version check, FFI warning filter
src/cli.tsx             renderer setup, shutdown
src/cli/                argument parsing, --help, headless --json mode
src/core/               ShareController, GetController, session, external store
src/engine/             the transfer engine (see docs/ENGINE.md)
src/shared/             backend-neutral transfer/bootstrap types
src/ui/                 OpenTUI React screens and widgets
scripts/                bootstrapper, e2e runners, release prep
test/                   unit and engine roundtrip tests
docs/                   ENGINE.md (engine provenance and re-sync notes)
.changeset/             pending changelog entries, consumed at release time
.github/                issue/PR templates, CI and release workflows, branch rulesets
CONTRIBUTING.md         this file
RELEASING.md            GitFlow, releases, hotfixes, one-time setup
```

## Rules of thumb

1. **The engine is a copy, not a dependency.** `src/engine/` mirrors the PearDrop desktop app's
   engine; keep edits minimal and record them in [docs/ENGINE.md](docs/ENGINE.md) so a re-sync stays a
   straight copy.
2. **The retired engine stays retired.** It must not come back; CI's guard job fails the build if
   its name appears in `src`, `scripts`, `bin`, `test`, `docs`, `README.md` or `package.json`.
3. **Never write outside the output folder.** Paths from a sharelink are sanitised in the receive
   path; keep it that way.
4. **Existing files are never overwritten.** A second download of `name.ext` becomes
   `name (1).ext`.
5. **`--json` is a stable surface.** Event names and fields are what scripts consume; changing or
   removing one is a breaking change and needs a changeset that says so.
6. **Test both ends.** Engine or transfer changes need `npm test` and `npm run e2e`; UI-only changes
   at least need `npm run typecheck` and a manual TUI run.
7. **Public surface changes need a changeset.** Renaming or removing a command, flag, event or exit
   code is breaking: say so in the changeset and include a migration note.
