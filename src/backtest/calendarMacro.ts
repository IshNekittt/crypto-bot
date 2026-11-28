import { Decimal } from 'decimal.js';
import { DateTime } from 'luxon';
import type { LiquidityPool, MacroContext } from '../smc/patternRecognizer';
import type { Candle } from '../types';

const ZERO = new Decimal(0);

interface Period {
  readonly key: string;
  readonly timestamp: number;
  readonly open: Decimal;
  high: Decimal;
  low: Decimal;
}

function isoWeekKey(date: DateTime): string {
  return `${date.weekYear}-W${date.weekNumber}`;
}

/** Closed LTF history is fed in chronological order, exactly once per bar. */
export class CalendarMacro {
  private day?: Period;
  private previousTradingDay: Period | undefined;
  private week?: Period;
  private previousWeek: Period | undefined;
  private ath = ZERO;
  private atl = new Decimal('Infinity');
  private dayOpen?: { key: string; open: Decimal };
  private weekOpen?: { key: string; open: Decimal };

  addClosed(candle: Candle): void {
    const date = DateTime.fromMillis(candle.timestamp, { zone: 'utc' });
    const dayKey = date.toISODate()!;
    const weekKey = isoWeekKey(date);
    const high = new Decimal(candle.high);
    const low = new Decimal(candle.low);
    this.ath = Decimal.max(this.ath, high);
    this.atl = Decimal.min(this.atl, low);

    if (this.day?.key !== dayKey) {
      this.previousTradingDay = this.day;
      this.day = { key: dayKey, timestamp: candle.timestamp, open: new Decimal(candle.open), high, low };
    } else {
      this.day.high = Decimal.max(this.day.high, high);
      this.day.low = Decimal.min(this.day.low, low);
    }

    if (this.week?.key !== weekKey) {
      this.previousWeek = this.week;
      this.week = { key: weekKey, timestamp: candle.timestamp, open: new Decimal(candle.open), high, low };
    } else {
      this.week.high = Decimal.max(this.week.high, high);
      this.week.low = Decimal.min(this.week.low, low);
    }
  }

  /** Only the execution bar's timestamp and open may be used here. In Sniper
   * mode the first 1m candle can supply the open before the first LTF close. */
  snapshot(candle: Pick<Candle, 'timestamp' | 'open'>): MacroContext {
    const date = DateTime.fromMillis(candle.timestamp, { zone: 'utc' });
    const dayKey = date.toISODate()!;
    const weekKey = isoWeekKey(date);
    const dayIsCurrent = this.day?.key === dayKey;
    const weekIsCurrent = this.week?.key === weekKey;
    const day = dayIsCurrent ? this.previousTradingDay : this.day;
    const week = weekIsCurrent ? this.previousWeek : this.week;
    const priorWeek = week?.key === isoWeekKey(date.minus({ weeks: 1 })) ? week : undefined;

    if (this.dayOpen?.key !== dayKey) {
      this.dayOpen = { key: dayKey, open: (dayIsCurrent && this.day?.open) || new Decimal(candle.open) };
    }
    if (this.weekOpen?.key !== weekKey) {
      this.weekOpen = { key: weekKey, open: (weekIsCurrent && this.week?.open) || new Decimal(candle.open) };
    }

    const liquidityPools: LiquidityPool[] = [];
    if (day) {
      liquidityPools.push(
        { type: 'PDH', priceLevel: day.high, timestamp: day.timestamp, isTaken: false, points: [] },
        { type: 'PDL', priceLevel: day.low, timestamp: day.timestamp, isTaken: false, points: [] },
      );
    }
    if (priorWeek) {
      liquidityPools.push(
        { type: 'PWH', priceLevel: priorWeek.high, timestamp: priorWeek.timestamp, isTaken: false, points: [] },
        { type: 'PWL', priceLevel: priorWeek.low, timestamp: priorWeek.timestamp, isTaken: false, points: [] },
      );
    }
    return {
      ath: this.ath,
      atl: this.atl,
      htfFvgs: [],
      htfObs: [],
      dailyLevels: { pdh: day?.high ?? ZERO, pdl: day?.low ?? ZERO, do: this.dayOpen.open },
      weeklyLevels: { pwh: priorWeek?.high ?? ZERO, pwl: priorWeek?.low ?? ZERO, wo: this.weekOpen.open },
      liquidityPools,
    };
  }
}
