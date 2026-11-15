# The transfer engine in `src/engine`

The CLI is a **copy** of the PearDrop desktop app's transfer engine. It is not a dependency and
not a submodule: the two projects are separate git repositories and deliberately share no code,
so each one builds on its own.

```
source:   desktop/src/engine/**            @ 0b27b25
plus:     desktop/src/shared/{transfer,bootstrap,engine}.ts
```

`src/shared/engine.ts` only supplies types used by `engine-host.ts`; the CLI drives
`HyperdriveManager` directly and leaves `EngineHost`/`TransferBackend` unused. They are kept so a
future sync is a straight copy rather than a merge.

## Local differences from the desktop copy

Everything is byte-identical except these edits, each forced by something the CLI needs:

| File | Change | Why |
|---|---|---|
| `engine/engine-host.ts` | `BACKENDS[...]!` (2×) | the CLI's `noUncheckedIndexedAccess` is on; the id is already validated |
| `engine/hyperdrive/network-probe.ts` | `const [address = ''] = entry.split('@')` | same |
| `engine/hyperdrive/receive.ts` | `const only = contents.files[0]!` | same |
| `engine/hyperdrive/share.ts` | `fileEntries[0]!.name` | same |
| `engine/hyperdrive/downloader.ts` | added optional `onFileStart` / `onFileDone` callbacks | the CLI shows per-file progress; the desktop app only uses aggregate progress |
| `shared/bootstrap.ts` | reworded header comment | it no longer mentions the retired engine |

The downloader addition is purely additive: desktop passes neither callback, and both default to
a no-op.

## Re-syncing after a desktop engine change

There is no automated sync. To pull in upstream work:

1. Copy `desktop/src/engine/**` and the three `desktop/src/shared` files over `cli/src/` (same
   layout, same `@engine`/`@shared` aliases).
2. Re-apply the table above.
3. `npm run typecheck && npm test && npm run e2e`.

Keeping the copy byte-identical apart from that table is what makes this cheap; if a change has
to be made for the CLI, add it to the table.

## How the CLI uses it

- `src/core/session.ts` creates a throw-away `HyperdriveManager` per run (data root under
  `~/.peardrop/sessions/`), so no drive list, storage or download history survives a run.
- `src/core/share.ts` calls `manager.createDrive()` and maps `share-started` / `share-progress` /
  `drive-announced` / `peer-connected` / `upload-progress` onto the TUI snapshot.
- `src/core/get.ts` calls `manager.openDrive()` and then `downloadFromDrive()` directly, so it can
  pass `destDir`, per-file callbacks, the cancel flag and the aborter.

Two behaviours are inherited from the engine and worth knowing:

- **A share copies its files** into a Corestore drive before it can be announced.
- **Folder detection on download** is a heuristic in `downloader.ts#resolveDownloadRoot`: more
  than one file, or a share name without a dot, gets its own folder. A folder whose name contains
  a dot and that holds exactly one file therefore lands flat in the output directory.
