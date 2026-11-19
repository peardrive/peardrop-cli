/**
 * Headless mode (`--json`): run a share or a get without the TUI and print
 * newline-delimited JSON events on stdout. Used by the e2e tests and by scripts.
 *
 * Engine logging is still redirected to ~/.peardrop/peardrop.log, so stdout
 * carries only JSON.
 */
import type { Args } from './args.js';
import { GetController } from '../core/get.js';
import { ShareController } from '../core/share.js';

/** Minimum gap between progress lines. */
const PROGRESS_INTERVAL_MS = 250;

type Json = Record<string, unknown>;

function emit(event: Json): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function onSignal(handler: () => void): void {
  process.once('SIGINT', handler);
  process.once('SIGTERM', handler);
}

export async function runShareHeadless(args: Args): Promise<number> {
  const controller = new ShareController(args.target!, args.bootstrap);

  let announcedStarted = false;
  let lastPhase = '';
  let lastLink: string | undefined;
  let lastProgress = 0;
  let lastAnnounced = false;

  const publish = () => {
    const snap = controller.store.get();

    if (!announcedStarted) {
      announcedStarted = true;
      emit({ event: 'share-started', input: snap.inputPath, files: snap.files.length, bytes: snap.totalBytes });
    }

    if (snap.phase === 'error') {
      emit({ event: 'error', message: snap.error ?? 'unknown error' });
      lastPhase = 'error';
      return;
    }

    if (snap.phase === 'copying') {
      const now = Date.now();
      if (now - lastProgress >= PROGRESS_INTERVAL_MS) {
        lastProgress = now;
        emit({
          event: 'progress',
          phase: 'copying',
          filesDone: snap.counts.ready,
          files: snap.files.length,
          bytesDone: snap.copiedBytes,
          bytes: snap.totalBytes,
        });
      }
    }

    if (snap.sharelink && snap.sharelink !== lastLink) {
      lastLink = snap.sharelink;
      emit({ event: 'sharelink', link: snap.sharelink, driveId: snap.driveId });
    }

    if (snap.phase === 'ready' && lastPhase !== 'ready') {
      lastPhase = 'ready';
      emit({ event: 'ready', files: snap.files.length, bytes: snap.totalBytes });
    }

    if (snap.announced && !lastAnnounced) {
      lastAnnounced = true;
      emit({ event: 'announced' });
    }
  };

  controller.store.subscribe(publish);
  await controller.start();
  publish();

  if (controller.store.get().phase === 'error') {
    await controller.stop();
    return 1;
  }

  // Keep seeding until interrupted: that is what a share is.
  await new Promise<void>((resolve) => onSignal(resolve));
  await controller.stop();
  return 0;
}

export async function runGetHeadless(args: Args): Promise<number> {
  const controller = new GetController({
    sharelink: args.target!.trim(),
    outDir: args.out,
    bootstrap: args.bootstrap,
  });

  let opened = false;
  let lastProgress = 0;
  const emittedFiles = new Set<string>();
  let lastPhase = '';

  const publish = () => {
    const snap = controller.store.get();

    if (snap.phase === 'error') {
      emit({ event: 'error', message: snap.error ?? 'unknown error' });
      lastPhase = 'error';
      return;
    }

    if (!opened && snap.files.length > 0) {
      opened = true;
      emit({
        event: 'opened',
        files: snap.files.length,
        bytes: snap.totalBytes,
        name: snap.shareName ?? null,
        driveId: snap.driveId ?? null,
      });
    }

    if (snap.phase === 'downloading') {
      const now = Date.now();
      if (now - lastProgress >= PROGRESS_INTERVAL_MS) {
        lastProgress = now;
        emit({
          event: 'progress',
          percent: snap.percent,
          bytes: snap.receivedBytes,
          total: snap.totalBytes,
          speed: Math.round(snap.speed),
          filesDone: snap.counts.done,
          files: snap.files.length,
        });
      }
    }

    for (const file of snap.files) {
      if (file.state !== 'done' || emittedFiles.has(file.virtualPath)) continue;
      emittedFiles.add(file.virtualPath);
      emit({ event: 'file-done', path: file.destination, key: file.virtualPath, size: file.size });
    }

    if (snap.phase === 'done' && lastPhase !== 'done') {
      lastPhase = 'done';
      emit({
        event: 'done',
        files: snap.counts.done,
        total: snap.files.length,
        bytes: snap.receivedBytes,
        path: snap.downloadPath ?? snap.outDir,
        partial: snap.partial,
        failed: snap.failedCount,
      });
    }
  };

  const stopOnSignal = () => controller.cancel();
  process.on('SIGINT', stopOnSignal);
  process.on('SIGTERM', stopOnSignal);

  controller.store.subscribe(publish);
  await controller.start();
  publish();

  process.removeListener('SIGINT', stopOnSignal);
  process.removeListener('SIGTERM', stopOnSignal);

  const snap = controller.store.get();
  await controller.stop();

  if (snap.phase === 'error') return 1;
  if (snap.partial || snap.counts.error > 0) return 1;
  return 0;
}
