import { ScenarioRouter } from '../src/engine/scenarioRouter';
import { IScenario } from '../src/types';

const mockNotifier = {
  enabled: true,
  sendMessage: jest.fn().mockResolvedValue(true),
};

const mockPatternRecognizer = {
  buildPatternData: jest.fn().mockResolvedValue({
    currentKillzone: 'LONDON',
    currentSession: 'LONDON',
    candles15m: [],
    candles4h: [],
    zones: [],
    structures: [],
    liquidityPools: [],
    sessionRanges: [],
    tradingRange: null,
    atr15m: 0.5,
    atr4h: 1.0,
    macroContext: {},
  }),
};

describe('ScenarioRouter', () => {
  let router: ScenarioRouter;

  beforeEach(() => {
    // Set ACTIVE_SCENARIOS to include all 11 scenarios for testing
    process.env.ACTIVE_SCENARIOS = '1,2,3,4,5,6,7,8,9,10,11';
    router = new ScenarioRouter({
      symbol: 'SOLUSDT',
      patternRecognizer: mockPatternRecognizer,
      notifier: mockNotifier,
      activeScenarios: [1,2,3,4,5,6,7,8,9,10,11],
    });
    jest.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.ACTIVE_SCENARIOS;
  });

  describe('scenario registration', () => {
    it('should have all 11 scenarios registered in order (priority order: complex first)', () => {
      const scenarios = (router as any).scenarios;
      expect(scenarios.length).toBe(11);
      expect(scenarios.map((s: IScenario) => s.id)).toEqual([5, 7, 9, 10, 11, 1, 3, 6, 8, 2, 4]);
      expect(scenarios.map((s: IScenario) => s.name)).toEqual([
        'HTF Liquidity Sweep',
        'AMD (Accumulation-Manipulation-Distribution)',
        'Turtle Soup (Range SFP)',
        'Breaker Block Entry',
        'Mitigation Block',
        'HTF Continuation',
        'Inducement (IDM)',
        'Failure Swing (SMS)',
        'Range Deviation & Reclaim',
        'FVG Fill',
        'Mitigation Chain',
      ]);
    });
  });

  describe('evaluation order and priority', () => {
    it('should evaluate scenarios in registration order', async () => {
      
      const mockScenarios = [
        { id: 1, name: 'Test1', evaluate: jest.fn().mockReturnValue(false), getLevels: () => ({ entry: '100', stopLoss: '99', takeProfit: '103' }), getReason: () => 'Test1 reason', getZoneDetails: () => null, getStructureDetails: () => null },
        { id: 2, name: 'Test2', evaluate: jest.fn().mockReturnValue(true), getLevels: () => ({ entry: '100', stopLoss: '99', takeProfit: '103' }), getReason: () => 'Test2 reason', getZoneDetails: () => null, getStructureDetails: () => null },
        { id: 3, name: 'Test3', evaluate: jest.fn().mockReturnValue(true), getLevels: () => ({ entry: '100', stopLoss: '99', takeProfit: '103' }), getReason: () => 'Test3 reason', getZoneDetails: () => null, getStructureDetails: () => null },
      ] as unknown as IScenario[];

      const testRouter = new ScenarioRouter({
        symbol: 'SOLUSDT',
        patternRecognizer: {
          buildPatternData: jest.fn().mockResolvedValue({
            structures: [
              { type: 'CHoCH', direction: 'BULLISH', timestamp: Date.now(), price: '100', isValidated: true, impulseFactor: 2 },
              { type: 'SMS', direction: 'BEARISH', timestamp: Date.now() - 3600000, price: '105' },
            ],
            zones: [],
            liquidityPools: [{ type: 'PDH', priceLevel: '105' }, { type: 'PDL', priceLevel: '95' }],
            currentKillzone: 'NY',
          }),
        },
        notifier: mockNotifier,
        activeScenarios: [1,2,3,4,5,6,7,8,9,10,11],
      });

      (testRouter as any).scenarios = mockScenarios;

      const result = await testRouter.evaluate([], [], Date.now());

      expect(result.triggered).toBe(true);
      expect(result.scenario?.id).toBe(2);
      expect(mockScenarios[0].evaluate).toHaveBeenCalledTimes(1);
      expect(mockScenarios[1].evaluate).toHaveBeenCalledTimes(1);
      expect(mockScenarios[2].evaluate).not.toHaveBeenCalled();
    });

    it('should return first matching scenario when multiple match', async () => {
      const mockScenarios = [
        { id: 5, name: 'Scenario5', evaluate: jest.fn().mockReturnValue(true), getLevels: () => ({ entry: '100', stopLoss: '99', takeProfit: '103' }), getReason: () => 'Scenario5 reason', getZoneDetails: () => null, getStructureDetails: () => null },
        { id: 1, name: 'Scenario1', evaluate: jest.fn().mockReturnValue(true), getLevels: () => ({ entry: '100', stopLoss: '99', takeProfit: '103' }), getReason: () => 'Scenario1 reason', getZoneDetails: () => null, getStructureDetails: () => null },
      ] as unknown as IScenario[];

      const testRouter = new ScenarioRouter({
        symbol: 'SOLUSDT',
        patternRecognizer: {
          buildPatternData: jest.fn().mockResolvedValue({
            structures: [
              { type: 'CHoCH', direction: 'BULLISH', timestamp: Date.now(), price: '100', isValidated: true, impulseFactor: 2 },
              { type: 'SMS', direction: 'BEARISH', timestamp: Date.now() - 3600000, price: '105' },
            ],
            zones: [],
            liquidityPools: [{ type: 'PDH', priceLevel: '105' }, { type: 'PDL', priceLevel: '95' }],
            currentKillzone: 'NY',
          }),
        },
        notifier: mockNotifier,
        activeScenarios: [1,2,3,4,5,6,7,8,9,10,11],
      });

      (testRouter as any).scenarios = mockScenarios;

      const result = await testRouter.evaluate([], [], Date.now());

      expect(result.triggered).toBe(true);
      expect(result.scenario?.id).toBe(5);
    });
  });

  describe('no match scenarios', () => {
    it('should return null scenario when no scenario matches', async () => {
      const mockScenarios = [
        { id: 1, name: 'Test1', evaluate: jest.fn().mockReturnValue(false) },
        { id: 2, name: 'Test2', evaluate: jest.fn().mockReturnValue(false) },
      ] as unknown as IScenario[];

      const testRouter = new ScenarioRouter({
        symbol: 'SOLUSDT',
        patternRecognizer: { buildPatternData: jest.fn().mockResolvedValue({}) },
        notifier: mockNotifier,
        activeScenarios: [1,2,3,4,5,6,7,8,9,10,11],
      });

      (testRouter as any).scenarios = mockScenarios;

      const result = await testRouter.evaluate([], [], Date.now());

      expect(result.triggered).toBe(false);
      expect(result.scenario).toBeNull();
      expect(result.reason).toBe('No scenario matched');
    });

    it('should return error when pattern recognition fails', async () => {
      const testRouter = new ScenarioRouter({
        symbol: 'SOLUSDT',
        patternRecognizer: {
          buildPatternData: jest.fn().mockRejectedValue(new Error('API Error')),
        },
        notifier: mockNotifier,
        activeScenarios: [1,2,3,4,5,6,7,8,9,10,11],
      });

      const result = await testRouter.evaluate([], [], Date.now());

      expect(result.triggered).toBe(false);
      expect(result.reason).toBe('Pattern recognition error');
    });
  });

  describe('pattern recognizer integration', () => {
    it('should call buildPatternData with correct parameters', async () => {
      const candles15m = [{ timestamp: 1, open: '100', high: '101', low: '99', close: '100', volume: '100' }];
      const candles4h = [{ timestamp: 1, open: '100', high: '101', low: '99', close: '100', volume: '100' }];

      await router.evaluate(candles15m, candles4h, Date.now());

      expect(mockPatternRecognizer.buildPatternData).toHaveBeenCalledWith('SOLUSDT', candles15m, candles4h, expect.any(Number));
    });
  });
});