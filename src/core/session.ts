import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseBootstrapList, type BootstrapNode } from '@shared/bootstrap';
import type { Logger } from '@engine/logger';
import { HyperdriveManager } from '@engine/hyperdrive/manager';

export interface SessionOptions {
  /** `host:port` of a custom DHT bootstrapper (e.g. the local one used for e2e tests). */
  bootstrap?: string | null;
  /** Used to label the session directory (share/get). */
  role: 'share' | 'get';
}

export interface PeardropSession {
  manager: HyperdriveManager;
  root: string;
  /** One Corestore folder per drive. */
  drivesDir: string;
  /** Bootstrap nodes this session's swarms were created with (empty = public DHT). */
  nodes: BootstrapNode[];
  close(): Promise<void>;
}

export function peardropHome(): string {
  return process.env.PEARDROP_HOME ?? path.join(os.homedir(), '.peardrop');
}

/** Parse a `--bootstrap` value into swarm bootstrap nodes. Throws on bad input. */
export function parseBootstrap(value: string | null | undefined): BootstrapNode[] {
  const parsed = parseBootstrapList(value);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.nodes;
}

/** A logger the engine writes through; the CLI redirects console to a file. */
export function createLogger(): Logger {
  const logger: Logger = {
    debug: (message, data) => console.log(`[engine] ${message}`, ...(data === undefined ? [] : [data])),
    info: (message, data) => console.log(`[engine] ${message}`, ...(data === undefined ? [] : [data])),
    warn: (message, data) => console.warn(`[engine] ${message}`, ...(data === undefined ? [] : [data])),
    error: (message, data) => console.error(`[engine] ${message}`, ...(data === undefined ? [] : [data])),
    child(scope: string): Logger {
      return {
        debug: (m, d) => logger.debug(`${scope}: ${m}`, d),
        info: (m, d) => logger.info(`${scope}: ${m}`, d),
        warn: (m, d) => logger.warn(`${scope}: ${m}`, d),
        error: (m, d) => logger.error(`${scope}: ${m}`, d),
        child: (nested) => logger.child(`${scope}:${nested}`),
      };
    },
  };
  return logger;
}

/**
 * Boot an isolated Hyperdrive engine for one CLI run.
 *
 * Every run gets a throw-away data root under ~/.peardrop/sessions/<id>: peardrop is a
 * "drop" tool, so nothing is worth keeping, and an isolated drive list means a re-run never
 * resumes a previous share or mistakes a link for an already-downloaded drive.
 */
export async function openSession({ bootstrap = null, role }: SessionOptions): Promise<PeardropSession> {
  const sessionsDir = path.join(peardropHome(), 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  sweepStaleSessions(sessionsDir);
  const root = fs.mkdtempSync(path.join(sessionsDir, `${role}-`));
  fs.writeFileSync(path.join(root, PID_FILE), String(process.pid));

  const drivesDir = path.join(root, 'drives');
  const nodes = parseBootstrap(bootstrap);
  const manager = new HyperdriveManager({
    drivesDir,
    manifestPath: path.join(root, 'drives-state.json'),
    swarmOptions: nodes.length ? { bootstrap: nodes } : {},
  });
  await manager.init();

  let closed = false;
  return {
    manager,
    root,
    drivesDir,
    nodes,
    async close() {
      if (closed) return;
      closed = true;
      try {
        // force: skip the DHT goodbyes, the process is exiting anyway.
        await withTimeout(manager.abortAllConnections({ force: true }), 3000);
        await withTimeout(manager.stopAll({ persistState: false, force: true }), 6000);
      } catch {
        // best effort
      }
      try {
        fs.rmSync(root, { recursive: true, force: true });
      } catch {}
    },
  };
}

const PID_FILE = '.peardrop.pid';

/** Remove session folders left behind by runs that were killed (kill -9, closed terminal...). */
export function sweepStaleSessions(sessionsDir: string): void {
  for (const name of fs.readdirSync(sessionsDir)) {
    const dir = path.join(sessionsDir, name);
    let pid = NaN;
    try {
      pid = Number(fs.readFileSync(path.join(dir, PID_FILE), 'utf8'));
    } catch {
      // no pid file: created by an older build or half-initialised
    }
    if (Number.isInteger(pid) && pid > 0 && isAlive(pid)) continue;
    if (!pid && Date.now() - fs.statSync(dir).mtimeMs < 30_000) continue; // may be another run starting up
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([promise, new Promise<undefined>((resolve) => setTimeout(resolve, ms))]);
}

export function shortKey(key: string | undefined | null, size = 8): string {
  return key ? key.slice(0, size) : '????????';
}
