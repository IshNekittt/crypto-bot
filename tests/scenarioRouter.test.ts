import { ScenarioRouter } from '../src/engine/scenarioRouter';
import { IScenario } from '../src/types';

const mockNotifier = {
  enabled: true,
  sendMessage: jest.fn().mockResolvedValue(true),
};

const mockPatternRecognizer = {
  buildPatternData: jest.fn().mockResolvedValue({
    currentKillzone: 'LONDON',
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
    router = new ScenarioRouter({
      symbol: 'SOLUSDT',
      patternRecognizer: mockPatternRecognizer,
      notifier: mockNotifier,
    });
    jest.clearAllMocks();
  });

  describe('scenario registration', () => {
    it('should have all 11 scenarios registered in order', () => {
      const scenarios = (router as any).scenarios;
      expect(scenarios.length).toBe(11);
      expect(scenarios.map((s: IScenario) => s.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
      expect(scenarios.map((s: IScenario) => s.name)).toEqual([
        'HTF Continuation',
        'FVG Fill',
        'Inducement (IDM)',
        'Mitigation Chain',
        'HTF Liquidity Sweep',
        'Failure Swing (SMS)',
        'AMD (Accumulation-Manipulation-Distribution)',
        'Range Deviation & Reclaim',
        'Turtle Soup (Range SFP)',
        'Breaker Block Entry',
        'Mitigation Block',
      ]);
    });
  });

  describe('evaluation order and priority', () => {
    it('should evaluate scenarios in registration order', async () => {
      
      const mockScenarios = [
        { id: 1, name: 'Test1', evaluate: jest.fn().mockReturnValue(false) },
        { id: 2, name: 'Test2', evaluate: jest.fn().mockReturnValue(true), getLevels: () => ({ entry: '100', stopLoss: '99', takeProfit: '103' }), getReason: () => 'Test2 reason' },
        { id: 3, name: 'Test3', evaluate: jest.fn().mockReturnValue(true), getLevels: () => ({ entry: '100', stopLoss: '99', takeProfit: '103' }), getReason: () => 'Test3 reason' },
      ] as unknown as IScenario[];

      const testRouter = new ScenarioRouter({
        symbol: 'SOLUSDT',
        patternRecognizer: {
          buildPatternData: jest.fn().mockResolvedValue({}),
        },
        notifier: mockNotifier,
      });

      (testRouter as any).scenarios = mockScenarios;

      const result = await testRouter.evaluate([], []);

      expect(result.triggered).toBe(true);
      expect(result.scenario?.id).toBe(2);
      expect(mockScenarios[0].evaluate).toHaveBeenCalledTimes(1);
      expect(mockScenarios[1].evaluate).toHaveBeenCalledTimes(1);
      expect(mockScenarios[2].evaluate).not.toHaveBeenCalled();
    });

    it('should return first matching scenario when multiple match', async () => {
      const mockScenarios = [
        { id: 5, name: 'Scenario5', evaluate: jest.fn().mockReturnValue(true), getLevels: () => ({ entry: '100', stopLoss: '99', takeProfit: '103' }), getReason: () => 'Scenario5 reason' },
        { id: 1, name: 'Scenario1', evaluate: jest.fn().mockReturnValue(true), getLevels: () => ({ entry: '100', stopLoss: '99', takeProfit: '103' }), getReason: () => 'Scenario1 reason' },
      ] as unknown as IScenario[];

      const testRouter = new ScenarioRouter({
        symbol: 'SOLUSDT',
        patternRecognizer: { buildPatternData: jest.fn().mockResolvedValue({}) },
        notifier: mockNotifier,
      });

      (testRouter as any).scenarios = mockScenarios;

      const result = await testRouter.evaluate([], []);

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
      });

      (testRouter as any).scenarios = mockScenarios;

      const result = await testRouter.evaluate([], []);

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
      });

      const result = await testRouter.evaluate([], []);

      expect(result.triggered).toBe(false);
      expect(result.reason).toBe('Pattern recognition error');
    });
  });

  describe('pattern recognizer integration', () => {
    it('should call buildPatternData with correct parameters', async () => {
      const candles15m = [{ timestamp: 1, open: '100', high: '101', low: '99', close: '100', volume: '100' }];
      const candles4h = [{ timestamp: 1, open: '100', high: '101', low: '99', close: '100', volume: '100' }];

      await router.evaluate(candles15m, candles4h);

      expect(mockPatternRecognizer.buildPatternData).toHaveBeenCalledWith('SOLUSDT', candles15m, candles4h);
    });
  });
});