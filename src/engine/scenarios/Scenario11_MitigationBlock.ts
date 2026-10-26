import { BaseScenario, TradeLevels } from '../baseScenario';
import { Decimal } from 'decimal.js';
import { BotConfig } from '../../config/env';
import { resolveTakeProfit } from '../tpResolver';

/** 15m entry timeframe. */
const ENTRY_TIMEFRAME = '15';
/**
 * Looking window for the whole chain (OB -> SMS -> CHoCH). The mitigation block
 * IS the block of the failed swing, so a block older than three days belongs to a
 * different leg of the market and cannot be "the" failed swing being mitigated.
 */
const PATTERN_WINDOW_MS = 72 * 60 * 60 * 1000;
/** The CHoCH must confirm the SMS inside 8h (32 LTF candles). */
const SMS_TO_CHOCH_WINDOW_MS = 8 * 60 * 60 * 1000;
/** The block must be mitigated (retested) inside 12h of the CHoCH. */
const RETEST_WINDOW_MS = 12 * 60 * 60 * 1000;
/** Displacement floor for the confirming CHoCH (AGENTS.md §7.2). */
const DISPLACEMENT_MULTIPLIER = 1.5;
/** Freshest SMS candidates walked before giving up (newest first). */
const MAX_SMS_CANDIDATES = 3;

type Direction = 'BULLISH' | 'BEARISH';

/** Fully validated mitigation block setup. Setters run only for a plan. */
interface MitigationPlan {
  readonly direction: Direction;
  readonly sms: any;
  readonly choch: any;
  readonly mitigationBlock: any;
  readonly retestCandle: any;
  readonly levels: TradeLevels;
  readonly reason: string;
}

interface Scenario11Stats {
  totalEvals: number;
  noData: number;
  killzone: number;
  noSms: number;
  noChoch: number;
  displacement: number;
  noMitigationBlock: number;
  noRetest: number;
  premiumDiscount: number;
  tpInvalid: number;
}

type FailureKind =
  | 'none'
  | 'noChoch'
  | 'displacement'
  | 'noMitigationBlock'
  | 'noRetest'
  | 'premiumDiscount'
  | 'tpInvalid';

/** A rejection plus how far down the chain it happened. */
interface Failure {
  readonly kind: FailureKind;
  readonly reason: string;
  readonly stage: number;
}

/**
 * Scenario 11 — Mitigation Block.
 *
 * The block of a failed swing. Price fails the extreme, breaks structure, and
 * then returns to the block that produced the failure. The traders who bought
 * that block (or sold it, mirrored) are underwater; their mitigation is the exit
 * liquidity for the reversal.
 *
 * Causal contract:
 *  1. Everything is 15m. The legacy code filtered SMS and the block on `'15'` but
 *     it is the *pairing* that broke: `structures` merges 15m and 4H, the SMS
 *     selection ran over the merged array, and a 4H SMS could be handed to a
 *     15m-only CHoCH search that then found nothing — or worse, matched.
 *  2. The chain is strictly ordered: the block exists before the SMS
 *     (`ob.timestamp < sms.timestamp`), the CHoCH confirms AT or AFTER the SMS
 *     (`choch.timestamp >= sms.timestamp` — `detectSMS()` stamps the SMS with the
 *     break candle, so equality is the same-bar case), and the retest is a later
 *     candle that closes inside the block.
 *  3. The block is the block of the FAILED leg: opposite in direction to the SMS,
 *     exactly as in the failure swing itself.
 *  4. The whole chain must fit the 72h looking window: a CHoCH cannot be paired
 *     with a month-old block.
 *  5. The retest is the candle that just closed, inside 12h of the CHoCH: wick
 *     into the block, body closing inside it and in the trade direction.
 *  6. Entry is at the Premium/Discount equilibrium of the SMS -> CHoCH impulse,
 *     taken from the retest close. A long must be in discount, a short in premium.
 *  7. The target comes from the structural resolver. `skipMinorObstacles: false`
 *     keeps the nearest obstacle a hard wall: if it leaves less than
 *     DYNAMIC_TP_MIN_RR the setup is rejected, never clamped.
 *
 * Removed legacy logic:
 *  - `validateSmsPattern()` returned a rejection STRING that the caller then
 *    re-parsed with `includes()` to pick a stats bucket. The funnel now reports the
 *    stage directly, so a bucket cannot be mis-attributed by wording.
 *  - The fixed `calculateLevels(..., rr = 3)` target, which restated the stop
 *    distance instead of consulting the market.
 *  - `!z.mitigated` was the only freshness guard; `Zone.mitigated` is always
 *    `false` from the recognizer, so it never filtered anything. Freshness is now
 *    enforced through the looking window.
 */
