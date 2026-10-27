import { BaseScenario, TradeLevels } from '../../../baseScenario';
import { Decimal } from 'decimal.js';
import { BotConfig } from '../../../../config/env';
import { resolveTakeProfit } from '../../../tpResolver';

/** 15m entry timeframe of this scenario. */
const ENTRY_TIMEFRAME = '15';
/** Higher-timeframe tag of the order block that defines the trade direction. */
const HTF_TIMEFRAME = '240';
/** One 4H candle in milliseconds — a 4H OB only exists after its own close. */
const HTF_CANDLE_MS = 4 * 60 * 60 * 1000;
/** 15m candles in a 4H window: OB-touch → CHoCH → FVG causality budget. */
const CAUSALITY_WINDOW_CANDLES = 16;
/** `detectFVGs()` stamps a gap at c1; it completes two bars later on c3. */
const FVG_FORMATION_CANDLES = 2;
/** Displacement floor for the confirming CHoCH (AGENTS.md §7.2). */
const DISPLACEMENT_MULTIPLIER = 1.5;
/** Fallback LTF spacing when the candle series is too short to measure. */
const DEFAULT_LTF_MS = 15 * 60 * 1000;

type Direction = 'BULLISH' | 'BEARISH';

interface DirectionalSetup {
  readonly direction: Direction;
  readonly ob: any;
  readonly touchCandle: any;
}

/** Fully validated entry chain. Setters are applied only for a plan. */
interface EntryPlan {
  readonly setup: DirectionalSetup;
  readonly choch: any;
  readonly fvg: any;
  readonly levels: TradeLevels;
  readonly reason: string;
}

/** Funnel counters surfaced in the backtest report (AGENTS.md §8.1). */
interface Scenario1Stats {
  totalEvals: number;
  killzone: number;
  noCandles: number;
  noOb: number;
  noTouch: number;
  wrongSide: number;
  noChoch: number;
  displacement: number;
  noFvg: number;
  tpInvalid: number;
}

type SetupFailure = 'noTouch' | 'wrongSide' | null;
type DirectionalFailure = 'none' | 'noChoch' | 'displacement' | 'noFvg' | 'tpInvalid';

/**
 * Scenario 1 — HTF Continuation.
 *
 * Handbook §2: a 4H break establishes the trend, the 15m order block is
 * retested, and a 15m CHoCH with displacement confirms continuation. The entry
 * POI is the 15m FVG equilibrium.
 *
 * Causal contract:
 *  1. The trade direction is derived from the tested 4H OB — demand can only
 *     produce longs, supply can only produce shorts.
 *  2. The CHoCH must print at/after the OB touch and inside one 4H window
 *     (16 LTF candles, measured from the actual candle spacing).
 *  3. The FVG must COMPLETE at/after the CHoCH. `detectFVGs()` stamps a gap at
 *     c1, two bars before it exists on the chart, so comparing the raw stamp
 *     would discard the impulse FVG the CHoCH itself creates.
 *  4. The target comes from `resolveTakeProfit()` — never a blind k × R.
 */
export class Scenario1_HTFContinuation extends BaseScenario {
  /** Last per-direction rejection, surfaced only when every setup fails. */
  private lastFailure = '';
  private lastFailureKind: DirectionalFailure = 'none';

  private static stats: Scenario1Stats = {
    totalEvals: 0,
    killzone: 0,
    noCandles: 0,
    noOb: 0,
    noTouch: 0,
    wrongSide: 0,
    noChoch: 0,
    displacement: 0,
    noFvg: 0,
    tpInvalid: 0,
  };

  static getRejectionStats(): Scenario1Stats {
    return { ...this.stats };
  }

  static resetStats(): void {
    this.stats = {
      totalEvals: 0,
      killzone: 0,
      noCandles: 0,
      noOb: 0,
      noTouch: 0,
      wrongSide: 0,
      noChoch: 0,
      displacement: 0,
      noFvg: 0,
      tpInvalid: 0,
    };
  }

  constructor(config: BotConfig) {
    super(1, 'HTF Continuation', config);
  }

