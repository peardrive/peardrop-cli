// Headless reproduction of the "downloads stall with many small files" bug (PEARCORE_ISSUES.md §5).
// Two pearcore cores in ONE process (like pearcore's vitest factory): the sharer publishes N small
// files, the getter downloads them CONCURRENCY at a time, then internal state is dumped.
//
//   node -r ./scripts/dev-dht-unfirewalled.cjs --import ./scripts/pearcore-case-hook.mjs \
//        scripts/diag-download-stall.mjs [N=400] [CONCURRENCY=3] [patches]
//
// patches (comma list) monkey-patch candidate fixes into pearcore at runtime:
//   throttle-interval  decay the per-peer message counter every second (setInterval)
//   throttle-raise     frequencyThrottle 100 -> 2000 messages/s
//   tree-timeout       forget unanswered SpaceFileTreeRequests after 5s so the heartbeat re-sends
//   content-retry      re-queue a content assignment with no progress for 8s, even with one provider
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.NODE_ENV = 'test'; // pearcore logger off
process.env.DEFAULT_ACCOUNT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-diag-logs-'));

const { createCore } = await import('pearcore/src/core.js');
const { startBootstrapper } = await import('pearcore/src/utils/network.utils.js');
const EVENTS = await import('pearcore/src/constants/events.constants.js');

const N = Number(process.argv[2] ?? 400);
const CONCURRENCY = Number(process.argv[3] ?? 3);
const patches = new Set((process.argv[4] ?? '').split(',').filter(Boolean));
const TIMEOUT_S = Number(process.env.DIAG_TIMEOUT ?? 60);

const port = 40000 + Math.floor(Math.random() * 20000);
const boot = await startBootstrapper({ ipv4: '127.0.0.1', port });
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-diag-'));
const src = path.join(work, 'src'); fs.mkdirSync(src);
for (let i = 0; i < N; i++) fs.writeFileSync(path.join(src, `f${String(i).padStart(4, '0')}.bin`), Buffer.alloc(1000 + (i * 97) % 50000, i % 251));

async function node(name) {
  const root = fs.mkdtempSync(path.join(work, name + '-'));
  const core = await createCore({ rootPath: root, bootstrap: `127.0.0.1:${port}` });
  await core.accounts.create(name, 'pw'); await core.accounts.authenticate(name, 'pw');
  const stats = { dropped: 0, quarantines: 0, rejects: {}, handled: {} };
  const t = core.managers.throttle;
  const orig = t.shouldBeThrottledByFrequency.bind(t);
  t.shouldBeThrottledByFrequency = (pk) => { const r = orig(pk); if (r) stats.dropped++; return r; };
  const origAdd = t.addToQuarantine.bind(t);
  t.addToQuarantine = (pk) => { stats.quarantines++; return origAdd(pk); };
  core.emitter.on(EVENTS.Reject, ({ message }) => { const r = message?.payload?.reason; stats.rejects[r] = (stats.rejects[r] ?? 0) + 1; });
  core.emitter.on('General', ({ message }) => { stats.handled[message.type] = (stats.handled[message.type] ?? 0) + 1; });
  applyPatches(core);
  return { core, stats, root };
}

function applyPatches(core) {
  if (patches.has('throttle-raise')) core.managers.session.setMessageConfig({ frequencyThrottle: 2000 });
  if (patches.has('throttle-interval')) {
    // FIX A: decay the per-peer frequency counter every second (pearcore uses a one-shot setTimeout)
    const t = core.managers.throttle;
    const timer = setInterval(() => t.clearFrequencyRecords(), 1000); timer.unref();
  }
}

function patchTask(task) {
  task._diag = { beats: 0, treeReqs: 0, treeResp: 0, verifyFail: {} };
  const ob = task.heartbeat.bind(task);
  task.heartbeat = async () => { task._diag.beats++; return ob(); };
  // re-arm the interval so it calls the wrapped heartbeat
  clearInterval(task.heartbeatTimer);
  task.heartbeatTimer = setInterval(() => task.heartbeat(), task.heartbeatIntervalMs);
  const oreq = task.puller.request.bind(task.puller);
  task.puller.request = async (pk) => { task._diag.treeReqs++; return oreq(pk); };
  const over = task.puller.verify.bind(task.puller);
  task.puller.verify = (m) => { const r = over(m); if (m.payload?.tree?.rootHash === task.rootHash) { task._diag.treeResp++; if (!r.succeed) task._diag.verifyFail[r.reason] = (task._diag.verifyFail[r.reason] ?? 0) + 1; } return r; };
  if (patches.has('tree-timeout')) {
    // FIX B: forget tree requests that got no answer within 5s so the heartbeat re-requests them
    const p = task.puller; const sent = new Map();
    for (const n of p.pendingRequests.keys()) sent.set(n, Date.now()); // request already sent by start()
    const origReq = p.request.bind(p);
    p.request = async (pk) => { await origReq(pk); for (const n of p.pendingRequests.keys()) if (!sent.has(n)) sent.set(n, Date.now()); };
    const origPending = p.isPending.bind(p);
    p.isPending = (pk) => { for (const [n, at] of sent) if (Date.now() - at > 5000) { p.pendingRequests.delete(n); sent.delete(n); } return origPending(pk); };
  }
  if (patches.has('content-retry')) {
    // FIX C: re-request an assignment that made no progress for 8s even with a single provider
    const s = task.scheduler; const origReclaim = s.reclaimStalled.bind(s);
    s.reclaimStalled = async () => {
      await origReclaim();
      for (const [pk, a] of [...s.assignments]) {
        if (Date.now() - a.requestedAt > 8000) { s.assignments.delete(pk); s.requeue(a); }
      }
    };
  }
}

