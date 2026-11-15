import fs from 'node:fs';
import path from 'node:path';
import * as EVENTS from 'pearcore/src/constants/events.constants.js';
import type { LocalFileEntry, SpaceDriveBrowser, SpaceInstance } from 'pearcore/src/core.js';
import { openSession, type PeardropSession } from './session.js';
import { Store } from './store.js';

const LEAF_SIZE = 256 * 1024; // pearcore DEFAULT_CHUNK_SIZE
const INDEX_CONCURRENCY = 4;

export type ShareFileState = 'queued' | 'indexing' | 'ready' | 'skipped' | 'error';

export interface ShareFile {
  id: number;
  virtualPath: string;
  sourcePath: string;
  size: number;
  state: ShareFileState;
  percent: number;
  error?: string;
  rootHash?: string;
  requestedLeaves: number;
}

export type SharePhase = 'starting' | 'indexing' | 'ready' | 'error';

export interface ShareSnapshot {
  phase: SharePhase;
  error?: string;
  inputPath: string;
  isDirectory: boolean;
  sharelink?: string;
  publicKey?: string;
  files: ShareFile[];
  counts: Record<ShareFileState, number>;
  totalBytes: number;
  indexedBytes: number;
  receivers: string[];
  requestedBytes: number;
}

interface SourceFile {
  virtualPath: string;
  sourcePath: string;
  size: number;
}

/** Collect the files to share. A directory keeps its own name as the top-level folder. */
export function collectSources(inputPath: string): { isDirectory: boolean; files: SourceFile[] } {
  const absolute = path.resolve(inputPath);
  const stat = fs.statSync(absolute);

  if (stat.isFile()) {
    return {
      isDirectory: false,
      files: [{ virtualPath: `/${path.basename(absolute)}`, sourcePath: absolute, size: stat.size }],
    };
  }

  if (!stat.isDirectory()) throw new Error(`${inputPath} is neither a file nor a directory`);

  const base = path.basename(absolute);
  const files: SourceFile[] = [];
  const walk = (dir: string) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        const rel = path.relative(absolute, full).split(path.sep).join('/');
        files.push({ virtualPath: `/${base}/${rel}`, sourcePath: full, size: fs.statSync(full).size });
      }
      // symlinks, sockets, fifos... are skipped on purpose
    }
  };
  walk(absolute);

  if (files.length === 0) throw new Error(`${inputPath} contains no files`);
  return { isDirectory: true, files };
}

export class ShareController {
  readonly store: Store<ShareSnapshot>;

  #inputPath: string;
  #bootstrap: string | null;
  #session: PeardropSession | null = null;
  #space: SpaceInstance | null = null;
  #drive: SpaceDriveBrowser | null = null;

  #phase: SharePhase = 'starting';
  #error?: string;
  #isDirectory = false;
  #files: ShareFile[] = [];
  #byVirtualPath = new Map<string, ShareFile>();
  #pending: ShareFile[] = [];
  #active = 0;
  #receivers = new Set<string>();
  #requestedLeaves = 0;
  #flushTimer: NodeJS.Timeout | null = null;
  #entries: LocalFileEntry[] = [];

  constructor(inputPath: string, bootstrap: string | null) {
    this.#inputPath = inputPath;
    this.#bootstrap = bootstrap;
    this.store = new Store(() => this.#snapshot());
  }

  async start(): Promise<void> {
    try {
      const { isDirectory, files } = collectSources(this.#inputPath);
      this.#isDirectory = isDirectory;
      this.#files = files.map((file, id) => ({ ...file, id, state: 'queued', percent: 0, requestedLeaves: 0 }));
      for (const file of this.#files) this.#byVirtualPath.set(file.virtualPath, file);
      this.store.touch(true);

      this.#session = await openSession({ bootstrap: this.#bootstrap, role: 'share' });
      const { core } = this.#session;

      // permissionRead=true  -> anybody holding the link may read (it is NOT "reading is restricted").
      // permissionBroadcast=false -> only this node may publish files into the space.
      this.#space = await core.space.create({
        spaceName: path.basename(path.resolve(this.#inputPath)) || 'peardrop',
        permissionRead: true,
        permissionBroadcast: false,
      });
      this.#drive = core.drives.get(this.#space);
      this.#wireNetworkEvents();

      this.#phase = 'indexing';
      // WORKAROUND: pearcore indexes a 0-byte file as one leaf but the provider then throws
      // "Leaf index 0 out of bounds" on every content request, so receivers hang forever.
      for (const file of this.#files) {
        if (file.size === 0) {
          file.state = 'skipped';
          file.error = 'empty file';
        }
      }
      this.#pending = this.#files.filter((file) => file.state === 'queued');
      this.store.touch(true);

      // WORKAROUND: pearcore's FileEventBroadcaster debounces (each add() restarts a 1s timer),
      // so while a folder is being indexed nothing reaches connected receivers. Flush periodically.
      this.#flushTimer = setInterval(() => {
        core.managers.spaceFiles?.fileEventBroadcaster?.flush?.().catch?.(() => {});
      }, 1500);

      this.#pump();
    } catch (error) {
      this.#fail(error);
    }
  }

  /** Start indexing as long as there are free slots; a slot is released by the entry's events. */
  #pump(): void {
    while (this.#active < INDEX_CONCURRENCY && this.#pending.length > 0) {
      const file = this.#pending.shift()!;
      this.#active += 1;
      this.#index(file).catch((error) => this.#settle(file, error));
    }

    if (this.#active === 0 && this.#pending.length === 0 && this.#phase === 'indexing') {
      this.#phase = 'ready';
      if (this.#flushTimer) clearInterval(this.#flushTimer);
      this.#flushTimer = null;
      this.store.touch(true);
    }
  }

  async #index(file: ShareFile): Promise<void> {
    const drive = this.#drive!;
    file.state = 'indexing';
    this.store.touch();

    const entry = await drive.addFile(file.virtualPath, file.sourcePath);
    this.#entries.push(entry);

    entry.onIndexing((snapshot) => {
      if (snapshot?.percent != null) {
        file.percent = snapshot.percent;
        this.store.touch();
      }
    });
    entry.onComplete(() => {
      file.rootHash = entry.rootHash ?? undefined;
      this.#settle(file);
    });
    entry.onError((error) => this.#settle(file, error));
  }

  #settle(file: ShareFile, error?: unknown): void {
    if (file.state === 'ready' || file.state === 'error') return; // entry callbacks are not guaranteed to be single-shot
    if (error) {
      file.state = 'error';
      file.error = error instanceof Error ? error.message : String(error);
    } else {
      file.state = 'ready';
      file.percent = 100;
    }
    this.#active -= 1;
    this.store.touch();
    this.#pump();
  }

