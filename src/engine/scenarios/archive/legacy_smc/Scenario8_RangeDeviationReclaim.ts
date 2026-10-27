import { BaseScenario, TradeLevels } from '../../../baseScenario';
import { Decimal } from 'decimal.js';
import { BotConfig } from '../../../../config/env';
import { resolveTakeProfit } from '../../../tpResolver';

/** 15m entry timeframe — the deviation, the CHoCH and the POI all live here. */
const ENTRY_TIMEFRAME = '15';
/** Excursion window: a deviation older than 12 LTF candles (3h at 15m) is stale. */
const DEVIATION_WINDOW_CANDLES = 12;
/** Causality budget after the reclaim: 32 LTF candles (8h at 15m). */
const CAUSALITY_WINDOW_CANDLES = 32;
/** Displacement floor for the confirming CHoCH (AGENTS.md §7.2). */
const DISPLACEMENT_MULTIPLIER = 1.5;
/**
 * A boundary "kiss" is noise, not a deviation. The excursion must clear the
 * boundary by 0.1 ATR (with a 0.05% floor so the gate survives ATR collapse).
 */
const PENETRATION_ATR_MULTIPLIER = new Decimal('0.1');
const PENETRATION_MIN_PCT = new Decimal('0.0005');
/** `detectFVGs()`/`detectOrderBlocks()` stamp c1; the pattern exists from c3. */
const POI_FORMATION_CANDLES = 2;
/** Fallback LTF spacing when the candle series is too short to measure. */
const DEFAULT_LTF_MS = 15 * 60 * 1000;

type Direction = 'BULLISH' | 'BEARISH';

/** A confirmed excursion outside the trading range and its reclaim. */
interface DeviationEvent {
  /** Trade direction implied by the deviation side (below low → long). */
  readonly direction: Direction;
  /** The boundary that was breached. */
  readonly boundary: Decimal;
  /** Deepest excursion beyond the boundary (the stop anchor). */
  readonly extreme: Decimal;
  /** The candle whose body closed back inside the range. */
  readonly reclaim: any;
  readonly reclaimIndex: number;
}

/** The entry point of interest (15m FVG or OB). */
interface Poi {
  readonly kind: 'FVG' | 'OB';
  readonly zone: any;
  readonly top: Decimal;
  readonly bottom: Decimal;
  readonly equilibrium: Decimal;
  readonly timestamp: number;
}

/**
 * Result of the backwards deviation scan.
 *
 * `breaches` counts candles that cleared the penetration gate even when no
 * reclaim followed, so the funnel can distinguish "price never left the range"
 * from "price left and never came back".
 */
interface DeviationScan {
  readonly event: DeviationEvent | null;
  readonly breaches: number;
}

/** Fully validated deviation→reclaim chain. Setters are applied only for a plan. */
interface DeviationPlan {
  readonly direction: Direction;
  readonly poi: Poi;
  readonly choch: any;
  readonly levels: TradeLevels;
  readonly reason: string;
}

interface Scenario8Stats {
  totalEvals: number;
  killzone: number;
  noTradingRange: number;
  noDeviation: number;
  noReclaim: number;
  noChoch: number;
  displacement: number;
  noPoi: number;
  tpInvalid: number;
}

type FailureKind =
  | 'none'
  | 'noChoch'
  | 'displacement'
  | 'noPoi'
  | 'tpInvalid';

/** A rejection plus how far down the chain it happened. */
interface Failure {
  readonly kind: FailureKind;
  readonly reason: string;
  readonly stage: number;
}

