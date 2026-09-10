import { BaseScenario } from '../baseScenario';
import { Decimal } from 'decimal.js';

export class Scenario11_MitigationBlock extends BaseScenario {
  private static rejectionStats = {
    killzone: 0,
    noSms: 0,
    invalidSmsPattern: 0,
    noChoch: 0,
    displacement: 0,
    noMitigationBlock: 0,
    noRetest: 0,
    totalEvals: 0
  };

  static getRejectionStats() {
    return { ...this.rejectionStats };
  }

  static resetStats() {
    this.rejectionStats = {
      killzone: 0,
      noSms: 0,
      invalidSmsPattern: 0,
      noChoch: 0,
      displacement: 0,
      noMitigationBlock: 0,
      noRetest: 0,
      totalEvals: 0
    };
  }

  constructor() {
    super(11, 'Mitigation Block');
  }

  /**
   * Strict SMS validation: 
   * - BEARISH SMS: Price tried to make Higher High, failed (formed Lower High or equal high within tolerance),
   *   then broke down through the swing low that confirmed the failure (CHoCH down)
   * - BULLISH SMS: Price tried to make Lower Low, failed (formed Higher Low or equal low within tolerance),
   *   then broke up through the swing high that confirmed the failure (CHoCH up)
   * The Mitigation Block is the OB that formed the failed swing extreme (Lower High for bearish, Higher Low for bullish)
   * Returns validation result with specific rejection reason if invalid
   */
  private validateSmsPattern(sms: any, structures: any[], zones: any[]): { isValid: boolean; mitigationBlock: any; chochAfterSms: any; rejectionReason?: string } {
    const smsDirection = sms.direction; // BEARISH = failed higher high, BULLISH = failed lower low
    const expectedChochDirection = smsDirection === 'BEARISH' ? 'BEARISH' : 'BULLISH';

    // Find CHoCH in opposite direction within 8H after SMS
    const chochAfterSms = structures.find((s: any) => 
      s.type === 'CHOCH' && 
      s.direction === expectedChochDirection &&
      s.timestamp > sms.timestamp &&
      s.timestamp <= sms.timestamp + 8 * 60 * 60 * 1000 // within 8H after SMS
    );

    if (!chochAfterSms) {
      return { isValid: false, mitigationBlock: null, chochAfterSms: null, rejectionReason: 'No CHoCH after SMS within 8H' };
    }

    // MUST check Displacement on the CHoCH
    if (!this.isValidDisplacement(chochAfterSms, 1.5)) {
      return { isValid: false, mitigationBlock: null, chochAfterSms: null, rejectionReason: 'CHoCH after SMS displacement < 1.5 ATR' };
    }

    // The Mitigation Block is the OB that formed the FAILED swing extreme
    // For BEARISH SMS (failed higher high): the OB that formed the LOWER HIGH (the failed attempt)
    // For BULLISH SMS (failed lower low): the OB that formed the HIGHER LOW (the failed attempt)
    // These are the last OB in the opposite direction BEFORE the SMS
    const mbObs = zones.filter((z: any) => 
      z.type === 'OB' && 
      z.direction === (smsDirection === 'BEARISH' ? 'BULLISH' : 'BEARISH') &&
      z.timestamp < sms.timestamp &&
      !z.mitigated
    );

    if (!mbObs.length) {
      return { isValid: false, mitigationBlock: null, chochAfterSms: null, rejectionReason: 'No Mitigation Block OB found before SMS' };
    }

    // The mitigation block is the LAST OB before SMS that formed the failed swing
    // For bearish SMS: the OB at the lower high (most recent bullish OB before SMS)
    // For bullish SMS: the OB at the higher low (most recent bearish OB before SMS)
    const mitigationBlock = mbObs[0];

    return { isValid: true, mitigationBlock, chochAfterSms };
  }

