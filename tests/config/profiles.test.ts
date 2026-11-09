import { readFileSync } from 'fs';
import { join } from 'path';

import { parse as parseDotenv } from 'dotenv';

import {
  loadConfig,
  resolveLimitExpirationCandles,
  resolveSymbolConfig,
  type BotConfig,
} from '../../src/config/env';

/**
 * Preset drift guard.
 *
 * The two deployment profiles are frozen strategy contracts, not scratch
 * configuration: `.env.subaru.example` (V4 Classic Tank) and
 * `.env.emilia.example` (V5 Sniper). Both are hand-maintained text files, so
 * nothing in the compiler prevents a silent edit from changing the shipped
 * calibration or leaking a Scenario 12 knob into a Classic deployment.
 *
 * These tests parse the real files through the real `loadConfig()`, with dummy
 * secrets injected in memory only — the profiles themselves stay secret-free.
 */

const REPO_ROOT = join(__dirname, '..', '..');

const SECRET_KEYS = [
  'BYBIT_API_KEY',
  'BYBIT_API_SECRET',
  'DATABASE_URL',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_CHAT_ID',
  'BACKUP_PASSWORD',
] as const;

const SUBARU = '.env.subaru.example';
const EMILIA = '.env.emilia.example';

function readProfile(file: string): Record<string, string> {
  return parseDotenv(readFileSync(join(REPO_ROOT, file), 'utf8'));
}

function bootProfile(file: string): { raw: Record<string, string>; config: BotConfig } {
  const raw = readProfile(file);
  const withSecrets: NodeJS.ProcessEnv = { ...raw };
  for (const key of SECRET_KEYS) {
    if (!withSecrets[key]) withSecrets[key] = `test-${key.toLowerCase()}`;
  }
  return { raw, config: loadConfig(withSecrets) };
}

/**
 * Keys whose only consumer is Scenario 12. A Classic deployment that lists one
 * of these reads as protected while evaluating nothing (AGENTS.md §1.3 profile
 * invariant 2, §7.13.5).
 */
const S12_ONLY_KEY_PATTERNS: RegExp[] = [
  /^MIN_NET_RR/,
  /^MIN_VOLATILITY_FEE_RATIO/,
  /^MIN_TP_DISTANCE_PCT/,
  /^S12_/,
  /^SNIPER_LIMIT_EXPIRATION_CANDLES/,
  /^SMC_SWEEP_MIN_WICK_RATIO/,
];

