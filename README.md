# peardrop-cli

Send files and folders between devices from the terminal. It runs on the
[Hyperdrive](https://docs.holepunch.to/building-blocks/hyperdrive) stack (Hyperdrive +
Corestore + Hyperswarm) for the peer-to-peer part and
[OpenTUI](https://github.com/anomalyco/opentui) for the interface.

```bash
peardrop share ./photos          # copy files into a drive, print a sharelink and a QR code
peardrop get peardrop://…        # connect, read the file list, download
```

The transfer engine in `src/engine/` is the same engine the PearDrop desktop app uses; see
[`docs/ENGINE.md`](docs/ENGINE.md) for where it came from and how to keep it in sync.

## Requirements: Node.js ≥ 26.4

OpenTUI's Node build uses the built-in `node:ffi` module, which arrived in Node 26.4. Everything
runs in one Node process: no second engine, no IPC.

```bash
npm install          # installs the engine's native modules and builds dist/ (prepare)
npm link             # optional: puts `peardrop` on your PATH
```

## Usage

```
peardrop share <file|directory> [--no-copy] [--bootstrap host:port] [--json]
peardrop get <sharelink> [-o <dir>] [--bootstrap host:port] [--json]
```

**share**
- A file is shared as `/name`. A folder is shared recursively as `/folder/…`, and receivers get
  the same tree back.
- Files are **copied into a drive** before the link exists, so sharing needs room for a second
  copy of the data, and later edits to the originals are not picked up.
- The link appears once the drive is built; it is announced on the DHT right after that. The
  "Ready to share" banner turns into "announcing…" until the announcement lands.
- The sharelink is **copied to your clipboard automatically** as soon as it exists (`--no-copy`
  turns this off). Locally it goes to the OS clipboard (Windows, macOS, X11, Wayland) through
  OpenTUI's native clipboard. Over SSH, or when no OS clipboard is available, it is sent to your
  terminal via OSC 52, so it lands on the machine you're typing on.
- Keys: `c` copies the link again, `r` toggles a full-screen QR code, `↑↓` / `PgUp` / `PgDn` /
  `g` / `G` scroll, `f` re-enables auto-follow, `q` stops sharing.
- Empty files are shared and downloaded normally.

**get**
- The screen shows the steps in order: finding the sender → reading the file list → downloading.
- Files are fetched one at a time and written straight to disk. Progress is byte-based, with a
  live speed; a stall watchdog fails the transfer instead of hanging when the sender disappears.
- A folder share lands in `<out>/<folder>/…`. A single file lands in `<out>/`.
- Existing files are never overwritten: a second copy becomes `name (1).ext`.
- Paths from the sender are sanitised; nothing can be written outside the output folder.
- `q` cancels: files already written are kept, the partial one is removed.

Each run uses its own throw-away data root under `~/.peardrop/sessions/`. Anything printed while
the TUI is open goes to `~/.peardrop/peardrop.log`. Set `PEARDROP_HOME` to move both.

## Headless mode (`--json`)

`--json` runs the same share/get logic without the TUI and prints newline-delimited JSON on
stdout, one event per line. It is what the e2e tests use, and it is the stable surface for
scripts:

```bash
peardrop share ./photos --json &
# {"event":"share-started","input":"…","files":9,"bytes":4230000}
# {"event":"progress","phase":"copying","filesDone":4,"files":9,"bytesDone":2100000,"bytes":4230000}
# {"event":"sharelink","link":"peardrop://…","driveId":"drive_…"}
# {"event":"ready","files":9,"bytes":4230000}
# {"event":"announced"}

peardrop get peardrop://… -o ./out --json
# {"event":"opened","files":9,"bytes":4230000,"name":"photos","driveId":"recv_…"}
# {"event":"progress","percent":42,"bytes":1770000,"total":4230000,"speed":812000,"filesDone":3,"files":9}
# {"event":"file-done","path":"…/out/photos/nested/a.txt","key":"/nested/a.txt","size":7}
# {"event":"done","files":9,"total":9,"bytes":4230000,"path":"…/out/photos","partial":false,"failed":0}
```

Exit codes: `0` success, `1` failure (including a partial download), `2` usage error.
`share` keeps running until it gets `SIGINT`/`SIGTERM`, because that is what sharing is.

## Local testing (no public DHT)

```bash
npm run dev:bootstrap                       # 127.0.0.1:49737
node bin/peardrop.mjs share ./some-folder --bootstrap 127.0.0.1:49737
node bin/peardrop.mjs get '<link>' -o ./out --bootstrap 127.0.0.1:49737
```

Two *separate processes* on one machine can fail to holepunch when both are marked firewalled by
HyperDHT: the client opens a stream the server never sees, then times out. The e2e tests work
around it with `node -r ./scripts/e2e-unfirewalled.cjs` (see the file for why). Between two
machines no workaround is needed.

## Tests

```bash
npm run typecheck   # strict TypeScript over the CLI and the engine
npm test            # unit tests + an in-process DHT roundtrip (no TUI, no tmux)
npm run e2e         # two real CLI processes + local bootstrapper + byte comparison
npm run e2e:tui     # the same over the real TUI, needs tmux (local only)
```

`npm test` includes `test/engine/roundtrip.test.ts`, which starts a private DHT testnet and
drives `ShareController`/`GetController` end to end: folder tree, empty file, single file, invalid
link, and cancelling while waiting for a sender.

## Layout

```
bin/peardrop.mjs        launcher: Node version check, FFI warning filter
src/cli.tsx             renderer setup, shutdown
src/cli/args.ts         argument parsing and --help
src/cli/headless.ts     --json mode (share/get without the TUI)
src/core/session.ts     throw-away engine session per run
src/core/share.ts       ShareController: collect sources, build the drive, seed it
src/core/get.ts         GetController: open the link, download, report progress
src/core/store.ts       throttled external store for useSyncExternalStore
src/engine/             the transfer engine (see docs/ENGINE.md)
src/shared/             backend-neutral transfer/bootstrap types used by the engine
src/ui/*                OpenTUI React screens and widgets
scripts/                local bootstrapper, test-only DHT preload, e2e runners
```

## Contributing

Work starts from an issue and lands on `develop` through a PR; `main` only holds releases.

```bash
git switch develop && git pull --ff-only
git switch -c feat/42-resume-download
# … make the change, then describe it for the changelog:
npx changeset
```

PRs into `develop` are squash-merged and must pass typecheck, unit tests, the DHT roundtrip,
headless e2e, `pr-title` and `changeset`. Releases are cut from `develop` with
`npm run release:prepare` and merged into `main`, where CI tags `vX.Y.Z` and publishes a GitHub
Release. Read [CONTRIBUTING.md](CONTRIBUTING.md) and
[RELEASING.md](RELEASING.md) for the full flow, branch naming and versioning.

The current version is **0.1.0**; see [CHANGELOG.md](CHANGELOG.md).
