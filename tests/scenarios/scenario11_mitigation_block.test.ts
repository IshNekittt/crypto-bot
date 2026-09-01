import { Scenario11_MitigationBlock } from '../../src/engine/scenarios/Scenario11_MitigationBlock';
import { Decimal } from 'decimal.js';

describe('Scenario11: Mitigation Block', () => {
  let scenario: Scenario11_MitigationBlock;

  const createMockPatternData = (overrides: Partial<{
    killzone: string;
    hasSms: boolean;
    smsDirection: 'BULLISH' | 'BEARISH';
    hasChochAfterSms: boolean;
    chochDisplacement: boolean;
    hasMitigationBlock: boolean;
    priceTestingMb: boolean;
  }> = {}) => {
    const config = {
      killzone: overrides.killzone || 'LONDON',
      hasSms: overrides.hasSms !== false,
      smsDirection: overrides.smsDirection || 'BEARISH',
      hasChochAfterSms: overrides.hasChochAfterSms !== false,
      chochDisplacement: overrides.chochDisplacement !== false,
      hasMitigationBlock: overrides.hasMitigationBlock !== false,
      priceTestingMb: overrides.priceTestingMb !== false,
    };

    const sms = config.hasSms ? {
      type: 'SMS', direction: config.smsDirection, price: new Decimal(104),
      timestamp: Date.now() - 2000, isValidated: true,
    } : null;

    const chochAfterSms = config.hasChochAfterSms ? {
      kind: 'CHOCH', direction: config.smsDirection === 'BEARISH' ? 'BEARISH' : 'BULLISH',
      price: new Decimal(102), timestamp: Date.now() - 1000, isValidated: true, impulseFactor: config.chochDisplacement ? new Decimal(2.0) : new Decimal(1.0),
    } : null;

    const mitigationBlock = config.hasMitigationBlock ? {
      type: 'OB', direction: config.smsDirection === 'BEARISH' ? 'BULLISH' : 'BEARISH',
      top: new Decimal(103), bottom: new Decimal(102), timestamp: Date.now() - 3000, mitigated: false, timeframe: '15',
    } : null;

    const expectedDirection = config.smsDirection === 'BEARISH' ? 'BEARISH' : 'BULLISH';

    const lastCandle = config.priceTestingMb ? {
      timestamp: Date.now(),
      close: expectedDirection === 'BULLISH' ? '102.5' : '102.5',
      high: expectedDirection === 'BULLISH' ? '103.5' : '103.5',
      low: expectedDirection === 'BULLISH' ? '102' : '102',
      open: '103', volume: '1000',
    } : {
      timestamp: Date.now(), close: '106', high: '107', low: '105', open: '106', volume: '1000',
    };

    return {
      currentKillzone: config.killzone,
      candles15m: [lastCandle],
      structures: [sms, chochAfterSms].filter(Boolean),
      zones: mitigationBlock ? [mitigationBlock] : [],
      atr15m: new Decimal('0.5'),
    };
  };

  beforeEach(() => {
    scenario = new Scenario11_MitigationBlock();
  });

  describe('positive cases', () => {
    it('should trigger for bearish SMS with all conditions', () => {
      const result = scenario.evaluate(createMockPatternData({}));
      
      expect(result).toBe(true);
      expect(scenario.getReason()).toContain('Mitigation Block');
      expect(scenario.getLevels().entry).toBeDefined();
    });

    it('should trigger for bullish SMS', () => {
      const result = scenario.evaluate(createMockPatternData({ smsDirection: 'BULLISH' }));
      
      expect(result).toBe(true);
      expect(scenario.getReason()).toContain('Mitigation Block');
    });
  });

  describe('negative cases - killzone', () => {
    it('should reject when killzone is NONE', () => {
      const result = scenario.evaluate(createMockPatternData({ killzone: 'NONE' }));
      expect(result).toBe(false);
      expect(scenario.getReason()).toBe('Not in active killzone');
    });
  });

  describe('negative cases - SMS', () => {
    it('should reject when no SMS detected', () => {
      const result = scenario.evaluate(createMockPatternData({ hasSms: false }));
      expect(result).toBe(false);
      expect(scenario.getReason()).toBe('No SMS (Smart Money Shift) detected');
    });
  });

  describe('negative cases - CHoCH after SMS', () => {
    it('should reject when no CHoCH after SMS', () => {
      const result = scenario.evaluate(createMockPatternData({ hasChochAfterSms: false }));
      expect(result).toBe(false);
      expect(scenario.getReason()).toContain('CHoCH after');
    });

    it('should reject when CHoCH displacement < 1.5 ATR', () => {
      const result = scenario.evaluate(createMockPatternData({ chochDisplacement: false }));
      expect(result).toBe(false);
      expect(scenario.getReason()).toBe('CHoCH after SMS displacement < 1.5 ATR');
    });
  });

  describe('negative cases - Mitigation Block', () => {
    it('should reject when no zones available (zones empty = early return)', () => {
      const result = scenario.evaluate(createMockPatternData({ hasMitigationBlock: false }));
      expect(result).toBe(false);
      // When zones is empty, early return without logging reason
      expect(scenario.getReason()).toBe('');
    });

    it('should reject when price not testing Mitigation Block zone', () => {
      const result = scenario.evaluate(createMockPatternData({ priceTestingMb: false }));
      expect(result).toBe(false);
      expect(scenario.getReason()).toBe('Price not testing Mitigation Block zone');
    });
  });
});