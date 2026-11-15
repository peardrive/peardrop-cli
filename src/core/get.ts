import fs from 'node:fs';
import path from 'node:path';
import * as EVENTS from 'pearcore/src/constants/events.constants.js';
import { decodeShareLink } from 'pearcore/src/utils/sharelink.utils.js';
import type { SpaceDownloadTask, SpaceDriveBrowser, SpaceInstance } from 'pearcore/src/core.js';
import { openSession, type PeardropSession } from './session.js';
import { Store } from './store.js';

const LIST_POLL_MS = 1000;

export type GetFileState = 'queued' | 'starting' | 'downloading' | 'done' | 'skipped' | 'error';
export type GetPhase = 'starting' | 'waiting' | 'connected' | 'synced' | 'error';

export interface GetFile {
  id: number;
  virtualPath: string;
  destination: string;
  state: GetFileState;
  percent: number | null;
  providers: number;
  note?: string;
}

export interface GetSnapshot {
  phase: GetPhase;
  error?: string;
  sharelink: string;
  ownerKey?: string;
  outDir: string;
  concurrency: number;
  peers: string[];
  ownerConnected: boolean;
  everConnected: boolean;
  files: GetFile[];
  counts: Record<GetFileState, number>;
  lastListedAt?: number;
}

export interface GetOptions {
  sharelink: string;
  outDir: string;
  concurrency: number;
  bootstrap: string | null;
}

/** Resolve a space path inside outDir, refusing anything that escapes it ("/../../.bashrc"). */
export function safeDestination(outDir: string, virtualPath: string): string | null {
  const normalized = path.posix.normalize('/' + virtualPath).replace(/^\/+/, '');
  if (!normalized || normalized.split('/').includes('..')) return null;
  const destination = path.resolve(outDir, ...normalized.split('/'));
  const root = path.resolve(outDir) + path.sep;
  return destination.startsWith(root) ? destination : null;
}

export class GetController {
  readonly store: Store<GetSnapshot>;

  #options: GetOptions;
  #session: PeardropSession | null = null;
  #topic: string | null = null;
  #ownerKey?: string;
  #space: SpaceInstance | null = null;
  #drive: SpaceDriveBrowser | null = null;

  #phase: GetPhase = 'starting';
  #error?: string;
  #peers = new Set<string>();
  #everConnected = false;
  #files: GetFile[] = [];
  #byPath = new Map<string, GetFile>();
  #queue: GetFile[] = [];
  #active = 0;
  #tasks = new Map<number, SpaceDownloadTask>();
  #pollTimer: NodeJS.Timeout | null = null;
  #lastListedAt?: number;
  #stopped = false;

