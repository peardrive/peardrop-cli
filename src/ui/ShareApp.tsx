import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { TextAttributes } from '@opentui/core';
import { ErrorCorrectionLevel } from '@opentui/qrcode';
import { useKeyboard, useRenderer, useTerminalDimensions } from '@opentui/react';
import type { ShareController, ShareFile, ShareSnapshot } from '../core/share.js';
import { LinkCopier, describeCopy } from '../core/clipboard.js';
import { formatBytes, formatSpeed, theme, truncateMiddle } from './theme.js';
import { FileList, Header, KeyHints, Panel, ProgressBar, Spinner, useListCursor, type ListRow } from './widgets.js';

export function ShareApp({
  controller,
  onQuit,
  autoCopy = true,
}: {
  controller: ShareController;
  onQuit: () => void;
  autoCopy?: boolean;
}) {
  const state = useSyncExternalStore(controller.store.subscribe, controller.store.get);
  const renderer = useRenderer();
  const { width, height } = useTerminalDimensions();
  const [showQR, setShowQR] = useState(false);
  const [copyStatus, setCopyStatus] = useState<{ text: string; ok: boolean } | null>(null);
  const copier = useMemo(() => new LinkCopier(renderer), [renderer]);
  const autoCopied = useRef(false);

  const sharelink = state.sharelink;

  const copyLink = (link: string) => {
    setCopyStatus({ text: 'Copying…', ok: true });
    void copier.copy(link).then((outcome) => setCopyStatus(describeCopy(outcome)));
  };

  // Copy the link as soon as the drive is built, so it can be pasted on the other device right away.
  useEffect(() => {
    if (autoCopy && sharelink && !autoCopied.current) {
      autoCopied.current = true;
      copyLink(sharelink);
    }
  }, [autoCopy, sharelink]);

  useEffect(() => () => void copier.dispose(), [copier]);
  const linkRows = sharelink ? Math.ceil(sharelink.length / Math.max(20, width - 6)) : 1;
  // header 1 + link panel (2 borders + rows + hint + copy status) + summary panel 4 + list borders 2 + hints 1
  const listHeight = Math.max(3, height - (1 + linkRows + 4 + 4 + 2 + 1));

  useKeyboard((key) => {
    if (key.name === 'q' || (key.ctrl && key.name === 'c') || key.name === 'escape') {
      if (showQR && key.name === 'escape') return setShowQR(false);
      onQuit();
      return;
    }
    if (key.name === 'c' && sharelink) {
      copyLink(sharelink);
      return;
    }
    if (key.name === 'r' && sharelink) {
      setShowQR((value) => !value);
      return;
    }
  });

  const focusIndex = state.files.findIndex((file) => file.state === 'copying');
  const { cursor, follow } = useListCursor(state.files.length, listHeight - 1, focusIndex);

  if (state.phase === 'error') {
    return (
      <box flexDirection="column" padding={1}>
        <Header mode="share" />
        <Panel title="Error" borderColor={theme.error}>
          <text fg={theme.error}>{state.error}</text>
        </Panel>
        <KeyHints hints={[['q', 'quit']]} />
      </box>
    );
  }

  const ready = state.phase === 'ready';
  const total = state.files.length;
  const overall = state.totalBytes > 0 ? (state.copiedBytes / state.totalBytes) * 100 : ready ? 100 : 0;
  const rows: ListRow[] = state.files.map((file) => toRow(file));

  if (showQR && sharelink) {
    return (
      <box flexDirection="column" width={width} height={height}>
        <Header mode="sharelink QR" />
        <QRPanel sharelink={sharelink} />
        <KeyHints hints={[['r', 'back'], ['c', 'copy link'], ['q', 'stop sharing']]} />
      </box>
    );
  }

  return (
    <box flexDirection="column" width={width} height={height}>
      <Header mode={state.isDirectory ? 'share folder' : 'share file'} right={<ReceiverBadge state={state} />} />

      <Panel title="Sharelink" borderColor={ready ? theme.brand : theme.border}>
        {sharelink ? (
          <>
            <text fg={theme.info} selectable wrapMode="char">
              {sharelink}
            </text>
            <text>
              <span fg={theme.muted}>run </span>
              <span fg={theme.text}>peardrop get {'<link>'}</span>
              <span fg={theme.muted}> on the other device</span>
            </text>
            <text fg={copyStatus?.ok === false ? theme.warn : theme.ok}>
              {truncateMiddle(
                copyStatus ? `${copyStatus.ok ? '✓' : '!'} ${copyStatus.text}` : 'c copies the link',
                Math.max(10, width - 4),
              )}
            </text>
          </>
        ) : (
          <text>
            <Spinner /> <span fg={theme.muted}>building the share… the link appears when it is ready</span>
          </text>
        )}
      </Panel>

      <Panel title={ready ? 'Ready' : 'Preparing'} borderColor={ready ? theme.brand : theme.border} height={4}>
        <box flexDirection="row" height={1}>
          <text>
            {ready ? (
              <span fg={theme.ok} attributes={TextAttributes.BOLD}>
                ✓ Ready to share
              </span>
            ) : (
              <>
                <Spinner /> <span fg={theme.text}>Copying into the drive </span>
              </>
            )}
            <span fg={theme.muted}>
              {'  '}
              {state.counts.ready}/{total} file{total === 1 ? '' : 's'} · {formatBytes(state.copiedBytes)} /{' '}
              {formatBytes(state.totalBytes)}
            </span>
            {ready && !state.announced ? <span fg={theme.warn}>{'  announcing…'}</span> : null}
            {state.counts.error > 0 ? <span fg={theme.error}>{`  ${state.counts.error} failed`}</span> : null}
          </text>
        </box>
        <box flexDirection="row" height={1}>
          <ProgressBar percent={overall} width={Math.max(10, width - 6)} done={ready} />
        </box>
      </Panel>

      <Panel
        title={`Files (${total})${state.sentBytes > 0 ? ` · ${formatBytes(state.sentBytes)} sent` : ''}`}
        flexGrow={1}
      >
        <FileList rows={rows} height={listHeight} width={width - 4} cursor={cursor} />
      </Panel>

      <KeyHints
        hints={[
          ['c', 'copy link'],
          ['r', 'QR code'],
          ['↑↓', 'scroll'],
          ...(follow ? [] : ([['f', 'follow']] as Array<[string, string]>)),
          ['q', 'stop sharing'],
        ]}
      />
    </box>
  );
}

