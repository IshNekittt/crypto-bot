import { BaseScenario } from '../baseScenario';
import { Decimal } from 'decimal.js';

export class Scenario11_MitigationBlock extends BaseScenario {
  constructor() {
    super(11, 'Mitigation Block');
  }

  override evaluate(patternData: any): boolean {
    // Mitigation Block works in active killzones
    if (!this.isInKillzone(patternData)) {
      this.logRejection('Not in active killzone');
      return false;
    }

    const { candles15m, structures, zones } = patternData;
    if (!candles15m?.length || !structures?.length || !zones?.length) return false;

    // Mitigation Block: similar to Breaker but with SMS (failure swing) before the break
    // Price makes a high, pulls back, tries to make higher high but FAILS (SMS),
    // then breaks down through the last bullish OB -> that OB becomes Mitigation Block

    // Find SMS (Smart Money Shift) - failure to make new high/low
    const sms = structures.find((s: any) => s.type === 'SMS');
    if (!sms) {
      this.logRejection('No SMS (Smart Money Shift) detected');
      return false;
    }

    // After SMS, there should be a CHoCH in the opposite direction
    const smsDirection = sms.direction; // BEARISH = failed higher high, BULLISH = failed lower low
    const expectedChochDirection = smsDirection === 'BEARISH' ? 'BEARISH' : 'BULLISH';

    const chochAfterSms = structures.find((s: any) => 
      s.kind === 'CHOCH' && 
      s.direction === expectedChochDirection &&
      s.timestamp > sms.timestamp
    );

    if (!chochAfterSms) {
      this.logRejection(`No ${expectedChochDirection} CHoCH after ${smsDirection} SMS`);
      return false;
    }

    // MUST check Displacement on the CHoCH
    if (!this.isValidDisplacement(chochAfterSms, 1.5)) {
      this.logRejection('CHoCH after SMS displacement < 1.5 ATR');
      return false;
    }

    // The Mitigation Block is the OB that was formed during the failed swing
    // For bearish SMS: the last BULLISH OB before SMS (the one that tried to push higher)
    // For bullish SMS: the last BEARISH OB before SMS
    const mbObs = zones.filter((z: any) => 
      z.type === 'OB' && 
      z.direction === (smsDirection === 'BEARISH' ? 'BULLISH' : 'BEARISH') &&
      z.timestamp < sms.timestamp &&
      !z.mitigated
    );

    if (!mbObs.length) {
      this.logRejection('No Mitigation Block OB found before SMS');
      return false;
    }

    const mitigationBlock = mbObs[0];

    // Wait for price to return and test the Mitigation Block
    const lastCandle = candles15m[candles15m.length - 1];
    if (!lastCandle) return false;

    const lastClose = new Decimal(lastCandle.close);
    const lastHigh = new Decimal(lastCandle.high);
    const lastLow = new Decimal(lastCandle.low);

    const mbTop = mitigationBlock.top;
    const mbBottom = mitigationBlock.bottom;

    // Price should test the mitigation block zone
    const testingMb = expectedChochDirection === 'BULLISH'
      ? lastLow.lte(mbTop) && lastClose.gte(mbBottom)
      : lastHigh.gte(mbBottom) && lastClose.lte(mbTop);

    if (!testingMb) {
      this.logRejection('Price not testing Mitigation Block zone');
      return false;
    }

    // Entry at 0.5 (Equilibrium) of Mitigation Block
    const entry = mbTop.plus(mbBottom).dividedBy(2);
    const atr15m = patternData.atr15m || new Decimal('0.01');
    const sl = expectedChochDirection === 'BULLISH'
      ? mbBottom.minus(atr15m.mul(0.5))
      : mbTop.plus(atr15m.mul(0.5));
    const tp = expectedChochDirection === 'BULLISH'
      ? entry.plus(entry.minus(sl).mul(3))
      : entry.minus(sl.minus(entry).mul(3));

    this.setLevels({
      entry: entry.toFixed(2),
      stopLoss: sl.toFixed(2),
      takeProfit: tp.toFixed(2),
    });

    this.setReason(`Mitigation Block: ${smsDirection} SMS + ${expectedChochDirection} CHoCH + MB 0.5 test (less reliable than Breaker)`);
    return true;
  }
}