/**
 * Scenario 8 — Range Deviation & Reclaim.
 *
 * A tight trading range is a liquidity engine. Price pokes outside one boundary
 * to run the stops resting there, fails to hold, and closes back inside — the
 * range then pulls back toward its equilibrium and the opposite boundary.
 *
 * Causal contract:
 *  1. Direction comes from the deviated side, never from a hardcoded short.
 *     Deviating BELOW the range low produces a long back inside; deviating ABOVE
 *     the range high produces a short. The short-only mirror image is gone.
 *  2. The anchor is the FRESHEST excursion, scanned backwards. A forward scan
 *     picks the oldest poke and lets a CHoCH that printed before a newer, still
 *     unreclaimed excursion validate a dead range.
 *  3. The excursion must clear the boundary by a minimum penetration depth — a
 *     boundary touch is not a liquidity grab — and the reclaim is the first body
 *     that closes back inside the range.
 *  4. The confirming CHoCH must print AT or AFTER that reclaim, inside the 8h
 *     causality window, with >= 1.5 ATR displacement.
 *  5. The entry POI is the equilibrium of the freshest 15m FVG (or, failing that,
 *     15m OB) printed with the reclaiming impulse and positioned inside the range.
 *     Higher-timeframe zones are rejected: a 4H imbalance cannot define a 15m
 *     range entry.
 *  6. The target comes from the structural resolver, which sees the range
 *     equilibrium (RANGE_EQUILIBRIUM) and any liquidity resting at the opposite
 *     boundary. `skipMinorObstacles: false` keeps the nearest obstacle a hard
 *     wall: if it leaves less than DYNAMIC_TP_MIN_RR the setup is rejected,
 *     never clamped.
 */
export class Scenario8_RangeDeviationReclaim extends BaseScenario {
  /** Deepest rejection of the chain — the stage the funnel actually choked on. */
  private failure: Failure | null = null;

  private static stats: Scenario8Stats = {
    totalEvals: 0,
    killzone: 0,
    noTradingRange: 0,
    noDeviation: 0,
    noReclaim: 0,
    noChoch: 0,
    displacement: 0,
    noPoi: 0,
    tpInvalid: 0,
  };

  constructor(config: BotConfig) {
    super(8, 'Range Deviation & Reclaim', config);
  }

  static getRejectionStats(): Scenario8Stats {
    return { ...this.stats };
  }

  static resetStats(): void {
    this.stats = {
      totalEvals: 0,
      killzone: 0,
      noTradingRange: 0,
      noDeviation: 0,
      noReclaim: 0,
      noChoch: 0,
      displacement: 0,
      noPoi: 0,
      tpInvalid: 0,
    };
  }

  protected override evaluateInternal(patternData: any): boolean {
    const stats = Scenario8_RangeDeviationReclaim.stats;
    stats.totalEvals++;
    this.resetFailure();

    if (!this.passesKillzone(patternData)) {
      this.logRejection('Range Deviation requires London or NY killzone');
      stats.killzone++;
      return false;
    }

    const candles15m: any[] = Array.isArray(patternData.candles15m)
      ? patternData.candles15m
      : [];
    const tradingRange = patternData.tradingRange;
    if (
      candles15m.length < 2 ||
      !tradingRange ||
      !(tradingRange.high instanceof Decimal) ||
      !(tradingRange.low instanceof Decimal) ||
      !tradingRange.high.gt(tradingRange.low)
    ) {
      this.logRejection('No valid trading range available');
      stats.noTradingRange++;
      return false;
    }

    const rangeHigh = new Decimal(tradingRange.high);
    const rangeLow = new Decimal(tradingRange.low);

    const atr =
      patternData.atr15m instanceof Decimal && patternData.atr15m.gt(0)
        ? patternData.atr15m
        : new Decimal('0.01');
    const ltfMs = this.resolveCandleMs(candles15m);

    const scan = this.findFreshestDeviation(candles15m, rangeHigh, rangeLow, atr);

    if (!scan.event) {
      // Distinguish "price never left the range" from "price left and never
      // reclaimed": the second is a live, unresolved manipulation the operator
      // should see, and it is exactly the state where a CHoCH cannot exist yet.
      if (scan.breaches > 0) {
        this.logRejection('Price has not reclaimed back into range after deviation');
        stats.noReclaim++;
      } else {
        this.logRejection(
          `No range deviation (boundary breach beyond penetration threshold) in the last ${DEVIATION_WINDOW_CANDLES} candles`,
        );
        stats.noDeviation++;
      }
      return false;
    }

    const deviation = scan.event;

    const zones: any[] = Array.isArray(patternData.zones) ? patternData.zones : [];
    const structures: any[] = Array.isArray(patternData.structures)
      ? patternData.structures
      : [];

    const plan = this.resolvePlan(
      deviation,
      patternData,
      zones,
      structures,
      rangeHigh,
      rangeLow,
      ltfMs,
    );
    if (!plan) {
      this.reportFailure(stats);
      return false;
    }

    this.setLevels(plan.levels);
    this.setZoneDetails({
      type: plan.poi.kind,
      top: plan.poi.top,
      bottom: plan.poi.bottom,
      timeframe: ENTRY_TIMEFRAME,
      direction: plan.direction,
      timestamp: plan.poi.timestamp,
    });
    this.setStructureDetails({
      type: 'CHoCH',
      timestamp: Number(plan.choch.timestamp),
      price: new Decimal(plan.choch.price),
      direction: plan.direction,
    });
    this.setReason(plan.reason);
    return true;
  }

