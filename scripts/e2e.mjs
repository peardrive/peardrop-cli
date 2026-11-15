#!/usr/bin/env node
/**
 * Headless end-to-end test — `npm run e2e`.
 *
 * Local bootstrapper + `peardrop share --json` + `peardrop get --json`, then a
 * byte-for-byte comparison of every file. No TUI, no tmux, no TTY: safe in CI on
 * Linux, macOS and Windows.
 *
 *   npm run build && npm run e2e
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const bin = path.join(root, 'bin', 'peardrop.mjs');
const bootstrapScript = path.join(root, 'scripts', 'dev-bootstrap.mjs');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-e2e-'));
const src = path.join(work, 'src', 'sample');
const out = path.join(work, 'out');
const port = Number(process.env.PEARDROP_E2E_PORT ?? 49837);
const bootstrap = `127.0.0.1:${port}`;
/** Single-host holepunch workaround; set PEARDROP_E2E_UNFIREWALLED=0 to disable. */
const preload =
  process.env.PEARDROP_E2E_UNFIREWALLED === '0' ? [] : ['-r', path.join(root, 'scripts', 'e2e-unfirewalled.cjs')];

const children = new Set();

function log(message) {
  process.stdout.write(`${message}\n`);
}

function start(args, env, onLine) {
  const child = spawn(process.execPath, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);

  const state = { child, stderr: '', lines: [], waiters: [] };

  const handle = (chunk) => {
    for (const line of chunk.toString().split(/\r?\n/)) {
      if (!line.trim()) continue;
      state.lines.push(line);
      for (const waiter of [...state.waiters]) {
        if (waiter.predicate(line)) {
          state.waiters.splice(state.waiters.indexOf(waiter), 1);
          waiter.resolve(line);
        }
      }
      onLine?.(line);
    }
  };

  child.stdout.on('data', handle);
  child.stderr.on('data', (chunk) => {
    state.stderr += chunk.toString();
  });

  state.exited = new Promise((resolve) => child.on('exit', (code) => resolve(code ?? 0)));

  state.waitFor = (predicate, timeoutMs = 60_000) =>
    new Promise((resolve, reject) => {
      const existing = state.lines.find(predicate);
      if (existing) return resolve(existing);
      const timer = setTimeout(() => {
        reject(new Error(`timed out after ${timeoutMs}ms\n--- stderr ---\n${state.stderr}`));
      }, timeoutMs);
      state.waiters.push({
        predicate,
        resolve: (line) => {
          clearTimeout(timer);
          resolve(line);
        },
      });
    });

  return state;
}

async function stop(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([new Promise((resolve) => child.on('exit', resolve)), new Promise((r) => setTimeout(r, 5000))]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

function parse(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function makeSample() {
  fs.mkdirSync(path.join(src, 'nested', 'deeper'), { recursive: true });
  fs.writeFileSync(path.join(src, 'big.bin'), crypto.randomBytes(3_000_000));
  fs.writeFileSync(path.join(src, 'nested', 'mid.bin'), crypto.randomBytes(700_000));
  fs.writeFileSync(path.join(src, 'nested', 'deeper', 'hello.txt'), 'hello from peardrop\n');
  fs.writeFileSync(path.join(src, 'nested', 'empty.bin'), '');
  for (let i = 1; i <= 5; i++) {
    fs.writeFileSync(path.join(src, 'nested', `small_${i}.bin`), crypto.randomBytes(i * 50_000));
  }
}

function walk(dir, base = dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(full, base));
    else if (entry.isFile()) files.push(path.relative(base, full));
  }
  return files;
}

async function main() {
  if (!fs.existsSync(path.join(root, 'dist', 'cli.js'))) {
    throw new Error('dist/cli.js is missing — run `npm run build` first');
  }

  makeSample();
  const expected = walk(src).sort();
  log(`sample: ${expected.length} files in ${src}`);

  const bootstrapper = start([bootstrapScript, String(port)], {}, (line) => {
    if (line.includes('listening')) log(`bootstrapper: ${line}`);
  });
  await bootstrapper.waitFor((line) => line.includes('listening'));

  const share = start(
    [...preload, bin, 'share', src, '--json', '--bootstrap', bootstrap],
    { PEARDROP_HOME: path.join(work, 'home-share') },
    (line) => {
      const event = parse(line);
      if (event?.event === 'progress' && event.filesDone > 0) {
        log(`share: copying ${event.filesDone}/${event.files} files (${event.bytesDone}/${event.bytes} bytes)`);
      }
    },
  );

  const linkLine = await share.waitFor((line) => parse(line)?.event === 'sharelink');
  const link = parse(linkLine).link;
  log(`sharelink: ${link}`);

  await share.waitFor((line) => parse(line)?.event === 'ready');
  log('share: ready and announced');

  const get = start(
    [...preload, bin, 'get', link, '-o', out, '--json', '--bootstrap', bootstrap],
    { PEARDROP_HOME: path.join(work, 'home-get') },
    (line) => {
      const event = parse(line);
      if (event?.event === 'progress' && event.percent > 0) {
        log(`get: ${event.filesDone}/${event.files} files · ${event.percent}%`);
      }
    },
  );

  await get.waitFor((line) => parse(line)?.event === 'done', 120_000);
  const code = await get.exited;
  if (code !== 0) throw new Error(`peardrop get exited with ${code}\n${get.stderr}`);

  const doneEvent = get.lines.map(parse).find((event) => event?.event === 'done');
  const downloadRoot = doneEvent?.path ?? out;
  log(`get: done, ${doneEvent?.files ?? '?'} files in ${downloadRoot}`);

  const received = walk(downloadRoot).sort();
  const missing = expected.filter((file) => !received.includes(file));
  if (missing.length) throw new Error(`missing files: ${missing.join(', ')}`);

  let mismatched = 0;
  for (const file of expected) {
    const original = fs.readFileSync(path.join(src, file));
    const copy = fs.readFileSync(path.join(downloadRoot, file));
    if (!original.equals(copy)) {
      mismatched += 1;
      log(`MISMATCH ${file}`);
    }
  }
  if (mismatched > 0) throw new Error(`${mismatched} file(s) differ`);

  await stop(get.child);
  await stop(share.child);
  await stop(bootstrapper.child);

  log(`e2e OK: ${expected.length} files transferred intact`);
}

let failure;
try {
  await main();
} catch (error) {
  failure = error;
  log(`e2e FAILED: ${error.message}`);
} finally {
  for (const child of children) await stop(child);
  fs.rmSync(work, { recursive: true, force: true });
}

process.exit(failure ? 1 : 0);
