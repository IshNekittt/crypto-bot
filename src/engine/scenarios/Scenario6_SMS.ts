import { BaseScenario } from '../baseScenario';
import { Decimal } from 'decimal.js';

export class Scenario6_SMS extends BaseScenario {
  constructor() {
    super(6, 'Failure Swing (SMS)');
  }

  override evaluate(patternData: any): boolean {
    // SMS can happen in any session, but CHoCH confirmation needs killzone
    // Check explicit killzone override first
    if (patternData.currentKillzone === 'NONE') {
      this.logRejection('Not in active killzone for CHoCH confirmation');
      return false;
    }
    const candleTimestamp = patternData.candles15m?.[patternData.candles15m.length - 1]?.timestamp ?? Date.now();
    if (!this.isInKillzone(candleTimestamp)) {
      this.logRejection('Not in active killzone for CHoCH confirmation');
      return false;
    }

    const { candles15m, structures, zones } = patternData;
    if (!candles15m?.length || !structures?.length || !zones?.length) return false;

    // Find SMS (Smart Money Shift) - failure to make new high/low
    const sms = structures.find((s: any) => s.type === 'SMS');
    if (!sms) {
      this.logRejection('No SMS (Smart Money Shift) detected');
      return false;
    }

    // SMS direction tells us the reversal direction
    // Bearish SMS = failed to make higher high -> expect BEARISH CHoCH down
    // Bullish SMS = failed to make lower low -> expect BULLISH CHoCH up
    const expectedDirection = sms.direction === 'BEARISH' ? 'BEARISH' : 'BULLISH';

    // CRITICAL: Verify aggressive CHoCH in SMS direction
    const choch = structures.find((s: any) => 
      s.type === 'CHOCH' && 
      s.direction === expectedDirection &&
      s.timestamp > sms.timestamp
    );

    if (!choch) {
      this.logRejection(`No ${expectedDirection} CHoCH after ${sms.direction} SMS`);
      return false;
    }

    // MUST check Displacement - body >= 1.5 * ATR
    if (!this.isValidDisplacement(choch, 1.5)) {
      this.logRejection('CHoCH after SMS displacement < 1.5 ATR');
      return false;
    }

    // Find the OB that formed the SMS (the block that failed to push through)
    // For bearish SMS: the last BULLISH OB before the SMS that failed
    // For bullish SMS: the last BEARISH OB before the SMS that failed
    const smsObs = zones.filter((z: any) => 
      z.type === 'OB' && 
      z.direction === (sms.direction === 'BEARISH' ? 'BULLISH' : 'BEARISH') &&
      z.timestamp < sms.timestamp &&
      !z.mitigated
    );

    if (!smsObs.length) {
      this.logRejection('No SMS-forming Order Block found');
      return false;
    }

    const smsOb = smsObs[0];

    // Entry at 0.5 (Equilibrium) of the SMS Order Block
    const entry = smsOb.top.plus(smsOb.bottom).dividedBy(2);
    const atr15m = patternData.atr15m || new Decimal('0.01');
    const offset = atr15m.mul(0.5);

    // CRITICAL: Ensure SL is on correct side of Entry regardless of OB top/bottom convention
    // BULLISH (Long): SL must be BELOW entry. Use min(smsOb.bottom, entry) - offset
    // BEARISH (Short): SL must be ABOVE entry. Use max(smsOb.top, entry) + offset
    const sl = expectedDirection === 'BULLISH'
      ? Decimal.min(smsOb.bottom, entry).minus(offset)
      : Decimal.max(smsOb.top, entry).plus(offset);
    const tp = expectedDirection === 'BULLISH'
      ? entry.plus(entry.minus(sl).mul(3))
      : entry.minus(sl.minus(entry).mul(3));

    this.setLevels({
      entry: entry.toFixed(2),
      stopLoss: sl.toFixed(2),
      takeProfit: tp.toFixed(2),
    });

    this.setReason(`SMS: ${sms.direction} failure swing + ${expectedDirection} CHoCH + SMS OB 0.5 entry`);
    return true;
  }
}