  /**
   * Resolve one deviation→reclaim chain end-to-end. Nothing is written to the
   * scenario state until the CHoCH, the entry POI and the structural target have
   * all validated.
   */
  private resolvePlan(
    deviation: DeviationEvent,
    patternData: any,
    zones: any[],
    structures: any[],
    rangeHigh: Decimal,
    rangeLow: Decimal,
    ltfMs: number,
  ): DeviationPlan | null {
    const direction = deviation.direction;
    const isLong = direction === 'BULLISH';
    const candles15m: any[] = patternData.candles15m;
    const last = candles15m[candles15m.length - 1];
    const lastTimestamp = Number(last.timestamp);
    const lastHigh = new Decimal(last.high);
    const lastLow = new Decimal(last.low);
    const reclaimTimestamp = Number(deviation.reclaim.timestamp);
    const windowEnd = reclaimTimestamp + CAUSALITY_WINDOW_CANDLES * ltfMs;

    // --- GATE 1: the CHoCH confirms the reclaim, so it cannot precede it ---
    const chochs = structures
      .filter(
        (s: any) =>
          s.type === 'CHOCH' &&
          s.direction === direction &&
          String(s.timeframe) === ENTRY_TIMEFRAME &&
          Number(s.timestamp) >= reclaimTimestamp &&
          Number(s.timestamp) <= windowEnd &&
          Number(s.timestamp) <= lastTimestamp,
      )
      .sort((a: any, b: any) => Number(a.timestamp) - Number(b.timestamp));

    const choch = chochs[chochs.length - 1];
    if (!choch) {
      this.fail(
        'noChoch',
        `No 15m ${direction} CHoCH at or after the range reclaim`,
        1,
      );
      return null;
    }

    if (!this.isValidDisplacement(choch, DISPLACEMENT_MULTIPLIER)) {
      this.fail('displacement', `${direction} CHoCH after reclaim displacement < 1.5 ATR`, 2);
      return null;
    }

    // --- GATE 2: the 15m entry POI ---
    // The reclaiming impulse leaves the gap/block, so its stamp can precede the
    // break candle by up to `POI_FORMATION_CANDLES`; anything older belongs to the
    // excursion leg and is not the point being retested.
    const poiFloor = reclaimTimestamp - POI_FORMATION_CANDLES * ltfMs;
    const poi = this.findPoi(
      zones,
      direction,
      poiFloor,
      windowEnd,
      lastTimestamp,
      rangeHigh,
      rangeLow,
    );

    if (!poi) {
      this.fail(
        'noPoi',
        `No 15m ${direction} FVG/OB inside the range to define the entry POI`,
        3,
      );
      return null;
    }

    // --- GATE 3: stop geometry, then the structural target ---
    // The stop must sit beyond the excursion extreme: that poke IS the thesis. A
    // stop tucked inside the range is taken out by the retest of the boundary the
    // setup was built on. The entry candle's own wick is included as well.
    const stopZone = isLong
      ? {
          top: poi.top,
          bottom: Decimal.min(poi.bottom, deviation.extreme, lastLow),
          direction,
        }
      : {
          top: Decimal.max(poi.top, deviation.extreme, lastHigh),
          bottom: poi.bottom,
          direction,
        };

    // `rr = 1` is a placeholder: only the stop geometry is consumed here.
    const base = this.calculateLevels(
      poi.equilibrium,
      stopZone,
      direction,
      patternData.atr15m instanceof Decimal && patternData.atr15m.gt(0)
        ? patternData.atr15m
        : new Decimal('0.01'),
      new Decimal(1),
    );

    // Passing `tradingRange` puts RANGE_EQUILIBRIUM in the candidate set, and the
    // pools/EQH/EQL resting at the opposite boundary provide the other structural
    // exit. `skipMinorObstacles: false` — the nearest obstacle is a hard wall. If
    // it leaves less than DYNAMIC_TP_MIN_RR the setup is rejected, never clamped.
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
      this.fail('tpInvalid', `Take-profit rejected: ${resolution.reason}`, 4);
      return null;
    }

