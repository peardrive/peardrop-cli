import { useSyncExternalStore, type ReactNode } from 'react';
import { TextAttributes } from '@opentui/core';
import { useKeyboard, useTerminalDimensions } from '@opentui/react';
import type { GetController, GetFile, GetSnapshot } from '../core/get.js';
import { shortKey } from '../core/session.js';
import { formatBytes, formatSpeed, theme, truncateMiddle } from './theme.js';
import { FileList, Header, KeyHints, Panel, ProgressBar, Spinner, useListCursor, type ListRow } from './widgets.js';

type StepState = 'pending' | 'active' | 'done' | 'warn';

export function GetApp({ controller, onQuit }: { controller: GetController; onQuit: () => void }) {
  const state = useSyncExternalStore(controller.store.subscribe, controller.store.get);
  const { width, height } = useTerminalDimensions();

  // header 1 + steps panel (2 + 4) + summary panel 4 + list borders 2 + hints 1
  const listHeight = Math.max(3, height - (1 + 6 + 4 + 2 + 1));

  useKeyboard((key) => {
    if (key.name === 'q' || key.name === 'escape' || (key.ctrl && key.name === 'c')) {
      onQuit();
      return;
    }
  });

  const focusIndex = state.files.findIndex((file) => file.state === 'downloading');
  const { cursor, follow } = useListCursor(state.files.length, listHeight - 1, focusIndex);

  if (state.phase === 'error') {
    return (
      <box flexDirection="column" padding={1}>
        <Header mode="get" />
        <Panel title="Error" borderColor={theme.error}>
          <text fg={theme.error}>{state.error}</text>
        </Panel>
        <KeyHints hints={[['q', 'quit']]} />
      </box>
    );
  }

  const { counts } = state;
  const total = state.files.length;
  const allDone = state.phase === 'done';
  const where = state.downloadPath ?? state.outDir;

  return (
    <box flexDirection="column" width={width} height={height}>
      <Header mode="get" right={<ConnectionBadge state={state} />} />

      <Panel title="Session" height={6}>
        <Steps state={state} />
      </Panel>

      <Panel title={allDone ? 'Done' : 'Downloads'} height={4} borderColor={allDone ? theme.brand : theme.border}>
        <box flexDirection="row" height={1}>
          <text>
            {allDone ? (
              <span fg={theme.ok} attributes={TextAttributes.BOLD}>
                {counts.done > 0 ? '✓ All files received' : '✓ Nothing to download'}
              </span>
            ) : state.phase === 'downloading' ? (
              <>
                <Spinner /> <span fg={theme.text}>Downloading</span>
              </>
            ) : (
              <span fg={theme.muted}>Connecting</span>
            )}
            <span fg={theme.muted}>
              {`  ${counts.done}/${total} done · ${formatBytes(state.receivedBytes)} / ${formatBytes(state.totalBytes)}`}
              {state.phase === 'downloading' ? ` · ${formatSpeed(state.speed)}` : ''}
            </span>
            {state.failedCount > 0 ? <span fg={theme.error}>{` · ${state.failedCount} failed`}</span> : null}
            <span fg={theme.muted}>{`  → ${truncateMiddle(where, 40)}`}</span>
          </text>
        </box>
        <box flexDirection="row" height={1}>
          <ProgressBar percent={state.percent} width={Math.max(10, width - 6)} done={allDone} />
        </box>
      </Panel>

      <Panel
        title={`Files (${total})${state.truncated ? ` · showing ${state.truncated.shown} of ${state.truncated.available}` : ''}`}
        flexGrow={1}
      >
        {total === 0 ? (
          <text fg={theme.muted}>The file list appears here once the sender answers…</text>
        ) : (
          <FileList rows={state.files.map(toRow)} height={listHeight} width={width - 4} cursor={cursor} />
        )}
      </Panel>

      <KeyHints hints={[['↑↓', 'scroll'], ...(follow ? [] : ([['f', 'follow']] as Array<[string, string]>) ), ['q', 'quit']]} />
    </box>
  );
}

function ConnectionBadge({ state }: { state: GetSnapshot }) {
  if (state.peerConnected) {
    return (
      <text>
        <span fg={theme.ok}>● connected to the sender {shortKey(state.ownerKey)}</span>
      </text>
    );
  }
  if (state.everConnected) {
    return (
      <text>
        <span fg={theme.warn}>○ disconnected, retrying</span>
      </text>
    );
  }
  if (state.reachable === false) {
    return (
      <text>
        <span fg={theme.warn}>○ offline · the DHT is unreachable</span>
      </text>
    );
  }
  return (
    <text>
      <span fg={theme.muted}>○ looking for the sender…</span>
    </text>
  );
}

function Steps({ state }: { state: GetSnapshot }) {
  const connecting = state.phase === 'starting' || state.phase === 'connecting';
  const downloading = state.phase === 'downloading';
  const done = state.phase === 'done';

  const found: StepState = connecting ? 'active' : 'done';
  const listing: StepState = connecting ? 'active' : 'done';
  const transfer: StepState = downloading ? 'active' : done ? 'done' : 'pending';

  return (
    <box flexDirection="column">
      <Step
        state={found}
        label="Finding the sender"
        detail={state.phase === 'starting' ? 'starting the engine…' : connecting ? 'looking up the share on the DHT' : 'connected'}
      />
      <Step
        state={listing}
        label="Reading the file list"
        detail={connecting ? 'syncing with the sender' : state.shareName ? `“${state.shareName}”` : ''}
        spinnerColor={theme.info}
      />
      <Step
        state={transfer}
        label="Downloading"
        detail={
          downloading
            ? `${formatBytes(state.receivedBytes)} of ${formatBytes(state.totalBytes)} · ${formatSpeed(state.speed)}`
            : done
              ? `${state.counts.done} file${state.counts.done === 1 ? '' : 's'}`
              : ''
        }
      />
    </box>
  );
}

function Step({
  state,
  label,
  detail,
  spinnerColor,
}: {
  state: StepState;
  label: string;
  detail?: string;
  spinnerColor?: string;
}) {
  let icon: ReactNode;
  switch (state) {
    case 'done':
      icon = <span fg={theme.ok}>✓</span>;
      break;
    case 'active':
      icon = <Spinner color={spinnerColor} />;
      break;
    case 'warn':
      icon = <span fg={theme.warn}>!</span>;
      break;
    default:
      icon = <span fg={theme.subtle}>○</span>;
  }
  return (
    <box height={1}>
      <text>
        {icon}
        <span fg={state === 'pending' ? theme.muted : theme.text}>{` ${label.padEnd(24)}`}</span>
        <span fg={theme.muted}>{detail ?? ''}</span>
      </text>
    </box>
  );
}

function toRow(file: GetFile): ListRow {
  switch (file.state) {
    case 'done':
      return {
        key: file.id,
        icon: <span fg={theme.ok}>✓</span>,
        label: file.virtualPath,
        percent: 100,
        done: true,
        status: 'saved',
        statusColor: theme.ok,
      };
    case 'downloading':
      return {
        key: file.id,
        icon: <Spinner />,
        label: file.virtualPath,
        percent: file.percent,
        done: false,
        status: 'receiving',
        statusColor: theme.accent,
      };
    case 'error':
      return {
        key: file.id,
        icon: <span fg={theme.error}>✗</span>,
        label: file.virtualPath,
        percent: null,
        done: false,
        status: file.note ?? 'failed',
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
