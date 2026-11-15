// Local DHT bootstrapper for testing, the same setup pearcore's e2e tests use (tests/factory.js).
// Usage: node scripts/dev-bootstrap.mjs [port]   then run peardrop with --bootstrap 127.0.0.1:<port>
import '../scripts/pearcore-case-hook.mjs';
const { startBootstrapper } = await import('pearcore/src/utils/network.utils.js');

const port = Number(process.argv[2] ?? 49737);
const instance = await startBootstrapper({ ipv4: '127.0.0.1', port });
console.log(`DHT bootstrapper listening on 127.0.0.1:${port} (persistent node on ${port + 1})`);

const stop = async () => {
  await instance.bootstrapperNode.destroy();
  await instance.persistentNode.destroy();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
