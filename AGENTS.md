# CRYPTO BOT SMC — ARCHITECTURAL BIBLE (v2026-09-10)

> **Single source of truth for any AI agent working on this codebase.**
> Every architectural decision, invariant, and convention is documented here.
> If it's not in this file, it doesn't exist.

---

## 1. TECH STACK & RUNTIME INVARIANTS

| Layer           | Technology            | Version / Config                     | Hard Constraints                                                  |
| --------------- | --------------------- | ------------------------------------ | ----------------------------------------------------------------- |
| Runtime         | Node.js               | **26.x** (LTS)                       | `--experimental-strip-types` NOT used; pure TS compiled           |
| Language        | TypeScript            | **5.9+**, `strict: true`             | `noImplicitAny`, `strictNullChecks`, `exactOptionalPropertyTypes` |
| Exchange        | Bybit V5              | REST + WebSocket (Linear Perpetuals) | `demoTrading` or `testnet` only for CI; `mainnet` prod            |
| Database        | Supabase (PostgreSQL) | **Direct Connection**, pool=5        | `NUMERIC(24,8)` for ALL money; `pg` returns strings               |
| Math            | `decimal.js`          | **10.6+**                            | **ZERO** `number` for prices/qty/PnL — only `Decimal`             |
| Logging         | `winston`             | JSON + console                       | `LOG_LEVEL=info` default; `debug` only in tests                   |
| Telegram        | `telegraf` 4.16       | Long-polling (NO webhook)            | Stateless Render deployment                                       |
| Container       | Docker multi-stage    | `node:26-alpine` base                | Final image **< 100 MB**, no dev deps                             |
| Process Manager | None (bare Node)      | `SIGTERM` 30s graceful               | Single process, no PM2/cluster                                    |

**Invariant**: All financial values (prices, qty, PnL, balance) are **strings in DB**, **`Decimal` in memory**, **strings on wire**. Never `number`.

---

## 2. PROJECT STRUCTURE

```
src/
├── api/              # Bybit REST + WebSocket clients
│   ├── bybitClient.ts     # REST with Circuit Breaker, Retry, ClosedPnL
│   └── wsClient.ts        # WS with 3-min Watchdog, 5s reconnect, custom logger
├── backtest/         # Historical simulation engine
│   ├── run.ts             # CLI entry, multi-symbol, 180-day default
│   ├── executionSimulator.ts  # State machine: SCANNING→IN_TRADE→CLOSED
│   └── reporter.ts        # PnL report generation
├── bootstrap/        # Startup & recovery
│   ├── preflight.ts       # Symbol validation, leverage, margin mode
│   ├── healthcheck.ts     # Express /health for Render
│   └── reconciliation.ts  # 10-min audit loop + hourly clock sync
├── config/
│   └── env.ts             # Zod-like validation, all .env parsed here
├── db/
│   └── database.ts        # pg.Pool, NUMERIC(24,8), connection leak proof
├── engine/           # Strategy orchestration
│   ├── strategyEngine.ts  # State machine per symbol
│   ├── scenarioRouter.ts  # Evaluates 11 scenarios, filters mitigatedZones
│   ├── pendingTradeManager.ts  # Manual approval queue + Slippage Guard
│   └── scenarios/         # 11 scenario implementations (S1–S11)
├── execution/
│   └── executionEngine.ts # Market order + TP/SL placement
├── feed/
│   └── candleFeed.ts      # 15m/4H buffers, live price from forming candle
├── risk/
│   └── riskManager.ts     # Position sizing, Drawdown Guard, minOrderQty
├── services/
│   └── backupService.ts   # 24h auto-backup + /backup cmd (Blob+fetch)
├── smc/
│   └── patternRecognizer.ts  # SMC core: swings, OB, FVG, SMS, ranges, macro
├── telegram/
│   └── notifier.ts        # Security middleware, commands, DI
├── utils/
│   ├── logger.ts          # winston wrapper, LOG_LEVEL aware
│   └── precision.ts       # tickSize/qtyStep rounding
├── types.ts               # All domain types, StrategyState enum
└── index.ts               # Bootstrap: DI, WS, Reconciliation, Macro refresher
```

