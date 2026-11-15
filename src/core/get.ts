import { downloadFromDrive } from '@engine/hyperdrive/downloader';
import { NetworkProbe } from '@engine/hyperdrive/network-probe';
import { parseShareLink } from '@engine/hyperdrive/share-link';
import type { RemoteFile } from '@engine/hyperdrive/types';
import { createLogger, openSession, type PeardropSession } from './session.js';
import { Store } from './store.js';

/** How often the DHT reachability probe is sampled for the header. */
const COUNTERS_POLL_MS = 1000;

export type GetFileState = 'queued' | 'downloading' | 'done' | 'error';
export type GetPhase = 'starting' | 'connecting' | 'downloading' | 'done' | 'error';

export interface GetFile {
  id: number;
  /** The file's key inside the share, e.g. "/sample/nested/a.txt". */
  virtualPath: string;
  /** Absolute path on disk, once known. */
  destination: string;
  size: number;
  state: GetFileState;
  percent: number | null;
  note?: string;
}

export interface GetSnapshot {
  phase: GetPhase;
  error?: string;
  sharelink: string;
  /** The drive key carried by the link. */
  ownerKey?: string;
  driveId?: string;
  shareName?: string;
  outDir: string;
  /** Folder the files were actually written to (may gain a "(1)"). */
  downloadPath?: string;
  peerConnected: boolean;
  everConnected: boolean;
  files: GetFile[];
  counts: Record<GetFileState, number>;
  totalBytes: number;
  receivedBytes: number;
  /** 0–100, or null while the total is unknown. */
  percent: number | null;
  /** Bytes per second. */
  speed: number;
  partial: boolean;
  failedCount: number;
  truncated: { available: number; shown: number } | null;
  reachable: boolean | null;
  cancelled: boolean;
}

export interface GetOptions {
  sharelink: string;
  outDir: string;
  bootstrap: string | null;
}

export class GetController {
  readonly store: Store<GetSnapshot>;

  #options: GetOptions;
  #session: PeardropSession | null = null;
  #probe: NetworkProbe | null = null;
  #listeners: Array<[string, (...args: any[]) => void]> = [];

  #phase: GetPhase = 'starting';
  #error?: string;
  #ownerKey?: string;
  #driveId?: string;
  #shareName?: string;
  #downloadPath?: string;
  #peerConnected = false;
  #everConnected = false;
  #files: GetFile[] = [];
  #byKey = new Map<string, GetFile>();
  #totalBytes = 0;
  #receivedBytes = 0;
  #percent: number | null = null;
  #speed = 0;
  #partial = false;
  #failedCount = 0;
  #truncated: { available: number; shown: number } | null = null;
  #reachable: boolean | null = null;
  #countersTimer: NodeJS.Timeout | null = null;
  #cancelled = false;
  #abort: (() => void) | null = null;
  #stopped = false;

