import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createCore, type Core } from 'pearcore/src/core.js';

export const SHARELINK_PREFIX = 'peardrop';

export interface SessionOptions {
  /** `host:port` of a custom DHT bootstrapper (e.g. the local one used for e2e tests). */
  bootstrap?: string | null;
  /** Used to label the session directory (share/get). */
  role: 'share' | 'get';
  /**
   * Where the throw-away account lives (defaults to ~/.peardrop/sessions). The receiver puts it
   * inside the output folder: pearcore downloads into the account dir and then fs.rename()s the
   * file to its destination, which fails with EXDEV across filesystems.
   */
  baseDir?: string;
}

export interface PeardropSession {
  core: Core;
  root: string;
  close(): Promise<void>;
}

export function peardropHome(): string {
  return process.env.PEARDROP_HOME ?? path.join(os.homedir(), '.peardrop');
}

/**
 * Boot an isolated pearcore node for one CLI run.
 *
 * Every run gets a throw-away account under ~/.peardrop/sessions/<id>: peardrop is a
 * "drop" tool, so there is no identity to keep, and an isolated DB means a re-run never
 * collides with "Record for sharelink already exists" or resumes stale download records.
 */
export async function openSession({ bootstrap = null, role, baseDir }: SessionOptions): Promise<PeardropSession> {
  const sessionsDir = baseDir ?? path.join(peardropHome(), 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  sweepStaleSessions(sessionsDir);
  const root = fs.mkdtempSync(path.join(sessionsDir, `${role}-`));
  fs.writeFileSync(path.join(root, PID_FILE), String(process.pid));

  const core = await createCore({ rootPath: root, bootstrap });
  core.space.setPrefix(SHARELINK_PREFIX);

  const username = 'peardrop';
  const password = randomBytes(16).toString('hex');
  await core.accounts.create(username, password);
  await core.accounts.authenticate(username, password);

  let closed = false;
  return {
    core,
    root,
    async close() {
      if (closed) return;
      closed = true;
      try {
        await withTimeout(core.accounts.logout(), 4000);
      } catch {
        // best effort: the process is exiting anyway
      }
      fs.rmSync(root, { recursive: true, force: true });
      if (baseDir) {
        try {
          fs.rmdirSync(baseDir); // only succeeds when empty
        } catch {}
      }
    },
  };
}

const PID_FILE = '.peardrop.pid';

/** Remove session folders left behind by runs that were killed (kill -9, closed terminal...). */
function sweepStaleSessions(sessionsDir: string): void {
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
    fs.rmSync(dir, { recursive: true, force: true });
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