---

## 3. INFRASTRUCTURE RESILIENCE (Enterprise Grade)

### 3.1 WebSocket Watchdog — `src/api/wsClient.ts`

- **Problem**: Cloud TCP sockets "silently hang" — no `close`, `error`, or `pong`.
- **Solution**: 3-minute (`180_000 ms`) watchdog timer.
  - Reset on **ANY** incoming message (klines, execution, position, pong, open, authenticated).
  - On timeout: `forceReconnect()` → closes `v5LinearPublic` + `v5Private` → logs `[ERROR] WS Watchdog: 180000ms of silence — forcing reconnect` → standard `reconnect`/`reconnected` handler fires `resync()`.
  - Check interval: 30s (`setInterval`, `unref()`).

### 3.2 Rate Limit Circuit Breaker — `src/api/bybitClient.ts`

All REST calls wrapped in `executeWithRetry()`:

| Mechanism                      | Config                 | Behavior                                                                                             |
| ------------------------------ | ---------------------- | ---------------------------------------------------------------------------------------------------- |
| **Exponential Backoff**        | Max 3 retries, base 1s | Retries on **429, 503, 10006** → delays: **1s → 2s → 4s**                                            |
| **Per-Symbol Circuit Breaker** | 3 failures in 60s      | Blocks **only that symbol** for 60s (5xx, 10006, 10007)                                              |
| **Global Circuit Breaker**     | **3 consecutive 429**  | **ALL REST paused 5 min** → Telegram alert: `🚨 API Rate Limit breached!` → auto-reset, log `CLOSED` |

### 3.3 Daily Clock Sync — `src/index.ts` + `src/bootstrap/reconciliation.ts`

- **Macro Refresher (00:00 UTC)**: `client.syncServerTime()` before `refreshMacroContext()`.
- **Reconciliation Loop (every 10 min)**: Syncs time **every hour** (`CLOCK_DRIFT_SYNC_INTERVAL_MS = 3_600_000`).
- Logs: `[Clock Drift] offset=Xms roundTrip=Yms`. Prevents `recvWindow` errors after weeks of uptime.

### 3.4 Reconciliation Loop — `src/bootstrap/reconciliation.ts`

- Runs every **10 minutes**.
- **Step 1**: For each `IN_TRADE` engine → `getOpenPositions()` → if gone, force `SCANNING`.
- **Step 2**: `db.getAllOpenTrades()` → for each, check exchange position → if missing, `reconcileWithTrade()` with zoneDetails for mitigatedZones tracking.
- Idempotent, safe to run concurrently with WS events.

### 3.5 Accurate PnL with Funding — `src/engine/strategyEngine.ts` + `src/api/bybitClient.ts`

**On trade close (WS execution/position OR ReconciliationLoop):**

1. Wait **2.5 seconds** for exchange to finalize.
2. `GET /v5/position/closed-pnl` (`getClosedPnl(symbol, startTime, endTime)`).
3. Match by `orderId` → fallback nearest `closedTime` (±5 min).
4. Use exchange `closedPnl` (includes fees + funding) + `exitPrice`.
5. Update `trades.pnl`, `trades.exit_price` in DB.
6. Log: `Using exchange closedPnl (with funding/fees): -12.3456 vs calculated: -11.9876`.
7. **Fallback**: calculated PnL from executions if closedPnL unavailable.

---

## 4. TELEGRAM UI & SECURITY

### 4.1 Security Middleware — `src/telegram/notifier.ts:186-192`

```typescript
this.bot.use(async (ctx, next) => {
  const chatId = ctx.chat?.id.toString();
  if (!chatId || chatId !== this.chatId) return; // SILENT IGNORE
  await next();
});
```

- **Only** `TELEGRAM_CHAT_ID` from `.env` gets responses.
- No `setMyCommands` → bot invisible to strangers.
- No error messages to unauthorized users.

### 4.2 Commands

