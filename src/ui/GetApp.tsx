import { useSyncExternalStore, type ReactNode } from 'react';
import { TextAttributes } from '@opentui/core';
import { useKeyboard, useTerminalDimensions } from '@opentui/react';
import type { GetController, GetFile, GetSnapshot } from '../core/get.js';
import { shortKey } from '../core/session.js';
import { theme, truncateMiddle } from './theme.js';
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

  const focusIndex = state.files.findIndex((file) => file.state === 'downloading' || file.state === 'starting');
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
  const finished = counts.done + counts.skipped + counts.error;
  const active = counts.starting + counts.downloading;
  const activePercent = state.files
    .filter((file) => file.state === 'downloading')
    .reduce((sum, file) => sum + (file.percent ?? 0), 0);
  const overall = total > 0 ? ((finished * 100 + activePercent) / (total * 100)) * 100 : 0;
  const allDone = total > 0 && finished === total;

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
                {counts.done > 0 ? '✓ All files received' : '✓ Nothing new to download'}
              </span>
            ) : active > 0 ? (
              <>
                <Spinner /> <span fg={theme.text}>Downloading</span>
              </>
            ) : (
              <span fg={theme.muted}>Idle</span>
            )}
            <span fg={theme.muted}>
              {`  ${counts.done}/${total} done · ${active} active (max ${state.concurrency}) · ${counts.queued} queued`}
            </span>
            {counts.skipped > 0 ? <span fg={theme.warn}>{` · ${counts.skipped} skipped`}</span> : null}
            {counts.error > 0 ? <span fg={theme.error}>{` · ${counts.error} failed`}</span> : null}
            <span fg={theme.muted}>{`  → ${truncateMiddle(state.outDir, 40)}`}</span>
          </text>
        </box>
        <box flexDirection="row" height={1}>
          <ProgressBar percent={total > 0 ? overall : null} width={Math.max(10, width - 6)} done={allDone} />
        </box>
      </Panel>

      <Panel title={`Files (${total})${state.phase === 'synced' ? ' · live' : ''}`} flexGrow={1}>
        {total === 0 ? (
          <text fg={theme.muted}>
            {state.phase === 'synced' ? 'Space is empty so far: waiting for the sharer to publish files…' : 'Files will appear here once connected.'}
          </text>
        ) : (
          <FileList rows={state.files.map(toRow)} height={listHeight} width={width - 4} cursor={cursor} />
        )}
      </Panel>

      <KeyHints hints={[['↑↓', 'scroll'], ...(follow ? [] : ([['f', 'follow']] as Array<[string, string]>)), ['q', 'quit']]} />
    </box>
  );
}

function ConnectionBadge({ state }: { state: GetSnapshot }) {
  if (state.ownerConnected) {
    return (
      <text>
        <span fg={theme.ok}>● connected to sharer {shortKey(state.ownerKey)}</span>
      </text>
    );
  }
  if (state.peers.length > 0) {
    return (
      <text>
        <span fg={theme.ok}>● {state.peers.length} peer(s)</span>
      </text>
    );
  }
  return (
    <text>
      <span fg={state.everConnected ? theme.warn : theme.muted}>
        ○ {state.everConnected ? 'disconnected, retrying' : 'offline'}
      </span>
    </text>
  );
}

function Steps({ state }: { state: GetSnapshot }) {
  const { phase } = state;
  const connectedOnce = state.everConnected;
  const live = state.peers.length > 0;

  const waiting: StepState = connectedOnce ? 'done' : phase === 'waiting' ? 'active' : 'pending';
  const connected: StepState = !connectedOnce ? 'pending' : live ? 'done' : 'warn';
  const listing: StepState = phase === 'synced' ? 'active' : connectedOnce ? 'active' : 'pending';
  const downloading: StepState = state.counts.downloading + state.counts.starting > 0 ? 'active' : state.counts.done > 0 ? 'done' : 'pending';

  return (
    <box flexDirection="column">
      <Step state={waiting} label="Waiting for connection" detail={phase === 'starting' ? 'starting node…' : 'looking up the sharer on the DHT'} />
      <Step
        state={connected}
        label="Connection established"
        detail={connectedOnce ? (live ? `peer ${shortKey(state.ownerKey)}` : 'lost connection, swarm will reconnect') : ''}
      />
      <Step
        state={listing}
        label="Listing files"
        detail={phase === 'synced' ? `${state.files.length} found · refreshing live` : connectedOnce ? 'syncing space…' : ''}
        spinnerColor={theme.info}
      />
      <Step
        state={downloading}
        label="Downloading"
        detail={`${state.concurrency} at a time, refilled as each file completes`}
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
      return { key: file.id, icon: <span fg={theme.ok}>✓</span>, label: file.virtualPath, percent: 100, done: true, status: 'saved', statusColor: theme.ok };
    case 'downloading':
      return {
        key: file.id,
        icon: <Spinner />,
        label: file.virtualPath,
        percent: file.percent,
        done: false,
        status: file.percent == null ? 'fetching tree' : `${file.providers} provider${file.providers === 1 ? '' : 's'}`,
        statusColor: theme.accent,
      };
    case 'starting':
      return { key: file.id, icon: <Spinner />, label: file.virtualPath, percent: null, done: false, status: 'starting', statusColor: theme.accent };
    case 'skipped':
      return { key: file.id, icon: <span fg={theme.warn}>↷</span>, label: file.virtualPath, percent: null, done: true, status: file.note ?? 'skipped', statusColor: theme.warn };
    case 'error':
      return { key: file.id, icon: <span fg={theme.error}>✗</span>, label: file.virtualPath, percent: null, done: false, status: file.note ?? 'failed', statusColor: theme.error };
    default:
      return { key: file.id, icon: <span fg={theme.muted}>·</span>, label: file.virtualPath, percent: 0, done: false, status: 'queued' };
  }
}