  override evaluate(patternData: any): boolean {
    Scenario11_MitigationBlock.rejectionStats.totalEvals++;

    // Mitigation Block works in active killzones
    // Check explicit killzone override first
    if (patternData.currentKillzone === 'NONE') {
      this.logRejection('Not in active killzone');
      Scenario11_MitigationBlock.rejectionStats.killzone++;
      return false;
    }
    const candleTimestamp = patternData.candles15m?.[patternData.candles15m.length - 1]?.timestamp ?? Date.now();
    if (!this.isInKillzone(candleTimestamp)) {
      this.logRejection('Not in active killzone');
      Scenario11_MitigationBlock.rejectionStats.killzone++;
      return false;
    }

    const { candles15m, structures, zones } = patternData;
    if (!candles15m?.length || !structures?.length || !zones?.length) return false;

    // Mitigation Block: ONLY works after SMS (Failure Swing)
    // Price makes a high, pulls back, tries to make higher high but FAILS (SMS),
    // then breaks down through the last bullish OB -> that OB becomes Mitigation Block

    // Find SMS (Smart Money Shift) - failure to make new high/low
    const sms = structures.find((s: any) => s.type === 'SMS');
    if (!sms) {
      this.logRejection('No SMS (Smart Money Shift) detected');
      Scenario11_MitigationBlock.rejectionStats.noSms++;
      return false;
    }

    // STRICT SMS PATTERN VALIDATION
    const validation = this.validateSmsPattern(sms, structures, zones);
    if (!validation.isValid) {
      const reason = validation.rejectionReason || 'Invalid SMS pattern';
      this.logRejection(reason);
      if (reason.includes('CHoCH after SMS')) {
        Scenario11_MitigationBlock.rejectionStats.noChoch++;
      } else if (reason.includes('displacement')) {
        Scenario11_MitigationBlock.rejectionStats.displacement++;
      } else if (reason.includes('Mitigation Block OB')) {
        Scenario11_MitigationBlock.rejectionStats.noMitigationBlock++;
      } else {
        Scenario11_MitigationBlock.rejectionStats.invalidSmsPattern++;
      }
      return false;
    }

    const mitigationBlock = validation.mitigationBlock;
    const chochAfterSms = validation.chochAfterSms;

    // Wait for price to return and test the Mitigation Block
    // SMC RULE: Entry ONLY on RETEST after CHoCH candle CLOSES
    // Check last 5 candles for retest (retest could be 1-4 candles ago)
    const mbTop = mitigationBlock.top;
    const mbBottom = mitigationBlock.bottom;
    const expectedChochDirection = chochAfterSms.direction;
    
    let retestCandle: any = null;
    const checkWindow = Math.min(5, candles15m.length);
    for (let i = candles15m.length - checkWindow; i < candles15m.length; i++) {
      const c = candles15m[i];
      // Must be AFTER CHoCH candle
      if (c.timestamp <= chochAfterSms.timestamp) continue;
      
      const close = new Decimal(c.close);
      const high = new Decimal(c.high);
      const low = new Decimal(c.low);

      // Price should test the mitigation block zone on RETEST
      const testingMb = expectedChochDirection === 'BULLISH'
        ? low.lte(mbTop) && close.gte(mbBottom)
        : high.gte(mbBottom) && close.lte(mbTop);

      if (testingMb) {
        retestCandle = c;
        break;
      }
    }

    if (!retestCandle) {
      this.logRejection('Price not testing Mitigation Block zone on retest in last 5 candles');
      Scenario11_MitigationBlock.rejectionStats.noRetest++;
      return false;
    }

    const lastClose = new Decimal(retestCandle.close);

    // Entry at 0.5 (Equilibrium) of Mitigation Block
    // Enter at market on retest candle close
    const entry = lastClose;
    const atr15m = patternData.atr15m || new Decimal('0.01');
    const offset = atr15m.mul(0.5);

    // CRITICAL: Ensure SL is on correct side of Entry regardless of MB top/bottom convention
    // BULLISH (Long): SL must be BELOW entry. Use min(mbBottom, entry) - offset
    // BEARISH (Short): SL must be ABOVE entry. Use max(mbTop, entry) + offset
    const sl = expectedChochDirection === 'BULLISH'
      ? Decimal.min(mbBottom, entry).minus(offset)
      : Decimal.max(mbTop, entry).plus(offset);
    const tp = expectedChochDirection === 'BULLISH'
      ? entry.plus(entry.minus(sl).mul(3))
      : entry.minus(sl.minus(entry).mul(3));

    this.setLevels({
      entry: entry.toFixed(2),
      stopLoss: sl.toFixed(2),
      takeProfit: tp.toFixed(2),
    });

    this.setReason(`Mitigation Block: ${sms.direction} SMS (strict) + ${expectedChochDirection} CHoCH + MB 0.5 retest`);
    return true;
  }
}