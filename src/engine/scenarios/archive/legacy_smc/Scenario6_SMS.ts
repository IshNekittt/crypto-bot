import { BaseScenario, TradeLevels } from '../../../baseScenario';
import { Decimal } from 'decimal.js';
import { BotConfig } from '../../../../config/env';
import { resolveTakeProfit } from '../../../tpResolver';

/** 15m entry timeframe. */
const ENTRY_TIMEFRAME = '15';
/**
 * Looking window for the whole chain (OB -> SMS -> CHoCH) AND for the age of the
 * trigger itself. 72h at 15m is 288 candles: long enough for a failure swing to
 * build, break and confirm, short enough that the block being mitigated is still
 * the block the market is actually trading against. Without it a CHoCH can be
 * paired with a month-old SMS that nobody remembers.
 */
const PATTERN_WINDOW_MS = 72 * 60 * 60 * 1000;
/** Displacement floor for the confirming CHoCH (AGENTS.md §7.2). */
const DISPLACEMENT_MULTIPLIER = 1.5;
/** Freshest SMS candidates walked before giving up (newest first). */
const MAX_SMS_CANDIDATES = 3;

type Direction = 'BULLISH' | 'BEARISH';

/** Fully validated failure-swing chain. Setters run only for a plan. */
interface SmsChain {
  readonly direction: Direction;
  readonly sms: any;
  readonly ob: any;
  readonly choch: any;
  readonly levels: TradeLevels;
  readonly reason: string;
}

interface Scenario6Stats {
  totalEvals: number;
  noData: number;
  killzone: number;
  noSms: number;
  noOb: number;
  noChoch: number;
  displacement: number;
  tpInvalid: number;
}

type FailureKind =
  | 'none'
  | 'noOb'
  | 'noChoch'
  | 'displacement'
  | 'tpInvalid';

/** A rejection plus how far down the chain it happened. */
interface Failure {
  readonly kind: FailureKind;
  readonly reason: string;
  readonly stage: number;
}

/**
 * Scenario 6 — SMS (Failure Swing).
 *
 * Price fails to make a new extreme, then breaks structure in the opposite
 * direction. The failed push left an order block behind; when price comes back to
 * mitigate it, the traders trapped by the failure are the ones who supply the
 * reversal. The trade is that mitigation.
 *
 * Causal contract:
 *  1. Everything is 15m. `confluence.py`-style cross-timeframe pooling is the
 *     single worst defect this scenario had: a 4H SMS paired with a 15m CHoCH
 *     produces a "setup" that no timeframe actually printed.
 *  2. The order block must be the block of the FAILED leg: causally before the
 *     SMS (`ob.timestamp < sms.timestamp`) and opposite in direction to the SMS
 *     — a bearish SMS is a failed push UP, so the block that failed is the demand
 *     (BULLISH) block of that up-leg, and entering at its equilibrium is the
 *     mitigation short.
 *  3. The CHoCH confirms the failure swing, so it prints AT or AFTER the SMS
 *     timestamp and no later than the last closed candle. Same-candle equality is
 *     legitimate: `detectSMS()` stamps the SMS with the break candle, which is
 *     the same bar `detectStructureBreaks()` may tag as the CHoCH.
 *  4. The whole chain must fit the 72h looking window, and the trigger itself
 *     must be no older than that window. A failure swing is a local event.
 *  5. The stop is the block edge widened by the trigger candle and the last
 *     closed candle: if price has already traded through those wicks, they are
 *     part of the entry, not a level the position may be stopped by later.
 *  6. The target comes from the structural resolver. `skipMinorObstacles: false`
 *     keeps the nearest obstacle a hard wall: if it leaves less than
 *     DYNAMIC_TP_MIN_RR the setup is rejected, never clamped.
 *
 * Removed legacy logic:
 *  - `patternData.structures` / `patternData.zones` were used unfiltered, so the
 *    newest match could be a 4H object. Both arrays are now filtered on
 *    `timeframe === '15'` before anything is selected.
 *  - Array order was trusted for "newest". `detectStructureBreaks()` appends SMS
 *    entries AFTER the chronological BOS/CHoCH pass, so the merged array is not
 *    strictly ascending; every selection here sorts by timestamp explicitly.
 *  - The fixed `calculateLevels(..., rr = 3)` target, which restated the stop
 *    distance instead of consulting the market.
 */
