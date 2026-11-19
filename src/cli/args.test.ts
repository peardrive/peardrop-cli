import { afterEach, describe, expect, test } from 'vitest';
import { parseArgs } from './args.js';

const ORIGINAL_BOOTSTRAP = process.env.PEARDROP_BOOTSTRAP;

afterEach(() => {
  if (ORIGINAL_BOOTSTRAP === undefined) delete process.env.PEARDROP_BOOTSTRAP;
  else process.env.PEARDROP_BOOTSTRAP = ORIGINAL_BOOTSTRAP;
});

describe('parseArgs', () => {
  test('defaults', () => {
    delete process.env.PEARDROP_BOOTSTRAP;
    const args = parseArgs([], 'C:\\work');
    expect(args).toEqual({
      out: 'C:\\work',
      bootstrap: null,
      help: false,
      copy: true,
      json: false,
    });
    expect(args.command).toBeUndefined();
  });

  test('reads command and target from positionals', () => {
    const args = parseArgs(['share', './photos']);
    expect(args.command).toBe('share');
    expect(args.target).toBe('./photos');
  });

  test('share accepts --no-copy', () => {
    const args = parseArgs(['share', './a.txt', '--no-copy']);
    expect(args.copy).toBe(false);
  });

  test('get accepts -o and -b', () => {
    const args = parseArgs(['get', 'peardrop://abc', '-o', './out', '-b', '127.0.0.1:49737']);
    expect(args.out.endsWith('out')).toBe(true);
    expect(args.bootstrap).toBe('127.0.0.1:49737');
  });

  test('accepts --flag=value', () => {
    const args = parseArgs(['get', 'peardrop://abc', '--bootstrap=10.0.0.2:8787']);
    expect(args.bootstrap).toBe('10.0.0.2:8787');
  });

  test('--json switches to headless', () => {
    expect(parseArgs(['share', './a.txt', '--json']).json).toBe(true);
  });

  test('falls back to PEARDROP_BOOTSTRAP', () => {
    process.env.PEARDROP_BOOTSTRAP = '127.0.0.1:8787';
    expect(parseArgs(['share', './a.txt']).bootstrap).toBe('127.0.0.1:8787');
  });

  test('rejects --concurrency with an explanation', () => {
    expect(() => parseArgs(['get', 'peardrop://abc', '-n', '3'])).toThrow(/no longer supported/);
    expect(() => parseArgs(['get', 'peardrop://abc', '--concurrency=3'])).toThrow(/no longer supported/);
  });

  test('rejects unknown flags', () => {
    expect(() => parseArgs(['share', './a.txt', '--nope'])).toThrow(/Unknown option/);
  });

  test('rejects a missing flag value', () => {
    expect(() => parseArgs(['get', 'peardrop://abc', '-o'])).toThrow(/Missing value for -o/);
  });

  test('rejects a malformed bootstrap address', () => {
    expect(() => parseArgs(['share', './a.txt', '-b', 'localhost'])).toThrow(/host:port/);
  });

  test('-h sets help', () => {
    expect(parseArgs(['-h']).help).toBe(true);
  });
});
