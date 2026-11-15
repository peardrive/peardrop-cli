#!/usr/bin/env node
/**
 * peardrop launcher.
 *
 * Everything (OpenTUI + pearcore) runs in this single Node process.
 * This file only prepares the runtime before the real CLI is imported:
 *   1. checks the Node version (OpenTUI's Node build needs `node:ffi`, Node >= 26.4),
 *   2. sets pearcore's import-time environment (log dir, no pretty stdout logger),
 *   3. installs a resolver hook for pearcore's case-mismatched imports (see docs/PEARCORE_ISSUES.md).
 */
import os from 'node:os';
import path from 'node:path';
import { readdirSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 26 || (major === 26 && minor < 4)) {
  console.error(
    `peardrop needs Node.js >= 26.4 (OpenTUI uses node:ffi). You are running ${process.version}.`,
  );
  process.exit(1);
}

// Silence the one-time "FFI is an experimental feature" warning; it would land on top of the TUI.
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = (warning, ...args) => {
  const text = typeof warning === 'string' ? warning : warning?.message ?? '';
  if (/FFI is an experimental feature/.test(text)) return;
  return emitWarning(warning, ...args);
};

// pearcore reads these at import time.
process.env.PEARDROP_HOME ??= path.join(os.homedir(), '.peardrop');
process.env.DEFAULT_ACCOUNT_DIR ??= process.env.PEARDROP_HOME; // pearcore writes its .logs here
process.env.NODE_ENV ??= 'production'; // keeps pearcore's pino-pretty logger off stdout

// WORKAROUND: pearcore imports './merkletree.utils.js' while the file is 'merkleTree.utils.js'.
// That only works on case-insensitive filesystems (macOS/Windows); on Linux it throws.
registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (error) {
      if (error?.code !== 'ERR_MODULE_NOT_FOUND' || !error.url?.includes('/pearcore/')) throw error;
      const wanted = fileURLToPath(error.url);
      const match = readdirSync(path.dirname(wanted)).find(
        (name) => name.toLowerCase() === path.basename(wanted).toLowerCase(),
      );
      if (!match) throw error;
      return next(pathToFileURL(path.join(path.dirname(wanted), match)).href, context);
    }
  },
});

await import('../dist/cli.js');