export class Scenario6_SMS extends BaseScenario {
  /** Deepest rejection of the chain — the stage the funnel actually choked on. */
  private failure: Failure | null = null;

  private static stats: Scenario6Stats = {
    totalEvals: 0,
    noData: 0,
    killzone: 0,
    noSms: 0,
    noOb: 0,
    noChoch: 0,
    displacement: 0,
    tpInvalid: 0,
  };

  constructor(config: BotConfig) {
    super(6, 'Failure Swing (SMS)', config);
  }

  static getRejectionStats(): Scenario6Stats {
    return { ...this.stats };
  }

  static resetStats(): void {
    this.stats = {
      totalEvals: 0,
      noData: 0,
      killzone: 0,
      noSms: 0,
      noOb: 0,
      noChoch: 0,
      displacement: 0,
      tpInvalid: 0,
    };
  }

  protected override evaluateInternal(patternData: any): boolean {
    const stats = Scenario6_SMS.stats;
    stats.totalEvals++;
    this.resetFailure();

    // The failure swing itself can build in any session, but the confirming CHoCH
    // is an entry and entries are killzone-gated.
    if (!this.passesKillzone(patternData)) {
      this.logRejection('Failure swing CHoCH requires London or NY killzone');
      stats.killzone++;
      return false;
    }

    const candles15m: any[] = Array.isArray(patternData.candles15m)
      ? patternData.candles15m
      : [];
    const structures: any[] = Array.isArray(patternData.structures)
      ? patternData.structures
      : [];
    const zones: any[] = Array.isArray(patternData.zones) ? patternData.zones : [];

    if (candles15m.length === 0 || structures.length === 0 || zones.length === 0) {
      this.logRejection('Missing 15m candles, structures or zones');
      stats.noData++;
      return false;
    }

    const last = candles15m[candles15m.length - 1];
    const lastTimestamp = Number(last.timestamp);

    // Newest failure swing first: the reversal being traded is the LATEST one. A
    // small fan-out keeps a freshest-SMS-without-a-block from hiding a valid,
    // slightly older chain; `fail()` still reports the deepest stage reached.
    const smsList = structures
      .filter(
        (s: any) =>
          s?.type === 'SMS' &&
          String(s.timeframe) === ENTRY_TIMEFRAME &&
          (s.direction === 'BULLISH' || s.direction === 'BEARISH') &&
          Number.isFinite(Number(s.timestamp)) &&
          Number(s.timestamp) <= lastTimestamp,
      )
      .sort((a: any, b: any) => Number(b.timestamp) - Number(a.timestamp))
      .slice(0, MAX_SMS_CANDIDATES);

    if (smsList.length === 0) {
      this.logRejection('No 15m SMS (failure swing) detected');
      stats.noSms++;
      return false;
    }

    for (const sms of smsList) {
      const chain = this.resolveChain(sms, patternData, candles15m, structures, zones);
      if (!chain) continue;

      // Zone top/bottom ordering is not guaranteed (Invariant 11).
      const obTop = Decimal.max(new Decimal(chain.ob.top), new Decimal(chain.ob.bottom));
      const obBottom = Decimal.min(new Decimal(chain.ob.top), new Decimal(chain.ob.bottom));

      this.setLevels(chain.levels);
      this.setZoneDetails({
        type: 'OB',
        top: obTop,
        bottom: obBottom,
        timeframe: ENTRY_TIMEFRAME,
        direction: chain.ob.direction === 'BEARISH' ? 'BEARISH' : 'BULLISH',
        timestamp: Number(chain.ob.timestamp),
      });
      // The CHoCH is the confirmation that must never be re-used: burning it
      // blocks a second entry on the same failure swing (Invariant 25).
      this.setStructureDetails({
        type: 'CHoCH',
        timestamp: Number(chain.choch.timestamp),
        price: new Decimal(chain.choch.price),
        direction: chain.direction,
      });
      this.setReason(chain.reason);
      return true;
    }

    this.reportFailure(stats);
    return false;
  }

