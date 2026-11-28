import type { Timeframe } from '../types';

const minutes: Record<Timeframe, number> = {
  '1': 1, '3': 3, '5': 5, '15': 15, '30': 30, '60': 60,
  '120': 120, '240': 240, '360': 360, '720': 720,
  D: 1440, W: 10080, M: 43200,
};

export function isTimeframe(tf: string): tf is Timeframe {
  return Object.hasOwn(minutes, tf);
}

export function timeframeToMinutes(tf: string): number {
  if (!isTimeframe(tf)) throw new Error(`Unknown Bybit timeframe: ${tf}`);
  return minutes[tf];
}

export function isMajorTimeframe(tf: string | undefined, htf = '240'): boolean {
  if (!tf || !isTimeframe(tf)) return false;
  return tf === 'D' || tf === 'W' || tf === 'M' || timeframeToMinutes(tf) >= timeframeToMinutes(htf);
}

export function timeframeLabel(tf: Timeframe): string {
  const minutes = timeframeToMinutes(tf);
  if (tf === 'D' || tf === 'W' || tf === 'M') return `1${tf}`;
  return minutes % 60 === 0 ? `${minutes / 60}H` : `${minutes}m`;
}

/** Monthly bars close on the next UTC month, not after the nominal 30 days. */
export function candleCloseTime(timestamp: number, tf: Timeframe): number {
  if (tf !== 'M') return timestamp + timeframeToMinutes(tf) * 60_000;
  const date = new Date(timestamp);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
}
