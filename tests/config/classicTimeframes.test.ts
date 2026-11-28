import type { BybitClient } from '../../src/api/bybitClient';
import { loadConfig, resolveLimitExpirationMs } from '../../src/config/env';
import { ScenarioRouter } from '../../src/engine/scenarioRouter';
import { Scenario1_HTFContinuation } from '../../src/engine/scenarios/Scenario1_HTFContinuation';
import { Scenario5_HTFLiquiditySweep } from '../../src/engine/scenarios/Scenario5_HTFLiquiditySweep';
import { Scenario14_QuantAlpha } from '../../src/engine/scenarios/Scenario14_QuantAlpha';
import { Scenario15_VolatilitySqueeze } from '../../src/engine/scenarios/Scenario15_VolatilitySqueeze';
import { PatternRecognizer, createPatternConfigFromBotConfig } from '../../src/smc/patternRecognizer';
import type { Candle } from '../../src/types';
import { candleCloseTime, timeframeToMinutes } from '../../src/utils/timeframe';

const END = Date.UTC(2026, 10, 23);

function history(intervalMs: number): Candle[] {
  const bars = Array.from({ length: 32 }, (_, i) => ({
    timestamp: END - (32 - i) * intervalMs,
    open: '100', close: '100', high: '101', low: '99', volume: '10',
  }));
  bars[6].high = '104';
  bars[11].open = '101';
  bars[12] = { ...bars[12], high: '109', close: '108' };
  bars[13] = { ...bars[13], open: '108', close: '108', high: '109', low: '107' };
  return bars;
}

it.each([
  ['15', '240', 15, 240],
  ['60', '240', 60, 240],
  ['240', 'D', 240, 1440],
])('routes Classic scenarios with LTF=%s and HTF=%s', async (ltf, htf, ltfMinutes, htfMinutes) => {
  const config = loadConfig({
    BYBIT_API_KEY: 'test', BYBIT_API_SECRET: 'test', SYMBOLS: 'BTCUSDT', RISK_PERCENT: '2',
    ACTIVE_SCENARIOS: '1,5,14,15', ENABLE_SNIPER_MODE: 'false', ENFORCE_KILLZONES: 'false',
    ALLOWED_DAYS_OF_WEEK: '1,2,3,4,5,6,7', LTF_TIMEFRAME: ltf, HTF_TIMEFRAME: htf,
  });
  const ltfMs = timeframeToMinutes(config.ltfTimeframe) * 60_000;
  const htfMs = timeframeToMinutes(config.htfTimeframe) * 60_000;
  expect(htfMs).toBe(htfMinutes * 60_000);
  expect(candleCloseTime(END, config.htfTimeframe) - END).toBe(htfMs);
  expect(config.cooldownCandles * ltfMs).toBe(config.cooldownCandles * ltfMinutes * 60_000);
  expect(resolveLimitExpirationMs(config)).toBe(config.limitExpirationCandles * ltfMinutes * 60_000);

  const scenarios = [Scenario1_HTFContinuation, Scenario5_HTFLiquiditySweep,
    Scenario14_QuantAlpha, Scenario15_VolatilitySqueeze];
  for (const scenario of scenarios) scenario.resetStats();
  const recognizer = new PatternRecognizer({} as BybitClient, createPatternConfigFromBotConfig(config));
  const build = jest.spyOn(recognizer, 'buildPatternData');
  const router = new ScenarioRouter({
    symbol: 'BTCUSDT', config, activeScenarios: config.activeScenarios,
    patternRecognizer: recognizer, notifier: {},
  });
  await router.evaluate(history(ltfMs), history(htfMs), END - ltfMs);
  expect(build).toHaveBeenCalledTimes(1);
  const data = await build.mock.results[0].value;
  expect(data.candles15m).toHaveLength(32);
  expect(data.candles4h).toHaveLength(32);
  expect(data.atr15m.gt(0) && data.atr4h.gt(0)).toBe(true);
  expect(new Set(data.structures.map(s => s.timeframe))).toEqual(new Set([ltf, htf]));
  expect(new Set(data.zones.map(z => z.timeframe))).toEqual(new Set([ltf, htf]));
  for (const scenario of scenarios) {
    expect(scenario.getRejectionStats()).toMatchObject({ totalEvals: 1, wrongMode: 0 });
  }
});

it.each([['60', 60], ['240', 240]] as const)('limits %s-minute session history to the latest two days', (ltfTimeframe, minutes) => {
  const recognizer = new PatternRecognizer({} as BybitClient, { ltfTimeframe });
  const barsPerDay = 1440 / minutes;
  const bars = Array.from({ length: 4 * barsPerDay }, (_, i) => ({
    timestamp: END - (4 * barsPerDay - i) * minutes * 60_000,
    open: '100', close: '100', high: i >= 2 * barsPerDay ? '101' : '200', low: '99', volume: '1',
  }));
  const ranges = recognizer.detectSessionRanges(bars);
  expect(ranges).toHaveLength(2);
  expect(ranges.every(range => range.start >= END - 2 * 86_400_000 && range.high.eq(101))).toBe(true);
});
