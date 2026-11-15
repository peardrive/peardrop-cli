import fs from 'node:fs';
import path from 'node:path';
import { format } from 'node:util';
import { createCliRenderer } from '@opentui/core';
import { createRoot } from '@opentui/react';
import { registerQRCode } from '@opentui/qrcode/react';
import { ShareController } from './core/share.js';
import { GetController } from './core/get.js';
import { peardropHome } from './core/session.js';
import { ShareApp } from './ui/ShareApp.js';
import { GetApp } from './ui/GetApp.js';
import { ErrorBoundary } from './ui/ErrorBoundary.js';

const HELP = `peardrop: share files and folders peer-to-peer (powered by pearcore)

Usage
  peardrop share <file|directory> [options]
  peardrop get <sharelink> [options]

Options
  -o, --out <dir>          (get) where to save files            default: current directory
  -n, --concurrency <N>    (get) parallel downloads              default: 3
  -b, --bootstrap <h:p>    custom DHT bootstrapper (e.g. 127.0.0.1:49737); env PEARDROP_BOOTSTRAP
      --no-copy            (share) don't copy the sharelink to the clipboard automatically
  -h, --help               show this help
`;

interface Args {
  command?: string;
  target?: string;
  out: string;
  concurrency: number;
  bootstrap: string | null;
  help: boolean;
  copy: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    out: process.cwd(),
    concurrency: 3,
    bootstrap: process.env.PEARDROP_BOOTSTRAP || null,
    help: false,
    copy: true,
  };
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const [flag, inline] = arg.startsWith('--') && arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined];
    const value = () => {
      const v = inline ?? argv[++i];
      if (v === undefined) throw new Error(`Missing value for ${flag}`);
      return v;
    };
    switch (flag) {
      case '-h':
      case '--help':
        args.help = true;
        break;
      case '-o':
      case '--out':
        args.out = path.resolve(value());
        break;
      case '-n':
      case '--concurrency': {
        const n = Number(value());
        if (!Number.isInteger(n) || n < 1 || n > 32) throw new Error('--concurrency must be an integer between 1 and 32');
        args.concurrency = n;
        break;
      }
      case '--no-copy':
        args.copy = false;
        break;
      case '-b':
      case '--bootstrap': {
        const v = value();
        if (!/^[^:\s]+:\d+$/.test(v)) throw new Error('--bootstrap expects host:port');
        args.bootstrap = v;
        break;
      }
      default:
        if (flag.startsWith('-')) throw new Error(`Unknown option ${flag}`);
        positional.push(arg);
    }
  }

  [args.command, args.target] = positional;
  return args;
}

/**
 * Everything printed while the TUI owns the terminal would corrupt the screen, and pearcore
 * still has stray console.log/console.error calls. Send them to ~/.peardrop/peardrop.log.
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
      concurrency: args.concurrency,
      bootstrap: args.bootstrap,
    });
    const quit = async () => {
      if (quitting) return;
      quitting = true;
      const snap = controller.store.get();
      summary = `Received ${snap.counts.done} file(s) into ${snap.outDir}.`;
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
    await Promise.race([stop(), new Promise((resolve) => setTimeout(resolve, 6000))]);
  } catch {
    // ignore
  }
  if (summary) process.stdout.write(`${summary}\n`);
  if (process.env.PEARDROP_DEBUG) process.stdout.write(`log: ${logFile}\n`);
  process.exit(0);
}

await main();
