import fs from 'node:fs';
import path from 'node:path';
import { NetworkProbe } from '@engine/hyperdrive/network-probe';
import type { ShareSourceFile } from '@engine/hyperdrive/types';
import { createLogger, openSession, type PeardropSession } from './session.js';
import { Store } from './store.js';

/** How often the DHT reachability probe is sampled for the header. */
const COUNTERS_POLL_MS = 1000;

export type ShareFileState = 'queued' | 'copying' | 'ready' | 'error';

export interface ShareFile {
  id: number;
  /** Path shown in the UI, e.g. "/sample/nested/a.txt". */
  virtualPath: string;
  sourcePath: string;
  size: number;
  state: ShareFileState;
  percent: number;
  error?: string;
}

export type SharePhase = 'starting' | 'copying' | 'ready' | 'error';

export interface ShareSnapshot {
  phase: SharePhase;
  error?: string;
  inputPath: string;
  isDirectory: boolean;
  shareName: string;
  sharelink?: string;
  driveId?: string;
  /** True once the drive is announced on the DHT and reachable by link holders. */
  announced: boolean;
  files: ShareFile[];
  counts: Record<ShareFileState, number>;
  totalBytes: number;
  /** Bytes copied into the drive so far (the share build). */
  copiedBytes: number;
  /** Peers currently connected to this share. */
  receivers: string[];
  /** Bytes actually sent to receivers. */
  sentBytes: number;
  /** Upload progress of the furthest-along receiver, 0–100. */
  uploadPercent: number;
  /** Bytes per second sent across all receivers. */
  uploadSpeed: number;
  /** Whether a DHT bootstrap server answers a ping; null until first checked. */
  reachable: boolean | null;
}

export interface CollectedSources {
  isDirectory: boolean;
  /** Display name of the share: the folder's or file's basename. */
  shareName: string;
  files: ShareSourceFile[];
}

/**
 * Collect the files to share.
 *
 * A directory keeps its own name as the share name and its tree below it: the engine
 * stores `relativePath` inside the drive and the receiver re-creates the tree under
 * `<out>/<shareName>/`. A single file becomes a one-file share named after the file.
 */
export function collectSources(inputPath: string): CollectedSources {
  const absolute = path.resolve(inputPath);
  const stat = fs.statSync(absolute);

  if (stat.isFile()) {
    const name = path.basename(absolute);
    return {
      isDirectory: false,
      shareName: name,
      files: [{ name, path: absolute, size: stat.size, relativePath: name }],
    };
  }

  if (!stat.isDirectory()) throw new Error(`${inputPath} is neither a file nor a directory`);

  const shareName = path.basename(absolute) || 'peardrop';
  const files: ShareSourceFile[] = [];
  const walk = (dir: string) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        const relativePath = path.relative(absolute, full).split(path.sep).join('/');
        files.push({ name: entry.name, path: full, size: fs.statSync(full).size, relativePath });
      }
      // symlinks, sockets, fifos... are skipped on purpose
    }
  };
  walk(absolute);

  if (files.length === 0) throw new Error(`${inputPath} contains no files`);
  return { isDirectory: true, shareName, files };
}

/** The path a receiver will see for a file: "/<shareName>/<relativePath>". */
export function virtualPathFor(shareName: string, relativePath: string, isDirectory: boolean): string {
  return isDirectory ? `/${shareName}/${relativePath}` : `/${relativePath}`;
}

/**
 * Map overall build progress onto the per-file rows.
 *
 * The engine copies files in order and reports how many are done plus the bytes copied so
 * far, so the file at index `filesDone` is the one currently streaming.
 */
export function applyProgress(files: ShareFile[], filesDone: number, bytesDone: number, copying: boolean): void {
  const done = Math.min(filesDone, files.length);
  let completedBytes = 0;

  for (let i = 0; i < files.length; i++) {
    const file = files[i]!;
    if (i < done) {
      file.state = 'ready';
      file.percent = 100;
    } else if (i === done && copying) {
      file.state = 'copying';
      const inFile = Math.max(0, bytesDone - completedBytes);
      file.percent = file.size > 0 ? Math.min(99, (inFile / file.size) * 100) : 0;
    } else {
      file.state = 'queued';
      file.percent = 0;
    }
    completedBytes += file.size;
  }
}

export class ShareController {
  readonly store: Store<ShareSnapshot>;

  #inputPath: string;
  #bootstrap: string | null;
  #session: PeardropSession | null = null;
  #probe: NetworkProbe | null = null;
  #listeners: Array<[string, (...args: any[]) => void]> = [];

  #phase: SharePhase = 'starting';
  #error?: string;
  #isDirectory = false;
  #shareName = '';
  #sharelink?: string;
  #driveId?: string;
  /** Drive id seen in events before createDrive() returned. */
  #eventDriveId?: string;
  #announced = false;
  #files: ShareFile[] = [];
  #filesDone = 0;
  #copiedBytes = 0;
  #receivers = new Set<string>();
  #uploads = new Map<string, { bytes: number; percent: number; speed: number }>();
  #reachable: boolean | null = null;
  #countersTimer: NodeJS.Timeout | null = null;
  #stopped = false;

