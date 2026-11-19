// TEST-ONLY preload: `node -r ./scripts/e2e-unfirewalled.cjs bin/peardrop.mjs ...`
//
// Two *separate processes* on one machine that HyperDHT both considers firewalled never
// complete the holepunch: the client "opens" a stream the server never sees, then the
// connection times out. In-process (the vitest roundtrip) it works, because both swarms
// share the same UDP stack.
//
// Marking the node as reachable and binding it to loopback makes HyperDHT connect directly,
// which is what the e2e tests need. This is a test harness detail: on a real network, or
// between two machines, no such patch is required.
const dhtPath = require.resolve('hyperdht', { paths: [require.resolve('hyperswarm')] });
const DHT = require(dhtPath);

class UnfirewalledDHT extends DHT {
  constructor(opts = {}) {
    super({ host: '127.0.0.1', firewalled: false, ...opts });
  }
}

Object.assign(UnfirewalledDHT, DHT);
require.cache[dhtPath].exports = UnfirewalledDHT;
