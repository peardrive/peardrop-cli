#!/usr/bin/env node
/**
 * peardrop launcher.
 *
 * Everything (OpenTUI + the Hyperdrive engine) runs in this single Node process.
 * This file only prepares the runtime before the real CLI is imported:
 *   1. checks the Node version (OpenTUI's Node build needs `node:ffi`, Node >= 26.4),
 *   2. silences the one-time FFI warning, which would land on top of the TUI.
 */
import os from 'node:os';
import path from 'node:path';

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 26 || (major === 26 && minor < 4)) {
  console.error(
    `peardrop needs Node.js >= 26.4 (OpenTUI uses node:ffi). You are running ${process.version}.`,
  );
  process.exit(1);
}

const emitWarning = process.emitWarning.bind(process);
process.emitWarning = (warning, ...args) => {
  const text = typeof warning === 'string' ? warning : warning?.message ?? '';
  if (/FFI is an experimental feature/.test(text)) return;
  return emitWarning(warning, ...args);
};

process.env.PEARDROP_HOME ??= path.join(os.homedir(), '.peardrop');

await import('../dist/cli.js');