function ReceiverBadge({ state }: { state: ShareSnapshot }) {
  if (state.receivers.length > 0) {
    const upload = state.uploadPercent > 0 ? ` · ${state.uploadPercent}% · ${formatSpeed(state.uploadSpeed)}` : '';
    return (
      <text>
        <span fg={theme.ok}>
          ● {state.receivers.length} receiver{state.receivers.length === 1 ? '' : 's'} connected{upload}
        </span>
      </text>
    );
  }
  if (state.reachable === false) {
    return (
      <text>
        <span fg={theme.warn}>○ DHT unreachable</span>
      </text>
    );
  }
  return (
    <text>
      <span fg={theme.muted}>○ no receivers yet</span>
    </text>
  );
}

function QRPanel({ sharelink }: { sharelink: string }) {
  return (
    <Panel title="Scan to copy the sharelink" flexGrow={1}>
      <box alignItems="center" justifyContent="center" flexGrow={1}>
        <qr-code
          content={sharelink}
          errorCorrectionLevel={ErrorCorrectionLevel.L}
          quietZone={4}
          fit="contain"
          foregroundColor="#000000"
          backgroundColor="#ffffff"
          fallbackContent="Terminal too small for the QR code. Enlarge the window or zoom out."
          fallbackColor={theme.warn}
        />
      </box>
    </Panel>
  );
}

function toRow(file: ShareFile): ListRow {
  switch (file.state) {
    case 'ready':
      return {
        key: file.id,
        icon: <span fg={theme.ok}>✓</span>,
        label: file.virtualPath,
        percent: 100,
        done: true,
        status: formatBytes(file.size),
        statusColor: theme.muted,
      };
    case 'copying':
      return {
        key: file.id,
        icon: <Spinner />,
        label: file.virtualPath,
        percent: file.percent,
        done: false,
        status: formatBytes(file.size),
        statusColor: theme.accent,
      };
    case 'error':
      return {
        key: file.id,
        icon: <span fg={theme.error}>✗</span>,
        label: file.virtualPath,
        percent: null,
        done: false,
        status: file.error ?? 'failed',
        statusColor: theme.error,
      };
    default:
      return {
        key: file.id,
        icon: <span fg={theme.muted}>·</span>,
        label: file.virtualPath,
        percent: 0,
        done: false,
        status: formatBytes(file.size),
      };
  }
}
