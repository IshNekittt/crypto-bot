import {
  loadConfig,
  resolveLimitExpirationCandles,
  resolveLimitExpirationMs,
} from '../../src/config/env';

const BASE_ENV: NodeJS.ProcessEnv = {
  BYBIT_API_KEY: 'test',
  BYBIT_API_SECRET: 'test',
  SYMBOLS: 'BTCUSDT',
  RISK_PERCENT: '2',
};

function env(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...BASE_ENV, ...overrides };
}

describe('loadConfig — Dynamic Take-Profit', () => {
  it('defaults to the legacy fixed-R behaviour', () => {
    const config = loadConfig(env());

    expect(config.enableDynamicTp).toBe(false);
    expect(config.fixedTpRr.toString()).toBe('3');
    expect(config.dynamicTpMinRr.toString()).toBe('1.5');
    expect(config.dynamicTpMaxRr.toString()).toBe('6');
    expect(config.dynamicTpRequireTarget).toBe(false);
  });

  it('parses explicit overrides as Decimal', () => {
    const config = loadConfig(
      env({
        ENABLE_DYNAMIC_TP: 'true',
        FIXED_TP_RR: '2.5',
        DYNAMIC_TP_MIN_RR: '2',
        DYNAMIC_TP_MAX_RR: '8',
        DYNAMIC_TP_REQUIRE_TARGET: 'true',
      }),
    );

    expect(config.enableDynamicTp).toBe(true);
    expect(config.fixedTpRr.toString()).toBe('2.5');
    expect(config.dynamicTpMinRr.toString()).toBe('2');
    expect(config.dynamicTpMaxRr.toString()).toBe('8');
    expect(config.dynamicTpRequireTarget).toBe(true);

    // Decimal, not number — downstream wallet math must stay exact.
    expect(typeof config.fixedTpRr).not.toBe('number');
    expect(config.fixedTpRr.plus('0.1').toString()).toBe('2.6');
  });

  it('treats any non-"true" value as false', () => {
    expect(
      loadConfig(env({ ENABLE_DYNAMIC_TP: 'yes' })).enableDynamicTp,
    ).toBe(false);
    expect(
      loadConfig(env({ ENABLE_DYNAMIC_TP: 'TRUE' })).enableDynamicTp,
    ).toBe(true);
  });

  it('rejects a non-positive FIXED_TP_RR', () => {
    expect(() => loadConfig(env({ FIXED_TP_RR: '0' }))).toThrow(
      /FIXED_TP_RR must be a strictly positive number/,
    );
    expect(() => loadConfig(env({ FIXED_TP_RR: '-1' }))).toThrow(
      /FIXED_TP_RR must be a strictly positive number/,
    );
  });

  it('rejects a non-numeric ratio', () => {
    expect(() => loadConfig(env({ DYNAMIC_TP_MIN_RR: 'abc' }))).toThrow(
      /DYNAMIC_TP_MIN_RR must be a valid number/,
    );
  });

  it('rejects a non-positive DYNAMIC_TP_MIN_RR', () => {
    expect(() => loadConfig(env({ DYNAMIC_TP_MIN_RR: '0' }))).toThrow(
      /DYNAMIC_TP_MIN_RR must be a strictly positive number/,
    );
  });

  it('rejects maxRr below minRr', () => {
    expect(() =>
      loadConfig(env({ DYNAMIC_TP_MIN_RR: '2', DYNAMIC_TP_MAX_RR: '1' })),
    ).toThrow(/DYNAMIC_TP_MAX_RR .* must be >= DYNAMIC_TP_MIN_RR/);
  });

  it('accepts maxRr equal to minRr', () => {
    const config = loadConfig(
      env({ DYNAMIC_TP_MIN_RR: '2', DYNAMIC_TP_MAX_RR: '2' }),
    );
    expect(config.dynamicTpMaxRr.toString()).toBe('2');
  });
});

describe('loadConfig — Scenario 12 knobs', () => {
  it('defaults the sweep wick ratio to 0.25 as a Decimal', () => {
    const config = loadConfig(env());

    expect(config.smcSweepMinWickRatio.toString()).toBe('0.25');
    // Decimal, not number — the SMC gate must stay exact (Invariant 1).
    expect(typeof config.smcSweepMinWickRatio).not.toBe('number');
  });

  it('parses an explicit SMC_SWEEP_MIN_WICK_RATIO', () => {
    expect(
      loadConfig(env({ SMC_SWEEP_MIN_WICK_RATIO: '0.2' })).smcSweepMinWickRatio.toString(),
    ).toBe('0.2');
  });

  it.each(['0', '1', '1.5', '25', '-0.2'])(
    'rejects an out-of-range SMC_SWEEP_MIN_WICK_RATIO (%s)',
    (value) => {
      expect(() => loadConfig(env({ SMC_SWEEP_MIN_WICK_RATIO: value }))).toThrow(
        /SMC_SWEEP_MIN_WICK_RATIO must be a ratio strictly between 0 and 1/,
      );
    },
  );

  it('rejects a non-numeric SMC_SWEEP_MIN_WICK_RATIO', () => {
    expect(() => loadConfig(env({ SMC_SWEEP_MIN_WICK_RATIO: 'abc' }))).toThrow(
      /SMC_SWEEP_MIN_WICK_RATIO must be a valid number/,
    );
  });

  it('defaults the sniper limit lifetime to 15 one-minute candles', () => {
    const config = loadConfig(env({ ENABLE_SNIPER_MODE: 'true' }));
    expect(config.sniperLimitExpirationCandles).toBe(15);
    expect(resolveLimitExpirationCandles(config)).toBe(15);
    expect(resolveLimitExpirationMs(config)).toBe(15 * 60 * 1000);
  });

  it('keeps the Classic lifetime measured in LTF candles', () => {
    const config = loadConfig(
      env({
        ENABLE_SNIPER_MODE: 'false',
        LTF_TIMEFRAME: '15',
        LIMIT_EXPIRATION_CANDLES: '6',
      }),
    );
    expect(resolveLimitExpirationCandles(config)).toBe(6);
    expect(resolveLimitExpirationMs(config)).toBe(90 * 60 * 1000);
  });

  it('does not let the Classic knob shorten Sniper limits', () => {
    // The original defect: 6 LTF candles silently became 6 minutes on 1m.
    const config = loadConfig(
      env({ ENABLE_SNIPER_MODE: 'true', LIMIT_EXPIRATION_CANDLES: '6' }),
    );
    expect(resolveLimitExpirationCandles(config)).toBe(15);
    expect(resolveLimitExpirationMs(config)).toBe(15 * 60 * 1000);
  });

  it('rejects a non-integer sniper lifetime', () => {
    expect(() =>
      loadConfig(env({ SNIPER_LIMIT_EXPIRATION_CANDLES: '1.5' })),
    ).toThrow(/SNIPER_LIMIT_EXPIRATION_CANDLES must be an integer/);
  });
});

