# pearcore: issues found while building peardrop-cli

Tested against `peardrive/pearcore@c8633de` (main, 2026-10-13), used as a library from a Node 26.11 process together with OpenTUI 0.5.11.
peardrop only goes through `createCore()` and `core.space` / `core.drives` / `core.accounts`. Every place where it had to reach into `core.managers` or patch something is listed below as a **workaround**, so these are the parts that need fixing in pearcore.

Severity: 🔴 breaks the main use case · 🟠 visible bug or missing capability · 🟡 rough edge / API design

Evidence: **[repro]** reproduced while testing peardrop · **[code]** found by reading the source, not triggered in testing

---

## 1. Protocol and sync

### 🔴 1.1 Receivers that join after indexing never get the file list **[repro]**
- **Symptom:** `peardrop share dir/` indexes everything, then `peardrop get <link>` connects and syncs the space, but `drive.files()` stays empty. It only fills when the sharer happens to index a *new* file later.
- **Cause:** `SpaceHashListHandler` (space.protocol.js:40) answers a newcomer with `SpaceSync` only. The file list is sent by `sendSpaceFileListContextToSocket()` (lines 169/201), and only the node that *receives* a SpaceSync calls it. So the joiner sends its own (empty) list to the owner, and the owner never sends its list back. The tests don't catch this because `drive.service.test.js` joins first and adds files afterwards.
- **Workaround in peardrop** (`src/core/share.ts → #pushFileList`): on `SpaceHashList` from a peer that includes our topic, call `managers.message.protocolHandlers.get('SpaceSync').sendSpaceFileListContextToSocket(socket, topic)` ourselves.
- **Fix:** after sending SpaceSync in `SpaceHashListHandler`, also send the file-list context, or add a `SpaceFileListRequest` message that a joiner sends after its first SpaceSync.

### 🟠 1.2 Messages from the same socket are handled concurrently, so they can run out of order **[code]**
- `MuxManager` calls `handler(socket, payload, info)` without awaiting it or queueing per socket (multiplexer.manager.js:184).
- A `SpaceFileEvent` that arrives right after a `SpaceSync` can be handled before the SpaceSync handler has written the space record. It is then rejected with `space is not found`.
- **Workaround:** retry the file-list push when a `Reject` comes back with that reason.
- **Fix:** keep a per-socket promise chain so JSON frames are handled strictly in order.

### 🟠 1.3 `FileEventBroadcaster` debounces instead of throttling **[code]**
- Every `add()` restarts the 1-second timer (events.js:61). While a folder is being indexed, a new event arrives more often than once a second, so nothing reaches connected receivers until indexing goes quiet.
- **Workaround:** call `managers.spaceFiles.fileEventBroadcaster.flush()` every 1.5 s while indexing.
- **Fix:** use a throttle, or a debounce with a `maxWait`.

### 🟠 1.4 A denied read gets no reply **[repro]**
- If the joiner isn't allowed to read, `SpaceHashListHandler` silently skips the SpaceSync (space.protocol.js:40). The joiner waits forever on "connected" with no reject and no event.
- **Fix:** send a `Reject` with `READ_PERMISSION_NOT_ALLOWED_MESSAGE` so the client can show "access denied".

### 🟡 1.5 `permissionRead` / `permissionBroadcast` are documented the opposite way **[repro]**
- The JSDoc says "Whether reading is permissioned", which reads as "restricted". In code (`policy.utils.js:21`), `permissionRead: true` means **anyone may read**.
- I first created spaces with `permissionRead: false`, expecting an open space, and the receiver hung (see 1.4).
- **Fix:** rename to `publicRead` / `publicBroadcast`, or fix the docs.

### 🟡 1.6 Receivers spam rejected file-list messages **[repro]**
- With `permissionBroadcast: false`, every receiver still pushes its own (empty) file list after SpaceSync. The owner rejects each one with `peer is not allowed to broadcast`.
- **Fix:** skip the push when the local list for the topic is empty or the node isn't allowed to broadcast.

### 🟡 1.7 File paths in file events are never validated **[code]**
- `validateSpaceFileEventPayload` checks the shape but not the `path`. A malicious owner can announce `/../../.bashrc`.
- peardrop resolves and checks every destination (`safeDestination()` in `src/core/get.ts`). pearcore should reject paths with `..`, empty segments or control characters before they reach the file list.

