import fs from 'node:fs';
import path from 'node:path';
import { format } from 'node:util';
import { createCliRenderer } from '@opentui/core';
import { createRoot } from '@opentui/react';
import { registerQRCode } from '@opentui/qrcode/react';
import { parseArgs, HELP, type Args } from './cli/args.js';
import { runGetHeadless, runShareHeadless } from './cli/headless.js';
import { GetController } from './core/get.js';
import { ShareController } from './core/share.js';
import { peardropHome } from './core/session.js';
import { ShareApp } from './ui/ShareApp.js';
import { GetApp } from './ui/GetApp.js';
import { ErrorBoundary } from './ui/ErrorBoundary.js';

/**
 * Everything printed while the TUI owns the terminal would corrupt the screen, and the
 * engine still logs through console. Send it all to ~/.peardrop/peardrop.log.
 */
function redirectConsole(): string {
  const logFile = path.join(peardropHome(), 'peardrop.log');
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const stream = fs.createWriteStream(logFile, { flags: 'a' });
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    console[level] = (...items: unknown[]) => {
      stream.write(`${new Date().toISOString()} [${level}] ${format(...items)}\n`);
    };
  }
  process.on('uncaughtException', (error) => console.error('uncaughtException', error));
  process.on('unhandledRejection', (error) => console.error('unhandledRejection', error));
  return logFile;
}

async function main() {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n\n${HELP}`);
    process.exit(2);
  }

  if (args.help || !args.command) {
    process.stdout.write(HELP);
    process.exit(args.help ? 0 : 2);
  }

  if (args.command !== 'share' && args.command !== 'get') {
    process.stderr.write(`Unknown command "${args.command}"\n\n${HELP}`);
    process.exit(2);
  }

  if (!args.target) {
    process.stderr.write(`Missing ${args.command === 'share' ? '<file|directory>' : '<sharelink>'}\n\n${HELP}`);
    process.exit(2);
  }

  if (args.command === 'share' && !fs.existsSync(args.target)) {
    process.stderr.write(`No such file or directory: ${args.target}\n`);
    process.exit(1);
  }

  const logFile = redirectConsole();

  if (args.json) {
    const code = args.command === 'share' ? await runShareHeadless(args) : await runGetHeadless(args);
    if (process.env.PEARDROP_DEBUG) process.stderr.write(`log: ${logFile}\n`);
    process.exit(code);
  }

  registerQRCode();

  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    consoleMode: 'disabled',
    targetFps: 30,
  });
  const root = createRoot(renderer);

  let quitting = false;
  let summary = '';

  if (args.command === 'share') {
    const controller = new ShareController(args.target, args.bootstrap);
    const quit = async () => {
      if (quitting) return;
      quitting = true;
      const snap = controller.store.get();
      summary = snap.sharelink ? `Stopped sharing ${snap.counts.ready} file(s).` : '';
      await shutdown(renderer, () => controller.stop(), summary, logFile);
    };
    root.render(
      <ErrorBoundary onQuit={quit}>
        <ShareApp controller={controller} onQuit={quit} autoCopy={args.copy} />
      </ErrorBoundary>,
    );
    process.on('SIGTERM', quit);
    process.on('SIGINT', quit);
    void controller.start();
  } else {
    const controller = new GetController({
      sharelink: args.target.trim(),
      outDir: args.out,
      bootstrap: args.bootstrap,
    });
    const quit = async () => {
      if (quitting) return;
      quitting = true;
      controller.cancel();
      const snap = controller.store.get();
      const where = snap.downloadPath ?? snap.outDir;
      summary = `Received ${snap.counts.done} file(s) into ${where}.`;
      await shutdown(renderer, () => controller.stop(), summary, logFile);
    };
    root.render(
      <ErrorBoundary onQuit={quit}>
        <GetApp controller={controller} onQuit={quit} />
      </ErrorBoundary>,
    );
    process.on('SIGTERM', quit);
    process.on('SIGINT', quit);
    void controller.start();
  }
}

async function shutdown(
  renderer: Awaited<ReturnType<typeof createCliRenderer>>,
  stop: () => Promise<void>,
  summary: string,
  logFile: string,
) {
  renderer.destroy();
  process.stdout.write('Closing peer connections…\n');
  try {
    await Promise.race([stop(), new Promise((resolve) => setTimeout(resolve, 8000))]);
  } catch {
    // ignore
  }
  if (summary) process.stdout.write(`${summary}\n`);
  if (process.env.PEARDROP_DEBUG) process.stdout.write(`log: ${logFile}\n`);
  process.exit(0);
}

await main();