    const levels = this.calculateLevelsWithTarget(
      poi.equilibrium,
      stopZone,
      direction,
      patternData.atr15m instanceof Decimal && patternData.atr15m.gt(0)
        ? patternData.atr15m
        : new Decimal('0.01'),
      resolution.takeProfit,
    );

    const deviatedSide = isLong ? 'Range Low' : 'Range High';
    return {
      direction,
      poi,
      choch,
      levels,
      reason:
        `Range Deviation: ${deviatedSide} deviation + reclaim + 15m ${direction} CHoCH + ` +
        `${ENTRY_TIMEFRAME} ${poi.kind} 0.5 entry, TP ${resolution.source} @ ${resolution.takeProfit.toFixed(4)}`,
    };
  }

  /**
   * The freshest deviation with a confirmed reclaim.
   *
   * Scanned backwards, because the anchor must be the most recent excursion: an
   * older poke whose reclaim is already spent cannot define the current range
   * manipulation. Both sides are evaluated on every bar so the scenario is
   * symmetric; if one bar clears both boundaries the deeper excursion wins, since
   * the shallower one never reached real resting liquidity.
   *
   * `breaches` is returned alongside the event so the caller can tell a range
   * that was never disturbed from one whose excursion has not reclaimed yet.
   */
  private findFreshestDeviation(
    candles: any[],
    rangeHigh: Decimal,
    rangeLow: Decimal,
    atr: Decimal,
  ): DeviationScan {
    const window = Math.min(DEVIATION_WINDOW_CANDLES, candles.length);
    let breaches = 0;

    for (let i = candles.length - 1; i >= candles.length - window; i--) {
      const candle = candles[i];
      const high = new Decimal(candle.high);
      const low = new Decimal(candle.low);

      const abovePenetration = high.gt(rangeHigh) ? high.minus(rangeHigh) : null;
      const belowPenetration = low.lt(rangeLow) ? rangeLow.minus(low) : null;
      if (!abovePenetration && !belowPenetration) continue;

      // Deterministic side selection when one bar clears both boundaries.
      let direction: Direction;
      if (abovePenetration && belowPenetration) {
        direction = abovePenetration.gte(belowPenetration) ? 'BEARISH' : 'BULLISH';
      } else {
        direction = abovePenetration ? 'BEARISH' : 'BULLISH';
      }
      const isShort = direction === 'BEARISH';
      const boundary = isShort ? rangeHigh : rangeLow;

      const minPenetration = Decimal.max(
        atr.mul(PENETRATION_ATR_MULTIPLIER),
        boundary.mul(PENETRATION_MIN_PCT),
      );
      const penetration = isShort ? abovePenetration! : belowPenetration!;
      if (penetration.lt(minPenetration)) continue;
      breaches++;

      // The reclaim: the first body that closes back inside the range. A close
      // through the OPPOSITE boundary is a full range break, not a reclaim — the
      // excursion became a trend, so the chain dies here.
      let reclaimIndex = -1;
      for (let j = i; j < candles.length; j++) {
        const close = new Decimal(candles[j].close);
        const inside = close.gt(rangeLow) && close.lt(rangeHigh);
        if (inside) {
          reclaimIndex = j;
          break;
        }
        if (isShort ? close.lt(rangeLow) : close.gt(rangeHigh)) break;
      }
      if (reclaimIndex < 0) continue;

      // Deepest excursion between the breach and the reclaim (inclusive), so the
      // stop sits beyond every wick that participated in the fake-out.
      let extreme = isShort ? high : low;
      for (let j = i; j <= reclaimIndex; j++) {
        const wick = isShort
          ? new Decimal(candles[j].high)
          : new Decimal(candles[j].low);
        extreme = isShort ? Decimal.max(extreme, wick) : Decimal.min(extreme, wick);
      }

      return {
        event: {
          direction,
          boundary,
          extreme,
          reclaim: candles[reclaimIndex],
          reclaimIndex,
        },
        breaches,
      };
    }

    return { event: null, breaches };
  }

  /**
   * The entry POI: the freshest same-direction 15m FVG inside the range, falling
   * back to the freshest same-direction 15m OB. The 15m filter is mandatory —
   * `zones` merges 15m and 4H objects, and a higher-timeframe imbalance has no
   * business defining a 15m range entry.
   */
  private findPoi(
    zones: any[],
    direction: Direction,
    fromTimestamp: number,
    toTimestamp: number,
    lastTimestamp: number,
    rangeHigh: Decimal,
    rangeLow: Decimal,
  ): Poi | null {
    const matches = (type: 'FVG' | 'OB'): any[] =>
      zones
        .filter((z: any) => {
          if (z.type !== type) return false;
          if (z.direction !== direction) return false;
          if (String(z.timeframe) !== ENTRY_TIMEFRAME) return false;
          if (!(z.top instanceof Decimal) || !(z.bottom instanceof Decimal)) return false;
          const timestamp = Number(z.timestamp);
          if (!Number.isFinite(timestamp)) return false;
          if (timestamp < fromTimestamp) return false;
          if (timestamp > toTimestamp) return false;
          if (timestamp > lastTimestamp) return false;
          const top = Decimal.max(z.top, z.bottom);
          const bottom = Decimal.min(z.top, z.bottom);
          if (!top.gt(bottom)) return false;
          // The POI must sit inside the range being traded — an entry outside it
          // belongs to a different structure than the reclaim.
          const mid = top.plus(bottom).dividedBy(2);
          return mid.gt(rangeLow) && mid.lt(rangeHigh);
        })
        .sort((a: any, b: any) => Number(a.timestamp) - Number(b.timestamp));

    for (const kind of ['FVG', 'OB'] as const) {
      const candidates = matches(kind);
      const zone = candidates[candidates.length - 1];
      if (!zone) continue;
      const top = Decimal.max(zone.top, zone.bottom);
      const bottom = Decimal.min(zone.top, zone.bottom);
      return {
        kind,
        zone,
        top,
        bottom,
        equilibrium: top.plus(bottom).dividedBy(2),
        timestamp: Number(zone.timestamp),
      };
    }

    return null;
  }

  /** Killzone gate: London/NY only, bypassable via ENFORCE_KILLZONES=false. */
  private passesKillzone(patternData: any): boolean {
    if (this.config.enforceKillzones === false) return true;
    const killzone = patternData.currentKillzone;
    return killzone === 'LONDON' || killzone === 'NY';
  }

  /** Candle spacing of the entry series, in milliseconds (Invariant 12). */
  private resolveCandleMs(candles: any[]): number {
    const start = Math.max(1, candles.length - 5);
    for (let i = start; i < candles.length; i++) {
      const delta = Number(candles[i].timestamp) - Number(candles[i - 1].timestamp);
      if (Number.isFinite(delta) && delta > 0) return delta;
    }
    return DEFAULT_LTF_MS;
  }

  /**
   * Keep the DEEPEST rejection, not the first one.
   *
   * The reported bucket describes how far the chain got, not which gate happened
   * to be evaluated first.
   */
  private fail(kind: FailureKind, reason: string, stage: number): void {
    if (this.failure && this.failure.stage >= stage) return;
    this.failure = { kind, reason, stage };
  }

  /** Emit the deepest rejection of this evaluation and bump its counter. */
  private reportFailure(stats: Scenario8Stats): void {
    const failure = this.failure;
    if (!failure) {
      this.logRejection('No valid Range Deviation setup');
      return;
    }
    this.logRejection(failure.reason);
    if (failure.kind !== 'none') stats[failure.kind]++;
  }

  /**
   * Clear the per-evaluation failure.
   *
   * Kept behind a method so the compiler does not narrow `this.failure` to `null`
   * for the rest of `evaluateInternal()`.
   */
  private resetFailure(): void {
    this.failure = null;
  }
}