  /**
   * Resolve one failure-swing chain end-to-end. Nothing is written to the scenario
   * state until the CHoCH, the block and the structural target all validate.
   */
  private resolveChain(
    sms: any,
    patternData: any,
    candles15m: any[],
    structures: any[],
    zones: any[],
  ): SmsChain | null {
    // The SMS direction IS the reversal direction: a bearish SMS is a failed
    // higher high, so the trade is the break DOWN that follows it.
    const direction: Direction = sms.direction === 'BEARISH' ? 'BEARISH' : 'BULLISH';
    const isLong = direction === 'BULLISH';
    const smsTimestamp = Number(sms.timestamp);
    const last = candles15m[candles15m.length - 1];
    const lastTimestamp = Number(last.timestamp);

    // --- GATE 1: the CHoCH confirms the failure swing, so it cannot precede it ---
    const chochCandidates = structures
      .filter(
        (s: any) =>
          s?.type === 'CHOCH' &&
          s.direction === direction &&
          String(s.timeframe) === ENTRY_TIMEFRAME &&
          Number(s.timestamp) >= smsTimestamp &&
          Number(s.timestamp) <= smsTimestamp + PATTERN_WINDOW_MS &&
          Number(s.timestamp) <= lastTimestamp &&
          Number(s.timestamp) >= lastTimestamp - PATTERN_WINDOW_MS,
      )
      .sort((a: any, b: any) => Number(a.timestamp) - Number(b.timestamp));

    const choch = chochCandidates[chochCandidates.length - 1];
    if (!choch) {
      this.fail(
        'noChoch',
        `No 15m ${direction} CHoCH at/after the ${sms.direction} failure swing ` +
          `(looking window ${PATTERN_WINDOW_MS / 3_600_000}h)`,
        2,
      );
      return null;
    }

    // --- GATE 2: displacement confirms the reversal is impulsive ---
    if (!this.isValidDisplacement(choch, DISPLACEMENT_MULTIPLIER)) {
      this.fail(
        'displacement',
        `CHoCH after the failure swing displaced < ${DISPLACEMENT_MULTIPLIER} ATR`,
        3,
      );
      return null;
    }

    // --- GATE 3: the block of the FAILED leg ---
    // A bearish SMS is a failed push UP, so the block that failed is the demand
    // (BULLISH) block of that up-leg; mitigating its equilibrium is the short.
    // The mirror holds for a bullish SMS.
    const obDirection: Direction = isLong ? 'BEARISH' : 'BULLISH';
    const chochTimestamp = Number(choch.timestamp);

    const obCandidates = zones
      .filter(
        (z: any) =>
          z?.type === 'OB' &&
          z.direction === obDirection &&
          String(z.timeframe) === ENTRY_TIMEFRAME &&
          z.mitigated !== true &&
          z.top instanceof Decimal &&
          z.bottom instanceof Decimal &&
          z.top.isFinite() &&
          z.bottom.isFinite() &&
          Decimal.max(z.top, z.bottom).gt(Decimal.min(z.top, z.bottom)) &&
          Number(z.timestamp) < smsTimestamp &&
          smsTimestamp - Number(z.timestamp) <= PATTERN_WINDOW_MS &&
          chochTimestamp - Number(z.timestamp) <= PATTERN_WINDOW_MS,
      )
      .sort((a: any, b: any) => Number(a.timestamp) - Number(b.timestamp));

    const ob = obCandidates[obCandidates.length - 1];
    if (!ob) {
      this.fail(
        'noOb',
        `No 15m ${obDirection} OB of the failed leg inside the ` +
          `${PATTERN_WINDOW_MS / 3_600_000}h window before the SMS`,
        4,
      );
      return null;
    }

    // --- GATE 4: stop geometry, then the structural target ---
    const atr =
      patternData.atr15m instanceof Decimal && patternData.atr15m.gt(0)
        ? patternData.atr15m
        : new Decimal('0.01');

    const obTop = Decimal.max(new Decimal(ob.top), new Decimal(ob.bottom));
    const obBottom = Decimal.min(new Decimal(ob.top), new Decimal(ob.bottom));
    // Entry is the block equilibrium: the mitigation price, never the signal close.
    const entry = obTop.plus(obBottom).dividedBy(2);

    // The trigger candle is the CHoCH that confirmed the reversal. If price has to
    // retrace through its wick to reach the block, that wick is still the last
    // evidence of the impulse — a stop inside it would be taken out by the entry
    // itself. The last closed candle joins for the same reason.
    const chochCandle = candles15m.find(
      (c: any) => Number(c.timestamp) === chochTimestamp,
    );
    const lastHigh = new Decimal(last.high);
    const lastLow = new Decimal(last.low);

    const stopZone = isLong
      ? {
          top: obTop,
          bottom: Decimal.min(
            obBottom,
            chochCandle ? new Decimal(chochCandle.low) : obBottom,
            lastLow,
          ),
          direction,
        }
      : {
          top: Decimal.max(
            obTop,
            chochCandle ? new Decimal(chochCandle.high) : obTop,
            lastHigh,
          ),
          bottom: obBottom,
          direction,
        };

    // `rr = 1` is a placeholder: only the stop geometry is consumed here.
    const base = this.calculateLevels(entry, stopZone, direction, atr, new Decimal(1));

    // `skipMinorObstacles: false` — the nearest obstacle is a hard wall. If it
    // leaves less than DYNAMIC_TP_MIN_RR the setup is rejected, never clamped to a
    // level the market has already invalidated.
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
      this.fail('tpInvalid', `Take-profit rejected: ${resolution.reason}`, 5);
      return null;
    }