  constructor(inputPath: string, bootstrap: string | null) {
    this.#inputPath = inputPath;
    this.#bootstrap = bootstrap;
    this.store = new Store(() => this.#snapshot());
  }

  async start(): Promise<void> {
    try {
      const { isDirectory, shareName, files } = collectSources(this.#inputPath);
      this.#isDirectory = isDirectory;
      this.#shareName = shareName;
      this.#files = files.map((file, id) => ({
        id,
        virtualPath: virtualPathFor(shareName, file.relativePath ?? file.name, isDirectory),
        sourcePath: file.path,
        size: file.size ?? 0,
        state: 'queued',
        percent: 0,
      }));
      this.store.touch(true);

      this.#session = await openSession({ bootstrap: this.#bootstrap, role: 'share' });
      this.#wireEvents();
      this.#startProbe();

      const totalBytes = files.reduce((sum, file) => sum + (file.size ?? 0), 0);
      this.#phase = 'copying';
      this.store.touch(true);

      const result = await this.#session.manager.createDrive(files, {
        name: shareName,
        totalBytes,
        clientJobId: null,
      });

      this.#driveId = result.driveId;
      this.#sharelink = result.shareLink;
      this.#markAllReady();
      this.#phase = 'ready';
      this.store.touch(true);
    } catch (error) {
      this.#fail(error);
    }
  }

  #wireEvents(): void {
    const manager = this.#session!.manager;
    const on = (event: string, fn: (...args: any[]) => void) => {
      manager.on(event, fn);
      this.#listeners.push([event, fn]);
    };

    on('share-started', (data: { driveId: string }) => {
      this.#eventDriveId = data.driveId;
      this.#phase = 'copying';
      this.store.touch(true);
    });

    on('share-progress', (data: { driveId: string; filesDone: number; bytesDone: number }) => {
      if (!this.#isOurs(data.driveId)) return;
      this.#applyProgress(data.filesDone, data.bytesDone);
      this.store.touch();
    });

    on('drive-announced', (data: { driveId: string }) => {
      if (!this.#isOurs(data.driveId)) return;
      this.#announced = true;
      this.store.touch(true);
    });

    on('drive-announce-failed', (data: { driveId: string }) => {
      if (!this.#isOurs(data.driveId)) return;
      this.#announced = false;
      this.store.touch(true);
    });

    on('peer-connected', (data: { driveId: string; peerId: string; publicKey: string | null }) => {
      if (!this.#isOurs(data.driveId)) return;
      this.#receivers.add(data.publicKey ?? data.peerId);
      this.store.touch(true);
    });

    on('peer-disconnected', (data: { driveId: string; peerId: string; publicKey: string | null }) => {
      if (!this.#isOurs(data.driveId)) return;
      if (this.#receivers.delete(data.publicKey ?? data.peerId)) this.store.touch(true);
    });

    on('upload-progress', (data: { driveId: string; peerId: string; percent: number; bytesTransferred: number; speed: number }) => {
      if (!this.#isOurs(data.driveId)) return;
      const previous = this.#uploads.get(data.peerId);
      this.#uploads.set(data.peerId, {
        bytes: Math.max(previous?.bytes ?? 0, data.bytesTransferred),
        percent: Math.max(previous?.percent ?? 0, data.percent),
        speed: data.speed,
      });
      this.store.touch();
    });
  }

  /** True when an event belongs to this run's drive (id may arrive before createDrive resolves). */
  #isOurs(driveId: string): boolean {
    const ours = this.#driveId ?? this.#eventDriveId;
    return !ours || ours === driveId;
  }

  /** Map overall build progress onto the per-file rows. */
  #applyProgress(filesDone: number, bytesDone: number): void {
    this.#filesDone = Math.min(filesDone, this.#files.length);
    this.#copiedBytes = bytesDone;
    applyProgress(this.#files, this.#filesDone, bytesDone, this.#phase === 'copying');
  }

  #markAllReady(): void {
    this.#filesDone = this.#files.length;
    this.#copiedBytes = this.#files.reduce((sum, file) => sum + file.size, 0);
    for (const file of this.#files) {
      file.state = 'ready';
      file.percent = 100;
    }
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

  #snapshot(): ShareSnapshot {
    const counts: Record<ShareFileState, number> = { queued: 0, copying: 0, ready: 0, error: 0 };
    let totalBytes = 0;
    for (const file of this.#files) {
      counts[file.state] += 1;
      totalBytes += file.size;
    }

    let sentBytes = 0;
    let uploadPercent = 0;
    let uploadSpeed = 0;
    for (const upload of this.#uploads.values()) {
      sentBytes += upload.bytes;
      uploadPercent = Math.max(uploadPercent, upload.percent);
      uploadSpeed += upload.speed;
    }

    return {
      phase: this.#phase,
      error: this.#error,
      inputPath: this.#inputPath,
      isDirectory: this.#isDirectory,
      shareName: this.#shareName,
      sharelink: this.#sharelink,
      driveId: this.#driveId,
      announced: this.#announced,
      files: this.#files.map((file) => ({ ...file })),
      counts,
      totalBytes,
      copiedBytes: this.#phase === 'ready' ? totalBytes : this.#copiedBytes,
      receivers: [...this.#receivers],
      sentBytes,
      uploadPercent,
      uploadSpeed,
      reachable: this.#reachable,
    };
  }
}