  constructor(options: GetOptions) {
    this.#options = options;
    this.store = new Store(() => this.#snapshot());
  }

  async start(): Promise<void> {
    try {
      const key = parseShareLink(this.#options.sharelink);
      if (!key) throw new Error('This does not look like a valid sharelink.');
      this.#ownerKey = key;

      this.#session = await openSession({ bootstrap: this.#options.bootstrap, role: 'get' });
      this.#wireEvents();
      this.#startProbe();

      this.#phase = 'connecting';
      this.store.touch(true);

      const opened = await this.#session.manager.openDrive(this.#options.sharelink);
      if (this.#stopped) return;

      this.#driveId = opened.driveId;
      this.#shareName = opened.shareName ?? undefined;
      this.#truncated = opened.truncated;
      this.#totalBytes = opened.totalBytes;
      this.#peerConnected = opened.peerConnected;
      this.#everConnected = opened.peerConnected;
      this.#files = opened.files.map((file, id) => toGetFile(file, id));
      this.#byKey = new Map(this.#files.map((file) => [file.virtualPath, file]));
      this.#phase = 'downloading';
      this.store.touch(true);

      await this.#download();
    } catch (error) {
      if (this.#cancelled) return;
      this.#fail(error);
    }
  }

  #wireEvents(): void {
    const manager = this.#session!.manager;
    const on = (event: string, fn: (...args: any[]) => void) => {
      manager.on(event, fn);
      this.#listeners.push([event, fn]);
    };

    // The engine reports receive-side liveness every 30s while it searches.
    on('connection-status', (data: { driveId: string; peerConnected: boolean }) => {
      if (!this.#isOurs(data.driveId)) return;
      this.#peerConnected = data.peerConnected;
      if (data.peerConnected) this.#everConnected = true;
      this.store.touch(true);
    });

    on('download-peer-disconnected', (data: { driveId: string }) => {
      if (!this.#isOurs(data.driveId)) return;
      this.#peerConnected = false;
      this.store.touch(true);
    });
  }

  #isOurs(driveId: string): boolean {
    return !this.#driveId || this.#driveId === driveId;
  }

  async #download(): Promise<void> {
    const manager = this.#session!.manager;
    const session = this.#driveId ? manager.activeDrives.get(this.#driveId) : undefined;
    if (!session) throw new Error('The sender closed the connection before the download started.');

    const result = await downloadFromDrive(session.drive, {
      destDir: this.#options.outDir,
      totalBytes: this.#totalBytes,
      shareName: this.#shareName ?? null,
      isCancelled: () => this.#cancelled,
      registerAborter: (abort) => {
        this.#abort = abort;
      },
      onRoot: (root) => {
        this.#downloadPath = root;
      },
      onProgress: (data) => {
        if (this.#cancelled) return;
        this.#percent = data.percent >= 0 ? data.percent : null;
        this.#receivedBytes = data.bytesTransferred;
        this.#speed = data.speed;
        this.store.touch();
      },
      onFileStart: ({ key }) => {
        const file = this.#byKey.get(key);
        if (!file) return;
        file.state = 'downloading';
        this.store.touch();
      },
      onFileDone: ({ key, size, path: written, error }) => {
        const file = this.#byKey.get(key);
        if (!file) return;
        if (error) {
          file.state = 'error';
          file.percent = null;
          file.note = error;
          this.#failedCount += 1;
        } else {
          file.state = 'done';
          file.percent = 100;
          file.size = size || file.size;
          if (written) file.destination = written;
        }
        this.store.touch();
      },
    });

    if (this.#cancelled) return;

    // Zero files retrieved is never a success: either the sender had nothing to send, or its
    // file list never replicated. Reporting "done" here would hide a broken transfer.
    if (result.files.length === 0) {
      throw new Error(
        result.failed.length > 0
          ? 'The sender went offline before any files transferred'
          : 'No files received — the sender never sent its file list',
      );
    }

    // The result is authoritative for sizes and final paths (including "(1)" renames).
    for (const file of result.files) {
      const row = file.key ? this.#byKey.get(file.key) : undefined;
      if (!row) continue;
      row.state = 'done';
      row.percent = 100;
      row.destination = file.path;
      row.size = file.size || row.size;
    }

    this.#downloadPath = result.destDir;
    this.#receivedBytes = result.totalBytes;
    this.#percent = 100;
    this.#speed = 0;
    this.#partial = result.failed.length > 0;
    this.#failedCount = result.failed.length;
    this.#phase = 'done';
    this.store.touch(true);
  }

  #startProbe(): void {
    const session = this.#session!;
    this.#probe = new NetworkProbe({ bootstrap: session.nodes, log: createLogger() });
    this.#probe.start();

    const tick = () => {
      if (this.#stopped) return;
      this.#reachable = this.#probe?.reachable ?? null;
      this.store.touch();
      this.#countersTimer = setTimeout(tick, COUNTERS_POLL_MS);
      this.#countersTimer.unref?.();
    };
    tick();
  }

  /** Stop the transfer. Partial files are removed by the downloader. */
  cancel(): void {
    if (this.#cancelled) return;
    this.#cancelled = true;
    try {
      this.#abort?.();
    } catch {}
    this.#abort = null;
    if (this.#phase === 'connecting') {
      // Still waiting for the sender: abort the pending connection.
      void this.#session?.manager.abortAllConnections({ force: true });
    }
    this.store.touch(true);
  }

  #fail(error: unknown): void {
    this.#phase = 'error';
    this.#error = error instanceof Error ? error.message : String(error);
    this.store.touch(true);
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#countersTimer) clearTimeout(this.#countersTimer);
    this.#countersTimer = null;

    const manager = this.#session?.manager;
    for (const [event, fn] of this.#listeners) manager?.removeListener(event, fn);
    this.#listeners = [];

    await this.#probe?.stop();
    this.#probe = null;
    this.store.dispose();
    await this.#session?.close();
  }

  #snapshot(): GetSnapshot {
    const counts: Record<GetFileState, number> = { queued: 0, downloading: 0, done: 0, error: 0 };
    for (const file of this.#files) counts[file.state] += 1;

    return {
      phase: this.#phase,
      error: this.#error,
      sharelink: this.#options.sharelink,
      ownerKey: this.#ownerKey,
      driveId: this.#driveId,
      shareName: this.#shareName,
      outDir: this.#options.outDir,
      downloadPath: this.#downloadPath,
      peerConnected: this.#peerConnected,
      everConnected: this.#everConnected,
      files: this.#files.map((file) => ({ ...file })),
      counts,
      totalBytes: this.#totalBytes,
      receivedBytes: this.#receivedBytes,
      percent: this.#percent,
      speed: this.#speed,
      partial: this.#partial,
      failedCount: this.#failedCount,
      truncated: this.#truncated,
      reachable: this.#reachable,
      cancelled: this.#cancelled,
    };
  }
}

function toGetFile(file: RemoteFile, id: number): GetFile {
  return {
    id,
    virtualPath: file.name,
    destination: file.path ?? '',
    size: file.size || 0,
    state: 'queued',
    percent: null,
  };
}
