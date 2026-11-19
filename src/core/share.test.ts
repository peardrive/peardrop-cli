import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { applyProgress, collectSources, virtualPathFor, type ShareFile } from './share.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-sources-'));

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function makeFile(relative: string, contents: string | Buffer): string {
  const full = path.join(tmp, relative);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, contents);
  return full;
}

describe('collectSources', () => {
  test('a single file is its own share', () => {
    const file = makeFile('single/hello.txt', 'hi');
    const collected = collectSources(file);

    expect(collected.isDirectory).toBe(false);
    expect(collected.shareName).toBe('hello.txt');
    expect(collected.files).toEqual([
      { name: 'hello.txt', path: file, size: 2, relativePath: 'hello.txt' },
    ]);
  });

  test('a directory keeps its name and its tree below it', () => {
    makeFile('tree/nested/deep/a.bin', Buffer.alloc(10, 1));
    makeFile('tree/b.txt', 'b');
    const collected = collectSources(path.join(tmp, 'tree'));

    expect(collected.isDirectory).toBe(true);
    expect(collected.shareName).toBe('tree');
    expect(collected.files.map((file) => file.relativePath).sort()).toEqual(['b.txt', 'nested/deep/a.bin']);
    expect(collected.files.map((file) => file.name).sort()).toEqual(['a.bin', 'b.txt']);
    expect(collected.files.reduce((sum, file) => sum + (file.size ?? 0), 0)).toBe(11);
  });

  test('relative paths always use forward slashes', () => {
    makeFile('slashes/x/y/z.txt', 'z');
    const collected = collectSources(path.join(tmp, 'slashes'));
    expect(collected.files[0]!.relativePath).toBe('x/y/z.txt');
  });

  test('an empty directory is an error', () => {
    fs.mkdirSync(path.join(tmp, 'empty'), { recursive: true });
    expect(() => collectSources(path.join(tmp, 'empty'))).toThrow(/contains no files/);
  });
});

describe('virtualPathFor', () => {
  test('folder shares are prefixed with the folder name', () => {
    expect(virtualPathFor('photos', '2024/a.jpg', true)).toBe('/photos/2024/a.jpg');
  });

  test('single-file shares are flat', () => {
    expect(virtualPathFor('a.txt', 'a.txt', false)).toBe('/a.txt');
  });
});

describe('applyProgress', () => {
  const files = (): ShareFile[] => [
    { id: 0, virtualPath: '/s/a', sourcePath: 'a', size: 100, state: 'queued', percent: 0 },
    { id: 1, virtualPath: '/s/b', sourcePath: 'b', size: 300, state: 'queued', percent: 0 },
    { id: 2, virtualPath: '/s/c', sourcePath: 'c', size: 0, state: 'queued', percent: 0 },
  ];

  test('the first file is copying, the rest queued', () => {
    const rows = files();
    applyProgress(rows, 0, 50, true);
    expect(rows[0]!.state).toBe('copying');
    expect(rows[0]!.percent).toBeCloseTo(50);
    expect(rows[1]!.state).toBe('queued');
    expect(rows[2]!.state).toBe('queued');
  });

  test('completed files are ready and the next one shows its own progress', () => {
    const rows = files();
    applyProgress(rows, 1, 250, true);
    expect(rows[0]!.state).toBe('ready');
    expect(rows[0]!.percent).toBe(100);
    // 250 total - 100 for the first file = 150 of the second's 300 bytes.
    expect(rows[1]!.state).toBe('copying');
    expect(rows[1]!.percent).toBeCloseTo(50);
    expect(rows[2]!.state).toBe('queued');
  });

  test('a zero-byte file does not divide by zero', () => {
    const rows = files();
    applyProgress(rows, 2, 400, true);
    expect(rows[2]!.state).toBe('copying');
    expect(rows[2]!.percent).toBe(0);
  });

  test('outside the copying phase nothing is marked active', () => {
    const rows = files();
    applyProgress(rows, 0, 0, false);
    expect(rows.every((row) => row.state === 'queued')).toBe(true);
  });

  test('never runs past the end of the list', () => {
    const rows = files();
    applyProgress(rows, 99, 999, true);
    expect(rows.every((row) => row.state === 'ready')).toBe(true);
  });
});