export class Scenario11_MitigationBlock extends BaseScenario {
  /** Deepest rejection of the chain — the stage the funnel actually choked on. */
  private failure: Failure | null = null;

  private static stats: Scenario11Stats = {
    totalEvals: 0,
    noData: 0,
    killzone: 0,
    noSms: 0,
    noChoch: 0,
    displacement: 0,
    noMitigationBlock: 0,
    noRetest: 0,
    premiumDiscount: 0,
    tpInvalid: 0,
  };

  constructor(config: BotConfig) {
    super(11, 'Mitigation Block', config);
  }

  static getRejectionStats(): Scenario11Stats {
    return { ...this.stats };
  }

  static resetStats(): void {
    this.stats = {
      totalEvals: 0,
      noData: 0,
      killzone: 0,
      noSms: 0,
      noChoch: 0,
      displacement: 0,
      noMitigationBlock: 0,
      noRetest: 0,
      premiumDiscount: 0,
      tpInvalid: 0,
    };
  }

  protected override evaluateInternal(patternData: any): boolean {
    const stats = Scenario11_MitigationBlock.stats;
    stats.totalEvals++;
    this.resetFailure();

    if (!this.passesKillzone(patternData)) {
      this.logRejection('Mitigation Block requires London or NY killzone');
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

    // Newest failure swing first — the mitigation being traded is the freshest one.
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
      const plan = this.resolvePlan(sms, patternData, candles15m, structures, zones);
      if (!plan) continue;

      const mbTop = Decimal.max(
        new Decimal(plan.mitigationBlock.top),
        new Decimal(plan.mitigationBlock.bottom),
      );
      const mbBottom = Decimal.min(
        new Decimal(plan.mitigationBlock.top),
        new Decimal(plan.mitigationBlock.bottom),
      );

      this.setLevels(plan.levels);
      this.setZoneDetails({
        type: 'OB',
        top: mbTop,
        bottom: mbBottom,
        timeframe: ENTRY_TIMEFRAME,
        direction:
          plan.mitigationBlock.direction === 'BEARISH' ? 'BEARISH' : 'BULLISH',
        timestamp: Number(plan.mitigationBlock.timestamp),
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

    this.reportFailure(stats);
    return false;
  }

  /**
   * Resolve one mitigation chain end-to-end. Nothing is written to the scenario
   * state until the SMS, the CHoCH, the block, the retest and the target validate.
   */
  private resolvePlan(
    sms: any,
    patternData: any,
    candles15m: any[],
    structures: any[],
    zones: any[],
  ): MitigationPlan | null {
    // A bearish SMS is a failed higher high; the confirming break is bearish, and
    // the mitigation short is taken at the demand block of the failed up-leg.
    const direction: Direction = sms.direction === 'BEARISH' ? 'BEARISH' : 'BULLISH';
    const isLong = direction === 'BULLISH';
    const smsTimestamp = Number(sms.timestamp);
    const retestCandle = candles15m[candles15m.length - 1];
    const retestTimestamp = Number(retestCandle.timestamp);

    // --- GATE 1: the CHoCH confirms the SMS, at/after it and inside 8h ---
    const chochCandidates = structures
      .filter(
        (s: any) =>
          s?.type === 'CHOCH' &&
          s.direction === direction &&
          String(s.timeframe) === ENTRY_TIMEFRAME &&
          Number(s.timestamp) >= smsTimestamp &&
          Number(s.timestamp) <= smsTimestamp + SMS_TO_CHOCH_WINDOW_MS &&
          Number(s.timestamp) <= retestTimestamp,
      )
      .sort((a: any, b: any) => Number(a.timestamp) - Number(b.timestamp));

    const choch = chochCandidates[chochCandidates.length - 1];
    if (!choch) {
      this.fail(
        'noChoch',
        `No 15m ${direction} CHoCH at/after the ${sms.direction} SMS within ` +
          `${SMS_TO_CHOCH_WINDOW_MS / 3_600_000}h`,
        2,
      );
      return null;
    }

    // --- GATE 2: displacement confirms the reversal is impulsive ---
    if (!this.isValidDisplacement(choch, DISPLACEMENT_MULTIPLIER)) {
      this.fail(
        'displacement',
        `CHoCH after SMS displaced < ${DISPLACEMENT_MULTIPLIER} ATR`,
        3,
      );
      return null;
    }

    const chochTimestamp = Number(choch.timestamp);

    // --- GATE 3: the block of the failed leg, chronologically before the SMS ---
    const mbDirection: Direction = isLong ? 'BEARISH' : 'BULLISH';
    const mbCandidates = zones
      .filter(
        (z: any) =>
          z?.type === 'OB' &&
          z.direction === mbDirection &&
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

    const mitigationBlock = mbCandidates[mbCandidates.length - 1];
    if (!mitigationBlock) {
      this.fail(
        'noMitigationBlock',
        `No 15m ${mbDirection} OB of the failed leg inside the ` +
          `${PATTERN_WINDOW_MS / 3_600_000}h window before the SMS`,
        4,
      );
      return null;
    }

    const mbTop = Decimal.max(
      new Decimal(mitigationBlock.top),
      new Decimal(mitigationBlock.bottom),
    );
    const mbBottom = Decimal.min(
      new Decimal(mitigationBlock.top),
      new Decimal(mitigationBlock.bottom),
    );

    // --- GATE 4: the retest is the candle that just closed ---
    const timeSinceChoch = retestTimestamp - chochTimestamp;
    if (timeSinceChoch <= 0) {
      this.fail(
        'noRetest',
        'Entry is only valid on a candle AFTER the CHoCH candle closes',
        5,
      );
      return null;
    }
    if (timeSinceChoch > RETEST_WINDOW_MS) {
      this.fail(
        'noRetest',
        `Mitigation arrived later than ${RETEST_WINDOW_MS / 3_600_000}h after the CHoCH`,
        5,
      );
      return null;
    }

    const retestHigh = new Decimal(retestCandle.high);
    const retestLow = new Decimal(retestCandle.low);
    const retestOpen = new Decimal(retestCandle.open);
    const retestClose = new Decimal(retestCandle.close);

    // Wick into the block, body closing inside it and in the trade direction.
    const touchedBlock = retestLow.lte(mbTop) && retestHigh.gte(mbBottom);
    const closedInsideInDirection = isLong
      ? retestClose.gt(retestOpen) && retestClose.gte(mbBottom) && retestClose.lte(mbTop)
      : retestClose.lt(retestOpen) && retestClose.lte(mbTop) && retestClose.gte(mbBottom);

    if (!touchedBlock || !closedInsideInDirection) {
      this.fail(
        'noRetest',
        `Retest candle did not reject from the mitigation block ${mbBottom.toFixed(4)}..${mbTop.toFixed(4)} ` +
          '(wick in, body closing inside in the trade direction)',
        5,
      );
      return null;
    }

    // --- GATE 5: Premium/Discount of the SMS -> CHoCH impulse ---
    const entry = retestClose;
    const impulseHigh = Decimal.max(new Decimal(sms.price), new Decimal(choch.price));
    const impulseLow = Decimal.min(new Decimal(sms.price), new Decimal(choch.price));
    const equilibrium = impulseLow.plus(impulseHigh.minus(impulseLow).dividedBy(2));
    const inCorrectHalf = isLong ? entry.lt(equilibrium) : entry.gt(equilibrium);

    if (!inCorrectHalf) {
      this.fail(
        'premiumDiscount',
        `${isLong ? 'Long' : 'Short'} entry ${entry.toFixed(4)} is not in ` +
          `${isLong ? 'Discount' : 'Premium'} of the SMS->CHoCH impulse (equilibrium ${equilibrium.toFixed(4)})`,
        6,
      );
      return null;
    }

    // --- GATE 6: stop geometry, then the structural target ---
    const atr =
      patternData.atr15m instanceof Decimal && patternData.atr15m.gt(0)
        ? patternData.atr15m
        : new Decimal('0.01');

    // The block edge is the invalidation, widened by the retest wick: the wick that
    // traded through the edge is part of the entry, not a level the position may be
    // stopped by afterwards.
    const stopZone = isLong
      ? { top: mbTop, bottom: Decimal.min(mbBottom, retestLow), direction }
      : { top: Decimal.max(mbTop, retestHigh), bottom: mbBottom, direction };

    // `rr = 1` is a placeholder: only the stop geometry is consumed here.
    const base = this.calculateLevels(entry, stopZone, direction, atr, new Decimal(1));

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
      this.fail('tpInvalid', `Take-profit rejected: ${resolution.reason}`, 7);
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
      choch,
      mitigationBlock,
      retestCandle,
      levels,
      reason:
        `Mitigation Block (${isLong ? 'Long' : 'Short'}): ${sms.direction} SMS + ` +
        `15m ${direction} CHoCH + ${mbDirection} MB ` +
        `${mbBottom.toFixed(4)}..${mbTop.toFixed(4)} retest @ ${entry.toFixed(4)} ` +
        `(${isLong ? 'Discount' : 'Premium'}), TP ${resolution.source} @ ${resolution.takeProfit.toFixed(4)}`,
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
  private reportFailure(stats: Scenario11Stats): void {
    const failure = this.failure;
    if (!failure) {
      this.logRejection('No valid mitigation block setup');
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
