/**
 * End-to-end through the CLI's own controllers: share a folder, open the link as a
 * receiver, download, and compare every byte. Runs on an in-process DHT testnet, so no
 * public network and no TUI are involved.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { GetController } from '../../src/core/get.js';
import { openSession } from '../../src/core/session.js';
import { ShareController } from '../../src/core/share.js';

const require = createRequire(import.meta.url);
const createTestnet = require('hyperdht/testnet') as (size: number) => Promise<{
  bootstrap: Array<{ host: string; port: number }>;
  destroy: () => Promise<void>;
}>;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-roundtrip-'));
const originalHome = process.env.PEARDROP_HOME;

let testnet: Awaited<ReturnType<typeof createTestnet>>;
let bootstrap: string;

beforeAll(async () => {
  process.env.PEARDROP_HOME = path.join(tmp, 'home');
  testnet = await createTestnet(3);
  bootstrap = testnet.bootstrap.map((node) => `${node.host}:${node.port}`).join(',');
});

afterAll(async () => {
  await testnet?.destroy();
  fs.rmSync(tmp, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env.PEARDROP_HOME;
  else process.env.PEARDROP_HOME = originalHome;
});

function writeFile(relative: string, contents: string | Buffer): string {
  const full = path.join(tmp, relative);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, contents);
  return full;
}

async function waitFor(predicate: () => boolean, timeoutMs = 20_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for a condition');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('share → get roundtrip', () => {
  test('a folder keeps its tree, including empty files', async () => {
    const src = path.join(tmp, 'photos');
    const big = crypto.randomBytes(300_000);
    writeFile('photos/2024/a.jpg', big);
    writeFile('photos/notes.txt', 'hello from peardrop');
    writeFile('photos/empty.bin', '');

    const share = new ShareController(src, bootstrap);
    await share.start();

    const shared = share.store.get();
    expect(shared.phase).toBe('ready');
    expect(shared.shareName).toBe('photos');
    expect(shared.sharelink).toMatch(/^peardrop:\/\/[0-9a-f]{64}$/);
    expect(shared.counts.ready).toBe(3);
    expect(shared.totalBytes).toBe(300_000 + 'hello from peardrop'.length);

    const out = path.join(tmp, 'out-folder');
    const get = new GetController({ sharelink: shared.sharelink!, outDir: out, bootstrap });
    await get.start();

    const received = get.store.get();
    expect(received.phase).toBe('done');
    expect(received.counts.done).toBe(3);
    expect(received.partial).toBe(false);

    const root = path.join(out, 'photos');
    expect(fs.readFileSync(path.join(root, '2024', 'a.jpg'))).toEqual(big);
    expect(fs.readFileSync(path.join(root, 'notes.txt'), 'utf8')).toBe('hello from peardrop');
    expect(fs.statSync(path.join(root, 'empty.bin')).size).toBe(0);

    await get.stop();
    await share.stop();
  }, 120_000);

  test('a single file lands directly in the output folder', async () => {
    const file = writeFile('solo/report.pdf', crypto.randomBytes(50_000));

    const share = new ShareController(file, bootstrap);
    await share.start();
    const shared = share.store.get();
    expect(shared.isDirectory).toBe(false);
    expect(shared.sharelink).toMatch(/^peardrop:\/\/[0-9a-f]{64}$/);

    const out = path.join(tmp, 'out-single');
    const get = new GetController({ sharelink: shared.sharelink!, outDir: out, bootstrap });
    await get.start();

    expect(get.store.get().phase).toBe('done');
    expect(fs.readFileSync(path.join(out, 'report.pdf'))).toEqual(fs.readFileSync(file));

    await get.stop();
    await share.stop();
  }, 120_000);
});

describe('failures', () => {
  test('an invalid link is rejected before any network work', async () => {
    const get = new GetController({
      sharelink: 'not-a-link',
      outDir: path.join(tmp, 'out-invalid'),
      bootstrap,
    });
    await get.start();

    const snap = get.store.get();
    expect(snap.phase).toBe('error');
    expect(snap.error).toMatch(/valid sharelink/);
    await get.stop();
  }, 30_000);

  test('cancelling while waiting for a sender resolves cleanly', async () => {
    const link = `peardrop://${'a'.repeat(64)}`;
    // Nothing answers on this bootstrap address, so the sender search stays pending for as long
    // as it runs. Wait for the pending connection itself rather than for the controller's
    // 'connecting' phase: on a fast runner that phase is gone before a poll can see it, which
    // made this test time out on ubuntu-latest in the 0.1.0 release.
    const session = await openSession({ bootstrap: '127.0.0.1:1', role: 'get' });

    try {
      const opening = session.manager.openDrive(link);
      // Attach the handler before the abort below: the rejection can land while the cleanup
      // is still being awaited, and an unhandled rejection fails the run on its own.
      opening.catch(() => {});

      await waitFor(() => session.manager.pendingConnections.size === 1);

      await session.manager.abortAllConnections({ force: true });

      await expect(opening).rejects.toThrow(/cancelled/i);
      expect(session.manager.pendingConnections.size).toBe(0);
    } finally {
      await session.close();
    }
  }, 60_000);
});