const sharer = await node('sharer');
const getter = await node('getter');

const space = await sharer.core.space.create({ spaceName: 'diag', permissionRead: true, permissionBroadcast: false });
const sdrive = sharer.core.drives.get(space);
let indexed = 0;
for (const f of fs.readdirSync(src)) {
  const e = await sdrive.addFile(f, path.join(src, f));
  e.onComplete(() => indexed++);
}
console.error('indexing…');
while (indexed < N) await new Promise((r) => setTimeout(r, 100));

console.error('indexed', indexed);
const synced = new Promise((r) => getter.core.emitter.on(EVENTS.SpaceSync, r));
await getter.core.space.join(space.sharelink);
await synced; console.error('synced');
// same workaround peardrop uses: owner pushes its list to the newcomer
await new Promise((r) => setTimeout(r, 300));
const sock = sharer.core.managers.sockets.getConnectedSockets({ peers: [getter.core.getPublicKey()] })[0];
await sharer.core.managers.message.protocolHandlers.get('SpaceSync').sendSpaceFileListContextToSocket(sock, space.topicHash);

const gspace = (await getter.core.space.list()).find((s) => s.isSync);
const gdrive = getter.core.drives.get(gspace);
for (let i = 0; gdrive.files().length < N; i++) { await new Promise((r) => setTimeout(r, 100)); if (i % 20 === 0) console.error('listed', gdrive.files().length); }
console.error('listed all');

const out = path.join(work, 'out');
const queue = gdrive.files().sort();
const active = new Map(); let done = 0; const started = Date.now();
const tasks = new Map();
async function pump() {
  while (active.size < CONCURRENCY && queue.length) {
    const p = queue.shift();
    active.set(p, Date.now());
    const entry = await gdrive.getFile(p);
    const task = await entry.download(entry.variants[0], path.join(out, p));
    patchTask(task); tasks.set(p, task);
    task.onComplete(() => { active.delete(p); tasks.delete(p); done++; pump(); });
  }
}
pump();

let last = -1, lastChange = Date.now();
const result = await new Promise((resolve) => {
  const iv = setInterval(() => {
    if (done !== last) { last = done; lastChange = Date.now(); }
    const elapsed = (Date.now() - started) / 1000;
    if (done === N) { clearInterval(iv); resolve('complete'); }
    else if (Date.now() - lastChange > 15000 || elapsed > TIMEOUT_S) { clearInterval(iv); resolve('STALLED'); }
  }, 250);
});

const elapsed = ((Date.now() - started) / 1000).toFixed(1);
console.log(`\n=== N=${N} concurrency=${CONCURRENCY} patches=[${[...patches].join(',') || 'none'}] -> ${result}: ${done}/${N} in ${elapsed}s`);
for (const [name, n] of [['sharer', sharer], ['getter', getter]]) {
  console.log(`${name}: quarantines=${n.stats.quarantines} droppedMessages=${n.stats.dropped} rejectsReceived=${JSON.stringify(n.stats.rejects)}`);
  console.log(`   handled=${JSON.stringify(n.stats.handled)}  throttle=${JSON.stringify(Object.values(n.core.managers.throttle.getSnapShot()))}`);
}
for (const [p, task] of tasks) {
  const pending = [...task.puller.pendingRequests.values()].length;
  const asg = [...task.scheduler.assignments.entries()].map(([k, a]) => ({ range: [a.start, a.end], remaining: a.remaining.size, ageS: ((Date.now() - a.requestedAt) / 1000).toFixed(0) }));
  console.log(`  diag ${JSON.stringify(task._diag)} heartbeatRunning=${task._heartbeatRunning}`);
  console.log(`stuck ${p}: tree=${task.tree ? 'adopted' : 'missing'} leafCount=${task.leafCount} pendingTreeReq=${pending} queue=${JSON.stringify(task.scheduler.queue)} assignments=${JSON.stringify(asg)} providers=${JSON.stringify([...task.providerList.entries()].map(([k, v]) => v))}`);
}
const deliv = sharer.core.managers.delivery;
console.log(`sharer delivery: activeKeys=${deliv.deliveryTasksByKey.size} openHandles=${deliv.fileCache.handlers.size}`);
process.exit(0);
