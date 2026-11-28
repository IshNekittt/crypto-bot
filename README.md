# Quant Trading Engine

[![CI Pipeline](https://github.com/IshNekittt/crypto-bot/actions/workflows/ci.yml/badge.svg)](https://github.com/IshNekittt/crypto-bot/actions/workflows/ci.yml)
[![Tests](https://img.shields.io/badge/Tests-1068%20passing-brightgreen?logo=jest)](https://ishnekittt.github.io/crypto-bot/)
[![Coverage Report](https://img.shields.io/badge/Coverage-Report-blue?logo=jest)](https://ishnekittt.github.io/crypto-bot/coverage/)
![Version](https://img.shields.io/badge/Version-v2026--11--28-blue)
![Node.js 26](https://img.shields.io/badge/Node.js-26.x-339933?logo=node.js&logoColor=white)
![TypeScript 5.9](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)

An event-driven TypeScript trading engine for **Bybit V5 linear perpetuals**, with a historical simulator that runs the same strategy router on Bybit candles or offline OHLCV CSVs. Live execution uses PostgreSQL for trade state, Telegram for operator approvals and alerts, and `decimal.js` for execution and PnL arithmetic.

[**`AGENTS.md`**](AGENTS.md) is the normative specification: **65 numbered invariants**, failure-mode analysis, and the full validation record.

## Architecture Baseline

| Layer | Design |
| --- | --- |
| **Market data and decisions** | Confirmed candles drive entries. The router evaluates scenarios against closed history, a causal macro snapshot, and the set of consumed triggers. |
| **Execution and recovery** | Manual and automatic entries validate live price, SL/TP geometry, and directional Market-order slippage before submission. A post-fill persistence failure triggers cancellation/flattening and exchange verification before the engine may resume scanning. |
| **Positions and risk** | One position lifecycle per symbol; tick-driven partial closes and stop management; Decimal sizing, instrument precision, and a working-capital cap. REST reconciliation backs up the position and execution WebSocket streams. |
| **Simulation and reporting** | Shared setup and order-selection logic; explicit maker/taker fees, limit fills and expiry, and SL-first resolution when a bar touches both exits. Text and HTML reports include monthly results, rejection funnels, floating drawdown, and a trade overlay. Candle simulation and live fills have different execution constraints. |

## Quality Assurance & Testing Rigor

| Practice | Evidence |
| --- | --- |
| **Unit, regression, and integration testing** | **1,068 tests across 53 Jest suites**. Strict TypeScript with `isolatedModules: true`; the local CI-equivalent run passes without `TS151002` or ts-jest configuration warnings. |
| **Failure-driven regression tests** | `ATR=0` and non-finite displacement; causal `LiquidityPool.isTaken` and `Zone.mitigated`; Friday-to-Monday rollover; router smoke tests at **15m/4H, 1H/4H, and 4H/1D**; malformed CSV input and synthetic offline instrument precision. The deployment profile suite also passes. |
| **Independent numerical cross-check** | The engine's Wilder-style ADX(14), with its documented seed convention, matched a separate Python `Decimal` implementation to **18 significant digits** on 28-, 80-, and 200-bar BTCUSDT 4H windows. The inputs and reference values are recorded in [AGENTS.md §7.26](AGENTS.md#726-core-math-hardening--multi-timeframe-unlock-v2026-11-28). |
| **CI and published evidence** | [GitHub Actions](.github/workflows/ci.yml) runs typecheck, Jest with coverage, and the build on `main` pushes and pull requests. Successful `main` pushes publish the [HTML test report](https://ishnekittt.github.io/crypto-bot/) and [coverage report](https://ishnekittt.github.io/crypto-bot/coverage/) to GitHub Pages. |

## Engine Features

- **Multi-timeframe engine.** Classic consumes configured LTF/HTF feeds; Sniper adds a 1m execution feed. A single `timeframeToMinutes()` handles `D/W/M`, with config aliases `1440 → D` and `10080 → W`. WebSocket subscriptions, structure tags, and higher-timeframe target thresholds follow the config. The backtester uses UTC trading days and ISO weeks: after a weekend gap, Monday's PDH/PDL come from Friday's closed candles.
- **Core math hardening.** Displacement fails closed at zero or non-finite ATR. The recognizer tracks taken liquidity and historically mitigated zones before the trigger candle. The S12 macro anchors stay intact for its 50-minute scan. EQH/EQL are clustered from confirmed swings independently of Bollinger compression.
- **Structural targets.** The resolver distinguishes major barriers from minor obstacles. S14 passes `max(DYNAMIC_TP_MIN_RR, 2.5)` into target selection; S15 requires a directional close outside the corresponding Bollinger band and reports `noBreakout` separately.
- **Entry filters.** The optional ADX gate reads closed HTF candles and fails open on insufficient history; it affects entry scans only. S1, S5, and S12 enforce London/New York killzones when enabled. S14 and S15 evaluate confirmed LTF closes regardless of that flag.

| Mode | Registered scenarios | Execution |
| --- | --- | --- |
| **Classic** | `1` HTF Continuation, `5` Liquidity Sweep, `14` Donchian Trend Following, `15` Volatility Squeeze | Configured LTF close; minimum 5 minutes. Smoke-tested at 15m/4H, 1H/4H, 4H/1D. |
| **Sniper** | `12` Sniper Touch | 1m CHoCH after a macro or opt-in intraday sweep, with OB-midpoint proximity, HTF bias, and fee-aware entry gates. |

The registry rejects archived scenario IDs. Classic and Sniper deployments use separate processes, databases, Telegram bots, and Bybit sub-accounts.

## Multi-Timeframe & Cross-Asset Validation (v2026-11-28)

Phase 3 ran on the hardened core. BTC and NEAR used Bybit history with the ADX gate off and killzones disabled. The 724-day futures test used Yahoo Finance **COMEX `GC=F` hourly continuous futures** (11,413 validated bars, 3.61% zero volume), loaded under the offline `XAUUSD` symbol. Starting balance: $1,000 per run.

| Market / configuration | Window (UTC) | Net PnL | Trades (W/L) | Win rate | PF | Max DD | Fees | Profitable months |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| BTCUSDT Classic · 15m/4H | 2025-11-28 → 2026-11-28 | −25.55% (−$255.47) | 199 (63/136) | 31.66% | 0.86 | 37.56% | $420.77 | 3/13 |
| BTCUSDT Classic · 1H/4H | 2025-11-28 → 2026-11-28 | −16.24% (−$162.39) | 96 (26/70) | 27.08% | 0.85 | 23.98% | $145.38 | 4/13 |
| BTCUSDT Classic · 4H/1D | 2024-11-28 → 2026-11-28 | −20.29% (−$202.91) | 59 (15/44) | 25.42% | 0.65 | 20.87% | $58.40 | 6/25 |
| NEARUSDT S12 · 1m | 2026-06-01 → 2026-11-28 | −4.72% (−$47.19) | 24 (11/13) | 45.83% | 0.82 | 12.21% | $166.68 | 4/6 |
| COMEX Gold S14 A/B · 1H/4H | 2024-12-03 → 2026-11-27 | **+43.14% (+$431.41)** | 74 (36/38) | 48.65% | 1.58 | 21.54% | $180.95 | 13/24 |
| COMEX Gold Classic C · 1H/4H | 2024-12-03 → 2026-11-27 | **+47.08% (+$470.85)** | 86 (40/46) | 46.51% | 1.54 | 22.12% | $245.50 | 13/24 |
| Dukascopy XAUUSD · 1H/4H, killzones on | 2026-05-20 → 2026-11-18 | +10.40% (+$103.99) | 20 (7/13) | 35.00% | 1.44 | 8.00% | $49.93 | 3/7 |
| Dukascopy XAUUSD · 4H/1D, killzones off | 2026-05-20 → 2026-11-18 | +2.06% (+$20.58) | 8 (3/5) | 37.50% | 1.19 | 6.30% | $15.51 | 2/7 |

- **Crypto:** All three BTC configurations lost money. S5 closed 37, 38, and 41 trades respectively and was net-negative in each. NEAR closed 24 trades with session sweeps and swing-based EQH/EQL enabled. The earlier BTC 15m control ended 20 days sooner, and the earlier NEAR audit also used a different window and settings, so the results cannot isolate the effect of the core changes.
- **COMEX:** A/B reports and charts were byte-identical because S14 ignores the killzone switch. C used the Classic set with killzones on (affecting S1/S5 only): **S14 +$506.08**, **S5 −$79.35**, **S15 +$44.11**, and no S1 trades. C lost **$122.40 on 44 trades** from December 2024 through December 2025, then earned **$377.42 on 21 trades** in January–June 2026 and **$215.82 on 21 trades** in July–November 2026 (rounded monthly sums).
- **Dukascopy:** The three-year download was blocked by HTTP 403/429. The two fallback runs used 183 days of bid candles, separate from the COMEX dataset and with different timeframe and killzone settings.

Full methodology, scenario attribution, and funnel counts: [AGENTS.md §7.27](AGENTS.md#727-phase-3-verification--multi-tf-crypto--2-year-comex-gold-gcf). Gold uses the simulator's synthetic instrument and fee model; historical results do not establish live profitability.

Earlier validation is recorded in [the endurance audit](AGENTS.md#723-long-horizon-endurance-audit--new-v2026-10-28), [the BTC ADX comparison](AGENTS.md#7241-measured-result--365-day-controlled-ab), and [the 15m Dukascopy stress test](AGENTS.md#725-cross-asset-stress-audit--xauusd-15m-183-days--new-v2026-11-20).

## Run Locally

Use **Node.js 26.x** to match CI. Copy [.env.example](.env.example) to `.env` and configure the Bybit key pair, PostgreSQL URL, Telegram bot token and chat ID, and backup password. For demo execution, use credentials issued for the Bybit Demo environment with `DEMO_TRADING=true`; Demo takes precedence over `TESTNET`.

```bash
npm ci
npm run typecheck
npm test
npm run test:ci        # Coverage summary and local HTML reports
npm run build
npm start             # Compiles and starts the configured worker
```

Deployment templates: [Subaru](.env.subaru.example) is BTCUSDT Classic (S14/S15, 15m/4H, ADX on); [Emilia](.env.emilia.example) is NEARUSDT Sniper (S12, 1m execution). These are checked-in configurations, not current profitability claims. Use the [Dockerfile](Dockerfile) for the worker image or the [Compose file](docker-compose.yml) for the two-profile layout. Operational commands and recovery flows are in [AGENTS.md §§3–5](AGENTS.md#3-infrastructure-resilience-enterprise-grade).

### Backtests

```bash
npm run backtest -- BTCUSDT

# Offline GC=F Classic run, after placing the validated 1h OHLCV file in data/.
SYMBOLS=XAUUSD BACKTEST_CSV_PATH=./data/gcf_1h_725d.csv DATA_DIR=./data/gold-classic \
  LTF_TIMEFRAME=60 HTF_TIMEFRAME=240 ACTIVE_SCENARIOS=1,5,14,15 \
  ENABLE_SNIPER_MODE=false ENABLE_REGIME_FILTER=false ENFORCE_KILLZONES=true \
  ALLOWED_DAYS_OF_WEEK=1,2,3,4,5,6,7 ENABLE_DYNAMIC_TP=true \
  DYNAMIC_TP_MIN_RR=1.5 DYNAMIC_TP_MAX_RR=6.0 RISK_PERCENT=2 \
  MAX_WORKING_CAPITAL=3000 npm run backtest -- XAUUSD
```

Bybit mode uses `BACKTEST_DAYS`; `USE_LOCAL_CACHE_ONLY=true` avoids candle downloads, though instrument metadata still comes from Bybit. CSV mode uses the file's time span and synthetic instrument metadata without exchange calls. The CSV header is `timestamp,open,high,low,close,volume`; input must contain a valid volume column. Market data and generated backtest reports under `data/` are gitignored.

## Project Structure

```text
.github/workflows/ci.yml     typecheck, Jest, build, GitHub Pages publication
src/
├── api/                    Bybit REST and WebSocket clients
├── backtest/
│   ├── run.ts              Bybit and CSV simulation entry point
│   ├── calendarMacro.ts    UTC trading-day and ISO-week levels
│   ├── csvLoader.ts        OHLCV validation and aggregation
│   ├── offlineInstruments.ts
│   ├── executionSimulator.ts
│   ├── historyLoader.ts    pagination and local cache
│   └── reporter.ts         text, monthly attribution, HTML charts
├── bootstrap/              preflight, reconciliation, and health checks
├── config/                 environment validation and execution fee constants
├── db/                     PostgreSQL persistence
├── dn_arbitrage/           separate funding-rate research simulator
├── engine/                 scenario registry/router, state machine, TP resolver
│   ├── brain/              HTF roadmap and volume exhaustion
│   ├── quant/              ADX and other indicators
│   └── scenarios/         registered strategies and archived designs
├── execution/              order submission
├── feed/                   confirmed candle buffers
├── risk/                   sizing and position management
├── services/               backup, news, and funding monitors
├── smc/                    pattern recognition and structure
├── telegram/               operator UI
├── utils/
│   ├── logger.ts
│   ├── precision.ts
│   └── timeframe.ts        canonical Bybit intervals and close-time arithmetic
├── types.ts
└── index.ts                live entry point
scripts/                    matrix runs, screening, funding analysis, maintenance
tests/                      unit, regression, and integration suites
```

## License

[MIT](LICENSE) © 2026 [Nikita Ishchenko](https://github.com/IshNekittt). Built for research and technical evaluation.