    const levels = this.calculateLevelsWithTarget(
      entry,
      stopZone,
      direction,
      atr,
      resolution.takeProfit,
    );

    return {
      direction,
      sms,
      ob,
      choch,
      levels,
      reason:
        `Failure Swing (${isLong ? 'Long' : 'Short'}): ${sms.direction} SMS @ ` +
        `${new Decimal(sms.price).toFixed(4)} + 15m ${direction} CHoCH + ` +
        `${obDirection} OB 0.5 entry ${entry.toFixed(4)}, ` +
        `TP ${resolution.source} @ ${resolution.takeProfit.toFixed(4)}`,
    };
  }

  /** Killzone gate: London/NY only, bypassable via ENFORCE_KILLZONES=false. */
  private passesKillzone(patternData: any): boolean {
    if (this.config.enforceKillzones === false) return true;
    const killzone = patternData.currentKillzone;
    return killzone === 'LONDON' || killzone === 'NY';
  }

  /**
   * Keep the DEEPEST rejection, not the first one.
   *
   * Reported bucket describes how far the chain got, not which gate happened to be
   * evaluated first.
   */
  private fail(kind: FailureKind, reason: string, stage: number): void {
    if (this.failure && this.failure.stage >= stage) return;
    this.failure = { kind, reason, stage };
  }

  /** Emit the deepest rejection of this evaluation and bump its counter. */
  private reportFailure(stats: Scenario6Stats): void {
    const failure = this.failure;
    if (!failure) {
      this.logRejection('No valid failure swing setup');
      return;
    }
    this.logRejection(failure.reason);
    if (failure.kind !== 'none') stats[failure.kind]++;
  }

  /**
   * Clear the per-evaluation failure.
   *
   * Kept behind a method so the compiler does not narrow `this.failure` to `null`
   * for the rest of `evaluateInternal()` — calls to `fail()` mutate it through a
   * different frame, which intra-procedural flow analysis cannot see.
   */
  private resetFailure(): void {
    this.failure = null;
  }
}
