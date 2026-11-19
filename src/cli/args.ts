import path from 'node:path';

export const HELP = `peardrop: share files and folders peer-to-peer (powered by Hyperdrive)

Usage
  peardrop share <file|directory> [options]
  peardrop get <sharelink> [options]

Options
  -o, --out <dir>          (get) where to save files            default: current directory
  -b, --bootstrap <h:p>    custom DHT bootstrapper (e.g. 127.0.0.1:49737); env PEARDROP_BOOTSTRAP
      --no-copy            (share) don't copy the sharelink to the clipboard automatically
      --json               headless: print newline-delimited JSON events instead of a TUI
  -h, --help               show this help
`;

export interface Args {
  command?: string;
  target?: string;
  out: string;
  bootstrap: string | null;
  help: boolean;
  copy: boolean;
  json: boolean;
}

export function parseArgs(argv: string[], cwd = process.cwd()): Args {
  const args: Args = {
    out: cwd,
    bootstrap: process.env.PEARDROP_BOOTSTRAP || null,
    help: false,
    copy: true,
    json: false,
  };
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const [flag, inline] = arg.startsWith('--') && arg.includes('=')
      ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)]
      : [arg, undefined];
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
      case '-b':
      case '--bootstrap': {
        const v = value();
        if (!/^[^:\s]+:\d+$/.test(v)) throw new Error('--bootstrap expects host:port');
        args.bootstrap = v;
        break;
      }
      case '-n':
      case '--concurrency':
        throw new Error(
          '--concurrency is no longer supported: the Hyperdrive engine streams files one at a time',
        );
      case '--no-copy':
        args.copy = false;
        break;
      case '--json':
        args.json = true;
        break;
      default:
        if (flag.startsWith('-')) throw new Error(`Unknown option ${flag}`);
        positional.push(arg);
    }
  }

  [args.command, args.target] = positional;
  return args;
}