  protected override evaluateInternal(patternData: any): boolean {
    const stats = Scenario1_HTFContinuation.stats;
    stats.totalEvals++;
    this.lastFailure = '';
    this.lastFailureKind = 'none';

    // London/NY only. `isInKillzone()` intentionally accepts ASIAN for other
    // scenarios, so the session gate is explicit here. Still bypassable globally
    // via ENFORCE_KILLZONES=false for backtesting.
    if (this.config.enforceKillzones !== false) {
      const killzone = patternData.currentKillzone;
      if (killzone !== 'LONDON' && killzone !== 'NY') {
        this.logRejection('HTF Continuation requires London or NY killzone');
        stats.killzone++;
        return false;
      }
    }

    const candles15m: any[] = Array.isArray(patternData.candles15m)
      ? patternData.candles15m
      : [];
    if (candles15m.length === 0) {
      this.logRejection('No 15m candle available');
      stats.noCandles++;
      return false;
    }

    const zones: any[] = Array.isArray(patternData.zones) ? patternData.zones : [];
    const htfObs = zones.filter(
      (z) =>
        z.type === 'OB' &&
        String(z.timeframe) === HTF_TIMEFRAME &&
        z.mitigated !== true,
    );
    if (htfObs.length === 0) {
      this.logRejection('No valid 4H Order Block found');
      stats.noOb++;
      return false;
    }

    const ltfMs = this.resolveCandleMs(candles15m);
    const causalityWindowMs = CAUSALITY_WINDOW_CANDLES * ltfMs;

    const { setups, failure, failureKind } = this.collectDirectionalSetups(
      htfObs,
      candles15m,
    );
    if (setups.length === 0) {
      this.logRejection(failure);
      if (failureKind === 'wrongSide') stats.wrongSide++;
      else stats.noTouch++;
      return false;
    }

    // Freshest zone interaction first: a newer supply test must not be shadowed
    // by a stale demand touch (or vice versa).
    for (const setup of setups) {
      const plan = this.resolvePlan(
        setup,
        patternData,
        zones,
        ltfMs,
        causalityWindowMs,
      );
      if (!plan) continue;

      this.setLevels(plan.levels);
      this.setZoneDetails({
        type: 'FVG',
        top: plan.fvg.top,
        bottom: plan.fvg.bottom,
        timeframe: ENTRY_TIMEFRAME,
        direction: plan.setup.direction,
        timestamp: Number(plan.fvg.timestamp),
      });
      this.setStructureDetails({
        type: 'CHoCH',
        timestamp: Number(plan.choch.timestamp),
        price: new Decimal(plan.choch.price),
        direction: plan.setup.direction,
      });
      this.setReason(plan.reason);
      return true;
    }

    this.logRejection(
      this.lastFailure ||
        'No 15m CHoCH/FVG with displacement after the 4H OB touch',
    );

    // One funnel bucket per evaluation: the last attempted direction names the
    // binding constraint of the scan.
    if (this.lastFailureKind !== 'none') {
      stats[this.lastFailureKind]++;
    }
    return false;
  }