describe('loadConfig — scenario registration bounds (S13 archived)', () => {
  it('accepts Scenario 12 in ACTIVE_SCENARIOS', () => {
    const config = loadConfig(env({ ACTIVE_SCENARIOS: '12' }));
    expect(config.activeScenarios).toEqual([12]);
  });

  it('accepts Scenario 12 in a per-symbol override', () => {
    const config = loadConfig(env({ SCENARIOS_BTCUSDT: '12' }));
    expect(config.symbolScenarios.get('BTCUSDT')).toEqual([12]);
  });

  it('rejects Scenario 13 now that it is archived', () => {
    expect(() => loadConfig(env({ ACTIVE_SCENARIOS: '13' }))).toThrow(
      /ACTIVE_SCENARIOS must contain valid scenario IDs \(1-12\)/,
    );
  });

  it('rejects scenario IDs above 12', () => {
    expect(() => loadConfig(env({ ACTIVE_SCENARIOS: '14' }))).toThrow(
      /ACTIVE_SCENARIOS must contain valid scenario IDs \(1-12\)/,
    );
  });

  it('drops Scenario 13 from a per-symbol override', () => {
    const config = loadConfig(env({ SCENARIOS_BTCUSDT: '12,13' }));
    expect(config.symbolScenarios.get('BTCUSDT')).toEqual([12]);
  });
});

describe('loadConfig — S12 sweep sources', () => {
  it('defaults both opt-in sweep sources to false', () => {
    const config = loadConfig(env({}));
    expect(config.s12SessionSweeps).toBe(false);
    expect(config.s12EqhEqlSweeps).toBe(false);
  });

  it('parses S12_SESSION_SWEEPS and S12_EQH_EQL_SWEEPS independently', () => {
    const config = loadConfig(
      env({ S12_SESSION_SWEEPS: 'true', S12_EQH_EQL_SWEEPS: 'true' }),
    );
    expect(config.s12SessionSweeps).toBe(true);
    expect(config.s12EqhEqlSweeps).toBe(true);
  });
});

describe('loadConfig — S12 fee-aware target floor', () => {
  it('defaults MIN_TP_DISTANCE_PCT to 0.35% as a Decimal', () => {
    const config = loadConfig(env());

    expect(config.minTpDistancePct.toString()).toBe('0.0035');
    // Decimal, not number — the fee gate must stay exact (Invariant 1).
    expect(typeof config.minTpDistancePct).not.toBe('number');
  });

  it('parses an explicit MIN_TP_DISTANCE_PCT', () => {
    expect(
      loadConfig(env({ MIN_TP_DISTANCE_PCT: '0.005' })).minTpDistancePct.toString(),
    ).toBe('0.005');
  });

  it.each(['0', '-0.001'])(
    'rejects a non-positive MIN_TP_DISTANCE_PCT (%s)',
    (value) => {
      expect(() => loadConfig(env({ MIN_TP_DISTANCE_PCT: value }))).toThrow(
        /MIN_TP_DISTANCE_PCT must be a strictly positive number/,
      );
    },
  );

  it('rejects a MIN_TP_DISTANCE_PCT at or above 10%', () => {
    expect(() => loadConfig(env({ MIN_TP_DISTANCE_PCT: '0.1' }))).toThrow(
      /MIN_TP_DISTANCE_PCT must be < 0.1/,
    );
    // A literal 10 is almost certainly a percentage written without /100.
    expect(() => loadConfig(env({ MIN_TP_DISTANCE_PCT: '10' }))).toThrow(
      /MIN_TP_DISTANCE_PCT must be < 0.1/,
    );
  });

  it('rejects a non-numeric MIN_TP_DISTANCE_PCT', () => {
    expect(() => loadConfig(env({ MIN_TP_DISTANCE_PCT: 'abc' }))).toThrow(
      /MIN_TP_DISTANCE_PCT must be a valid number/,
    );
  });
});
