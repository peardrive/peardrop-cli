import { useEffect, useState, type ReactNode } from 'react';
import { useKeyboard } from '@opentui/react';
import { TextAttributes } from '@opentui/core';
import { theme, padEnd, truncateMiddle } from './theme.js';

const PARTIALS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'];

export function barString(percent: number | null | undefined, width: number): { fill: string; track: string } {
  if (width <= 0) return { fill: '', track: '' };
  if (percent == null) return { fill: '', track: '╌'.repeat(width) };
  const clamped = Math.min(100, Math.max(0, percent));
  const exact = (clamped / 100) * width;
  const full = Math.floor(exact);
  const partial = PARTIALS[Math.floor((exact - full) * 8)] ?? '';
  const fill = '█'.repeat(full) + (full < width ? partial : '');
  return { fill, track: ' '.repeat(Math.max(0, width - fill.length)) };
}

export function ProgressBar({
  percent,
  width,
  done = false,
  color,
}: {
  percent: number | null | undefined;
  width: number;
  done?: boolean;
  color?: string;
}) {
  const { fill, track } = barString(percent, width);
  return (
    <text>
      <span fg={done ? theme.barDone : (color ?? theme.barFill)} bg={theme.barTrack}>
        {fill}
      </span>
      <span fg={theme.muted} bg={theme.barTrack}>
        {track}
      </span>
    </text>
  );
}

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export function useSpinner(active = true): string {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setFrame((value) => (value + 1) % SPINNER.length), 90);
    return () => clearInterval(timer);
  }, [active]);
  return SPINNER[frame]!;
}

export function Spinner({ color = theme.accent }: { color?: string }) {
  const glyph = useSpinner();
  return <span fg={color}>{glyph}</span>;
}

export function Header({ mode, right }: { mode: string; right?: ReactNode }) {
  return (
    <box flexDirection="row" justifyContent="space-between" paddingLeft={1} paddingRight={1} height={1}>
      <text>
        <span fg={theme.brand} attributes={TextAttributes.BOLD}>
          ◆ peardrop
        </span>
        <span fg={theme.muted}> · </span>
        <span fg={theme.text}>{mode}</span>
      </text>
      {right ?? <text> </text>}
    </box>
  );
}

export function KeyHints({ hints }: { hints: Array<[string, string]> }) {
  return (
    <box paddingLeft={1} height={1}>
      <text>
        {hints.map(([key, label], index) => (
          <span key={key}>
            {index > 0 ? <span fg={theme.subtle}> · </span> : null}
            <span fg={theme.accent}>{key}</span>
            <span fg={theme.muted}> {label}</span>
          </span>
        ))}
      </text>
    </box>
  );
}

export function Panel({
  title,
  children,
  flexGrow,
  height,
  borderColor = theme.border,
}: {
  title?: string;
  children: ReactNode;
  flexGrow?: number;
  height?: number;
  borderColor?: string;
}) {
  return (
    <box
      border
      borderStyle="rounded"
      borderColor={borderColor}
      title={title ? ` ${title} ` : undefined}
      titleAlignment="left"
      paddingLeft={1}
      paddingRight={1}
      flexDirection="column"
      flexGrow={flexGrow}
      flexShrink={flexGrow ? 1 : 0}
      height={height}
    >
      {children}
    </box>
  );
}

export interface ListRow {
  key: string | number;
  icon: ReactNode;
  label: string;
  percent: number | null | undefined;
  done: boolean;
  barColor?: string;
  status: string;
  statusColor?: string;
}

/**
 * Virtualised, keyboard-scrollable file list: only the rows that fit are rendered, so a
 * folder with thousands of files stays cheap to redraw on every progress tick.
 */