  /**
   * Resolve one direction end-to-end. Returns a complete plan only when the
   * CHoCH, displacement, FVG and structural target all validate — nothing is
   * written to the scenario state until every gate has passed.
   */
  private resolvePlan(
    setup: DirectionalSetup,
    patternData: any,
    zones: any[],
    ltfMs: number,
    causalityWindowMs: number,
  ): EntryPlan | null {
    const { direction, touchCandle } = setup;
    const structures: any[] = Array.isArray(patternData.structures)
      ? patternData.structures
      : [];
    const touchTimestamp = Number(touchCandle.timestamp);

    // --- GATE 1: CHoCH at/after the OB touch, inside one 4H window ---
    const chochs = structures
      .filter(
        (s: any) =>
          s.type === 'CHOCH' &&
          s.direction === direction &&
          String(s.timeframe) === ENTRY_TIMEFRAME &&
          Number(s.timestamp) >= touchTimestamp &&
          Number(s.timestamp) <= touchTimestamp + causalityWindowMs,
      )
      .sort((a: any, b: any) => Number(a.timestamp) - Number(b.timestamp));

    const choch = chochs[chochs.length - 1];
    if (!choch) {
      this.lastFailure = `No 15m ${direction} CHoCH after the 4H OB touch`;
      this.lastFailureKind = 'noChoch';
      return null;
    }

    // --- GATE 2: displacement (AGENTS.md §7.2) ---
    if (!this.isValidDisplacement(choch, DISPLACEMENT_MULTIPLIER)) {
      this.lastFailure = '15m CHoCH displacement < 1.5 ATR';
      this.lastFailureKind = 'displacement';
      return null;
    }

    // --- GATE 3: FVG completes at/after the CHoCH ---
    // `detectFVGs()` stamps a gap at `c1.timestamp`, but the three-bar gap only
    // exists once `c3` closes. Causality is measured on that completion bar.
    const fvgs = zones.filter((z: any) => {
      if (z.type !== 'FVG') return false;
      if (z.direction !== direction) return false;
      if (String(z.timeframe) !== ENTRY_TIMEFRAME) return false;
      const completesAt =
        Number(z.timestamp) + FVG_FORMATION_CANDLES * ltfMs;
      return (
        completesAt >= Number(choch.timestamp) &&
        completesAt <= Number(choch.timestamp) + causalityWindowMs
      );
    });
    const fvg = fvgs[fvgs.length - 1];
    if (!fvg) {
      this.lastFailure = 'No 15m FVG found after CHoCH inside the 4H window';
      this.lastFailureKind = 'noFvg';
      return null;
    }

    // --- GATE 4: stop geometry and structural take-profit ---
    const entry = new Decimal(fvg.top).plus(fvg.bottom).dividedBy(2);
    const fvgZone = {
      top: new Decimal(fvg.top),
      bottom: new Decimal(fvg.bottom),
      direction,
    };
    const atr15m =
      patternData.atr15m instanceof Decimal && patternData.atr15m.gt(0)
        ? patternData.atr15m
        : new Decimal('0.01');

    // Stop comes from the single source of truth (rr = 1 is a placeholder here).
    const base = this.calculateLevels(
      entry,
      fvgZone,
      direction,
      atr15m,
      new Decimal(1),
    );

    // `skipMinorObstacles: false` — the nearest obstacle is a hard wall. If it
    // leaves less than DYNAMIC_TP_MIN_RR the setup is rejected, never clamped.
    const resolution = resolveTakeProfit({
      direction,
      entry: base.entry,
      stopLoss: base.stopLoss,
      zones,
      liquidityPools: patternData.liquidityPools ?? [],
      tradingRange: patternData.tradingRange ?? null,
      macroContext: patternData.macroContext ?? null,
      sessionRanges: patternData.sessionRanges ?? [],
      minRr: this.config.dynamicTpMinRr,
      maxRr: this.config.dynamicTpMaxRr,
      fixedRr: this.config.fixedTpRr,
      enableDynamicTp: this.config.enableDynamicTp,
      requireTarget: this.config.dynamicTpRequireTarget,
      skipMinorObstacles: false,
    });

    if (!resolution.ok) {
      this.lastFailure = `Take-profit rejected: ${resolution.reason}`;
      this.lastFailureKind = 'tpInvalid';
      return null;
    }

    const levels = this.calculateLevelsWithTarget(
      entry,
      fvgZone,
      direction,
      atr15m,
      resolution.takeProfit,
    );

    return {
      setup,
      choch,
      fvg,
      levels,
      reason: `HTF Continuation: 4H ${direction} OB touch + 15m ${direction} CHoCH + 15m FVG entry`,
    };
  }