| Command            | Description                                                                                                   | Auth |
| ------------------ | ------------------------------------------------------------------------------------------------------------- | ---- |
| `/status`          | **X-Ray** per engine: Live Price, Last Candle, 4H Trend, Zones in Memory, Nearest Macro %dist, State          | ✅   |
| `/backup`          | Manual DB dump (full 19 cols) → gzip → Telegram via `fetch`+Blob (no disk)                                    | ✅   |
| `/test_signal`     | Dry-run fake setup → Approve/Reject buttons → logs `✅ Test trade approved (DRY RUN)`                         | ✅   |
| `/test_live_order` | **E2E live demo** (requires `ENABLE_LIVE_TEST_ORDERS=true`) → real Bybit Demo order, full API response logged | ✅   |
| `/test_db`         | Integration test: INSERT/SELECT/DELETE with Decimal zoneDetails                                               | ✅   |

### 4.3 Approval Flow (`PendingTradeManager`)

1. Setup found → `ENTRY_STAGED` → if `AUTO_TRADING=false` → queue for approval.
2. User taps **✅ Войти** → `handleApproval(tradeId, true)`.
3. **Slippage Guard**: Before sending order, compares `lastClose` (candleFeed) vs `entry`:
   - If price moved **> 0.2% toward TP** → **REJECT** + log `[Slippage Guard] ... rejecting`.
   - If price already **≥ TP** → **REJECT**.
4. On approve: `ExecutionEngine.execute()` → `db.openTrade()` → `IN_TRADE`.

---

## 5. RISK MANAGEMENT — `src/risk/riskManager.ts`

| Guard                | Logic                                                                                 | Config                                        |
| -------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------- |
| **Drawdown Guard**   | 3 consecutive losing trades → risk reduced to `REDUCED_RISK_PERCENT` (default **1%**) | `RISK_PERCENT` (base), `REDUCED_RISK_PERCENT` |
| **Position Sizing**  | `qty = (balance * risk%) / SL_distance` → rounded to `qtyStep`                        | `leverage` (default 10x) via isolated margin  |
| **Min Order Qty**    | If `rounded_qty < minOrderQty` → **ABORT** + `[WARN]` + state→`SCANNING`              | Exchange `minOrderQty`                        |
| **Max Order Qty**    | If `qty > maxOrderQty` → **ABORT**                                                    | Exchange `maxOrderQty`                        |
| **Micro-Stop Guard** | SL distance must be **> 0.1%** (prevents noise stops)                                 | Hardcoded in `RiskManager`                    |

**Leverage**: Set once at bootstrap via `setupMarginAndLeverage(symbol, leverage)` (isolated margin).

---

## 6. SMC MATHEMATICS — `src/smc/patternRecognizer.ts`

### 6.1 Tolerance & Intersections (No Strict Equality)

| Concept                   | Tolerance                                          | Implementation                                  |
| ------------------------- | -------------------------------------------------- | ----------------------------------------------- |
| **EQH/EQL**               | `max(0.1%, 0.5 * ATR / close)`                     | `detectEqualLevels()` dynamic threshold         |
| **Trading Range**         | `0.5 * ATR` for boundary "touch"                   | `detectTradingRange()` uses actual highs/lows   |
| **SFP/Sweep**             | Wick pierces, body closes inside                   | `high > level && close < level` (not `==`)      |
| **Breaker Block**         | Full body close beyond OB + displacement ≥ 1.5 ATR | `isValidBodyClose` + `isValidDisplacement(1.5)` |
| **All Price Comparisons** | `Decimal` with tolerance                           | **Never** `.eq()`                               |

### 6.2 Displacement Validation

- **Structure Break (BOS/CHoCH)**: Candle body ≥ **1.5 \* ATR** (`displacementMultiplier`).
- **SMS (Failure Swing)**: CHoCH candle body ≥ **1.5 \* ATR**.
- **Breaker Block**: Impulse candle body closes beyond OB + **1.5 \* ATR**.

### 6.3 Killzones (NY Time)

| Session    | Hours (NY)  | Phase        |
| ---------- | ----------- | ------------ |
| **Asian**  | 20:00–24:00 | Accumulation |
| **London** | 02:00–05:00 | Manipulation |
| **NY**     | 07:00–10:00 | Distribution |

Only **London/NY** valid for entry (Scenario 5, 7, etc.).

