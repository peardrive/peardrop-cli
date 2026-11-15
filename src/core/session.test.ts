import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { parseBootstrap, peardropHome, sweepStaleSessions } from './session.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-session-'));

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('parseBootstrap', () => {
  test('a single host:port', () => {
    expect(parseBootstrap('127.0.0.1:49737')).toEqual([{ host: '127.0.0.1', port: 49737 }]);
  });

  test('a comma-separated list', () => {
    expect(parseBootstrap('127.0.0.1:8787, 10.0.0.2:49737')).toEqual([
      { host: '127.0.0.1', port: 8787 },
      { host: '10.0.0.2', port: 49737 },
    ]);
  });

  test('empty means the public DHT', () => {
    expect(parseBootstrap(null)).toEqual([]);
    expect(parseBootstrap('')).toEqual([]);
    expect(parseBootstrap(undefined)).toEqual([]);
  });

  test('a missing port is an error', () => {
    expect(() => parseBootstrap('localhost')).toThrow(/Missing port/);
  });

  test('an out-of-range port is an error', () => {
    expect(() => parseBootstrap('localhost:99999')).toThrow(/out of range/);
  });
});

describe('peardropHome', () => {
  const original = process.env.PEARDROP_HOME;

  test('honours PEARDROP_HOME', () => {
    process.env.PEARDROP_HOME = path.join(tmp, 'custom');
    expect(peardropHome()).toBe(path.join(tmp, 'custom'));
    if (original === undefined) delete process.env.PEARDROP_HOME;
    else process.env.PEARDROP_HOME = original;
  });
});

describe('sweepStaleSessions', () => {
  function sessionDir(name: string, pid: number | null, ageMs = 0): string {
    const dir = path.join(tmp, 'sessions', name);
    fs.mkdirSync(dir, { recursive: true });
    if (pid !== null) fs.writeFileSync(path.join(dir, '.peardrop.pid'), String(pid));
    if (ageMs > 0) {
      const when = new Date(Date.now() - ageMs);
      fs.utimesSync(dir, when, when);
    }
    return dir;
  }

  test('removes dead runs, keeps live and freshly started ones', () => {
    const sessions = path.join(tmp, 'sessions');
    const dead = sessionDir('dead', 999_999);
    const live = sessionDir('live', process.pid);
    const fresh = sessionDir('fresh', null);
    const stale = sessionDir('stale', null, 10 * 60 * 1000);

    sweepStaleSessions(sessions);

    expect(fs.existsSync(dead)).toBe(false);
    expect(fs.existsSync(live)).toBe(true);
    expect(fs.existsSync(fresh)).toBe(true);
    expect(fs.existsSync(stale)).toBe(false);
  });
});