describe('Preset .env.subaru.example — V4 Classic (S14 + S15, BTCUSDT)', () => {
  let config: BotConfig;

  beforeAll(() => {
    config = bootProfile(SUBARU).config;
  });

  it('parses without errors and stays a Classic deployment', () => {
    expect(config.enableSniperMode).toBe(false);
    expect(config.ltfTimeframe).toBe('15');
    expect(config.htfTimeframe).toBe('240');
  });

  it('trades BTCUSDT only', () => {
    expect(config.symbols).toEqual(['BTCUSDT']);
  });

  it('runs the validated S14 + S15 pair with no per-symbol narrowing', () => {
    expect(config.activeScenarios).toEqual([14, 15]);
    // One symbol, one global list — a per-symbol override would NARROW the
    // symbol rather than extend the global list (AGENTS.md §1.3 invariant 1).
    expect(config.symbolScenarios.size).toBe(0);
  });

  it('keeps the verified SMC geometry', () => {
    expect(config.smcSlAtrOffset).toBe('0.5');
    // SMC_SWEEP_VOLUME_MULTIPLIER is S5-only and S5 is not active, so the file
    // omits it and the code default applies.
    expect(config.sweepVolumeMultiplier.toString()).toBe('1.3');
    expect(config.smcDisplacementMultiplier).toBe('1.5');
  });

  it('resolves structural targets between 1.5R and 6R', () => {
    expect(config.enableDynamicTp).toBe(true);
    expect(config.dynamicTpMinRr.toString()).toBe('1.5');
    expect(config.dynamicTpMaxRr.toString()).toBe('6');
  });

  it('uses Classic candle counts for cooldown and limit lifetime', () => {
    expect(config.cooldownCandles).toBe(16);
    expect(config.limitExpirationCandles).toBe(6);
    // The Sniper knob is absent, so it keeps the Classic-independent code
    // default — it is inert while enableSniperMode is false.
    expect(config.sniperLimitExpirationCandles).toBe(15);
    // Classic resolves the LTF knob: 6 x 15m = 90 min (AGENTS.md §7.20.2).
    expect(resolveLimitExpirationCandles(config)).toBe(6);
  });

  it('arms the 4H ADX regime gate measured on this profile', () => {
    expect(config.enableRegimeFilter).toBe(true);
    expect(config.regimeAdxThreshold?.toString()).toBe('25');
  });

  it('keeps killzones enforced across all seven weekdays', () => {
    expect(config.enforceKillzones).toBe(true);
    expect(config.allowedDaysOfWeek).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('carries the operational scaffolding', () => {
    expect(config.autoTrading).toBe(true);
    expect(config.riskPercent).toBe('2');
    expect(config.reducedRiskPercent).toBe('1');
    expect(config.leverage).toBe('10');
    expect(config.maxWorkingCapital).toBe(3000);
    expect(config.enableHealthcheckServer).toBe(true);
    expect(config.backtestDays).toBe(365);
  });

  it('carries no Scenario-12-only key', () => {
    const { raw } = bootProfile(SUBARU);
    const offenders = Object.keys(raw).filter((key) =>
      S12_ONLY_KEY_PATTERNS.some((pattern) => pattern.test(key)),
    );

    expect(offenders).toEqual([]);

    // Absence must mean "code default", never zero / undefined.
    expect(config.minNetRr.toString()).toBe('1');
    expect(config.minVolatilityFeeRatio.toString()).toBe('1');
    expect(config.minTpDistancePct.toString()).toBe('0.0035');
    expect(config.smcSweepMinWickRatio.toString()).toBe('0.25');
  });
});

describe('Preset .env.emilia.example — V5 Sniper (S12, NEARUSDT)', () => {
  let config: BotConfig;

  beforeAll(() => {
    config = bootProfile(EMILIA).config;
  });

  it('parses without errors and stays a Sniper deployment', () => {
    expect(config.enableSniperMode).toBe(true);
    expect(config.activeScenarios).toEqual([12]);
    // S12 is the only 1m producer, so no symbol narrows away from it.
    expect(config.symbolScenarios.size).toBe(0);
  });

  it('trades NEARUSDT only', () => {
    expect(config.symbols).toEqual(['NEARUSDT']);
  });

  it('arms both opt-in sweep sources', () => {
    expect(config.s12SessionSweeps).toBe(true);
    expect(config.s12EqhEqlSweeps).toBe(true);
  });

  it('keeps the verified 1C entry physics', () => {
    expect(config.smcSweepMinWickRatio.toString()).toBe('0.25');
    expect(config.minTpDistancePct.toString()).toBe('0.0035');
    expect(config.sniperLimitExpirationCandles).toBe(15);
    // 15 x 1m = 15 min, not the Classic 90 min.
    expect(resolveLimitExpirationCandles(config)).toBe(15);
  });

  it('keeps the global P0 shields at 1.5', () => {
    expect(config.minNetRr.toString()).toBe('1.5');
    expect(config.minVolatilityFeeRatio.toString()).toBe('1.5');
  });

  it('relaxes both shields for NEARUSDT only', () => {
    const near = resolveSymbolConfig(config, 'NEARUSDT');
    expect(near.minVolatilityFeeRatio.toString()).toBe('1');
    expect(near.minNetRr.toString()).toBe('1');
    // Everything else stays at the global value.
    expect(near.minTpDistancePct.toString()).toBe('0.0035');
    expect(near.smcSweepMinWickRatio.toString()).toBe('0.25');
  });

  it('keeps the APTUSDT calibration out of the active roster', () => {
    // APTUSDT is not in SYMBOLS, so its grid-search cell survives only as a
    // commented future-pair note — no override can leak into an unconfigured
    // pair (resolveSymbolConfig returns the same object identity).
    expect(config.symbols).not.toContain('APTUSDT');
    expect(resolveSymbolConfig(config, 'APTUSDT')).toBe(config);

    const { raw } = bootProfile(EMILIA);
    expect(raw.SMC_SL_ATR_OFFSET_APTUSDT).toBeUndefined();
    expect(raw.SNIPER_LIMIT_EXPIRATION_CANDLES_APTUSDT).toBeUndefined();
  });

  it('resolves structural targets between 1.5R and 6R', () => {
    expect(config.enableDynamicTp).toBe(true);
    expect(config.dynamicTpMinRr.toString()).toBe('1.5');
    expect(config.dynamicTpMaxRr.toString()).toBe('6');
  });

  it('keeps the regime gate off — S12 is the only producer', () => {
    expect(config.enableRegimeFilter).toBe(false);
    expect(config.regimeAdxThreshold?.toString()).toBe('25');
  });

  it('keeps killzones enforced across all seven weekdays', () => {
    expect(config.enforceKillzones).toBe(true);
    expect(config.allowedDaysOfWeek).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('carries the operational scaffolding', () => {
    expect(config.autoTrading).toBe(true);
    expect(config.riskPercent).toBe('2');
    expect(config.leverage).toBe('10');
    expect(config.maxWorkingCapital).toBe(3000);
    expect(config.enableHealthcheckServer).toBe(true);
    expect(config.backtestDays).toBe(60);
  });

  it('carries no Classic-only S5 knob', () => {
    const { raw } = bootProfile(EMILIA);
    // SMC_SWEEP_VOLUME_MULTIPLIER is read exclusively by Scenario 5.
    expect(
      Object.keys(raw).filter((key) => key.startsWith('SMC_SWEEP_VOLUME_MULTIPLIER')),
    ).toEqual([]);
    expect(config.sweepVolumeMultiplier.toString()).toBe('1.3');
  });
});

describe('Deployment presets — cross-profile invariants', () => {
  it.each([SUBARU, EMILIA])('%s ships without secrets', (file) => {
    const raw = readProfile(file);
    for (const key of SECRET_KEYS) {
      expect(raw[key]).toBeUndefined();
    }
  });

  it.each([SUBARU, EMILIA])('%s lists only registered scenario ids', (file) => {
    const { config } = bootProfile(file);
    const ids = new Set(config.activeScenarios);
    for (const list of config.symbolScenarios.values()) {
      for (const id of list) ids.add(id);
    }
    // The registry is the single source of truth; archived ids abort the boot,
    // so a successful parse already proves this — assert it explicitly anyway.
    for (const id of ids) {
      expect([1, 5, 12, 14, 15]).toContain(id);
    }
  });

  it('never mixes Classic and Sniper scenario families in one process', () => {
    const subaru = bootProfile(SUBARU).config;
    const emilia = bootProfile(EMILIA).config;

    expect(subaru.enableSniperMode).toBe(false);
    expect(emilia.enableSniperMode).toBe(true);

    const emiliaIds = new Set([
      ...emilia.activeScenarios,
      ...[...emilia.symbolScenarios.values()].flat(),
    ]);
    expect(emiliaIds.has(12)).toBe(true);
    expect(emiliaIds.has(5)).toBe(false);

    const subaruIds = new Set([
      ...subaru.activeScenarios,
      ...[...subaru.symbolScenarios.values()].flat(),
    ]);
    expect(subaruIds.has(12)).toBe(false);
  });
});