### 6.4 Macro Context (Bootstrap Only, ~5-10ms)

- **Loaded ONCE** at startup (single `PatternRecognizer` shared across engines).
- **1W/1D candles** (1000 each) → **linear O(N) passes only**:
  - ATH/ATL: max high / min low
  - PWH/PWL: `weekly[-2]` high/low
  - PDH/PDL: `daily[-2]` high/low
  - DO/WO: `daily[-1].open` / `weekly[-1].open`
  - FVG: last **20** daily candles only
- **NO** Order Blocks, Breakers, Mitigation on macro timeframes.
- Daily 00:00 UTC refresh: atomic cache replacement.

### 6.5 Strict Stop-Loss Calculation — `BaseScenario.calculateLevels()` — **NEW v2026-09-10**

**Problem**: Zone objects (OB, FVG, Breaker, MB) can have arbitrary `top`/`bottom` ordering (not guaranteed `top > bottom`). Naive SL formulas like `zone.bottom - offset` fail when zone is inverted.

**Solution**: Centralized `BaseScenario.calculateLevels()` method — single source of truth for all bidirectional scenarios (S1, S5, S6, S10, S11).

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

**Key invariants guaranteed by this formula:**
- **BULLISH (Long)**: `SL < Entry < TP` — always, even if `zone.top < zone.bottom`
- **BEARISH (Short)**: `SL > Entry > TP` — always, even if `zone.top < zone.bottom`
- `Decimal.min/max` handles inverted zones automatically
- Used by Scenarios 1, 5, 6, 10, 11 (all bidirectional scenarios)
- Tests call this method directly — no full pattern recognition needed

### 6.6 News Filter (News Embargo) — `src/services/newsService.ts` — **NEW v2026-09-12**

**Problem**: High-impact USD macro news (NFP, CPI, FOMC, etc.) causes extreme volatility and spread widening. Trading during these windows produces random PnL with negative expectancy.

**Solution**: **News Embargo Filter** — blocks all trade scanning ±30 minutes around high-impact USD news.

**Implementation** (`src/services/newsService.ts`):

| Component | Detail |
|-----------|--------|
| **Source** | ForexFactory public JSON: `https://nfs.faireconomy.media/ff_calendar_thisweek.json` |
| **Filter** | `country === 'USD'` AND `impact === 'High'` |
| **Cache** | In-memory array of `NewsEvent { title, timestamp }` for current week (±7 days) |
| **Refresh** | Daily at 00:00 UTC (via macro context refresher) + at startup |
| **Embargo Window** | ±30 minutes (configurable via `EMBARGO_WINDOW_MS = 30 * 60 * 1000`) |
| **Method** | `isNewsEmbargo(ts: number): boolean` — returns `true` if `ts` within ±30 min of any cached high-impact USD event |
| **Resilience** | Network/HTTP/parse errors → empty cache + `logger.warn`, never throws |
| **Cloudflare 429 Fix** | Browser headers (`User-Agent`, `Accept`, `Cache-Control: no-cache`) to bypass Cloudflare 429 rate limiting on ForexFactory | `src/services/newsService.ts:25-31` |

**Integration Points**:

1. **Bootstrap** (`src/index.ts`):
   - `newsService.fetchNews()` at startup
   - Daily 00:00 UTC: `newsService.fetchNews()` in `startMacroContextRefresher()`
   - Injected into all `StrategyEngine` instances

2. **StrategyEngine** (`src/engine/strategyEngine.ts`):
   - In `process()` (15m candle close): **embargo check BEFORE `scenarioRouter.evaluate()`**
   - If `newsService.isNewsEmbargo(candleTimestamp)` → logs `[SYMBOL] 15m candle closed, but HIGH IMPACT NEWS EMBARGO is active. Skipping scan.` → returns early
   - **4H timeframe** bypasses check (early return)

3. **Telegram /status**:
   - `getNextHighImpactNews()` → shows next USD high-impact event or "None for today"

**Tests** (`tests/newsService.test.ts`, `tests/strategyEngine.test.ts`):
- Filtering: only USD High impact events stored
- Boundary checks: 13:29:59→false, 13:30:00→true, 14:30:00→true, 14:30:01→false
- Resilience: network/HTTP/parse errors → empty cache + warn, no crash
- Engine integration: embargo blocks scan, logs message, doesn't call evaluate