  /**
   * One candidate per direction: the freshest valid retest of an unmitigated 4H
   * OB of that direction inside the 4H window.
   *
   * The causality anchor is the FIRST wick intersection, not the newest one. A
   * 4H OB is wide enough that price often sits inside it for several 15m closes;
   * advancing the anchor on every touch would push it past the confirming CHoCH
   * and make the `choch >= touch` gate unsatisfiable for the whole test.
   *
   * The OB direction defines the trade direction — this is the guard that
   * prevents buying into 4H supply.
   */
  private collectDirectionalSetups(
    htfObs: any[],
    candles15m: any[],
  ): { setups: DirectionalSetup[]; failure: string; failureKind: SetupFailure } {
    const byDirection = new Map<Direction, DirectionalSetup>();
    const windowStart = Math.max(
      0,
      candles15m.length - CAUSALITY_WINDOW_CANDLES,
    );
    let sawTouch = false;

    for (const ob of htfObs) {
      const direction = ob.direction as Direction;
      if (direction !== 'BULLISH' && direction !== 'BEARISH') continue;

      const obTimestamp = Number(ob.timestamp);
      if (!Number.isFinite(obTimestamp) || obTimestamp <= 0) continue;

      // Zone top/bottom ordering is not guaranteed (Invariant 11).
      const top = Decimal.max(new Decimal(ob.top), new Decimal(ob.bottom));
      const bottom = Decimal.min(new Decimal(ob.top), new Decimal(ob.bottom));

      // A 4H block only exists after its own 4H candle has closed, so the
      // earliest genuine retest is `obTimestamp + 4h`. Within the formation
      // candle price is still printing the block, not testing it.
      const earliestRetest = obTimestamp + HTF_CANDLE_MS;

      let firstTouch = -1;
      for (let i = windowStart; i < candles15m.length; i++) {
        const candle = candles15m[i];
        if (Number(candle.timestamp) < earliestRetest) continue;
        if (!this.candleTouchesZone(candle, top, bottom)) continue;
        firstTouch = i;
        break;
      }
      if (firstTouch === -1) continue;
      sawTouch = true;

      if (!this.isValidApproach(direction, candles15m, firstTouch, top, bottom)) {
        continue;
      }

      // Freshest retest wins per direction; the newer OB breaks a tie.
      const touchCandle = candles15m[firstTouch];
      const existing = byDirection.get(direction);
      const isFresher =
        !existing ||
        Number(touchCandle.timestamp) > Number(existing.touchCandle.timestamp) ||
        (Number(touchCandle.timestamp) ===
          Number(existing.touchCandle.timestamp) &&
          obTimestamp > Number(existing.ob.timestamp));
      if (isFresher) {
        byDirection.set(direction, { direction, ob, touchCandle });
      }
    }

    const setups = [...byDirection.values()].sort(
      (a, b) =>
        Number(b.touchCandle.timestamp) - Number(a.touchCandle.timestamp),
    );
    if (setups.length > 0) return { setups, failure: '', failureKind: null };

    return sawTouch
      ? {
          setups,
          failure:
            'Price approached the 4H OB from the wrong side (zone already broken through)',
          failureKind: 'wrongSide',
        }
      : {
          setups,
          failure: 'Price has not touched 4H OB zone',
          failureKind: 'noTouch',
        };
  }

  /**
   * Approach-side validation.
   *
   * A demand block is only valid while price arrives from ABOVE it; a supply
   * block only while price arrives from BELOW. Two independent failures are
   * rejected here:
   *
   *  1. Arrival side — the candle before the first intersection must close on the
   *     origin side of the block. A rally into a bullish OB from below is a broken
   *     block being tested as supply, not a demand retest.
   *  2. Break-through — once price closes beyond the far edge, the block is
   *     consumed and can no longer justify a continuation.
   *
   * The break-through scan starts at the first intersection: any earlier
   * violation would have forced the arrival itself to come from behind.
   */
  private isValidApproach(
    direction: Direction,
    candles15m: any[],
    firstTouchIndex: number,
    top: Decimal,
    bottom: Decimal,
  ): boolean {
    const reference =
      firstTouchIndex > 0
        ? new Decimal(candles15m[firstTouchIndex - 1].close)
        : new Decimal(candles15m[firstTouchIndex].open);

    const arrivedFromOrigin =
      direction === 'BULLISH' ? reference.gte(top) : reference.lte(bottom);
    if (!arrivedFromOrigin) return false;

    for (let i = firstTouchIndex; i < candles15m.length; i++) {
      const close = new Decimal(candles15m[i].close);
      if (direction === 'BULLISH' ? close.lt(bottom) : close.gt(top)) {
        return false;
      }
    }

    return true;
  }

  /**
   * Candle spacing of the entry series, in milliseconds.
   *
   * The 16-candle causality budget must be expressed in the LTF actually in
   * use, never assumed to be 15 minutes (Invariant 12).
   */
  private resolveCandleMs(candles: any[]): number {
    const start = Math.max(1, candles.length - 5);
    for (let i = start; i < candles.length; i++) {
      const delta = Number(candles[i].timestamp) - Number(candles[i - 1].timestamp);
      if (Number.isFinite(delta) && delta > 0) return delta;
    }
    return DEFAULT_LTF_MS;
  }

  /** Wick intersection counts as a touch: an OB is consumed by the wick that tests it. */
  private candleTouchesZone(
    candle: any,
    top: Decimal,
    bottom: Decimal,
  ): boolean {
    const high = new Decimal(candle.high);
    const low = new Decimal(candle.low);
    // Zone top/bottom ordering is not guaranteed (Invariant 11).
    const zoneTop = Decimal.max(top, bottom);
    const zoneBottom = Decimal.min(top, bottom);
    return high.gte(zoneBottom) && low.lte(zoneTop);
  }
}