export function FileList({
  rows,
  height,
  width,
  cursor,
}: {
  rows: ListRow[];
  height: number;
  width: number;
  cursor: number;
}) {
  const visible = Math.max(1, height);
  const maxOffset = Math.max(0, rows.length - visible);
  const offset = Math.min(maxOffset, Math.max(0, cursor - Math.floor(visible / 2)));
  const slice = rows.slice(offset, offset + visible);

  const barWidth = width >= 90 ? 24 : width >= 70 ? 16 : 10;
  const statusWidth = 14;
  const labelWidth = Math.max(8, width - barWidth - statusWidth - 2 /*icon*/ - 6 /*percent*/ - 4 /*gaps*/ - 2);
  const scrollable = rows.length > visible;

  return (
    <box flexDirection="row" flexGrow={1}>
      <box flexDirection="column" flexGrow={1}>
        {slice.map((row, index) => {
          const selected = offset + index === cursor && scrollable;
          return (
            <box key={row.key} flexDirection="row" height={1} backgroundColor={selected ? theme.selectedBg : undefined}>
              <text>
                {row.icon}
                <span> </span>
                <span fg={row.done ? theme.muted : theme.text}>{padEnd(truncateMiddle(row.label, labelWidth), labelWidth)}</span>
                <span> </span>
              </text>
              <ProgressBar percent={row.percent} width={barWidth} done={row.done} color={row.barColor} />
              <text>
                <span fg={row.done ? theme.ok : theme.text}> {formatPct(row.percent)} </span>
                <span fg={row.statusColor ?? theme.muted}>{padEnd(truncateMiddle(row.status, statusWidth), statusWidth)}</span>
              </text>
            </box>
          );
        })}
      </box>
      {scrollable ? <ScrollIndicator total={rows.length} offset={offset} visible={visible} /> : null}
    </box>
  );
}

function formatPct(percent: number | null | undefined): string {
  if (percent == null) return '   –';
  return `${Math.floor(Math.min(100, Math.max(0, percent)))}%`.padStart(4);
}

function ScrollIndicator({ total, offset, visible }: { total: number; offset: number; visible: number }) {
  const thumb = Math.max(1, Math.round((visible / total) * visible));
  const start = Math.round((offset / Math.max(1, total - visible)) * (visible - thumb));
  return (
    <box flexDirection="column" width={1}>
      {Array.from({ length: visible }, (_, i) => (
        <text key={i} fg={i >= start && i < start + thumb ? theme.accent : theme.subtle}>
          {i >= start && i < start + thumb ? '┃' : '│'}
        </text>
      ))}
    </box>
  );
}

/** Shared list navigation (↑/↓, j/k, PgUp/PgDn, g/G). Returns true when the key was handled. */
export function moveCursor(name: string, shift: boolean, cursor: number, total: number, page: number): number | null {
  const last = Math.max(0, total - 1);
  switch (name) {
    case 'up':
    case 'k':
      return Math.max(0, cursor - 1);
    case 'down':
    case 'j':
      return Math.min(last, cursor + 1);
    case 'pageup':
      return Math.max(0, cursor - page);
    case 'pagedown':
    case 'space':
      return Math.min(last, cursor + page);
    case 'home':
      return 0;
    case 'end':
      return last;
    case 'g':
      return shift ? last : 0;
    default:
      return null;
  }
}

/**
 * List cursor that follows the "interesting" row (e.g. the first active download) until the
 * user scrolls manually; `f` turns following back on.
 */
export function useListCursor(total: number, page: number, focusIndex: number) {
  const [cursor, setCursor] = useState(0);
  const [follow, setFollow] = useState(true);

  useKeyboard((key) => {
    if (key.name === 'f') {
      setFollow(true);
      return;
    }
    const next = moveCursor(key.name, key.shift, follow ? Math.max(0, focusIndex) : cursor, total, page);
    if (next !== null) {
      setFollow(false);
      setCursor(next);
    }
  });

  const effective = follow && focusIndex >= 0 ? focusIndex : Math.min(cursor, Math.max(0, total - 1));
  return { cursor: effective, follow };
}