  #wireNetworkEvents(): void {
    const { core } = this.#session!;
    const topic = this.#space!.topicHash;

    core.emitter.on(EVENTS.SpaceHashList, ({ message, topics }: any) => {
      if (!Array.isArray(topics) || !topics.includes(topic)) return;
      const peer: string = message.publicKey;
      this.#receivers.add(peer);
      this.store.touch();
      this.#pushFileList(peer, 0);
    });

    core.emitter.on(EVENTS.Disconnect, ({ publicKey }: any) => {
      if (this.#receivers.delete(publicKey)) this.store.touch();
    });

    core.emitter.on(EVENTS.SpaceFileContentRequest, ({ message }: any) => {
      const payload = message?.payload;
      if (!payload || !Array.isArray(payload.slice)) return;
      const [from, to] = payload.slice as [number, number];
      const leaves = Math.max(0, to - from + 1);
      this.#requestedLeaves += leaves;
      const file = this.#byVirtualPath.get(payload.spaceFilePath);
      if (file) file.requestedLeaves += leaves;
      this.store.touch();
    });

    // A receiver processes messages concurrently, so our file list can overtake the
    // SpaceSync that creates its space record and gets rejected with "space is not found".
    core.emitter.on(EVENTS.Reject, ({ message }: any) => {
      const reason: string | undefined = message?.payload?.reason;
      if (reason === 'space is not found' && this.#receivers.has(message.publicKey)) {
        this.#pushFileList(message.publicKey, 1);
      }
    });
  }

  #pushAttempts = new Map<string, number>();

  /**
   * WORKAROUND: pearcore only sends a space's file list to the node that *receives* a SpaceSync.
   * The owner sends SpaceSync to a newcomer but never its file list, so a receiver that joins
   * after indexing finished would see an empty drive. Push the list ourselves.
   */
  #pushFileList(peer: string, attemptDelta: number): void {
    const attempts = (this.#pushAttempts.get(peer) ?? 0) + attemptDelta;
    if (attempts > 6) return;
    this.#pushAttempts.set(peer, attempts);

    setTimeout(() => {
      const core = this.#session?.core;
      if (!core || !this.#space) return;
      const socket = core.managers.sockets.getConnectedSockets({ peers: [peer] })[0];
      const handler = core.managers.message.protocolHandlers.get(EVENTS.SpaceSync);
      if (!socket || !handler?.sendSpaceFileListContextToSocket) return;
      handler.sendSpaceFileListContextToSocket(socket, this.#space.topicHash).catch(() => {});
    }, 300 + attempts * 400);
  }

  #fail(error: unknown): void {
    this.#phase = 'error';
    this.#error = error instanceof Error ? error.message : String(error);
    this.store.touch(true);
  }

  async stop(): Promise<void> {
    if (this.#flushTimer) clearInterval(this.#flushTimer);
    this.store.dispose();
    await this.#session?.close();
  }

  #snapshot(): ShareSnapshot {
    const counts: Record<ShareFileState, number> = { queued: 0, indexing: 0, ready: 0, skipped: 0, error: 0 };
    let totalBytes = 0;
    let indexedBytes = 0;
    for (const file of this.#files) {
      counts[file.state] += 1;
      totalBytes += file.size;
      indexedBytes += file.state === 'ready' ? file.size : file.state === 'indexing' ? (file.size * file.percent) / 100 : 0;
    }

    return {
      phase: this.#phase,
      error: this.#error,
      inputPath: this.#inputPath,
      isDirectory: this.#isDirectory,
      sharelink: this.#space?.sharelink,
      publicKey: this.#session?.core.getPublicKey(),
      files: this.#files.map((file) => ({ ...file })),
      counts,
      totalBytes,
      indexedBytes,
      receivers: [...this.#receivers],
      requestedBytes: this.#requestedLeaves * LEAF_SIZE,
    };
  }
}
