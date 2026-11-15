export const theme = {
  brand: '#9ece6a', // pear green
  accent: '#7aa2f7',
  text: '#c0caf5',
  muted: '#565f89',
  subtle: '#3b4261',
  border: '#3b4261',
  ok: '#9ece6a',
  warn: '#e0af68',
  error: '#f7768e',
  info: '#7dcfff',
  barFill: '#7aa2f7',
  barDone: '#9ece6a',
  barTrack: '#292e42',
  selectedBg: '#283457',
} as const;

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;
  return `${value >= 100 || exponent === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[exponent]}`;
}

export function formatPercent(percent: number | null | undefined): string {
  if (percent == null || !Number.isFinite(percent)) return '  …';
  return `${Math.floor(Math.min(100, Math.max(0, percent)))}%`.padStart(4);
}

/** Shorten a path in the middle so both the folder context and the file name stay visible. */
export function truncateMiddle(value: string, width: number): string {
  if (width <= 0) return '';
  if (value.length <= width) return value;
  if (width <= 3) return value.slice(0, width);
  const keepEnd = Math.ceil((width - 1) * 0.6);
  const keepStart = width - 1 - keepEnd;
  return `${value.slice(0, keepStart)}…${value.slice(value.length - keepEnd)}`;
}

export function padEnd(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}
