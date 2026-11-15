// TEST-ONLY preload: `node -r ./scripts/dev-dht-unfirewalled.cjs bin/peardrop.mjs ...`
//
// In some sandboxes / single-host setups two *separate processes* that are both marked as
// firewalled by HyperDHT never complete the holepunch (the client "opens" a stream the server
// never sees, then ETIMEDOUT). In-process (pearcore's vitest setup) it works. Marking the node
// as reachable makes HyperDHT connect directly. pearcore offers no option to pass DHT settings
// through createCore(), hence this monkey-patch (see docs/PEARCORE_ISSUES.md).
const dhtPath = require.resolve('hyperdht', { paths: [require.resolve('hyperswarm')] });
const DHT = require(dhtPath);
class UnfirewalledDHT extends DHT {
  constructor(opts = {}) {
    super({ host: '127.0.0.1', firewalled: false, ...opts });
  }
}
Object.assign(UnfirewalledDHT, DHT);
require.cache[dhtPath].exports = UnfirewalledDHT;
