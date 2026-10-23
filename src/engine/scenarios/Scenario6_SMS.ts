import { BaseScenario } from '../baseScenario';
import { Decimal } from 'decimal.js';
import { BotConfig } from '../../config/env';

export class Scenario6_SMS extends BaseScenario {
  constructor(config: BotConfig) {
    super(6, 'Failure Swing (SMS)', config);
  }

  protected override evaluateInternal(patternData: any): boolean {
    // SMS can happen in any session, but CHoCH confirmation needs killzone
    if (!this.isInKillzone(patternData)) {
      this.logRejection('Not in active killzone for CHoCH confirmation');
      return false;
    }

    const { candles15m, structures, zones } = patternData;
    if (!candles15m?.length || !structures?.length || !zones?.length) return false;

    // Find SMS (Smart Money Shift) - failure to make new high/low
    const sms = [...structures].reverse().find((s: any) =>
      s.type === 'SMS' && s.timeframe === '15',
    );
    if (!sms) {
      this.logRejection('No SMS (Smart Money Shift) detected');
      return false;
    }

    // SMS direction tells us the reversal direction
    // Bearish SMS = failed to make higher high -> expect BEARISH CHoCH down
    // Bullish SMS = failed to make lower low -> expect BULLISH CHoCH up
    const expectedDirection = sms.direction;

    // CRITICAL: Verify aggressive CHoCH in SMS direction
    const choch = [...structures].reverse().find((s: any) => 
      s.type === 'CHOCH' &&
      s.timeframe === '15' &&
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
      z.timeframe === '15' &&
      z.direction === (sms.direction === 'BEARISH' ? 'BULLISH' : 'BEARISH') &&
      z.timestamp < sms.timestamp &&
      !z.mitigated
    );

    if (!smsObs.length) {
      this.logRejection('No SMS-forming Order Block found');
      return false;
    }

    const smsOb = smsObs[smsObs.length - 1];

    // Entry at 0.5 (Equilibrium) of the SMS Order Block
    const entry = smsOb.top.plus(smsOb.bottom).dividedBy(2);

    // Use base class calculateLevels with correct trade direction (expectedDirection)
    const levels = this.calculateLevels(
      entry,
      {
        top: smsOb.top,
        bottom: smsOb.bottom,
        direction: expectedDirection, // zone direction = trade direction
      },
      expectedDirection, // trade direction = CHoCH direction
      patternData.atr15m || new Decimal('0.01'),
    );

    this.setLevels({
      entry: levels.entry,
      stopLoss: levels.stopLoss,
      takeProfit: levels.takeProfit,
    });

    this.setReason(`SMS: ${sms.direction} failure swing + ${expectedDirection} CHoCH + SMS OB 0.5 entry`);
    
    // Set zone details for mitigation tracking (the SMS-forming OB we entered from)
    this.setZoneDetails({
      type: 'OB',
      top: smsOb.top,
      bottom: smsOb.bottom,
      timeframe: smsOb.timeframe || '15',
      direction: smsOb.direction,
      timestamp: smsOb.timestamp,
    });
    
    // Set structure details for mitigation tracking (CHoCH is the trigger structure)
    this.setStructureDetails({
      type: 'CHoCH',
      timestamp: choch.timestamp,
      price: choch.price,
      direction: expectedDirection,
    });
    
    return true;
  }
}