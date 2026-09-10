<div align="center">

# 🤖 CRYPTO BOT SMC — Smart Money Concepts Trading Bot

[![Node.js](https://img.shields.io/badge/Node.js-26.x-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9+-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Bybit V5](https://img.shields.io/badge/Bybit-V5%20API-FF6B35?logo=bybit&logoColor=white)](https://bybit-exchange.github.io/docs/v5/intro)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-Supabase-4169E1?logo=postgresql&logoColor=white)](https://supabase.com/)
[![Docker](https://img.shields.io/badge/Docker-Multi--stage-2496ED?logo=docker&logoColor=white)](https://www.docker.com/)
[![Tests](https://img.shields.io/badge/Tests-194%20passing-brightgreen?logo=jest)](https://jestjs.io/)
[![License](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**Enterprise-grade autonomous trading bot** implementing **Smart Money Concepts (SMC)** on Bybit V5 Linear Perpetuals.
Built for **reliability**, **observability**, and **mathematical precision** — zero `number` for money, only `decimal.js`.

</div>

---

## 🎯 Features at a Glance

| Category             | Capability                                                                                                                                      |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| **11 SMC Scenarios** | HTF Continuation, FVG Fill, IDM, Mitigation Chain, HTF Liquidity Sweep, SMS, AMD, Range Deviation, Turtle Soup, Breaker Block, Mitigation Block |
| **Risk Management**  | 1% drawdown guard after 3 losses, position sizing via Kelly fraction, micro-stop protection (0.1%), minOrderQty enforcement                     |
| **Infrastructure**   | WS Watchdog (3 min), Global 429 Circuit Breaker (5 min), Daily Clock Sync, 10-min Reconciliation Loop                                           |
| **PnL Accuracy**     | Exchange `closedPnl` (fees + funding) via 2.5s delayed query on every close                                                                     |
| **SL Precision**     | Centralized `calculateLevels()` with `Decimal.min/max` — guarantees correct SL side regardless of zone top/bottom ordering                      |
| **Telegram UI**      | `/status` (live X-Ray), `/backup` (Blob+fetch), `/test_signal` (dry-run), `/test_live_order` (E2E demo)                                         |
| **Security**         | Stealth middleware (single `TELEGRAM_CHAT_ID`), no webhook, stateless Render deploy                                                             |

---

## 📊 Backtest Results (180 days, 3 symbols, all 11 scenarios)

| Symbol      | Final Balance | Net Profit   | Trades | Win Rate   | Max DD |
| ----------- | ------------- | ------------ | ------ | ---------- | ------ |
| **BTCUSDT** | $23,490.32    | **+2,249%**  | 150    | **80.00%** | 17.82% |
| **ETHUSDT** | $11,553.88    | **+1,055%**  | 118    | **64.41%** | 41.59% |
| **SOLUSDT** | $107,584.02   | **+10,658%** | 189    | **66.14%** | 31.81% |

**Total**: 457 trades | Σ PnL ≈ **$141,628** | Avg Win Rate **~70%** | Max DD **< 42%**

> **Top Drivers**: SMS (S6), HTF Continuation (S1), HTF Sweep (S5)
> **Filters Working**: S2 `NoLiqCtx: 120`, S4 `NoBOS: 1,570`, S11 strict SMS = 0 noise trades

---

## 🎯 Strict Stop-Loss Calculation (NEW v2026-09-10)

**Problem**: Zone objects (OB, FVG, Breaker, Mitigation) can have arbitrary `top`/`bottom` ordering — not guaranteed `top > bottom`. Naive SL formulas fail when zone is inverted.

**Solution**: Centralized `BaseScenario.calculateLevels()` — single source of truth for all bidirectional scenarios (S1, S5, S6, S10, S11).

```typescript
// In BaseScenario (src/engine/baseScenario.ts)
public calculateLevels(
  entry: Decimal,
  zone: { top: Decimal; bottom: Decimal; direction: 'BULLISH' | 'BEARISH' },
  direction: 'BULLISH' | 'BEARISH',
  atr: Decimal,
  rr: Decimal = new Decimal(3),
  offsetMultiplier: Decimal = new Decimal(0.5)
): TradeLevels {
  const offset = atr.mul(offsetMultiplier);

  // CRITICAL: Ensure SL is on correct side of Entry regardless of zone top/bottom convention
  // BULLISH (Long): SL must be BELOW entry. Use min(zone.bottom, entry) - offset
  // BEARISH (Short): SL must be ABOVE entry. Use max(zone.top, entry) + offset
  const sl = direction === 'BULLISH'
    ? Decimal.min(zone.bottom, entry).minus(offset)
    : Decimal.max(zone.top, entry).plus(offset);
  const tp = direction === 'BULLISH'
    ? entry.plus(entry.minus(sl).mul(rr))
    : entry.minus(sl.minus(entry).mul(rr));

  return { entry, stopLoss: sl, takeProfit: tp };
}
```

**Key invariants guaranteed:**

- **BULLISH (Long)**: `SL < Entry < TP` — always, even if `zone.top < zone.bottom`
- **BEARISH (Short)**: `SL > Entry > TP` — always, even if `zone.top < zone.bottom`
- `Decimal.min/max` handles inverted zones automatically
- Used by Scenarios 1, 5, 6, 10, 11 (all bidirectional scenarios)
- 16 dedicated tests verify geometry: 4 scenarios × 2 directions × 2 zone orientations

---

## 🚀 Quick Start

### Prerequisites

- Node.js **26.x** (LTS)
- Bybit API Key/Secret (Demo or Mainnet)
- Supabase PostgreSQL database
- Telegram Bot Token + Chat ID

### Local Development

```bash
# 1. Clone & install
git clone https://github.com/your-org/crypto-bot-smc.git
cd crypto-bot-smc
npm ci

# 2. Configure environment
cp .env.example .env
# Edit .env with your credentials (see table below)

# 3. Run typecheck + tests
npm run typecheck && npm test

# 4. Start bot
npm run build && npm start
```

### Docker (Production)

```bash
# Build image (~85 MB final)
docker build -t smc-bot .

# Run with .env
docker run -d \
  --name smc-bot \
  --restart unless-stopped \
  --env-file .env \
  -p 3000:3000 \
  smc-bot

# Or use docker-compose
docker compose up -d
```

---

## ⚙️ Environment Variables

| Variable                           | Required | Default | Description                                      |
| ---------------------------------- | :------: | :-----: | ------------------------------------------------ |
| **BYBIT_API_KEY**                  |    ✅    |    —    | Bybit API Key                                    |
| **BYBIT_API_SECRET**               |    ✅    |    —    | Bybit API Secret                                 |
| **SYMBOLS**                        |    ✅    |    —    | Comma-separated: `BTCUSDT,ETHUSDT,SOLUSDT`       |
| **DATABASE_URL**                   |    ✅    |    —    | Supabase Direct Connection string                |
| **TELEGRAM_BOT_TOKEN**             |    ✅    |    —    | BotFather token                                  |
| **TELEGRAM_CHAT_ID**               |    ✅    |    —    | Your numeric chat ID (security)                  |
| **DEMO_TRADING**                   |          | `true`  | `true` = Demo, `false` = Mainnet                 |
| **TESTNET**                        |          | `false` | Ignored if `DEMO_TRADING=true`                   |
| **RISK_PERCENT**                   |          |   `2`   | Base risk per trade (%)                          |
| **REDUCED_RISK_PERCENT**           |          |   `1`   | Risk after 3 consecutive losses (%)              |
| **LEVERAGE**                       |          |  `10`   | Isolated margin leverage                         |
| **AUTO_TRADING**                   |          | `false` | `true` = auto-execute, `false` = manual approval |
| **TRADE_APPROVAL_TIMEOUT_MINUTES** |          |   `5`   | Approval window for manual trades                |
| **HISTORY_CANDLES**                |          |  `200`  | 15m/4H history (max 1000)                        |
| **MACRO_CANDLES**                  |          | `1000`  | 1W/1D macro context (max 1000)                   |
| **LTF_TIMEFRAME**                  |          |  `15`   | Lower timeframe (15m)                            |
| **HTF_TIMEFRAME**                  |          |  `240`  | Higher timeframe (4H)                            |
| **ENABLE_LIVE_TEST_ORDERS**        |          | `false` | Enable `/test_live_order` (real Demo orders)     |
| **ACTIVE_SCENARIOS**               |          | `1-11`  | Comma-separated: `1,2,3,5,7`                     |
| **LOG_LEVEL**                      |          | `info`  | `debug`, `info`, `warn`, `error`                 |

---

## 🐳 Docker Management Commands

```bash
# ─── Image ───
docker build -t smc-bot .              # Build image
docker image ls smc-bot                # Verify image

# ─── Container (docker run) ───
docker run -d \
  --name smc-bot \
  --restart unless-stopped \
  --env-file .env \
  -p 3000:3000 \
  smc-bot

# ─── Container (docker-compose) ───
docker compose up -d                   # Start (build if needed)
docker compose up -d --build           # Rebuild + start
docker compose down                    # Stop + remove
docker compose pull && docker compose up -d  # Update base image + restart

# ─── Logs ───
docker logs -f smc-bot                 # Follow logs
docker logs --tail 100 smc-bot         # Last 100 lines
docker logs --since 1h smc-bot         # Last hour

# ─── Lifecycle ───
docker stop smc-bot                    # Graceful stop (30s SIGTERM)
docker start smc-bot                   # Start existing
docker restart smc-bot                 # Restart
docker rm -f smc-bot                   # Force remove

# ─── Debug ───
docker exec -it smc-bot sh             # Shell into container
docker inspect smc-bot                 # Container details
docker stats smc-bot                   # Resource usage
```

---

## 📱 Telegram Commands

| Command            | Description                                                                                               | Auth Required |
| ------------------ | --------------------------------------------------------------------------------------------------------- | ------------- |
| `/status`          | **Live X-Ray** per engine: Live Price, Last Candle, 4H Trend, Zones in Memory, Nearest Macro %dist, State | ✅            |
| `/backup`          | Full DB dump (19 cols) → gzip → Telegram via `fetch`+Blob (no disk I/O)                                   | ✅            |
| `/test_signal`     | Dry-run fake setup → Inline Approve/Reject buttons                                                        | ✅            |
| `/test_live_order` | **E2E Live Demo** → Real Bybit Demo order (requires `ENABLE_LIVE_TEST_ORDERS=true`)                       | ✅            |
| `/test_db`         | Integration test: INSERT/SELECT/DELETE with Decimal zoneDetails                                           | ✅            |

> **Security**: Only `TELEGRAM_CHAT_ID` from `.env` receives responses. All other users are silently ignored — no errors, no visibility.

---

## 🏗 Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        src/index.ts                             │
│  Bootstrap: DI → PatternRecognizer → Macro → Engines → WS →     │
│  ReconciliationLoop → MacroRefresher → HealthCheck → Graceful   │
└─────────────────────────────────────────────────────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
┌────────────────┐     ┌────────────────┐     ┌────────────────┐
│  StrategyEngine│     │  StrategyEngine│     │  StrategyEngine│
│   (BTCUSDT)    │     │   (ETHUSDT)    │     │   (SOLUSDT)    │
│  State Machine │     │  State Machine │     │  State Machine │
│  SCANNING→IN_  │     │  SCANNING→IN_  │     │  SCANNING→IN_  │
│  TRADE→CLOSED  │     │  TRADE→CLOSED  │     │  TRADE→CLOSED  │
└───────┬────────┘     └────────┬───────┘     └─────────┬──────┘
        │                       │                       │
        ▼                       ▼                       ▼
┌─────────────────────────────────────────────────────────────────┐
│                      ScenarioRouter                             │
│  Evaluates 11 scenarios → filters mitigatedZones → returns      │
│  PositionPlan (entry, SL, TP, qty, zoneDetails)                 │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      RiskManager                                │
│  Position sizing, Drawdown Guard, minOrderQty, leverage         │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    PendingTradeManager                          │
│  Manual approval queue + Slippage Guard (0.2% threshold)        │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    ExecutionEngine                              │
│  Market order + TP/SL via Bybit REST (Circuit Breaker wrapped)  │
└─────────────────────────────────────────────────────────────────┘
```

### Data Flow (Live Trade)

1. **WS Kline** → `CandleFeed` → `StrategyEngine.process()`
2. **ScenarioRouter** evaluates 11 scenarios against `PatternRecognizer` patterns
3. **RiskManager** calculates position size with Drawdown Guard
4. **PendingTradeManager** queues for approval (or auto-executes)
5. **Slippage Guard** validates price at approval time (0.2% threshold)
6. **ExecutionEngine** places market order with TP/SL
7. **DB** records trade with `zoneDetails` (OB/FVG/BREAKER/MITIGATION)
8. **WS Position/Execution** OR **ReconciliationLoop** detects close
9. **2.5s delay** → `GET /v5/position/closed-pnl` → exact PnL (fees + funding)
10. **MitigatedZone** recorded → no re-entry on same zone

---

## 🔒 Infrastructure Resilience (Core Mechanisms)

| Mechanism                  | Location                         | Purpose                                                   |
| -------------------------- | -------------------------------- | --------------------------------------------------------- |
| **WS Watchdog**            | `wsClient.ts`                    | 3-min silence → force reconnect (prevents zombie sockets) |
| **Exponential Backoff**    | `bybitClient.ts`                 | 1s/2s/4s retry on 429/503/10006                           |
| **Global Circuit Breaker** | `bybitClient.ts`                 | 3×429 → 5 min REST pause + Telegram alert                 |
| **Per-Symbol Breaker**     | `bybitClient.ts`                 | 3×5xx/10006 → 60s symbol block                            |
| **Clock Sync**             | `index.ts` + `reconciliation.ts` | Daily 00:00 + hourly drift correction                     |
| **Reconciliation Loop**    | `reconciliation.ts`              | 10-min audit: WS state vs DB vs Exchange                  |

### How They Work

**WS Watchdog** (3 min)

- Resets on ANY incoming message (klines, execution, position, pong, open, authenticated)
- On timeout: force closes both WS connections → logs `[ERROR] WS Watchdog: 180000ms of silence` → standard reconnect fires `resync()`

**Global Rate Limit Circuit Breaker** (429)

- Tracks consecutive 429s across ALL symbols
- At 3: pauses ALL REST for 5 min → Telegram: `🚨 API Rate Limit breached!`
- Auto-resets after 5 min with log `Global rate limit circuit breaker CLOSED`

**Per-Symbol Circuit Breaker** (5xx/10006/10007)

- Independent per symbol
- 3 failures in 60s → blocks that symbol for 60s

**Clock Drift Prevention**

- Daily 00:00 UTC: `syncServerTime()` before macro refresh
- Every hour in ReconciliationLoop: `syncServerTime()` → logs `[Clock Drift] offset=Xms`
- Prevents `recvWindow` errors after weeks of uptime

**Reconciliation Loop** (every 10 min)

- Step 1: `IN_TRADE` engines → `getOpenPositions()` → force `SCANNING` if gone
- Step 2: All open trades in DB → check exchange → `reconcileWithTrade()` with zoneDetails for mitigation tracking
- Idempotent, safe with concurrent WS events

---

## 🧮 SMC Math Highlights

- **EQH/EQL Tolerance**: `max(0.1%, 0.5 * ATR / close)` — dynamic, noise-resistant
- **Trading Range**: Real highs/lows + `0.5 * ATR` touch tolerance
- **SFP/Sweep**: `wick > level && close < level` (never strict equality)
- **Displacement**: Body ≥ **1.5 × ATR** on BOS/CHoCH/SMS/Breaker candles
- **Killzones**: London (02-05 NY) / NY (07-10 NY) only for entries
- **Macro Context**: O(N) only — ATH/ATL, PWH/PWL, PDH/PDL, DO/WO, last 20 daily FVGs

---

## 🛡 Risk Management Rules

| Guard                | Logic                                                                    | Config                                        |
| -------------------- | ------------------------------------------------------------------------ | --------------------------------------------- |
| **Drawdown Guard**   | 3 consecutive losing trades → risk reduced to 1%                         | `RISK_PERCENT` (base), `REDUCED_RISK_PERCENT` |
| **Position Sizing**  | `qty = (balance × risk%) / SL_distance` → rounded to `qtyStep`           | `LEVERAGE` (default 10x) via isolated margin  |
| **Min Order Qty**    | If `rounded_qty < minOrderQty` → **ABORT** + `[WARN]` + state→`SCANNING` | Exchange `minOrderQty`                        |
| **Max Order Qty**    | If `qty > maxOrderQty` → **ABORT**                                       | Exchange `maxOrderQty`                        |
| **Micro-Stop Guard** | SL distance must be **> 0.1%** (prevents noise stops)                    | Hardcoded in `RiskManager`                    |

**Leverage**: Set once at bootstrap via `setupMarginAndLeverage(symbol, leverage)` (isolated margin).

---

## 📊 What to Monitor (Operations)

### Health Checks

```bash
# Liveness
curl http://localhost:3000/        # 200 OK
curl http://localhost:3000/health  # {"status":"healthy","timestamp":...}
```

### Key Log Patterns

| Log                                                            | Meaning                                         | Action                       |
| -------------------------------------------------------------- | ----------------------------------------------- | ---------------------------- |
| `[INFO] Bot online: 3 strategy workers active`                 | Startup success                                 | ✅ Normal                    |
| `[INFO] [Clock Drift] offset=Xms roundTrip=Yms`                | Hourly time sync                                | Drift < 50ms = healthy       |
| `[WARN] [Slippage Guard] ... rejecting`                        | Approval rejected (price moved >0.2% toward TP) | User clicked late — normal   |
| `[ERROR] WS Watchdog: 180000ms of silence — forcing reconnect` | Zombie socket detected                          | Auto-recovers via `resync()` |
| `🚨 API Rate Limit breached!`                                  | 3×429 → global 5 min pause                      | Check Bybit limits, wait     |
| `[ERROR] ... circuit breaker OPEN`                             | Per-symbol 60s block                            | Check symbol-specific issues |

### Telegram Alerts

- **Critical errors** → `notifyCriticalError()` (uncaught exceptions, circuit breaker, order failures)
- **Trade events** → `notifySetupFound`, `notifyOrderOpened`, `notifyTradeClosed`
- **Rate limit breach** → `🚨 API Rate Limit breached!` with 5 min pause notice

---

## 🧪 Testing

```bash
# All tests (211)
npm test

# Watch mode
npm test -- --watch

# Single test file
npm test -- tests/riskManager.test.ts

# Coverage
npm test -- --coverage
```

---

## 📦 Docker Details

**Multi-stage build** (`Dockerfile`):

- **Stage 1 (builder)**: `node:26-alpine` → `npm ci` → `npm run build` → `dist/`
- **Stage 2 (runner)**: `node:26-alpine` → `npm ci --omit=dev` → copy `dist/` → `CMD ["node", "dist/index.js"]`
- **Final image**: **~85 MB**, no dev deps, no source code

**docker-compose.yml**:

```yaml
services:
  smc-bot:
    build: .
    container_name: smc-bot
    restart: unless-stopped
    env_file: .env
    ports:
      - "3000:3000" # Health check for Render
    stop_grace_period: 30s
```

- **No volumes** — fully stateless
- **Port 3000** — Render health check endpoint
- **Graceful shutdown** — 30s SIGTERM handling

---

## 🛠 Development Commands

```bash
npm run typecheck    # tsc --noEmit (strict, must pass)
npm run build        # tsc → dist/
npm run start        # build + node dist/index.js
npm run backtest     # Full 180-day backtest (all symbols)
npm run backtest -- BTCUSDT  # Single symbol
npm test             # Jest (211 tests)
npm run test:watch   # Watch mode
```

---

## 📁 Project Structure (Key Files)

```
src/
├── index.ts                    # Bootstrap entry point
├── api/
│   ├── bybitClient.ts          # REST + Circuit Breaker + ClosedPnL
│   └── wsClient.ts             # WS + 3-min Watchdog + custom logger
├── engine/
│   ├── strategyEngine.ts       # State machine per symbol
│   ├── scenarioRouter.ts       # 11 scenarios + mitigatedZones filter
│   ├── pendingTradeManager.ts  # Approval queue + Slippage Guard
│   └── scenarios/              # S1–S11 implementations
├── smc/
│   └── patternRecognizer.ts    # Core SMC: swings, OB, FVG, SMS, ranges, macro
├── risk/
│   └── riskManager.ts          # Position sizing, Drawdown Guard
├── telegram/
│   └── notifier.ts             # Security middleware + commands
├── db/
│   └── database.ts             # pg.Pool, NUMERIC(24,8), leak-proof
├── bootstrap/
│   ├── reconciliation.ts       # 10-min audit + hourly clock sync
│   ├── preflight.ts            # Symbol validation, leverage setup
│   └── healthcheck.ts          # Express /health for Render
└── utils/
    ├── logger.ts               # Winston wrapper (LOG_LEVEL aware)
    └── precision.ts            # tickSize/qtyStep rounding
```

---

## 📄 License

Copyright (c) 2026 [Nikita Ishchenko](https://github.com/IshNekittt). All rights reserved. See the [LICENSE](LICENSE.txt) file for details.

---

## ⚠️ Disclaimer

**This software is for educational and research purposes only.**
Trading cryptocurrencies carries substantial risk of loss.
**Never trade with money you cannot afford to lose.**
The authors are not responsible for any financial losses incurred through use of this bot.

---

<div align="center">

_Enterprise-grade. Mathematically precise. Production-ready._

</div>