---

## 2. Files and downloads

### 🔴 2.1 Zero-byte files can never be downloaded **[repro]**
- `getLeafCount(0)` returns 1, but `getFileChunk()` throws `Leaf index 0 out of bounds` when `offset >= fileSize`, which is always true at offset 0 of an empty file (files.utils.js:486).
- The provider throws on every content request and the downloader stalls forever at 0%, with no error.
- **Workaround:** the share side skips empty files and marks them "skipped: empty file".
- **Fix:** special-case 0-byte files: deliver an empty leaf, or complete as soon as the tree is adopted.

### 🟠 2.2 Downloads fail across filesystems **[code]**
- `setDownloadAsComplete` moves the finished file with `fs.rename(temp, final)` (files.utils.js:756). This fails with `EXDEV` when the account directory and the destination are on different filesystems (`/home` vs a USB drive or `/tmp`).
- The error is thrown inside `handleChunk`, so the task never completes and nothing is reported.
- **Workaround:** the receiver's throw-away account lives in `<out>/.peardrop-partial/`.
- **Fix:** fall back to copy + unlink on `EXDEV`, and surface the error (see 2.3).

### 🟠 2.3 `SpaceDownloadTask` has no error or stall events **[repro]**
- Only `onProgress` and `onComplete` exist.
- When the provider disconnects, the provider list isn't pruned (see 2.4) and the task just stops making progress.
- Failures in `finish()` / `handleChunk()` are swallowed.
- **Fix:** add `onError` and an `onStall` / `onProvidersChanged` event, and a `cancel()` / `retry()`.

### 🟠 2.4 Stale providers stay in the file list **[repro]**
- A `Disconnect` doesn't remove that peer's records from `SpaceFileListManager`. `getProvidersForVariant()` keeps reporting a provider that is gone, so the UI shows "1 provider" for a dead peer.
- **Fix:** keep provider records per live connection, or expire them on disconnect.

### 🟠 2.5 File list carries no size or other metadata **[repro]**
- Records are `[path, publicKey, timestamp, rootHash, signature]` only.
- A receiver can't show file sizes, total bytes or an ETA until it has fetched each Merkle tree. `getProgress()` gives only a percent: no bytes and no speed.
- **Fix:** add `size` (and optionally `mtime` / `mime`) to the signed record, and bytes/sec to the progress snapshot.

### 🟠 2.6 Indexing has no limit, and there is no `addDirectory` **[code]**
- `browser.addFile()` starts indexing immediately and doesn't await `addLocalFile` (browsers.js:148). Adding N files opens N hashing streams at once, plus N chokidar watchers.
- There is no directory API, so the caller must walk the tree.
- **Workaround:** peardrop walks the folder itself and calls `addFile` only when one of 4 slots is free, releasing the slot on the entry's `onComplete` / `onError`.
- **Fix:** add an internal indexing queue with a configurable concurrency, and `drive.addDirectory(virtualDir, localDir, { ignore })`.

### 🟡 2.7 Provider side can't see upload progress **[repro]**
- There is no per-peer or per-file "bytes sent" event. peardrop estimates from the `slice` in `SpaceFileContentRequest` events, which counts *requested* bytes, not delivered ones.

---

## 3. Entry and event API (services layer)

### 🟡 3.1 Entry callbacks are single slots **[code]**
- `LocalFileEntry.onComplete`, `onError` and `onIndexing`, and `SpaceDownloadTask.onComplete`, each store one callback. A second subscriber silently replaces the first. There is no `off()` for complete or error.
- `triggerError` calls the callback *before* storing `#error`, so an `onError` registered from inside that callback misses it.
- **Suggestion:** make entries and tasks `EventEmitter`s (`'progress' | 'complete' | 'error'`).

### 🟡 3.2 No drive-level change events **[repro]**
- The receiver has to poll `drive.files()` or listen to the raw `core.emitter` `SpaceFileEvent`. `drive.onChange(cb)` / `drive.watch()` on `SpaceDriveBrowser` would be the natural services-level API.

