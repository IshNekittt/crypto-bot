import { Candle, Timeframe } from '../types';
import { KlineUpdate } from '../api/wsClient';

export interface HistorySource {
  getKlines(symbol: string, interval: Timeframe, limit: number): Promise<readonly Candle[]>;
}

export function mergeCandle(
  buffer: readonly Candle[],
  incoming: Candle,
  capacity: number,
): Candle[] {
  const last = buffer.length > 0 ? buffer[buffer.length - 1] : undefined;
  if (!last) return [incoming];
  if (incoming.timestamp < last.timestamp) return [...buffer];
  if (incoming.timestamp === last.timestamp) {
    const copy = [...buffer];
    copy[copy.length - 1] = incoming;
    return copy;
  }
  const next = [...buffer, incoming];
  while (next.length > capacity) next.shift();
  return next;
}

export class CandleFeed {
  readonly symbol: string;
  readonly interval: Timeframe;
  private readonly capacity: number;
  private buffer: Candle[] = [];

  constructor(symbol: string, interval: Timeframe, capacity: number) {
    this.symbol = symbol;
    this.interval = interval;
    this.capacity = capacity;
  }

  async loadHistory(source: HistorySource): Promise<void> {
    const candles = await source.getKlines(this.symbol, this.interval, this.capacity);
    this.buffer = [...candles];
  }

  getCandles(): readonly Candle[] {
    return this.buffer;
  }

  getLastClosed(): Candle | null {
    return this.buffer.length > 0 ? this.buffer[this.buffer.length - 1] : null;
  }

  applyKline(update: KlineUpdate): void {
    if (update.symbol !== this.symbol || update.interval !== this.interval || !update.confirmed) {
      return;
    }
    this.buffer = mergeCandle(this.buffer, update.candle, this.capacity);
  }
}