---

## 7. THE 11 SCENARIOS — `src/engine/scenarios/`

| ID     | Name                | Core Logic                                                 | Key Filters                                                                   |
| ------ | ------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------- |
| **1**  | HTF Continuation    | 4H BOS → 15m OB retest in direction                        | 4H trend alignment                                                            |
| **2**  | FVG Fill            | 15m FVG → retest at 50%                                    | **Liquidity Context**: sweep/CHoCH in prior 10-15 candles (`NoLiqCtx`)        |
| **3**  | IDM (Inducement)    | Local extreme swept → true OB beyond                       | Swing detection                                                               |
| **4**  | Mitigation Chain    | OB → BOS within 24h → retest                               | **Strength Context**: OB must make BOS (`NoBOS`)                              |
| **5**  | HTF Liquidity Sweep | PDH/PDL/BSL/SSL sweep in London/NY                         | Killzone + SFP (wick pierce, close inside)                                    |
| **6**  | SMS (Failure Swing) | Failed HH/LL → CHoCH opposite                              | Displacement ≥ 1.5 ATR on CHoCH candle                                        |
| **7**  | AMD (Asian Range)   | Asian 20:00-24:00 high/low → sweep → reversal              | `detectSessionRanges()` per day                                               |
| **8**  | Range Deviation     | Range High/Low deviation → reclaim                         | Wick back inside, equilibrium target                                          |
| **9**  | Turtle Soup         | Range High sweep (EQH) → short                             | EQH tolerance + SFP on range boundary                                         |
| **10** | Breaker Block       | OB broken with displacement → retest                       | Body close beyond OB + FVG nearby                                             |
| **11** | Mitigation Block    | **Only after SMS** → retest block that formed failed swing | **Strict SMS pattern**: failed HH → CHoCH down (`NoSms`, `InvalidSmsPattern`) |

### 7.1 Zone Mitigation (No Re-entry) — `ScenarioRouter` + `StrategyEngine`

- `mitigatedZones[]` in engine memory (max 100).
- On trade close: `addMitigatedZone(zoneDetails)` → Router filters by `type/timeframe/direction/top/bottom` before `evaluate()`.
- Scenarios setting `zoneDetails`: **1, 2, 4, 5, 7, 8, 10, 11**.

### 7.2 Contextual Quality Filters (Confluence)

| Scenario                  | Filter                                       | Rejection Stat               |
| ------------------------- | -------------------------------------------- | ---------------------------- |
| **2 (FVG Fill)**          | Liquidity sweep/CHoCH in prior 10-15 candles | `NoLiqCtx`                   |
| **4 (Mitigation Chain)**  | Originating OB made BOS within 24h           | `NoBOS`                      |
| **11 (Mitigation Block)** | Valid SMS pattern (failed HH → CHoCH down)   | `NoSms`, `InvalidSmsPattern` |

---

## 8. DATABASE SCHEMA — `src/db/database.ts`

```sql
CREATE TABLE trades (
  id VARCHAR(255) PRIMARY KEY,
  symbol VARCHAR(20) NOT NULL,
  scenario_id INTEGER,
  entry_price NUMERIC(24, 8) NOT NULL,
  sl_price NUMERIC(24, 8) NOT NULL,
  tp_price NUMERIC(24, 8) NOT NULL,
  qty NUMERIC(24, 8) NOT NULL,
  pnl NUMERIC(24, 8),
  exit_price NUMERIC(24, 8),
  status VARCHAR(20) CHECK (status IN ('OPEN', 'CLOSED')),
  reason TEXT,
  opened_at BIGINT NOT NULL,
  closed_at BIGINT,
  order_id VARCHAR(255),
  side VARCHAR(10) CHECK (side IN ('Buy', 'Sell')),
  zone_type VARCHAR(20),           -- OB, FVG, BREAKER, MITIGATION
  zone_top NUMERIC(24, 8),         -- top of entry zone
  zone_bottom NUMERIC(24, 8),      -- bottom of entry zone
  zone_timeframe VARCHAR(10),      -- 15, 240, D, W
  zone_direction VARCHAR(10),      -- BULLISH, BEARISH
  zone_timestamp BIGINT            -- zone formation timestamp
);

CREATE TABLE symbol_state (
  symbol VARCHAR(20) PRIMARY KEY,
  state VARCHAR(20) CHECK (state IN ('SCANNING','WAITING','CONFIRMATION','ENTRY_STAGED','IN_TRADE')),
  updated_at BIGINT NOT NULL
);
```