### 🟡 3.3 `SpaceDriveBrowser.getFile()` and `entry.download()` fail silently **[code]**
- `getFile()` doesn't check that the path exists.
- `download()` returns `undefined` when `!exists`, instead of throwing.

### 🟡 3.4 Bad sharelinks give an obscure error **[code]**
- `decodeShareLink` returns `null` for an invalid link, and `space.join()` passes that `null` into `querySpace`, which fails with an unrelated TypeError. `join()` should throw `Invalid sharelink`.

### 🟡 3.5 Prefix bugs in `SpaceInstance` **[code]**
- The default prefix is the typo `'preacore'` (space.service.js:47).
- `SpaceService.update()` returns `new SpaceInstance(updatedSpace, "space")` without the service prefix, so its `.sharelink` starts with `preacore://`.

### 🟡 3.6 No ephemeral or in-memory node **[repro]**
- A drop-style tool still has to `accounts.create()` + `authenticate()` with a password, write a SQLite DB and encrypted credentials, and clean them up.
- Joining the same link twice in one account throws `Record for sharelink already exists`.
- peardrop creates a throw-away account per run under `~/.peardrop/sessions/<id>`, with a pid file so leftovers from killed runs are swept.
- `createCore({ ephemeral: true })` would remove all of that.

---

## 4. Packaging and runtime

### 🔴 4.1 Imports with the wrong case crash on Linux **[repro]**
- `merkleTree.utils.js` is imported as `merkletree.utils.js` in files.utils.js, protocol.utils.js, registry.js, trees.js, files.protocol.js and seven test files. This only works on case-insensitive filesystems (macOS, Windows). On Linux the first import fails with `ERR_MODULE_NOT_FOUND`.
- **Workaround:** `bin/peardrop.mjs` installs a `module.registerHooks` resolver that retries with a case-insensitive match inside `pearcore/`.
- **Fix:** rename the file or the imports, and run CI on Linux.

### 🟠 4.2 No `main` / `exports` in package.json **[repro]**
- Only `"module": "src/core.js"`, which bundlers read but Node ignores, so `import 'pearcore'` fails.
- Consumers must deep-import `pearcore/src/core.js`, `pearcore/src/constants/events.constants.js` and `pearcore/src/utils/sharelink.utils.js`.
- **Fix:** add an `exports` map with `.`, `./events`, `./sharelink`, and ship `.d.ts` files. peardrop keeps a hand-written `src/types/pearcore.d.ts` for now.

### 🟠 4.3 `better-sqlite3` locks pearcore to Node **[repro]**
- Bun refuses to load `better-sqlite3`. OpenTUI runs on Bun, or on Node only from 26.4 (it needs `node:ffi`). So a pearcore + OpenTUI app currently **must** run on Node ≥ 26.4.
- That works, and it's what peardrop does: one process, no IPC. But it rules out Bun, and Node 26's FFI is still experimental.
- pearcore also declares three SQLite drivers: `better-sqlite3`, `sqlite3` and `@libsql/client`.
- **Fix:** move to `node:sqlite` (built in, no native build) or `@libsql/client` (works on Node and Bun), behind drizzle's matching driver.

### 🟠 4.4 Import-time side effects and output to stdout **[repro]**
- `logger.js` creates `~/.pearcore/.logs` and reads `DEFAULT_ACCOUNT_DIR` / `PEARCORE_LOG_LEVEL` when imported, so env vars must be set **before** the first import. That's why peardrop has a launcher file.
- With `NODE_ENV !== 'production'` a `pino-pretty` target writes to stdout, which breaks any TUI.
- Raw `console.*` calls are left in library code:
  - `download.js:404` (`console.log(error)` in the heartbeat)
  - `message.manager.js:223`
  - `connection.manager.js:194`
  - `message.service.js:23`
  - `accounts.utils.js:419`, which logs `{ internal, username }` during authentication
- **Workaround:** the launcher sets `NODE_ENV=production`, and peardrop sends `console.*` to `~/.peardrop/peardrop.log` while the TUI runs.
- **Fix:** accept `createCore({ logger })` or a `silent` flag, configure the log dir lazily, and remove the stray `console.*` calls.

