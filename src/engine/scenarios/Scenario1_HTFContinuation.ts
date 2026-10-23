import { BaseScenario } from '../baseScenario';
import { Decimal } from 'decimal.js';
import { BotConfig } from '../../config/env';
import { resolveTakeProfit } from '../tpResolver';

/**
 * A 4H window holds 16 fifteen-minute candles. The CHoCH and the entry FVG must
 * both form inside it, so a stale 4H POI cannot justify a trade hours later.
 */
const HTF_TOUCH_WINDOW_CANDLES = 16;
/** Higher-timeframe tags produced by `buildPatternData`. */
const HTF_TIMEFRAMES = new Set<string>(['240', '360', '720', 'D', 'W', 'M']);
/** 15m entry timeframe of this scenario. */
const ENTRY_TIMEFRAME = '15';
/** Fallback candle interval (ms) when the series is too short to infer it. */
const DEFAULT_LTF_MS = 15 * 60 * 1000;

type Direction = 'BULLISH' | 'BEARISH';

interface HtfOb {
  readonly top: Decimal;
  readonly bottom: Decimal;
  readonly direction: Direction;
  readonly timestamp: number;
  readonly timeframe: string;
}

interface ContinuationCandidate {
  readonly ob: HtfOb;
  readonly choch: any;
  readonly fvg: any;
  readonly touchTimestamp: number;
}

/**
 * Scenario 1 — HTF Continuation.
 *
 * 4H Order Block retest → 15m CHoCH → 15m FVG retest entry.
 *
 * The direction is a property of the TESTED 4H ORDER BLOCK, never a label:
 * bullish demand produces longs, bearish supply produces shorts (Invariant 57).
 * Causality is enforced — the CHoCH must form at or after the touch that consumed
 * the OB, inside a 4H window, and the entry FVG must form at or after that CHoCH,
 * inside the same window.
 */
export class Scenario1_HTFContinuation extends BaseScenario {
  constructor(config: BotConfig) {
    super(1, 'HTF Continuation', config);
  }