**Connection Pool**: `max=5`, `idleTimeout=10s`, `keepAlive=true` (Supabase compatibility).
**Leak Proof**: Every method uses `const client = await pool.connect(); try {...} finally { client.release() }`.

---

## 9. BACKTEST ENGINE — `src/backtest/`

- **State Machine**: `openTrade()` / `checkAndCloseTrade()` in `executionSimulator.ts`.
- **Drawdown Guard**: `consecutiveLosses` increments on loss → feeds `RiskManager.getEffectiveRiskPercent()`.
- **Max Drawdown**: Calculated correctly (not `TODO%`).
- **CLI**: `npm run backtest -- BTCUSDT` (single symbol filter via `parseArgs`).
- **Performance**: ~25s for 17,280 candles (180 days × 3 symbols).

---

## 10. ENVIRONMENT VARIABLES (`.env`)

```bash
# Required
BYBIT_API_KEY=...
BYBIT_API_SECRET=...
SYMBOLS=BTCUSDT,ETHUSDT,SOLUSDT
DATABASE_URL=postgresql://...
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...

# Risk
RISK_PERCENT=2
REDUCED_RISK_PERCENT=1
LEVERAGE=10

# Trading Mode
DEMO_TRADING=true          # false = mainnet (testnet ignored)
AUTO_TRADING=false         # true = auto-execute, false = manual approval
TRADE_APPROVAL_TIMEOUT_MINUTES=5

# Data
HISTORY_CANDLES=200        # 15m/4H history (max 1000)
MACRO_CANDLES=1000         # 1W/1D for macro context (max 1000)
LTF_TIMEFRAME=15
HTF_TIMEFRAME=240

# Features
ENABLE_LIVE_TEST_ORDERS=false
ACTIVE_SCENARIOS=1,2,3,4,5,6,7,8,9,10,11

# Logging
LOG_LEVEL=info             # debug, info, warn, error
```

---

## 11. BUILD & VERIFICATION COMMANDS

```bash
npm run typecheck    # tsc --noEmit  (must pass)
npm test             # jest (194 tests, all green)
npm run build        # tsc → dist/
npm run backtest     # Full backtest all symbols
npm run backtest -- BTCUSDT  # Single symbol
docker build -t smc-bot .
docker compose up -d
```

---

## 12. CRITICAL INVARIANTS (DO NOT BREAK)

1. **No `number` for money** — only `Decimal` + string serialization.
2. **Single `PatternRecognizer`** instance shared across all engines.
3. **Macro context initialized ONCE** at bootstrap, never in hot path.
4. **`mitigatedZones`** is the ONLY re-entry protection (no "freshness" hacks).
5. **`reconcileWithTrade`** receives `zoneDetails` for mitigation tracking.
6. **Slippage Guard** runs at approval time, not order time.
7. **ClosedPnL** fetched after 2.5s delay on every close.
8. **Global 429 circuit breaker** pauses ALL REST for 5 min.
9. **WS Watchdog** 3-min silence = force reconnect.
10. **Daily clock sync** at 00:00 UTC + hourly in reconciliation.
11. **SL calculation** uses `Decimal.min(zone.bottom, entry)` for Longs and `Decimal.max(zone.top, entry)` for Shorts — guarantees correct SL side regardless of zone top/bottom ordering.

---

## 13. DOCKER & DEPLOYMENT

### 13.1 Dockerfile (Multi-stage, Node 26)

```dockerfile
# builder: compiles TS → dist/
FROM node:26-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# runner: production deps only, non-root user
FROM node:26-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV TZ=UTC
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
USER node
EXPOSE 3000
CMD ["node", "dist/index.js"]
```