### 🟠 4.5 Swarm and DHT options can't be passed in **[repro]**
- `ConnectionManager` builds the swarm with only `{ keyPair, bootstrap }`.
- On this test machine, two **separate processes** whose HyperDHT nodes are both "firewalled" never finish the holepunch: the client gets `open`, the server never sees the connection, then `ETIMEDOUT`. Same-process connections, which is how pearcore's vitest suite runs, work fine.
- **Workaround (tests only):** `scripts/dev-dht-unfirewalled.cjs` monkey-patches HyperDHT with `{ host: '127.0.0.1', firewalled: false }`.
- **Fix:** `createCore({ swarm: { dht: {...} } })`, plus an e2e test with two cores in two processes.

### 🟡 4.6 Small bugs **[code]**
- `LocalFileRegistry.stop()` loops with `for (const [k, v] in map.entries())`. `for…in` over an iterator does nothing, so the backoff timers are never cleared (registry.js:395).
- A socket `error` followed by `close` emits `Disconnect` twice.
- The config key is spelled `download.heatbeatInterval`.
- `registerGracefulShutdown` calls `process.exit(0)` from inside a library. It's unused today, but a footgun if it gets wired in.

---

## 5. Download stalls with many small files (diagnosed 2026-10-14)

**Symptom:** sharing a folder of ~2000 small files, the receiver downloads ~48 files and then hangs. Two downloads sit at 0%, one at "fetching tree", and they never move. The sharer is still indexing and the peer doesn't look throttled.

**Root cause:** the multiplexer and delivery manager are fine. The problem is the message throttle, combined with download tasks that never retry a request that got no answer.
1. Each file costs the receiver at least 2 requests: a tree request and a content request.
2. After 100 messages from a peer (48 files × 2 + hash list + file-list push = exactly 100), the sharer's `ThrottleManager` quarantines the receiver for 1 s.
3. During that second, every message from the receiver is **silently dropped**, including the 3 in-flight requests.
4. Neither the tree puller nor the leaf scheduler ever re-sends a lost request, so those 3 tasks wait forever. peardrop then has no free download slot to start another file.

**How to reproduce:** `scripts/diag-download-stall.mjs` runs two cores in one process and dumps throttle, puller and scheduler state. Results with 1500 files of 1–50 KB, 3 at a time; patches are applied at runtime:

| Patches applied | Result | Sharer quarantines / dropped msgs |
|---|---|---|
| none | **stalls at 48/1500** | 1 / 3 |
| `throttle-interval` (5.1) | stalls at 51/1500 | 1 / 3 |
| `tree-timeout` + `content-retry` (5.3, 5.4) | stalls at 95/1500 | 1 / 3 (+ getter quarantined the sharer: 1 / 2) |
| 5.1 + 5.3 + 5.4 | completes in **146 s** | 19 / 45 (each drop costs a 5–8 s retry) |
| 5.1 + raise limit to 2000/s (5.5) | completes in **21.6 s** | 0 / 0 |
| 5.1 + 5.5 + 5.3 + 5.4 | completes in **21.3 s** | 0 / 0 |

### 🔴 5.1 The throttle counter never resets **[repro]**
- `ThrottleManager` clears `frequencyRecord` with a one-shot `setTimeout(() => this.clearFrequencyRecords(), 1000)` (throttle.manager.js:12). It runs once, one second after startup, and never again.
- So `MAX_FREQUENCY_THROTTLE = 100` behaves as "100 messages per quarantine cycle", not "100 per second". Any long-lived connection eventually hits it during normal use.
- **Fix:** `setInterval(...).unref()`, cleared in `clear()` / logout, or a sliding window.

### 🔴 5.2 Quarantine drops messages silently **[repro]**
- `ALLOW_THROTTLE_REJECTIONS = false`, so a quarantined peer's requests vanish with no `Reject`, no event and no log entry.
- The requester can't tell "slow" from "dropped".
- **Fix:** at least emit a local event or debug log. Better, reply with a cheap `Reject` (`MESSAGE_RATE_LIMIT_EXCEEDED`) that carries `linkedMessageNonce` and a retry-after hint.

