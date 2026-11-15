// Minimal typings for the parts of pearcore that peardrop uses.
// pearcore ships plain JS without declarations (see docs/PEARCORE_ISSUES.md).

declare module 'pearcore/src/core.js' {
  import type { EventEmitter } from 'node:events';

  export interface ProgressSnapshot {
    percent: number | null;
    contributions: Array<{ source: string; percent: number }>;
  }

  export interface SpaceInstance {
    readonly id: number;
    readonly spaceName: string;
    readonly publicKey: string;
    readonly nonce: string;
    readonly isSync: boolean;
    readonly sharelink: string;
    readonly topicHash: string;
    setPrefix(prefix: string): void;
  }

  export interface LocalFileEntry {
    readonly name: string;
    readonly path: string;
    readonly rootHash: string | null;
    readonly exists: boolean;
    readonly indexingProgress: ProgressSnapshot | null | undefined;
    onIndexing(callback: (snapshot: ProgressSnapshot) => void): void;
    onComplete(callback: () => void): void;
    onError(callback: (error: Error) => void): void;
  }

  export interface SpaceDownloadTask {
    readonly downloadComplete: boolean;
    getProgress(): ProgressSnapshot;
    onProgress(callback: (snapshot: ProgressSnapshot) => void): void;
    offProgress(callback: (snapshot: ProgressSnapshot) => void): void;
    onComplete(callback: () => void): void;
    stop(): Promise<void>;
  }

  export interface SpaceFileEntry {
    readonly name: string;
    readonly path: string;
    readonly exists: boolean;
    readonly variants: string[];
    getProvidersForVariant(rootHash: string): string[];
    download(rootHash: string, destination: string): Promise<SpaceDownloadTask | undefined>;
  }

  export interface SpaceDriveBrowser {
    readonly path: string;
    files(options?: { recursive?: boolean }): string[];
    folders(options?: { recursive?: boolean }): string[];
    getFile(spaceFilePath: string): Promise<SpaceFileEntry>;
    addFile(spaceFilePath: string, localFilePath: string): Promise<LocalFileEntry>;
    cd(subpath: string): SpaceDriveBrowser;
  }

  export interface Core {
    emitter: EventEmitter;
    managers: any;
    space: {
      setPrefix(prefix: string): void;
      create(payload: {
        spaceName: string;
        permissionBroadcast?: boolean;
        permissionRead?: boolean;
        broadcastWhitelist?: string[];
        readWhitelist?: string[];
      }): Promise<SpaceInstance>;
      join(sharelink: string): Promise<SpaceInstance>;
      leave(space: SpaceInstance): Promise<void>;
      list(params?: Record<string, unknown>): Promise<SpaceInstance[]>;
    };
    drives: { get(space: SpaceInstance): SpaceDriveBrowser };
    accounts: {
      create(username: string, password: string): Promise<unknown>;
      authenticate(username: string, password: string): Promise<unknown>;
      logout(): Promise<void>;
    };
    getPublicKey(): string | undefined;
  }

  export function createCore(options?: {
    rootPath?: string;
    bootstrap?: string | null;
    user?: { username: string; password: string } | null;
  }): Promise<Core>;
}

declare module 'pearcore/src/constants/events.constants.js' {
  export const Connection: 'Connection';
  export const Disconnect: 'Disconnect';
  export const Handshake: 'Handshake';
  export const Reject: 'Reject';
  export const SpaceHashList: 'SpaceHashList';
  export const SpaceSync: 'SpaceSync';
  export const SpaceFileEvent: 'SpaceFileEvent';
  export const SpaceFileTreeRequest: 'SpaceFileTreeRequest';
  export const SpaceFileContentRequest: 'SpaceFileContentRequest';
}

declare module 'pearcore/src/utils/sharelink.utils.js' {
  export function decodeShareLink(sharelink: string): {
    spaceName: string;
    publicKey: string;
    nonce: string;
  } | null;
}
