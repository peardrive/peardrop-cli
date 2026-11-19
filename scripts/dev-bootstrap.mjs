#!/usr/bin/env node
/**
 * Local HyperDHT bootstrapper for testing — `npm run dev:bootstrap`.
 *
 * Starts a private DHT so two peardrop processes can find each other without the
 * public network (LAN / offline testing / CI):
 *
 *   npm run dev:bootstrap                       # 127.0.0.1:49737
 *   npm run dev:bootstrap -- 8787               # 127.0.0.1:8787
 *   npm run dev:bootstrap -- 49737 0.0.0.0      # bind to every interface
 *
 * Then point peers at it:
 *   peardrop share ./file --bootstrap 127.0.0.1:49737
 *   PEARDROP_BOOTSTRAP=127.0.0.1:49737 peardrop get '<link>'
 *
 * The bootstrapper listens on <port>; a persistent DHT node on <port+1> joins it, so the
 * network has a routable member from the first second.
 */
import HyperDHT from 'hyperdht';

const port = Number(process.argv[2] ?? 49737);
const host = process.argv[3] ?? '127.0.0.1';

if (!Number.isInteger(port) || port < 1 || port > 65534) {
  console.error(`Invalid port: ${process.argv[2]}`);
  process.exit(2);
}

const bootstrapperNode = HyperDHT.bootstrapper(port, host);
await bootstrapperNode.fullyBootstrapped();

const persistentNode = new HyperDHT({ bootstrap: [{ host, port }], ephemeral: false, port: port + 1 });
await persistentNode.fullyBootstrapped();

console.log(`DHT bootstrapper listening on ${host}:${port} (persistent node on ${host}:${port + 1})`);

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await Promise.allSettled([persistentNode.destroy(), bootstrapperNode.destroy()]);
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
