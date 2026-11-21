# Changelog

All notable changes to `peardrop-cli` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project follows
[SemVer](https://semver.org). While the version is `0.x`, a minor bump is the breaking one.

## 0.1.0

First release. `peardrop` sends files and folders between devices from the terminal, peer-to-peer,
on the Hyperdrive stack (Hyperdrive + Corestore + Hyperswarm), with an OpenTUI interface.

### Added

- **`peardrop share <file|directory>`** copies the source into a drive, prints a sharelink and a QR
  code, and seeds it. Files are copied before the link exists, so later edits to the originals are
  not picked up. Empty files are shared normally.
- **`peardrop get <sharelink> [-o <dir>]`** connects to the sender, reads the file list, and
  downloads files one at a time straight to disk with byte-based progress and a live speed. A stall
  watchdog fails the transfer instead of hanging when the sender disappears.
- **Headless mode (`--json`)** on both commands: newline-delimited events on stdout
  (`share-started`, `progress`, `sharelink`, `ready`, `announced`, `opened`, `file-done`, `done`)
  with exit codes `0` success, `1` failure, `2` usage error. This is the stable surface for scripts
  and is what the e2e tests drive.
- **Clipboard handoff**: the sharelink is copied automatically (OS clipboard on Windows, macOS, X11
  and Wayland; OSC 52 over SSH or when no clipboard is available). `--no-copy` turns it off.
- **TUI**: scrollable log, full-screen QR view (`r`), re-copy (`c`), scroll keys, cancel with `q`.
  Anything printed while the TUI is open goes to `~/.peardrop/peardrop.log`.
- **Local testing without the public DHT**: `npm run dev:bootstrap` runs a private bootstrapper on
  `127.0.0.1:49737`, and `--bootstrap host:port` points share/get at it.
- **Tests**: unit tests, an in-process DHT roundtrip covering folder trees, empty files, single
  files, invalid links and cancellation, and a headless e2e that runs two real CLI processes and
  compares bytes.

### Changed

- The transfer engine is now the Hyperdrive engine from the PearDrop desktop app, copied under
  `src/engine/` (see [docs/ENGINE.md](docs/ENGINE.md)).

### Security

- Paths from the sender are sanitised; nothing can be written outside the output folder.
- Existing files are never overwritten: a second download becomes `name (1).ext`.

### Notes

- Requires Node.js ≥ 26.4 (OpenTUI's Node build uses `node:ffi`).
- Each run uses a throw-away data root under `~/.peardrop/sessions/`. Set `PEARDROP_HOME` to move it.