  constructor(options: GetOptions) {
    this.#options = options;
    this.store = new Store(() => this.#snapshot());
  }

  async start(): Promise<void> {
    try {
      const decoded = decodeShareLink(this.#options.sharelink);
      if (!decoded) throw new Error('This does not look like a valid sharelink.');
      this.#ownerKey = decoded.publicKey;

      fs.mkdirSync(this.#options.outDir, { recursive: true });

      this.#session = await openSession({
        bootstrap: this.#options.bootstrap,
        role: 'get',
        baseDir: path.join(this.#options.outDir, '.peardrop-partial'),
      });
      const { core } = this.#session;
      this.#wireNetworkEvents();

      const joined = await core.space.join(this.#options.sharelink);
      this.#topic = joined.topicHash;
      this.#phase = 'waiting';
      this.store.touch(true);
    } catch (error) {
      this.#fail(error);
    }
  }

  #wireNetworkEvents(): void {
    const { core } = this.#session!;

    core.emitter.on(EVENTS.Handshake, ({ publicKey }: any) => {
      this.#peers.add(publicKey);
      this.#everConnected = true;
      if (this.#phase === 'waiting') this.#phase = 'connected';
      this.store.touch(true);
    });

    core.emitter.on(EVENTS.Disconnect, ({ publicKey }: any) => {
      if (this.#peers.delete(publicKey)) this.store.touch(true);
    });

    core.emitter.on(EVENTS.SpaceSync, () => {
      this.#onSpaceSync().catch((error) => this.#fail(error));
    });

    // Live listing: refresh as soon as the sharer announces changes...
    core.emitter.on(EVENTS.SpaceFileEvent, () => this.#refreshList());
  }

  async #onSpaceSync(): Promise<void> {
    if (this.#drive || !this.#session || !this.#topic) return;
    const spaces = await this.#session.core.space.list();
    const space = spaces.find((s) => s.isSync && s.topicHash === this.#topic);
    if (!space || this.#drive) return;

    this.#space = space;
    this.#drive = this.#session.core.drives.get(space);
    this.#phase = 'synced';
    this.store.touch(true);

    this.#refreshList();
    // ...and keep polling: pearcore offers no "file list changed" subscription on the drive itself.
    this.#pollTimer = setInterval(() => this.#refreshList(), LIST_POLL_MS);
  }

  #refreshList(): void {
    if (!this.#drive || this.#stopped) return;
    const paths = this.#drive.files({ recursive: true }).sort((a, b) => a.localeCompare(b));
    this.#lastListedAt = Date.now();

    let changed = false;
    for (const virtualPath of paths) {
      if (this.#byPath.has(virtualPath)) continue;
      const destination = safeDestination(this.#options.outDir, virtualPath);
      const file: GetFile = {
        id: this.#files.length,
        virtualPath,
        destination: destination ?? '',
        state: 'queued',
        percent: null,
        providers: 0,
      };
      if (!destination) {
        file.state = 'error';
        file.note = 'unsafe path, refused';
      } else if (fs.existsSync(destination)) {
        file.state = 'skipped';
        file.note = 'already exists';
      } else {
        this.#queue.push(file);
      }
      this.#files.push(file);
      this.#byPath.set(virtualPath, file);
      changed = true;
    }

    if (changed) this.store.touch();
    this.#pump();
  }

  /** Keep at most `concurrency` downloads running; a slot frees up on the task's completion event. */
  #pump(): void {
    while (!this.#stopped && this.#active < this.#options.concurrency && this.#queue.length > 0) {
      const file = this.#queue.shift()!;
      this.#active += 1;
      this.#download(file).catch((error) => this.#finish(file, error));
    }
  }

  async #download(file: GetFile): Promise<void> {
    file.state = 'starting';
    this.store.touch();

    const entry = await this.#drive!.getFile(file.virtualPath);
    const variants = entry.variants;
    if (variants.length === 0) throw new Error('no provider advertises this file anymore');

    // Prefer the variant offered by the most providers.
    const rootHash = [...variants].sort(
      (a, b) => entry.getProvidersForVariant(b).length - entry.getProvidersForVariant(a).length,
    )[0]!;
    file.providers = entry.getProvidersForVariant(rootHash).length;

    const task = await entry.download(rootHash, file.destination);
    if (!task) throw new Error('download could not be started');
    this.#tasks.set(file.id, task);

    file.state = 'downloading';
    file.percent = task.getProgress().percent;
    this.store.touch();

    task.onProgress((snapshot) => {
      file.percent = snapshot.percent;
      this.store.touch();
    });
    task.onComplete(() => this.#finish(file));
  }

  #finish(file: GetFile, error?: unknown): void {
    if (file.state === 'done' || file.state === 'error') return;
    if (error) {
      file.state = 'error';
      file.note = error instanceof Error ? error.message : String(error);
    } else {
      file.state = 'done';
      file.percent = 100;
    }
    this.#tasks.delete(file.id);
    this.#active -= 1;
    this.store.touch();
    this.#pump();
  }

  #fail(error: unknown): void {
    this.#phase = 'error';
    this.#error = error instanceof Error ? error.message : String(error);
    this.store.touch(true);
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#pollTimer) clearInterval(this.#pollTimer);
    this.store.dispose();
    await Promise.allSettled([...this.#tasks.values()].map((task) => task.stop()));
    await this.#session?.close();
  }

  #snapshot(): GetSnapshot {
    const counts: Record<GetFileState, number> = {
      queued: 0,
      starting: 0,
      downloading: 0,
      done: 0,
      skipped: 0,
      error: 0,
    };
    for (const file of this.#files) counts[file.state] += 1;

    return {
      phase: this.#phase,
      error: this.#error,
      sharelink: this.#options.sharelink,
      ownerKey: this.#ownerKey,
      outDir: this.#options.outDir,
      concurrency: this.#options.concurrency,
      peers: [...this.#peers],
      ownerConnected: this.#ownerKey ? this.#peers.has(this.#ownerKey) : false,
      everConnected: this.#everConnected,
      files: this.#files.map((file) => ({ ...file })),
      counts,
      lastListedAt: this.#lastListedAt,
    };
  }
}
