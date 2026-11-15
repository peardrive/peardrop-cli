# peardrop-cli

Send files and folders between devices from the terminal. It runs on [pearcore](https://github.com/peardrive/pearcore) for the peer-to-peer part and [OpenTUI](https://github.com/anomalyco/opentui) for the interface.

```bash
peardrop share ./photos          # index files, print a sharelink and a QR code
peardrop get peardrop://…        # connect, list files live, download N at a time
```

This repo is also a test bed for pearcore. Everything that needed a workaround is written up in [`docs/PEARCORE_ISSUES.md`](docs/PEARCORE_ISSUES.md).

## Requirements: Node.js ≥ 26.4

OpenTUI's Node build uses the built-in `node:ffi` module, which arrived in Node 26.4. pearcore uses `better-sqlite3`, which Bun can't load. The only runtime that supports both is **Node 26.4 or newer**, so everything runs in one Node process: no Bun, no second engine, no IPC.

```bash
npm install          # builds better-sqlite3 for your Node, and builds dist/ (prepare)
npm link             # optional: puts `peardrop` on your PATH
```

## Usage

```
peardrop share <file|directory> [--no-copy] [--bootstrap host:port]
peardrop get <sharelink> [-o <dir>] [-n <concurrency>] [--bootstrap host:port]
```

**share**
- A file is shared as `/<name>`. A folder is shared recursively as `/<folder>/…`.
- Files are indexed (Merkle-hashed) 4 at a time. Each one is published as soon as its `LocalFileEntry` fires `onComplete`, and the "Ready to share" banner appears once all of them are done.
- The sharelink is **copied to your clipboard automatically** as soon as it exists (`--no-copy` turns this off). Locally it goes to the OS clipboard (Windows, macOS, X11, Wayland) through OpenTUI's native clipboard. Over SSH, or when no OS clipboard is available, it is sent to your terminal via OSC 52, so it lands on the machine you're typing on.
- Keys: `c` copies the link again, `r` toggles a full-screen QR code, `↑↓` / `PgUp` / `PgDn` / `g` / `G` scroll, `f` re-enables auto-follow, `q` stops sharing.
- Empty files are skipped (pearcore issue 2.1).

**get**
- The screen shows the steps in order: waiting for connection → connection established → listing files (live; refreshed on every `SpaceFileEvent` and every second) → downloading.
- At most `-n` downloads run at once (default 3). A new one starts only when a running `SpaceDownloadTask` fires `onComplete`.
- Files that already exist at the destination are skipped. Paths that would escape the output folder are refused.
- In-progress data lives in `<out>/.peardrop-partial/` (pearcore issue 2.2) and is removed when you quit.

Each run uses its own throw-away pearcore account under `~/.peardrop/sessions/`. Anything printed while the TUI is open goes to `~/.peardrop/peardrop.log`. Set `PEARDROP_HOME` to move both.

## Local testing (no public DHT)

This is the same bootstrapper setup pearcore's e2e tests use (`tests/factory.js`):

```bash
npm run dev:bootstrap                       # 127.0.0.1:49737
node bin/peardrop.mjs share ./some-folder --bootstrap 127.0.0.1:49737
node bin/peardrop.mjs get '<link>' -o /tmp/out --bootstrap 127.0.0.1:49737
```

If the two processes see each other but never exchange data (the client times out), add `-r ./scripts/dev-dht-unfirewalled.cjs` after `node`. HyperDHT can fail to holepunch between two firewalled nodes in separate processes on one host (pearcore issue 4.5).

`npm run e2e` runs the whole loop in two tmux sessions and compares every byte. It needs `tmux`.

## Layout

```
bin/peardrop.mjs        launcher: Node version check, pearcore env, case-insensitive import hook
src/cli.tsx             argument parsing, renderer setup, shutdown
src/core/session.ts     throw-away pearcore node per run
src/core/share.ts       ShareController: walk, index queue, file-list push workaround
src/core/get.ts         GetController: join, live listing, N-at-a-time download queue
src/core/store.ts       throttled external store for useSyncExternalStore
src/ui/*                OpenTUI React screens and widgets
src/types/pearcore.d.ts typings for the pearcore API used here
scripts/                local bootstrapper, test-only DHT preload, e2e script
docs/PEARCORE_ISSUES.md issues and challenges found in pearcore
```