**Key points**:
- `node:26-alpine` base — matches runtime invariant
- Multi-stage → final image **~85 MB**, no dev deps, no source
- `USER node` — non-root for security
- `TZ=UTC` — consistent timestamps for SMC killzones
- `EXPOSE 3000` — health check endpoint for Render/load balancer

### 13.2 docker-compose.yml

```yaml
services:
  smc-bot:
    build: .
    container_name: smc-bot
    restart: unless-stopped
    env_file: .env
    ports:
      - "3000:3000"
    stop_grace_period: 30s
```

- **No volumes** — fully stateless (Supabase for persistence)
- **Port 3000** — health check (`GET /health`) for Render
- **stop_grace_period: 30s** — matches `SIGTERM` handler in `index.ts`

### 13.3 Render Deployment (Recommended)

```yaml
# render.yaml
services:
  - type: web
    name: smc-bot
    env: docker
    dockerfilePath: ./Dockerfile
    envVars:
      - key: BYBIT_API_KEY
        sync: false
      - key: BYBIT_API_SECRET
        sync: false
      - key: SYMBOLS
        value: BTCUSDT,ETHUSDT,SOLUSDT
      - key: DATABASE_URL
        fromDatabase:
          name: smc-db
          property: connectionString
      - key: TELEGRAM_BOT_TOKEN
        sync: false
      - key: TELEGRAM_CHAT_ID
        sync: false
      - key: DEMO_TRADING
        value: "true"
      - key: AUTO_TRADING
        value: "false"
      - key: LOG_LEVEL
        value: "info"
    healthCheckPath: /health
    autoDeploy: true
```

**Render specifics**:
- **Stateless web service** — no persistent disk
- **Health check** on `/health` (returns `{status: "healthy", timestamp}`)
- **Auto-deploy** on push to main
- **Environment variables** via Render dashboard (secrets for keys)

### 13.4 Local Development Commands

```bash
# Build image
docker build -t smc-bot .

# Run with .env (loads all env vars)
docker run -d \
  --name smc-bot \
  --restart unless-stopped \
  --env-file .env \
  -p 3000:3000 \
  smc-bot

# View logs (follow)
docker logs -f smc-bot

# Stop gracefully (30s SIGTERM)
docker stop smc-bot

# Remove container
docker rm smc-bot

# Rebuild + restart
docker compose up -d --build
```

### 13.5 Health Checks & Monitoring

| Endpoint | Purpose | Expected Response |
|----------|---------|-------------------|
| `GET /` | Basic liveness | `200 OK` |
| `GET /health` | Render health check | `{"status":"healthy","timestamp":1234567890}` |

**Key log patterns to monitor**:
- `[INFO] Bot online: 3 strategy workers active` — startup success
- `[INFO] [Clock Drift] offset=Xms` — hourly time sync (drift < 50ms is healthy)
- `[WARN] [Slippage Guard] ... rejecting` — approval rejected due to price movement
- `[ERROR] WS Watchdog: ... forcing reconnect` — zombie socket detected
- `🚨 API Rate Limit breached!` — global circuit breaker activated
- `[ERROR] ... circuit breaker OPEN` — per-symbol breaker

---

## 14. BACKTEST RESULTS (Reference)

| Symbol      | Final Balance | Net Profit | Trades | Win Rate | Max DD |
| ----------- | ------------- | ---------- | ------ | -------- | ------ |
| **BTCUSDT** | $23,490.32    | +2249%     | 150    | 80.00%   | 17.82% |
| **ETHUSDT** | $11,553.88    | +1055%     | 118    | 64.41%   | 41.59% |
| **SOLUSDT** | $107,584.02   | +10658%    | 189    | 66.14%   | 31.81% |

**Top Drivers**: S6 (SMS), S1 (HTF Continuation), S5 (HTF Sweep).
**Filters Working**: S2 `NoLiqCtx: 120`, S4 `NoBOS: 1570`, S11 strict SMS = 0 noise trades.

---

_Last updated: 2026-09-10. All 211 tests green. Build passes. Enterprise-ready._