  protected override evaluateInternal(patternData: any): boolean {
    if (!this.isInKillzone(patternData)) {
      this.logRejection('Not in active killzone');
      return false;
    }

    const candles15m: any[] = Array.isArray(patternData.candles15m) ? patternData.candles15m : [];
    if (candles15m.length === 0) {
      this.logRejection('No 15m candle available');
      return false;
    }

    const zones: any[] = Array.isArray(patternData.zones) ? patternData.zones : [];

    // --- 1. Unmitigated 4H Order Blocks --------------------------------
    // `zones` are timestamp-ascending, so reverse iteration walks newest -> oldest.
    const htfObs: HtfOb[] = zones
      .filter(
        (z) =>
          z.type === 'OB' &&
          HTF_TIMEFRAMES.has(String(z.timeframe)) &&
          z.mitigated !== true &&
          this.isDirection(z.direction)
      )
      .map((z) => ({
        top: new Decimal(z.top),
        bottom: new Decimal(z.bottom),
        direction: z.direction as Direction,
        timestamp: Number(z.timestamp),
        timeframe: String(z.timeframe),
      }));

    if (htfObs.length === 0) {
      this.logRejection('No valid unmitigated 4H Order Block found');
      return false;
    }

    // --- 2. 15m CHoCH candidates ---------------------------------------
    const chochs = (patternData.structures ?? []).filter(
      (s: any) =>
        s.type === 'CHOCH' &&
        String(s.timeframe) === ENTRY_TIMEFRAME &&
        this.isDirection(s.direction)
    );

    if (chochs.length === 0) {
      this.logRejection('No 15m CHoCH found');
      return false;
    }

    const ltfMs = this.resolveLtfMs(candles15m);
    const windowMs = HTF_TOUCH_WINDOW_CANDLES * ltfMs;

    let firstFailure = '';
    const candidates: ContinuationCandidate[] = [];

    // Newest CHoCH first: a confirmed continuation is a fresh one, never the
    // oldest structure the array happens to hold.
    for (let c = chochs.length - 1; c >= 0; c--) {
      const choch = chochs[c];
      const direction: Direction = choch.direction;

      // Displacement is a hard gate: a break without expansion is noise.
      if (!this.isValidDisplacement(choch, 1.5)) {
        if (!firstFailure) firstFailure = '15m CHoCH displacement < 1.5 ATR';
        continue;
      }

      // --- 2a. 4H OB touch BEFORE the CHoCH, inside the 4H window ---
      const windowStart = Number(choch.timestamp) - windowMs;
      let touchedOb: HtfOb | null = null;
      let touchTimestamp = 0;

      for (let i = candles15m.length - 1; i >= 0; i--) {
        const candle = candles15m[i];
        const candleTs = Number(candle.timestamp);
        if (candleTs > Number(choch.timestamp)) continue;
        if (candleTs < windowStart) break;

        // Newest matching OB wins: the freshest POI explains the reaction.
        for (let o = htfObs.length - 1; o >= 0; o--) {
          const ob = htfObs[o];
          if (ob.direction !== direction) continue;
          if (!this.candleTouchesZone(candle, ob.top, ob.bottom)) continue;
          touchedOb = ob;
          touchTimestamp = candleTs;
          break;
        }

        if (touchedOb) break;
      }

      if (!touchedOb) {
        if (!firstFailure) firstFailure = 'Price has not touched a matching 4H OB before the CHoCH';
        continue;
      }

      // --- 2b. Entry FVG AT/AFTER the CHoCH, inside the same 4H window ---
      const fvg = [...zones].reverse().find((z) => {
        if (z.type !== 'FVG') return false;
        if (String(z.timeframe) !== ENTRY_TIMEFRAME) return false;
        if (z.direction !== direction) return false;
        const ts = Number(z.timestamp);
        return ts >= Number(choch.timestamp) && ts - touchTimestamp <= windowMs;
      });

      if (!fvg) {
        if (!firstFailure) firstFailure = 'No 15m FVG found after CHoCH inside the 4H window';
        continue;
      }

      candidates.push({ ob: touchedOb, choch, fvg, touchTimestamp });
    }

    if (candidates.length === 0) {
      this.logRejection(firstFailure || 'No valid 4H continuation chain found');
      return false;
    }

    // Deterministic winner: newest CHoCH, then most recent OB touch.
    candidates.sort((a, b) => {
      const chochDelta = Number(b.choch.timestamp) - Number(a.choch.timestamp);
      if (chochDelta !== 0) return chochDelta;
      return b.touchTimestamp - a.touchTimestamp;
    });

    const { choch, fvg } = candidates[0];
    const direction: Direction = choch.direction;

    // --- 3. Entry at the FVG equilibrium (0.5) --------------------------
    const entry = new Decimal(fvg.top).plus(fvg.bottom).dividedBy(2);
    const fvgZone = {
      top: new Decimal(fvg.top),
      bottom: new Decimal(fvg.bottom),
      direction,
    };

    // --- 4. Stop geometry + structural target --------------------------
    const atr =
      patternData.atr15m instanceof Decimal && patternData.atr15m.gt(0)
        ? patternData.atr15m
        : new Decimal('0.01');

    const offsetMultiplier = this.config.smcSlAtrOffset
      ? new Decimal(this.config.smcSlAtrOffset)
      : new Decimal('0.5');

    // The stop comes from `calculateLevels()` through the shared base helper; the
    // target from market structure (`tpResolver`). `skipMinorObstacles: false` keeps
    // the legacy wall semantics: the NEAREST obstacle decides, and a target with no
    // room rejects the setup instead of being clamped to a distance the market has
    // already invalidated.
    const resolution = resolveTakeProfit({
      direction,
      entry,
      stopLoss: this.calculateLevels(entry, fvgZone, direction, atr, new Decimal(1)).stopLoss,
      zones: patternData.zones ?? [],
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
      this.logRejection(`Take-profit rejected: ${resolution.reason}`);
      return false;
    }

    const levels = this.calculateLevelsWithTarget(
      entry,
      fvgZone,
      direction,
      atr,
      resolution.takeProfit,
      offsetMultiplier
    );

    this.setLevels({
      entry: levels.entry,
      stopLoss: levels.stopLoss,
      takeProfit: levels.takeProfit,
    });

    // Zone mitigation: the FVG we entered from.
    this.setZoneDetails({
      type: 'FVG',
      top: fvgZone.top,
      bottom: fvgZone.bottom,
      timeframe: ENTRY_TIMEFRAME,
      direction,
      timestamp: Number(fvg.timestamp),
    });

    // Structure mitigation: the CHoCH that confirmed the continuation.
    this.setStructureDetails({
      type: 'CHoCH',
      timestamp: Number(choch.timestamp),
      price: new Decimal(choch.price),
      direction,
    });

    this.setReason(
      `HTF Continuation: ${direction} 4H OB touch + 15m CHoCH + 15m FVG entry`,
    );
    return true;
  }

  private isDirection(value: unknown): value is Direction {
    return value === 'BULLISH' || value === 'BEARISH';
  }

  /** Wick intersection counts as a touch: an OB is consumed by the wick that tests it. */
  private candleTouchesZone(candle: any, top: Decimal, bottom: Decimal): boolean {
    const high = new Decimal(candle.high);
    const low = new Decimal(candle.low);
    // Zone top/bottom ordering is not guaranteed (Invariant 11).
    const zoneTop = Decimal.max(top, bottom);
    const zoneBottom = Decimal.min(top, bottom);
    return high.gte(zoneBottom) && low.lte(zoneTop);
  }

  /**
   * Candles in a 4H window, derived from the actual candle spacing rather than a
   * hardcoded 15-minute assumption (Invariant 12).
   */
  private resolveLtfMs(candles: any[]): number {
    const sample = Math.min(candles.length, 5);
    for (let i = 1; i < sample; i++) {
      const delta = Number(candles[i].timestamp) - Number(candles[i - 1].timestamp);
      if (Number.isFinite(delta) && delta > 0) return delta;
    }
    return DEFAULT_LTF_MS;
  }
}