### 🔴 5.3 A lost tree request is never retried **[repro]**
- `SpaceTreePuller.pendingRequests` entries have no timestamp or timeout, and `isPending()` stays true forever (trees.js).
- `shouldRequest()` therefore refuses to ask that provider again, and the task stays in "fetching tree" for good.
- **Fix:** store `sentAt` per nonce and expire it after a few seconds, or when a `Reject` arrives for that nonce, so the heartbeat re-requests.

### 🔴 5.4 A lost content request is never retried when there's only one provider **[repro]**
- `LeafDeliveryScheduler.reclaimStalled()` only releases a stalled assignment `if (canBeReleased)`, which requires **another** idle provider. `requestTimeout` is also 64 s.
- With a single provider, a dropped `SpaceFileContentRequest` leaves the assignment in place forever.
- **Fix:** with no alternative, re-queue the range and re-send to the same provider, ideally with backoff. Also time out on "no progress since X" rather than "requested X ago": a 1-leaf assignment needs a seconds-scale timeout, not 64 s.

### 🟠 5.5 100 messages per second is too low for small files **[repro]**
- Even with 5.1 fixed, ~2 request messages per file limits a receiver to ~50 small files/s per provider, and bursts trip the quarantine.
- Measured above: 146 s with retries, versus 21 s once the limit isn't hit.
- **Fix ideas:**
  - Don't count request/response protocol traffic (tree and content requests) against the anti-spam budget, or give it a separate, higher budget.
  - Raise the default.
  - Let one request cover several files: a batched tree request, or tree and content in one round trip for files that are a single leaf.

### 🟠 5.6 Rejects and delivery failures never reach the download task **[code]**
- `RejectionProtocolHandler` only emits `Reject`, and nothing in `SpaceDownloadTask`, `SpaceTreePuller` or `LeafDeliveryScheduler` listens for it. A provider answering `SLICE_NOT_AVAILABLE`, `FILE_NOT_ACCESSIBLE` or `SPACE_FILE_NOT_FOUND` leaves the assignment hanging exactly like a dropped message.
- On the provider side, `FileContentDeliveryManager.createTask()` returns `succeed: true` before streaming starts, and later stream errors are swallowed.
- `FileHandlerCache` keeps `entry.error` forever, so one failed open poisons every later request for that path until `eject()`.

### 🟡 5.7 `lastRequestableLeaf` is a count on one side and an index on the other **[code]**
- The tree response sends `registry.leafCount`, or `lastPushedLeaf + 1` for a partial download (files.protocol.js ~L213–221). That is a count.
- The scheduler and `SpaceFileContentRequestHandler` treat it as the last valid index. The handler allows up to `leafCount - 1` / `lastPushedLeaf`.
- A partial provider can therefore be asked for one leaf it doesn't have, which gets `SLICE_NOT_AVAILABLE` and then hangs (see 5.6).
- `trees.js` also uses a falsy check (`!info.lastRequestableLeaf`), which misreads index 0.

### 🟡 5.8 Throttle state misleads **[repro]**
- `getSnapShot().isThrottled` comes from the quarantine map, which is only cleaned up when that peer's *next* message arrives. It can report `true` long after the quarantine ended, and the frequency `count` shown is reset to 0 the moment quarantine starts, so a snapshot rarely shows the peer that is actually being dropped.
- This is likely why the peer didn't look throttled: the quarantine only lasts 1 s, but the requests it dropped are never re-sent (5.3, 5.4).
- Separately, `SessionManager.reset()` sets `this.session = this.STATIC_SESSION`, replacing the proxied object with the raw one, so `session.get/set` stop working after a logout or reset.

### Suggested order
Fix 5.1 and 5.3 / 5.4 first: they turn a permanent hang into a recoverable one. Then 5.5 for throughput, and 5.2 / 5.6 so failures become visible.

---

## Not pearcore, but found on the way (OpenTUI 0.5.11)
- `@opentui/react`'s built-in `ErrorBoundary` renders through `jsxDEV`, which is undefined under React's production build. Any render error becomes `jsxDEV is not a function`. peardrop wraps the app in its own boundary.
- `@opentui/qrcode` throws if `quietZone < 4`, and draws nothing when the code doesn't fit unless `fallbackContent` is set.
- `@opentui/core@^0.5.11` resolved to 0.5.17 while `@opentui/react` pins `0.5.11`, giving two copies of core. Pin all `@opentui/*` to the same exact version.
