# CRYPTO BOT SMC — ARCHITECTURAL SPECIFICATION (v2026-10-21)

> **Single source of truth for any agent or engineer working on this codebase.**
> Every architectural decision, invariant, and convention is documented here.
> Every failure mode that cost real money is recorded in §16 as Root Cause → Fix → Rule.
> If it is not in this file, it does not exist.

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

### 1.1 V5 Matrix — Sniper Mode (Single-Pass Execution)

| Layer | Technology | Description |
|-------|------------|-------------|
| **Radar (LTF)** | 15m/4H candles | Builds macro context (PDH/PDL/PWH/PWL, HTF sweeps) consumed by Scenario 12 |
| **Sniper (1m)** | 1m candles | Every 1m close re-evaluates Scenario 12 (Sniper Touch): per-CHoCH sweep pairing → 1m CHoCH → OB proximity |
| **Execution** | Smart Pullback | On a valid 1m CHoCH: `idealEntry = OB midpoint`; SL under the 1m extreme; standard Market/Limit logic |

**State**: the live engine enters `ENTRY_STAGED` directly from `SCANNING` — Scenario 12 performs the radar and sniper checks in a single router pass. `StrategyState.SNIPER_MODE` and `_activeSniperZone` exist in `types.ts` / `StrategyEngine` as **reserved scaffolding** for a future two-phase split and are never entered by the current live path.

**Invariant**: Scenario 12 is the only producer of 1m Sniper entries. It requires the macro level to have been swept **before** the triggering CHoCH (causality) and measures OB proximity from the OB midpoint (Invariant 51).

### 1.2 Dual-Mode Architecture (V4 Classic & V5 Sniper)

The codebase now supports **two distinct operational modes** running from the same codebase, controlled by `ENABLE_SNIPER_MODE`:

| Aspect | **V4 Classic (ENABLE_SNIPER_MODE=false)** | **V5 Sniper (ENABLE_SNIPER_MODE=true)** |
|--------|-------------------------------------------|-----------------------------------------|
| **Timeframes** | 15m LTF / 4H HTF | 1m entry / 15m + 4H macro context |
| **Entry Logic** | Close of 15m signal candle | 1m CHoCH after a macro sweep, near its OB midpoint |
| **Scenarios** | **15** (Volatility Squeeze; 15m Classic) | **12** (Sniper Touch) |
| **State Machine** | SCANNING → ENTRY_STAGED → IN_TRADE | SCANNING → ENTRY_STAGED → IN_TRADE (Scenario 12 on 1m closes) |
| **WS Subscription** | 15m, 240m | 1m, 15m, 240m |
| **Killzone** | London/NY only | London/NY only (enforced in Scenario 12) |
| **Cooldown** | After SL only (loss) | After SL only (loss) |

**Critical Invariant**: V4 and V5 **MUST NOT** run on the same process/instance. The `IN_TRADE` state machine is per-symbol and mutually exclusive. Running both modes simultaneously would cause state conflicts, double position risk, and `IN_TRADE` blocking.

> **Scenario 13 is ARCHIVED** (v2026-10-23): the Top-Down Order Flow implementation moved to `src/engine/scenarios/archive/Scenario13_TopDownOrderFlow.ts` and is no longer registered in the router. Scenario 13 remains invalid in global and per-symbol scenario lists; Scenario 15 is registered as a separate 15m Classic strategy. The archived module still compiles and its test suite still runs (`tests/scenarios/archive/`), so the design remains available for future revival.

### 1.3 Deployment Strategy (Sub-accounts)

To run V4 Classic and V5 Sniper simultaneously, **complete infrastructure separation** is required:

| Component | V4 Instance (Classic) | V5 Instance (Sniper) |
|-----------|----------------------|----------------------|
| **Process** | Separate Node.js process | Separate Node.js process |
| **Database** | Separate Supabase project/schema | Separate Supabase project/schema |
| **Telegram Bot** | Separate bot token & chat | Separate bot token & chat |
| **Bybit Account** | Sub-account A (isolated margin) | Sub-account B (isolated margin) |
| **WebSocket** | Subscribes 15m, 240m | Subscribes 1m, 15m, 240m |
| **State Machine** | Independent `IN_TRADE` | Independent `IN_TRADE` |

**Why Required**: The `IN_TRADE` state machine is per-symbol and mutually exclusive per process. Running both modes on the same instance would cause:
- `IN_TRADE` blocking across modes (V4 holds position → V5 blocked, or vice versa)
- Double position risk on same symbol
- State corruption from shared `StrategyEngine` instances
- DB conflicts from concurrent `trades` table writes

**Deployment Pattern**: Two services from the same Docker image, each with its own frozen profile file. Both profiles are **secret-free**: credentials are injected by the platform (Render dashboard, Docker `env_file` chain, systemd `EnvironmentFile`) and `loadConfig()` hard-fails when any of the six is missing.

```bash
# V4 Classic Tank (.env.subaru) — Scenarios 1 + 5 + 14 + 15
SYMBOLS=BTCUSDT,ETHUSDT,SOLUSDT
ENABLE_SNIPER_MODE=false
ACTIVE_SCENARIOS=1,5,14,15
LTF_TIMEFRAME=15
HTF_TIMEFRAME=240
HISTORY_CANDLES=200
MACRO_CANDLES=1000
COOLDOWN_CANDLES=16
LIMIT_EXPIRATION_CANDLES=6
ENABLE_DYNAMIC_TP=true
DYNAMIC_TP_MIN_RR=1.5
DYNAMIC_TP_MAX_RR=6.0
SMC_SL_ATR_OFFSET=0.5
SMC_DISPLACEMENT_MULTIPLIER=1.5
SMART_ENTRY_THRESHOLD_PCT=0.15
PREFLIGHT_BUFFER_PCT=0.05
ENABLE_FUNDING_MONITOR=true
# No SCENARIOS_<SYMBOL>: ACTIVE_SCENARIOS=1,5,14,15 applies to all three symbols, and an
# override would NARROW a symbol rather than extend the global list.
# No MIN_NET_RR / MIN_VOLATILITY_FEE_RATIO / MIN_TP_DISTANCE_PCT: S12-only gates.

# V5 Sniper (.env.emilia) — Scenario 12 only
SYMBOLS=NEARUSDT,APTUSDT
ENABLE_SNIPER_MODE=true
ACTIVE_SCENARIOS=12
ENABLE_DYNAMIC_TP=true
DYNAMIC_TP_MIN_RR=1.5
DYNAMIC_TP_MAX_RR=6.0
S12_SESSION_SWEEPS=true
S12_EQH_EQL_SWEEPS=true
MIN_NET_RR=1.5
MIN_VOLATILITY_FEE_RATIO=1.5
SMC_SWEEP_MIN_WICK_RATIO=0.25
SMC_SL_ATR_OFFSET=0.5
MIN_TP_DISTANCE_PCT=0.0035
SNIPER_LIMIT_EXPIRATION_CANDLES=15
SMC_SL_ATR_OFFSET_APTUSDT=0.60
SNIPER_LIMIT_EXPIRATION_CANDLES_APTUSDT=25
MIN_VOLATILITY_FEE_RATIO_NEARUSDT=1.0
MIN_NET_RR_NEARUSDT=1.0
ENABLE_FUNDING_MONITOR=false
```

**Profile invariants**:
1. Never copy a secret into `.env.subaru` / `.env.emilia` — they are templates, and the repo convention is that only `.env.example` is tracked (`.env` and `.env.*` are gitignored).
2. Never let a Classic deployment carry S12-only knobs (`MIN_NET_RR`, `MIN_VOLATILITY_FEE_RATIO`, `MIN_TP_DISTANCE_PCT`, `S12_*`, `SNIPER_*`). They are evaluated **only** inside Scenario 12, so listing them in a Tank profile is dead configuration that reads as protection (§7.13.5).
3. `SNIPER_LIMIT_EXPIRATION_CANDLES_<SYMBOL>` is resolved through `resolveLimitExpirationCandles()`; confirm the resolved minutes in the run log rather than trusting the file (§7.13.3).
4. `MIN_VOLATILITY_FEE_RATIO_NEARUSDT=1.0` + `MIN_NET_RR_NEARUSDT=1.0` is the **audited** NEAR calibration (§7.23). **Both** knobs are required: the volatility gate alone measures +14.87%, the pair together +22.40%. They exist so the global `1.5` shields keep covering APTUSDT while NEAR trades at the settings the 180-day endurance run actually validated. A per-symbol override is the only sanctioned way to relax a P0 shield for one pair — never lower the global. The same keys live in the local `.env`, where they are inert for the live Classic profile but **are** consumed by `npm run backtest -- NEARUSDT`.

---

## 2. PROJECT STRUCTURE

```
src/
├── api/              # Bybit REST + WebSocket clients
│   ├── bybitClient.ts     # REST with Circuit Breaker, Retry, ClosedPnL
│   └── wsClient.ts        # WS with 3-min Watchdog, 5s reconnect, custom logger
├── backtest/         # Historical simulation engine
│   ├── run.ts             # CLI entry, multi-symbol, BACKTEST_DAYS window
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
│   ├── scenarioRouter.ts  # Evaluates 12 scenarios, filters mitigatedZones/Structures
│   ├── pendingTradeManager.ts  # Manual approval queue + Slippage Guard
│   ├── baseScenario.ts    # Shared calculateLevels() — single SL source of truth
│   ├── tpResolver.ts      # Brain Module 3: structural TP resolution (major/minor)
│   ├── brain/
│   │   ├── htfRoadmap.ts      # Brain Module 1: 4H range, bias, primary target
│   │   └── volumeExhaustion.ts # Brain Module 2: 15m pullback exhaustion + reaction
│   └── scenarios/         # 12 scenario implementations (S1–S12) + archive/ (S13)
├── execution/
│   └── executionEngine.ts # Market order + TP/SL placement
├── feed/
│   └── candleFeed.ts      # 15m/4H buffers, live price from forming candle
├── risk/
│   ├── riskManager.ts     # Position sizing, Drawdown Guard, minOrderQty
│   └── tradeManager.ts    # Adaptive Fractioning logic (partial close, SL trailing)
├── services/
│   ├── backupService.ts   # 24h auto-backup + /backup cmd (Blob+fetch)
│   ├── newsService.ts     # News Embargo filter (FXMacroData API)
│   └── fundingMonitorService.ts  # Delta-neutral funding rate monitor
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

**Order Idempotency** (`bybitClient.ts:372`): `orderLinkId` passed to `submitOrder()` in `placeMarketOrderWithTpsl()` — prevents duplicate orders on retry via `executeWithRetry()`.

### 3.3 Daily Clock Sync — `src/index.ts` + `src/bootstrap/reconciliation.ts`

- **Macro Refresher (00:00 UTC)**: `client.syncServerTime()` before `refreshMacroContext()`.
- **Reconciliation Loop (every 10 min)**: Syncs time **every hour** (`CLOCK_DRIFT_SYNC_INTERVAL_MS = 3_600_000`).
- Logs: `[Clock Drift] offset=Xms roundTrip=Yms`. Prevents `recvWindow` errors after weeks of uptime.

### 3.4 Reconciliation Loop — `src/bootstrap/reconciliation.ts`

- Runs every **10 minutes**.
- **Step 1**: For each `IN_TRADE` engine → `getOpenPositions()` → if gone, force `SCANNING`.
  - **Limit Order Awareness** (`v2026-10-06`): Before force-reset `IN_TRADE → SCANNING`, checks for active Limit orders (`status === 'New' | 'PartiallyFilled'`) via `getOpenOrders()` (the client wrapper over REST `getActiveOrders`). If active Limit orders exist, **skips force-reset** to prevent race conditions and signal duplication.
  - **Limit Order Expiration & Cancellation** (`v2026-10-13`, hardened `v2026-10-21`): Checks for expired Limit orders using a dynamic timeframe (1m for Sniper Mode, LTF for Classic).
    - `status === 'New'` (never filled) → cancel on the exchange, then `closeTrade(orderId, '0', price, now, 'CANCELLED')`. This prevents Step 2 from hallucinating PnL.
    - `status === 'PartiallyFilled'` → cancel only the **resting remainder**; the filled portion MUST remain `IN_TRADE` and be managed by Adaptive Fractioning (Invariant 53). Closing the whole record as `CANCELLED` is forbidden.
- **Step 2**: `db.getAllOpenTrades()` → for each, check exchange position → if missing, `reconcileWithTrade()` with zoneDetails for mitigatedZones tracking.
  - **Limit Order Silent Skip**: If an active Limit order is found, silently skips force-reset (already logged in Step 1 to prevent duplicate logs).
- **Limit Fallback Prevention** (`v2026-10-13`): In `reconcileWithTrade()`, if `getClosedPnl` returns empty and `trade.order_type === 'Limit'`, the system **MUST assume it was cancelled unfilled** and record `0` PnL with `CANCELLED` reason. Mathematical PnL fallback is **strictly reserved for Market orders**.
- Idempotent, safe to run concurrently with WS events.

### 3.5 Accurate PnL with Funding — `src/engine/strategyEngine.ts` + `src/api/bybitClient.ts`

**On trade close (WS execution/position OR ReconciliationLoop):**

1. Wait **2.5 seconds** for exchange to finalize.
2. `GET /v5/position/closed-pnl` (`getClosedPnl(symbol, startTime, endTime)`).
3. **Match by symbol + `createdTime`** — filter all closedPnl records where `symbol === trade.symbol` AND `createdTime >= trade.openedAt` (Bybit closes position with a new order, different orderId).
4. **Sum all `closedPnl` values** using `Decimal.reduce()` — critical for Adaptive Fractioning (partial closes) where one trade generates multiple closedPnl records.
5. Use `avgExitPrice` from the record with latest `createdTime` (last partial close).
6. Update `trades.pnl`, `trades.exit_price` in DB.
7. Log: `Using exchange closedPnl (with funding/fees): -12.3456 vs calculated: -11.9876`.
8. **Fallback**: calculated PnL from executions if closedPnL unavailable.

> **Important**: Uses `filter().reduce()` instead of `find()` to correctly sum PnL across multiple partial closes (Adaptive Fractioning).

> **Critical — Fallback PnL Uses WS Execution Price** (`v2026-10-14`): If `getClosedPnl` from the REST API is delayed or empty for a Market/SL close, the mathematical fallback MUST use the `execPrice` extracted directly from the WebSocket `Execution` payload (passed down via `onExchangePositionClosed(null, execPrice)`). Using the current market price (`getLivePrice()`) is strictly prohibited as it causes inaccurate PnL due to network delay/volatility.

### 3.6 Robust Bybit V5 Position Parsing — `src/engine/strategyEngine.ts:42-55`

**Problem**: Bybit V5 WebSocket position updates send position sizes as strings (`"0"`, `"0.000"`, `"0.0000"`, `""`) or side `'None'`. Native `Number()` comparison can fail due to precision or string falsiness; `new Decimal(sizeStr).isZero()` with fallback is required.

**Solution**: In `parseClosedPositions()` (`src/engine/strategyEngine.ts:42-55`), position closure is detected by:

```typescript
const sizeStr = String(item.size ?? '0');
let isZeroSize = false;
try {
  isZeroSize = new Decimal(sizeStr).isZero();
} catch {
  isZeroSize = Number(sizeStr) === 0;
}

const isClosedSide = item.side === 'None' || !item.side;

if (isZeroSize || isClosedSide) {
  // Position is closed
}
```

**Rule**: Always parse Bybit V5 position sizes using `Decimal.isZero()` with fallback — never rely on `Number()` alone.

### 3.6.1 Guaranteed State Reset on Position Close — `src/engine/strategyEngine.ts:447-556` — **NEW v2026-10-08**

**Problem**: When `onExchangePositionClosed` processes a position close event (WS execution), any failure in `getClosedPnl()`, DB writes, or Telegram notifications would leave the engine stuck in `IN_TRADE` until the ReconciliationLoop forcibly reset it (up to 10 minutes).

**Solution**: All PnL calculation, DB operations, and notifications are wrapped in a `try/finally` block:

```typescript
try {
  // === ACCURATE PNL: Fetch real closed PnL from Bybit ===
  const closedPnls = await this.deps.client.getClosedPnl(...);
  // ... calculation, DB writes, notifications ...
} catch (error) {
  logger.error(`[${this.symbol}] Failed to process closed position: ${error}`);
} finally {
  // GUARANTEED STATE RESET — always executes
  this.transition(StrategyState.SCANNING);
  logger.info(`[${this.symbol}] Position closed processing finished. State reset to SCANNING.`);
}
```

**Invariant**: `this.transition(StrategyState.SCANNING)` in `finally` block **always executes**, regardless of:
- Network errors calling Bybit `getClosedPnl`
- Database connection failures
- Telegram notification timeouts
- Any uncaught exception in the try block

This eliminates dependency on ReconciliationLoop for recovery and ensures the bot can immediately scan for new setups after any position close.

### 3.7 Unhandled Promise Rejection Guards — `src/index.ts` + `src/engine/strategyEngine.ts` — **NEW v2026-10-11**

**Problem**: High-frequency WebSocket streams (klines, positions, executions) can generate thousands of async callbacks per minute. If any async handler (`onKline`, `onPosition`, `onExecution`) throws an unhandled rejection, Node.js will crash the entire process — catastrophic for a 14-day Burn-In.

**Solution**: Every WebSocket callback and event handler is strictly wrapped:

1. **In `src/index.ts` (WS registration)**:
   ```typescript
   ws.onKline((update) => {
     const engine = engines.find((candidate) => candidate.symbol === update.symbol);
     if (engine) {
       void engine.handleKline(update).catch((error) => {
         logger.error(`Unhandled error in handleKline for ${update.symbol}: ${error instanceof Error ? error.message : String(error)}`);
       });
     }
   });
   ws.onPosition((payload) => {
     for (const engine of engines) {
       void engine.handlePositionPayload(payload).catch((error) => {
         logger.error(`Unhandled error in handlePositionPayload for ${engine.symbol}: ${error instanceof Error ? error.message : String(error)}`);
       });
     }
   });
   ```

2. **In `src/engine/strategyEngine.ts` (handler implementations)**:
   - `handleKline()`: Individual `try/catch` for `checkAndManagePosition()` and `process('1')` on 1m candles.
   - `handlePositionPayload()`: `try/catch` for `parseClosedPositions()` before `onExchangePositionClosed()`.

**Invariant**: No async WS callback is ever left without a `.catch()` or `try/catch`. Any error is logged, never crashes the process.

### 3.8 Bybit V5 WebSocket Quirks (Execution Channel) — **NEW v2026-10-12**

**Problem**: Bybit V5 frequently omits `Position` channel updates when a position is closed via Stop-Loss or Take-Profit. Instead, it sends an `Execution` event (`topic: "execution", execType: "Trade", closedSize > 0`). If the bot only listens to `ws.onPosition`, it will miss SL/TP closures entirely, leaving the engine stuck in `IN_TRADE` until the ReconciliationLoop forcibly resets it.

**Solution**: The bot MUST listen to `ws.onExecution` and route payloads to `engine.handleExecutionPayload()`. This handler checks for `execType === 'Trade'` and `closedSize > 0`, then triggers `onExchangePositionClosed()` to fetch real PnL via `getClosedPnl()`.

**Implementation** (`src/index.ts` + `src/engine/strategyEngine.ts`):

1. **In `src/index.ts` (WS registration)**:
   ```typescript
   ws.onExecution((payload) => {
     for (const engine of engines) {
       void engine.handleExecutionPayload(payload).catch((error) => {
         logger.error(`Unhandled error in handleExecutionPayload for ${engine.symbol}: ${error instanceof Error ? error.message : String(error)}`);
       });
     }
   });
   ```

2. **In `src/engine/strategyEngine.ts` (new handler)**:
   ```typescript
   async handleExecutionPayload(payload: unknown): Promise<void> {
     if (this.state !== StrategyState.IN_TRADE) return;
     try {
       const items = Array.isArray(payload) ? payload : [payload];
       for (const item of items) {
         if (item.symbol === this.symbol && item.execType === 'Trade') {
           const closedSize = new Decimal(item.closedSize ?? '0');
           if (closedSize.gt(0)) {
             logger.info(`[${this.symbol}] Execution WS: Position closed (size=${closedSize}), triggering reconciliation`);
             await this.onExchangePositionClosed(null);
             return;
           }
         }
       }
     } catch (error) {
       logger.error(`${this.symbol}: handleExecutionPayload error: ${error instanceof Error ? error.message : String(error)}`);
     }
   }
   ```

**Invariant**: The engine MUST monitor BOTH `Position` and `Execution` WS topics to reliably detect position closures. Relying solely on `Position` channel will miss SL/TP closures.

---

### 3.9 Global Error Monitoring, Notification Toggle & Stateful Degradation Alerts — **NEW v2026-10-19**

#### 3.9.1 Winston Telegram Transport (`src/utils/logger.ts`)

Every `logger.error(...)` in the codebase is routed to Telegram without per-call-site wiring:

1. `setLoggerTelegramHook(fn)` stores a module-local callback (called once in `src/index.ts`: `setLoggerTelegramHook((msg) => notifier.notifyCriticalError(msg).catch(() => {}))`).
2. `class TelegramTransport extends Transport` (from `winston-transport`) is added to the `winston.createLogger` transports array.
3. In `log(info, callback)`: `callback()` is invoked immediately (never stalls the logger), then — **only for `info.level === 'error'`** — the hook is invoked.
4. **Infinite-loop filter (mandatory)**: messages containing `telegram` or `telegraf` (case-insensitive) are dropped. The delivery layer itself logs failures via `logger.error`, so without the filter a Telegram outage would recursively re-send its own failure forever. The hook call is additionally wrapped in `try/catch` so a throwing hook can never break the logging pipeline.

**Invariant**: The hook only ever calls `notifyCriticalError` — it must never be awaited inside `log()`.

#### 3.9.2 Routine Trade Notification Toggle (`ENABLE_TRADE_NOTIFICATIONS`)

- Parsed in `src/config/env.ts` as `enableTradeNotifications` (default `true`), injected into the notifier via `notifier.setBotConfig(config)`.
- `notifySetupFound`, `notifyOrderOpened` and `notifyTradeClosed` (including the `CANCELLED` Limit branch) return `true` immediately when the toggle is off.
- The toggle **never** gates `notifyCriticalError` or the global error hook — muting trade spam keeps all error alerts flowing.

#### 3.9.3 Stateful Degradation Alerts (REST + WS)

Both channels implement the same edge-triggered state machine: **degraded (red) → first success (green)**, one alert per episode.

| Layer | Degradation trigger | Recovery trigger | Recovery message |
|-------|--------------------|------------------|------------------|
| **REST** (`bybitClient.ts`) | `executeWithRetry` exhausts all retries (`attempt >= MAX_RETRIES`) → `isApiDegraded = true` + `logger.error('REST API Degradation: Failed after ${maxRetries} attempts.')` | First successful operation in `executeWithRetry` → `isApiDegraded = false` | `🟢 API Connection Recovered` via `notifier.sendMessage` |
| **WS** (`wsClient.ts`) | Watchdog timeout (3 min silence) → `isWsDegraded = true` + `logger.error('[WS Watchdog] ...')` | `reconnected` → resync promise resolves successfully → `isWsDegraded = false` | `🟢 WS Connection Recovered` via `notifier.sendMessage` |

**Notes**: the degradation marker is only set when retries are actually exhausted (a non-retryable business error on the first attempt does not mark degradation). `markApiDegraded` is edge-triggered — one Telegram alert per episode, not one per failed call. Recovery notifications use `.catch(() => {})` (fire-and-forget).

#### 3.9.4 Fatal Crash Guard (`src/index.ts`)

`setupGlobalErrorHandlers()` wraps both `uncaughtException` and `unhandledRejection`, sends `notifyCriticalError` through `Promise.race` with a **3000 ms timeout**, and only then calls `process.exit(1)` — guaranteed SOS delivery attempt before the process dies.

#### 3.9.5 Backtest Chunk Retry Guard (`src/backtest/historyLoader.ts`)

- Each pagination chunk (critical for 1m history — hundreds of requests) gets **8 attempts with a 3 s pause**, logging `[WARN] Fetch chunk failed, retrying...`.
- If a chunk still fails, the loader logs the permanent failure and **breaks pagination instead of crashing the backtest** — already-collected candles are merged with cache and returned (partial history; run.ts logs the shortened window).
- An empty result never overwrites the cache file (`No candles fetched ... cache file left untouched`), so a failed fetch cannot poison the cache.

---

## 4. TELEGRAM UI & SECURITY

### 4.1 Security Middleware — `src/telegram/notifier.ts:197-204`

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
5. **On Reject / Timeout**: Bot **MUST** call `burnSetup()` to prevent spam cycles — zone + structure added to mitigation lists, state → `SCANNING`.

### 4.4 Dynamic Approval (Anti-Slippage) — **NEW v2026-09-30** (Updated v2026-10-12: Slippage Guard Paradox Fix)

**Problem**: In manual approval mode (`AUTO_TRADING=false`), price can move significantly between signal generation and user clicking "Approve". The old logic always sent a Market order on approval, causing slippage.

**Solution**: Order type (Market vs Limit) is decided **AT APPROVAL TIME** by comparing live price vs `idealEntry` (zone equilibrium from scenario geometry):

| Condition | Order Type | Limit Price |
|-----------|------------|-------------|
| `|idealEntry - livePrice| / idealEntry ≤ 0.15%` | **Market** (IOC) | — |
| `|idealEntry - livePrice| / idealEntry > 0.15%` | **Limit** (GTC) | `idealEntry` |

**Implementation** (`src/engine/pendingTradeManager.ts`):
- `queueTrade()` stores `idealEntry` alongside setup.
- `handleApproval()` fetches live price via `priceProvider()` (injected from `StrategyEngine` → `candleFeed.getCurrentLivePrice()`).
- Returns `{ approved: true, orderType: 'Market'|'Limit', limitPrice?: string }`.
- **Slippage Guard still runs**: If live price ≥ TP → reject; if > 0.2% toward TP → reject.

**Slippage Guard Paradox Fix (Auto-Trading Path)** — **NEW v2026-10-12**:
In auto-trading mode (`executeStagedEntry`), the logic order was corrected to eliminate the **Slippage Guard Paradox**:
1. **Market vs Limit determination occurs FIRST** (at live tick).
2. **Pre-flight SL breach and TP reached checks remain UNCONDITIONAL** for all orders.
3. The **0.2% Slippage Guard (deviation toward TP) is applied ONLY to Market orders**.
4. **Limit orders bypass the slippage guard** — they wait for a pullback by design; a slippage check would incorrectly abort valid pullback setups.

| Order Type | SL Breach Check | TP Reached Check | 0.2% Slippage Guard |
|------------|-----------------|------------------|---------------------|
| **Market** | ✅ Unconditional | ✅ Unconditional | ✅ Applied (>0.2% aborts) |
| **Limit** | ✅ Unconditional | ✅ Unconditional | ❌ Bypassed (waits for pullback) |

**Invariant**: Market vs Limit decision is **purely at live tick** — no pre-commitment at signal time. Slippage Guard is **context-aware**: Market orders only.

### 4.4.1 Discount Trap Fix — **NEW v2026-10-14**

**Problem**: When the live price is BETTER than the ideal entry (a "discount"), the old logic could still place a Limit order at the ideal entry price. This caused the Limit order to be immediately filled at the current market price (which is better than the limit price), but the attached Stop-Loss was calculated based on the ideal entry price, not the actual fill price. This violated Stop-Loss geometry and caused Bybit Error `[10001]` (StopLoss set for Buy position should be lower than base_price).

**Solution**: In `executeStagedEntry()`, the Market vs Limit decision now checks for a discount FIRST, before the 0.15% threshold check:

1. **Discount Check (FIRST)**: If live price is BETTER than ideal entry (discount), ALWAYS use **Market** order — never Limit.
2. **Threshold Check (SECOND)**: If no discount, apply the 0.15% threshold — Market if within threshold, Limit if beyond.
3. **Pre-flight SL/TP checks**: Remain UNCONDITIONAL for all orders.

```typescript
// Check if current price is BETTER than ideal entry (discount)
const isDiscount = isLong ? livePrice.lte(idealEntry) : livePrice.gte(idealEntry);

// ALWAYS use Market if discount exists, OR if within threshold
const useMarket = isDiscount || priceDiffPct.lte(threshold);
```

**Result**: Limit orders are ONLY placed when price has moved AWAY from ideal entry (premium). At a discount, Market orders execute immediately at the favorable price with correct SL/TP geometry.

### 4.4.2 Pre-flight Spread Buffer — **NEW v2026-10-14**

**Problem**: When placing Market orders with attached TP/SL, Bybit validates that the SL is properly positioned relative to the execution price. During volatile moments, the order book spread can cause the live price to be within the spread of the SL, causing Bybit to reject the order with error `[10001]` (StopLoss should be greater/lower than base_price).

**Solution**: Added configurable `PREFLIGHT_BUFFER_PCT` (default 0.05%) that adds a safety margin to the Pre-flight SL check:

```typescript
// 0.05% spread buffer (configurable via PREFLIGHT_BUFFER_PCT)
const slBuffer = livePrice.mul(this.deps.config.preflightBufferPct);
const slBreached = isLong 
  ? livePrice.lte(sl.plus(slBuffer))   // Long: SL + buffer
  : livePrice.gte(sl.minus(slBuffer)); // Short: SL - buffer
```

The buffer creates a safety margin between the live price and the SL, preventing rejections due to order book spread. The default 0.05% is conservative for liquid pairs; adjust via `PREFLIGHT_BUFFER_PCT` in `.env` for less liquid markets.

### 4.4.3 Directional Slippage Guard — Manual Path — **NEW v2026-10-21**

**Problem**: The manual approval path could diverge from `executeStagedEntry()` — a guard built on absolute deviation (`|current − entry|`) rejects *favorable* movement (the Discount Trap) and misreads adverse movement as progress. Parity with the auto path is mandatory: both must measure movement **toward TP only**.

**Solution** (`src/engine/pendingTradeManager.ts:handleApproval`): after the Market/Limit decision is computed (`isDiscount || priceDiffPct <= smartThreshold`), the guard runs **only when `useMarketOrder` is true** (Limit orders wait for a pullback by design — Invariant 38) and uses a signed vector:

```typescript
const plannedEntry = new Decimal(pending.entry);
if (useMarketOrder && plannedEntry.gt(0)) {
  const movedTowardTp = isLong
    ? currentPrice.minus(plannedEntry)
    : plannedEntry.minus(currentPrice);

  if (movedTowardTp.gt(0)) {
    const deviationPct = movedTowardTp.div(plannedEntry);
    if (deviationPct.gt(new Decimal('0.002'))) {
      // > 0.2% toward TP → delete pending, resolve(false), reject
    }
  }
}
```

**Rules**:
1. **Vector, not magnitude** — `movedTowardTp.gt(0)` gates the check. A discount yields a negative vector and is never rejected (Invariant 37).
2. **`Math.abs()` / `.abs()` is FORBIDDEN** for this guard. An absolute value cannot distinguish "price ran to TP" (bad R:R) from "price gave a better entry" (desirable).
3. **Limit orders bypass the guard** (Invariant 38). Pre-flight SL/TP checks remain unconditional for all order types.
4. **Denominator** is `pending.entry`; the Market/Limit decision divides by `idealEntry`. They coincide today because `queueForApproval()` passes `result.levels.entry` as both `entry` and `idealEntry` — any future divergence must be a deliberate, tested decision.
5. Threshold `0.002` (0.2%) is duplicated in the auto path; changing one without the other breaks parity.

**Invariant**: Manual and auto slippage protection MUST share identical semantics — directional, Market-only, 0.2% of the planned entry.

---

### 4.6 Telegram Localization & Notification Hygiene — **NEW v2026-10-13** (Updated v2026-10-16)

**English-Only Localization Rule**: All user-facing strings, logs, and Telegram messages MUST be strictly in **English**. No Cyrillic/Russian strings are allowed in the codebase. All user-facing text in `src/telegram/notifier.ts` has been translated to English (e.g., "Position Closed", "Setup Found", "Critical Error").

**Cancelled Limit Order Notification**: Expired/Cancelled Limit orders trigger a dedicated, distinct Telegram notification (`🗑️ Limit Order Cancelled`) to formally close the loop on previously broadcasted `🚀 Order Opened` alerts, ensuring the user is never left guessing the status of an unfilled limit. This replaced the former silent suppression — it is a distinct, minimalist message with no PnL line (cancelled limits have 0 PnL by definition).

**Implementation** (`src/telegram/notifier.ts:575-579`):
```typescript
async notifyTradeClosed(
  symbol: string,
  pnl: string,
  _pnlPercent: string,
  reason?: string,
): Promise<boolean> {
  // Cancelled limit orders: send a distinct message so the "Order Opened" loop gets closed
  if (reason === 'CANCELLED') {
    const text = `🗑️ <b>Limit Order Cancelled</b>\n\n📊 ${symbol}\n⏳ Reason: Expired / Timeout`;
    return this.sendMessage(text);
  }
  // ... rest of notification logic
}
```

**Silent Micro-Rejections**: Setups that never reach the exchange (Slippage Guard aborts, Pre-flight DEAD setups, ghost-setup burns) are logged server-side ONLY — they intentionally produce no Telegram message to keep the chat clean.

**Minimalist Trade Closure Notifications**: Trade closure notifications are kept strictly minimalist, displaying only the exact USDT PnL formatted to 2 decimal places (e.g., `✅ PnL: +60.70 USDT`). PnL percentage metrics have been removed from Telegram alerts to prevent `DecimalError` parsing bugs and UI clutter.

Breakeven logic (SL → entry at fixed R-multiple) has been **replaced by Adaptive Fractioning** (`src/risk/tradeManager.ts`). 

The new system uses milestone-based management:
- **Classic (TotalR < 4)**: Single milestone at 66% progress → `move_sl_to_entry`
- **Sniper (TotalR ≥ 4)**: Milestone 1 at 33% → `close_partial_25` + `move_sl_to_entry`; Milestone 2 at 66% → `close_partial_50` + `trail_sl_to_profit`

The legacy `BREAKEVEN_RR_TRIGGER` config variable has been **removed** from codebase and `.env` files. It no longer affects Live or Backtest behavior.

### 4.7 Telegram UI Reflection on Order Failure — **NEW v2026-10-08**

**Problem**: If `executionEngine.execute()` returns an error (order rejected by exchange), Telegram still showed `[ ✅ APPROVED ]` because `handleTradeApproval` did not propagate the failure to the UI handler.

**Solution**: In `handleTradeApproval` (`src/engine/strategyEngine.ts:407-414`), on execution failure:
1. `burnSetup()` is called to prevent ghost signals (zone + structure added to mitigation lists)
2. State transitions to `SCANNING`
3. `throw new Error(\`Exchange Error: ${result.reason}\`)` propagates to Telegram handler

The Telegram callback handler in `src/index.ts:121-139` catches this error and updates the user's message to `[ ❌ SYSTEM ERROR ]`, preventing false `[ ✅ APPROVED ]` display.

**Flow**:
```
User clicks ✅ Approve
       ↓
executionEngine.execute() → fails (e.g., insufficient balance, rate limit)
       ↓
StrategyEngine.handleTradeApproval:
  - burnSetup() → zone/structure mitigation
  - transition(SCANNING)
  - throw Error("Exchange Error: ...")
       ↓
Telegram handler (index.ts) catches error
       ↓
ctx.editMessageText() → changes button text to [ ❌ SYSTEM ERROR ]
```

**Invariant**: Telegram UI **always reflects actual exchange result** — no false approvals.

---

## 5. RISK MANAGEMENT — `src/risk/riskManager.ts`

| Guard                | Logic                                                                                 | Config                                        |
| -------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------- |
| **Drawdown Guard**   | 3 consecutive losing trades → risk reduced to `REDUCED_RISK_PERCENT` (default **1%**) | `RISK_PERCENT` (base), `REDUCED_RISK_PERCENT` |
| **Position Sizing**  | `qty = (balance * risk%) / SL_distance` → rounded to `qtyStep`                        | `leverage` (default 10x) via isolated margin  |
| **Min Order Qty**    | If `rounded_qty < minOrderQty` → **ABORT** + `[WARN]` + state→`SCANNING`              | Exchange `minOrderQty`                        |
| **Max Order Qty**    | If `qty > maxOrderQty` → **ABORT**                                                    | Exchange `maxOrderQty`                        |
| **Micro-Stop Guard** | SL distance must be **> 0.1%** (prevents noise stops)                                 | Hardcoded in `RiskManager`                    |
| **Leverage Cap**     | `maxAllowedQty = marginBuffer * leverage / entry` — caps qty if stop is too tight     | `LEVERAGE` from config                        |
| **No Double Rounding** | Entry/SL passed directly to `formatPrice()` — no intermediate `roundDownToStep()`     | Instrument `tickSize`                         |
| **TP From Scenario** | Takes pre-calculated `takeProfitRaw` from `BaseScenario.calculateLevels()` — no RR recalc | N/A                                           |

**Leverage**: Set once at bootstrap via `setupMarginAndLeverage(symbol, leverage)` (isolated margin).

### 5.1 RiskManager Hardening (v2026-09-21)

All three execution pipeline fixes applied in single pass:

1. **Order Idempotency** (`bybitClient.ts:372`): `orderLinkId` now passed to `submitOrder()` — prevents duplicate orders on retry via `executeWithRetry()`.

2. **Leverage Cap** (`riskManager.ts:146-155`): `maxAllowedQty = marginBuffer.mul(leverage).div(entryDecimal)`. If `rawQty > maxAllowedQty`, caps it. Prevents "Insufficient Margin" when stop is very tight.

3. **No Double Rounding** (`riskManager.ts:115-116`): Removed `roundDownToStep()` for entry/SL. Now `formatPrice(input.entryPrice, tickSize)` and `formatPrice(input.stopLossRaw, tickSize)` — single precision step.

4. **TP From Scenario** (`riskManager.ts:131`): Removed internal `TAKE_PROFIT_RR_RATIO` recalculation. Takes `input.takeProfitRaw` (already calculated by `BaseScenario.calculateLevels()` with correct geometry). RiskManager only formats via `formatPrice()`.

### 5.2 Bybit API: Position Stop-Loss Management — **v2026-10-03**

**Critical Rule**: To modify Stop-Loss or Take-Profit on an **open position** in Bybit V5, you **MUST** use `setTradingStop` (position-level stop), **NOT** `amendOrder` (which is for pending/conditional orders only).

| Method | Purpose | Use Case |
|--------|---------|----------|
| `amendOrder` | Modify pending/conditional orders | Limit orders, stop orders, take-profit orders that are NOT yet filled |
| `setTradingStop` | Modify SL/TP on **open position** | Moving SL to breakeven, trailing SL, partial close SL adjustment |

**Implementation** (`src/api/bybitClient.ts:558-579`):
```typescript
async setTradingStop(request: { symbol: string; stopLoss?: string; takeProfit?: string }): Promise<void> {
  return this.executeWithRetry(async () => {
    const response = await this.rest.setTradingStop({
      category: 'linear',
      symbol: request.symbol,
      stopLoss: request.stopLoss,
      takeProfit: request.takeProfit,
      positionIdx: 0, // One-Way Mode
    });
    // ...
  }, 'setTradingStop');
}
```

**Usage in Live** (`src/engine/strategyEngine.ts:271-308`): All SL updates (breakeven, trailing, post-partial-close) now use `client.setTradingStop()`.

**Invariant**: `amendOrder` is **never** called for `IN_TRADE` positions. Only `setTradingStop` with `positionIdx: 0`.

### 5.2.1 Bybit V5 Order Placement with TP/SL — **positionIdx: 0 Mandatory** — **v2026-10-11**

**Critical Rule**: When placing orders with attached TP/SL via `submitOrder()` in Bybit V5 (One-Way Mode), you **MUST** explicitly include `positionIdx: 0` in the request payload. This applies to BOTH Market and Limit orders. Without it, the exchange may reject the order or fail to attach the TP/SL correctly.

**Implementation** (`src/api/bybitClient.ts:366-378`, `396-409`):
```typescript
// placeMarketOrderWithTpsl
const response = await this.rest.submitOrder({
  category: 'linear',
  symbol: request.symbol,
  side: request.side,
  orderType: 'Market',
  qty: request.qty,
  timeInForce: 'IOC',
  tpslMode: 'Full',
  stopLoss: request.stopLoss,
  takeProfit: request.takeProfit,
  orderLinkId: request.orderLinkId,
  positionIdx: 0,  // ← MANDATORY for One-Way Mode with TP/SL
});

// placeLimitOrderWithTpsl
const response = await this.rest.submitOrder({
  category: 'linear',
  symbol: request.symbol,
  side: request.side,
  orderType: 'Limit',
  qty: request.qty,
  price: request.price,
  timeInForce: request.timeInForce,
  tpslMode: 'Full',
  stopLoss: request.stopLoss,
  takeProfit: request.takeProfit,
  orderLinkId: request.orderLinkId,
  positionIdx: 0,  // ← MANDATORY for One-Way Mode with TP/SL
});
```

**Invariant**: Every `submitOrder()` call with `tpslMode: 'Full'` MUST include `positionIdx: 0`.

### 5.3 Pre-flight SL Check at Approval & Auto-Execution — **NEW v2026-10-03** (Hardened v2026-10-10)

**Problem**: In manual approval mode (`AUTO_TRADING=false`), price can move significantly between signal generation and user clicking "Approve". If price crosses the calculated SL during this wait, the order would be rejected by Bybit with error [10001] (StopLoss set for Buy position should lower than base_price). The same risk exists in auto-trading mode (`AUTO_TRADING=true`) where `executeStagedEntry()` fires immediately after signal detection.

**Solution**: **Pre-flight SL validation** at two points:
1. **At approval time** (manual mode): Before sending order to ExecutionEngine (in `StrategyEngine.handleTradeApproval`)
2. **At auto-execution time** (auto mode): Inside `executeStagedEntry()` before calling `executionEngine.execute()`

Both paths fetch `getLivePrice()` and validate against the calculated SL. If live price has crossed the SL, the setup is **burned** (zone + structure added to mitigation lists) and state returns to `SCANNING`.

```typescript
// In handleTradeApproval() AND executeStagedEntry()
const currentPrice = this.feedLtf.getCurrentLivePrice();
if (currentPrice) {
  const currentPriceDecimal = new Decimal(currentPrice);
  const slDecimal = new Decimal(this.plan.stopLoss);
  const isLong = this.plan.side === 'Buy';

  if (isLong && currentPriceDecimal.lte(slDecimal)) {
    logger.warn(`[${this.symbol}] Setup DEAD: Live price (${currentPrice}) is already below SL (${this.plan.stopLoss})`);
    this.burnSetup(this.plan);
    this.transition(StrategyState.SCANNING);
    return;
  }
  if (!isLong && currentPriceDecimal.gte(slDecimal)) {
    logger.warn(`[${this.symbol}] Setup DEAD: Live price (${currentPrice}) is already above SL (${this.plan.stopLoss})`);
    this.burnSetup(this.plan);
    this.transition(StrategyState.SCANNING);
    return;
  }
}
```

**Fail-Fast on Execution Failure** (auto-trading path, `executeStagedEntry`): If `executionEngine.execute()` returns `{ ok: false }` or throws, `burnSetup(this.plan)` is **guaranteed** to be called before transitioning to `SCANNING`. This prevents rejection loops (e.g., Bybit error [10001] spam) by immediately burning the zone/structure so the bot doesn't re-detect the dead setup on the next candle.

If price has crossed the SL during approval wait, the setup is **burned** (zone + structure added to mitigation lists) and state returns to `SCANNING`. This prevents the dead setup from being re-detected on the next candle.

### 5.4 State Guard in `handleTradeApproval` — **NEW v2026-10-06**

**Problem**: In manual approval mode (`AUTO_TRADING=false`), a user could click "Approve" on a stale Telegram message after the bot has already moved to a different state (e.g., due to reconciliation, WS position update, or another signal). This would cause the bot to execute an order in an invalid state, potentially resetting `ENTRY_STAGED` back to `SCANNING` or creating duplicate orders.

**Solution**: **State guard** at the start of `handleTradeApproval` — only process approval if the engine is in `ENTRY_STAGED`:

```typescript
async handleTradeApproval(tradeId: string, approved: boolean): Promise<void> {
  // State guard: ignore approvals if not in ENTRY_STAGED
  if (this.state !== StrategyState.ENTRY_STAGED) {
    logger.warn(`[${this.symbol}] Ignored approval for ${tradeId}: bot is in ${this.state}`);
    return;
  }
  // ... rest of approval logic
}
```

**Behavior**: If the bot is in any state other than `ENTRY_STAGED` (e.g., `SCANNING`, `IN_TRADE`, `SNIPER_MODE`), the approval is silently ignored with a warning log. This prevents stale Telegram callbacks from corrupting the state machine.

### 5.5 Concurrency Lock in `process()` — **NEW v2026-10-06**

**Problem**: When 1m and 15m candles close simultaneously, `process()` can be called concurrently. This creates a race condition where:
- The state machine can be corrupted (e.g., `ENTRY_STAGED` reset to `SCANNING`)
- Multiple evaluations can run simultaneously, leading to duplicate signal evaluation
- The state machine can transition to invalid states

**Solution**: **Concurrency lock** (`isProcessing` flag) in the `process()` method:

```typescript
private isProcessing: boolean = false;

private async process(timeframe: Timeframe): Promise<void> {
  // Concurrency lock: prevent race condition between 1m and 15m candle processing
  if (this.isProcessing) return;
  this.isProcessing = true;

  try {
    // Only evaluate on LTF confirmed candles for scenario matching
    const ltfInterval = this.deps.config.ltfTimeframe;
    const isSniper1m = this.deps.config.enableSniperMode && timeframe === '1';
    if (timeframe !== ltfInterval && !isSniper1m) return;

    // Only process in SCANNING state
    if (this.state !== StrategyState.SCANNING) return;

    // ... rest of process() logic
  } finally {
    this.isProcessing = false;
  }
}
```

**Behavior**: 
- First call to `process()` acquires the lock (`isProcessing = true`)
- Subsequent concurrent calls immediately return
- Lock is released in `finally` block, guaranteeing release even on error

This ensures the state machine is never corrupted by concurrent candle processing.

### 5.6 Live Price Provider for Pre-flight & Slippage Guard — **NEW v2026-10-06**

**Problem**: `PendingTradeManager` used the last closed 15m candle close price as "live price" for slippage guard and pre-flight checks. In volatile markets, this price can be minutes stale, causing the bot to approve setups that are already invalid.

**Solution**: `getLivePrice()` on `StrategyEngine` returns the **global tick memory** (`latestTickPrice`), written at the top of `handleKline()` from every incoming WS tick — before the `confirmed` guard and before any processing:

```typescript
getLivePrice(): string | null {
  return this.latestTickPrice; // never coupled to a single timeframe feed
}
```

Updated `src/index.ts` to wire this provider:
```typescript
pendingTradeManager.setPriceProvider((symbol: string) => {
  const engine = engines.find((e) => e.symbol === symbol);
  return engine?.getLivePrice() ?? null;
});
```

**Impact**: Slippage Guard, Pre-flight Check and Adaptive Fractioning all evaluate against the freshest tick — including Sniper Mode, where an LTF feed read can be up to 14 minutes stale (Invariant 38).

### 5.7 Guaranteed Ghost Signal Burning via `structureDetails` — **NEW v2026-10-06**

**Problem**: Scenario 12 (Sniper) continued detecting the same CHoCH after `burnSetup` because `structureDetails` was lost when passing through `PendingTradeManager`. The `direction` field was lost, causing `isMitigated` to fail.

**Solution**: Full chain of custody for `structureDetails`:

1. **`PendingTrade` interface** (`pendingTradeManager.ts:25`): Added `structureDetails?: any`
2. **`queueTrade`** (`pendingTradeManager.ts:60`): Accepts and stores `structureDetails` in `pending.structureDetails`
3. **`handleApproval`** (`pendingTradeManager.ts:148, 194, 207`): Returns `structureDetails` in approval result
4. **`PositionPlan` interface** (`riskManager.ts:65`): Added `structureDetails?: any`
5. **`queueForApproval`** (`strategyEngine.ts:827`): Passes `result.structureDetails` to `queueTrade`
6. **`handleTradeApproval`** (`strategyEngine.ts:400`): Copies `approvalResult.structureDetails` to `updatedPlan`
7. **`burnSetup`** (`strategyEngine.ts:530-570`): Uses `plan.structureDetails` for guaranteed burning with fallback to `zoneDetails`

**Result**: Ghost signals in Scenario 12 are now permanently burned — the CHoCH timestamp is preserved end-to-end.

> **Addendum v2026-10-21 — Burn Trigger Structure on Trade Open (Live)**: Live structures used to be burned ONLY via `burnSetup()` (abort paths) and after position close — a successful entry left the trigger CHoCH unburned until the trade closed. This is now prevented: BOTH live entry paths (`executeStagedEntry()` auto and `handleTradeApproval()` manual) push `this.plan.structureDetails` into `mitigatedStructures` **immediately after the exchange confirms the order — before `transition(StrategyState.IN_TRADE)` and before the `avgPrice` / DB bookkeeping** (standard 100-entry cap). Burning after `db.openTrade()` is forbidden: a post-fill DB failure would then leave a live position whose trigger structure is still re-detectable. This mirrors backtester burn-on-entry (Invariant 15) and satisfies Invariant 39.

### 5.8 Zero-NULL Database Guarantee for Closed Trades — **NEW v2026-10-06**

**Problem**: `closeTrade` was called with NULL `pnl`/`exit_price` when exchange data was unavailable, polluting the database.

**Solution**: Comprehensive fallback logic in three locations:

1. **`onExchangePositionClosed`** (lines 495-510): Calculates fallback PnL from trade data + `getLivePrice()` for exit price
2. **`reconcile`** (lines 851-875): Calculates PnL from live price instead of passing null
3. **`reconcileWithTrade`** (lines 990-1010): Fallback PnL calculation + live price for exit price

**Guarantee**: `closeTrade` is never called with NULL `pnl` or `exit_price` — database integrity maintained.

### 5.9 Strategy Capacity Limit (MAX_WORKING_CAPITAL) — **NEW v2026-10-06**

**Problem**: On large accounts, the strategy's edge can diminish due to slippage and market impact when position sizes become too large. There was no way to cap the capital used for risk calculations, leading to degraded performance on large deposits.

**Solution**: **Strategy Capacity Limit (MAX_WORKING_CAPITAL)** — A configurable cap on the capital used for risk calculations:

```typescript
// In RiskManager.calculatePosition()
let workingBalance = balance;
if (this.options.maxWorkingCapital && this.options.maxWorkingCapital > 0) {
  const maxCap = new Decimal(this.options.maxWorkingCapital);
  if (balance.gt(maxCap)) {
    workingBalance = maxCap;  // Cap the balance used for risk calculations
  }
}

// Drawdown Guard: reduced risk applies to workingBalance
const riskPercent = await this.getEffectiveRiskPercent();

// Margin Buffer: Use 98% of workingBalance to leave 2% for fees/reserve
const marginBuffer = workingBalance.mul(0.98);
```

**Behavior**:
- **If balance ≤ cap**: Uses actual balance (no change)
- **If balance > cap**: Uses cap for ALL risk calculations (position sizing, drawdown guard, margin buffer)
- **If MAX_WORKING_CAPITAL = 0 (default)**: No cap applied (unlimited)

**Backtester Integration**: The backtester (`src/backtest/executionSimulator.ts`) also respects `MAX_WORKING_CAPITAL`:
- `calculatePositionSize()` accepts `maxWorkingCapital` parameter
- `openTrade()` accepts `maxWorkingCapital` parameter
- Both backtester and live engine use the same logic

**Configuration**: Set `MAX_WORKING_CAPITAL` in `.env` (e.g., `MAX_WORKING_CAPITAL=50000` to cap at $50k). Default is `0` (unlimited).

**Why This Matters**: Prevents strategy degradation on large accounts by ensuring position sizes don't exceed the strategy's capacity. The Drawdown Guard (risk reduction after 3 losses) now correctly applies to the capped working balance, not the full account balance.

### 5.10 Ghost Signal Loop Fix (Auto-Trading) — **NEW v2026-10-12**

**Problem**: In `AUTO_TRADING=true` mode, the bot could enter an infinite "Ghost Signal Loop":
1. Setup detected → `ENTRY_STAGED` → `executeStagedEntry()` 
2. Slippage Guard triggers (price moved >0.2% toward TP) → `burnSetup()` called
3. `burnSetup()` had a hard dependency on `zoneDetails` — if zone was incomplete, it silently skipped burning the structure
4. Logged misleading "Setup burned: zone X mitigated, structure added" even when structure was NOT added
5. State → `SCANNING` but `mitigatedStructures` unchanged + `_activeSniperZone` not cleared
6. Next 1m candle → same CHoCH re-detected (not filtered) → loop repeats every minute

**Root Causes (3 independent bugs):**
1. **Router not receiving `mitigatedStructures`**: `process()` called `scenarioRouter.evaluate(..., [], candles1m)` with hardcoded empty array
2. **`burnSetup()` hard dependency on `zoneDetails`**: Required complete zone to burn anything; structure burning was nested inside zone check
3. **`transition(SCANNING)` not clearing `_activeSniperZone`**: Stale macro zone persisted across state resets

**Solution — 3 Surgical Fixes in `src/engine/strategyEngine.ts`:**

| Fix | Location | Change |
|-----|----------|--------|
| **1. Pass `mitigatedStructures` to router** | `process()` line 742 | `evaluate(..., this.mitigatedStructures, candles1m)` instead of `[]` |
| **2. Independent burning + honest logging** | `burnSetup()` lines 584–638 | Zone and structure burned independently; logs exactly what was burned |
| **3. Clear `_activeSniperZone` on reset** | `transition()` line 680 | `this._activeSniperZone = null` added to `SCANNING` branch |

**New `burnSetup()` Behavior:**
- Burns zone if `zoneDetails` valid (type + timestamp + all fields)
- Burns structure if `structureDetails` has valid timestamp (>0)
- Falls back to zoneDetails for structure ONLY if no structureDetails exist
- Logs exactly what happened: "ONLY zone", "ONLY structure", "both", or "CRITICAL: neither"

**Invariant**: After any `burnSetup()` call in auto-mode, the triggering CHoCH timestamp is guaranteed in `mitigatedStructures`, and `_activeSniperZone` is cleared on next `transition(SCANNING)`. Router will filter it out on next candle.

### 5.11 No Assumed Fill — Actual Entry Price from Exchange — **NEW v2026-10-12**

**Problem**: Market orders suffer from slippage. Writing `plan.entryPrice` (the planned price) to the database corrupts Adaptive Fractioning math — the trailing stop logic calculates distance from entry, and if the entry is wrong, the Stop-Loss can be moved into losing territory.

**Solution**: After `executionEngine.execute()` succeeds, the bot MUST:
1. Wait 500ms for the exchange to finalize the fill.
2. Call `client.getOpenPositions(symbol)` to fetch the position's actual `avgPrice`.
2. Use the exchange's `avgPrice` as the true entry price for `db.openTrade()`.
3. Fallback to `plan.entryPrice` only if the fetch fails.

**Implementation** (`src/engine/strategyEngine.ts:executeStagedEntry`):
```typescript
// After successful execution:
let actualEntryPrice = this.plan.entryPrice;
try {
  await new Promise(resolve => setTimeout(resolve, 500));
  const positions = await this.deps.client.getOpenPositions(this.symbol);
  if (positions.length > 0) {
    const pos = positions[0];
    if (pos.avgPrice && pos.avgPrice.gt(0)) {
      actualEntryPrice = pos.avgPrice.toString();
      logger.info(`[${this.symbol}] Actual entry price from exchange: ${actualEntryPrice} (planned: ${this.plan.entryPrice})`);
    }
  }
} catch (e) {
  logger.warn(`[${this.symbol}] Failed to fetch actual entry price, using planned: ${e instanceof Error ? e.message : String(e)}`);
}

await this.deps.db.openTrade({
  // ...
  entry_price: actualEntryPrice,  // REAL entry price from exchange
  // ...
});
```

**Invariant**: Database `entry_price` MUST reflect the exchange's `avgPrice` (actual fill price), never the planned `entryPrice`. This ensures Adaptive Fractioning's trailing stop math is accurate.

> **Manual path sync (v2026-10-20)**: `handleTradeApproval()` now mirrors this flow exactly — `transition(IN_TRADE)` immediately after exchange confirmation, then 500 ms wait → `getOpenPositions()` → `db.openTrade({ entry_price: actualEntryPrice })`. A post-fill `db.openTrade` failure triggers `panicCloseOrphan()`: the engine burns the setup and returns to `SCANNING` ONLY after the exchange is verified flat, otherwise it stays `IN_TRADE` (Invariants 23 / 47 / 49).

### 5.12 Panic Close & Strict Recovery State — **NEW v2026-10-21**

**Problem**: After `executionEngine.execute()` confirms the order, a `db.openTrade()` failure leaves a live position with no database row. A blind reset to `SCANNING` would orphan that exposure — Reconciliation Step 1 only audits engines in `IN_TRADE`, and `checkAndManagePosition()` reads `db.getOpenTrade()` (no row → no management). The position would survive unmanaged and invisible to Adaptive Fractioning.

**Solution**: `executeStagedEntry()` freezes the live plan (`orderLive`, `liveOrderId`, `livePlanRef`) immediately after exchange confirmation. Any subsequent exception enters the panic branch and calls:

```typescript
const flattened = await this.panicCloseOrphan(liveOrderId, livePlanRef?.orderType ?? 'Market');
```

`panicCloseOrphan(orderId, orderType)` (`src/engine/strategyEngine.ts`) executes a strict, ordered recovery:

1. **Cancel the resting order first** (`orderType === 'Limit'` only): `getOpenOrders()` → match `orderId` with status `New`/`PartiallyFilled` → `cancelOrder()`. Market orders are IOC and skip this round-trip. Failure to cancel sets `orderCancelled = false`.
2. **Flatten any filled exposure**: `getOpenPositions()` → if `size > 0`, compute the opposite `closeSide`, format size via `formatQuantity(size, qtyStep)`, and submit `placeReduceOnlyMarketOrder()`. A formatted qty of zero aborts with a critical alert.
3. **Verify flatness**: `isExchangeFlat()` polls `getOpenPositions()` up to 3 × 500 ms. A still-open position returns `false` with a critical alert.
4. **Return contract**: `true` ONLY when the exchange is verified flat AND no live order remains. `false` means exposure may still exist.

**State rule** (`executeStagedEntry` catch block):

| Panic result | State machine action |
|--------------|---------------------|
| `true` (verified flat) | `burnSetup(recoveryPlan)` → `plan = null` → `transition(SCANNING)` |
| `false` (unverified exposure) | Log `CRITICAL`, force `IN_TRADE` if the state drifted, `return` — **never** `SCANNING`, never `burnSetup()` |

**Invariant**: Transitioning to `SCANNING` while an unverified/uncontrolled position exists is **strictly forbidden**. Staying `IN_TRADE` keeps the exposure under Reconciliation supervision — the only mechanism that can later adopt or close it. A live `Limit` order with a null `orderId` conservatively returns `false` (cannot prove the order is gone), so the engine deliberately remains `IN_TRADE`.

> **Operational consequence**: when the panic close cannot be verified, the surviving position may have no `trades` row (the very write that failed). `checkAndManagePosition()` will no-op until Reconciliation adoption or manual intervention — which is precisely why the engine must not pretend the episode ended.

---

## 6. ADAPTIVE FRACTING — DYNAMIC POSITION MANAGEMENT

**Problem**: Static position management (fixed SL/TP) leaves profit on the table in trending markets and exposes full risk in choppy markets.

**Solution**: **Adaptive Fractioning** — Dynamic position management that adapts to the trade's initial R:R ratio.

### 6.1 Core Concept: Two Management Modes

| Trade Type | Condition | Management Strategy |
|------------|-----------|---------------------|
| **Classic** | TotalR < 4 (e.g., 1:3 R:R) | Single milestone: Move SL to entry at 66% progress |
| **Sniper** | TotalR ≥ 4 (e.g., 1:5+ R:R) | Two milestones: 33% (close 25%, SL→entry) → 66% (close 25%, trail SL) |

### 6.2 Progress Calculation

**Profit-direction guard (mandatory, v2026-10-19)**: progress MUST only be computed for trades that are in profit. Before any progress math, `evaluateTradeManagement()` evaluates `isProfitable`:

```typescript
const isProfitable = isLong ? currentPrice.gt(entry) : currentPrice.lt(entry);
if (!isProfitable) {
  return { action: 'none', reason: 'Trade is not in profit', updatedState: state };
}
```

Reason: an absolute-value distance (`|currentPrice - entry|`) treats an adverse move toward SL as progress toward TP — the bot then tries to move SL to entry while price is on the wrong side, producing Bybit error `[10001]` (StopLoss above/below base_price). Progress is measured as **directional** movement, strictly positive because of the guard:

```
progress = (isLong ? currentPrice - entry : entry - currentPrice) / |takeProfit - entry|  // 0.0 to 1.0
```

### 6.3 Milestone Logic

| Mode | Milestone | Progress | Action |
|------|-----------|----------|--------|
| Classic | 1 (only) | ≥ 66% | SL → Entry (breakeven) |
| Sniper | 1 | ≥ 33% | Close 25% of position, SL → Entry |
| Sniper | 2 | ≥ 66% | Close another 25%, Trail SL to Entry + 33% of TP distance |

### 6.4 Implementation (`src/risk/tradeManager.ts`)

```typescript
export function evaluateTradeManagement(context: TradeContext): TradeManagementSignal {
  // Calculates progress toward TP
  // Returns signal: { action, reason, newStopLoss?, closeQty?, updatedState }
}
```

**State Persistence** (`TradeManagementState`):
```typescript
{
  milestone1Triggered: boolean,   // 33% (Sniper) or 66% (Classic)
  milestone2Triggered: boolean,   // 66% (Sniper only)
  initialTotalR: string,          // Initial R:R ratio as string
  initialQty: string              // Initial position size
}
```

**DB Persistence**: `management_state JSONB` column in `trades` table, updated on each milestone.

### 6.5 Live Execution (`StrategyEngine.checkAndManagePosition`)

**Tick-Agnostic Management (v2026-10-16)**: Adaptive Fractioning evaluates progress on **EVERY incoming tick** (confirmed or unconfirmed — 1m for Sniper, 15m for Classic, 4H macro) — completely independent of the scenario evaluation intervals. `checkAndManagePosition()` is invoked from `handleKline()` on every tick **before** the `confirmed` guard, guaranteeing SL→BE and partial closes trigger promptly in **both** modes (a 15m trade can no longer hit a milestone and reverse to full SL inside one candle). Previously the call was trapped inside the 1m branch, leaving V4 Classic silently unmanaged.

**Lazy API Evaluation (v2026-10-16)**: Per-tick management reads the trade from DB and runs `evaluateTradeManagement()` locally first; exchange REST calls happen **only when a milestone action is actually required**. A re-entrancy guard (`isManaging`) prevents overlapping runs, and a 30s backoff (`NO_POSITION_RECHECK_MS`) prevents API spam while a Limit order is unfilled.

Called on **every incoming tick** when `state === IN_TRADE`:
1. **Live price guard** — reads `getLivePrice()` (global tick memory); if null, returns early (never manages blind)
2. **Re-entrancy / backoff guard** — skips if a previous management run is in flight (`isManaging`), or if the last position check found no live position (`noPositionRecheckAt`, 30s backoff)
3. Fetch open trade + `management_state` from DB
4. Call `evaluateTradeManagement()` locally with the live tick price
5. **If `signal.action === 'none'` → return immediately — zero exchange REST calls**
6. **Only when an action is required** — call `client.getOpenPositions()` to confirm position size > 0; if position is 0 (unfilled Limit order), back off for 30s without management
7. Execute signal:
   - `move_sl_to_entry` / `trail_sl_to_profit` → `client.setTradingStop()` (position-level SL update via `setTradingStop`)
   - `close_partial_25` / `close_partial_50` → `executePartialClose()` (reduceOnly market order, `qty` rounded to `qtyStep` via `formatQuantity`, min `minOrderQty` enforced)
   - Update `management_state` in DB via `updateTradeManagementState()` **only after successful API response**

**STATE SYNCHRONIZATION INVARIANT (v2026-10-16)**: `management_state` in the DB MUST ONLY be updated after a successful `ok: true` response from the execution engine. A failed partial close (`ok: false`) aborts the milestone progression immediately (`return`) — no SL update, no DB state update — so the identical management signal re-fires on the next tick (natural retry). Failed SL updates (`setTradingStop` throwing) are already aborted by the outer `try/catch` before any DB write.

### 6.6 Backtest Simulation (`executionSimulator.ts`)

In `checkAndCloseTrade()`:
1. Evaluate management signal on each candle
2. For partial closes: Calculate PnL for closed portion, reduce `qty`, update balance
3. Update `managementState` in `openTrade` state
4. Track partial close PnL in balance immediately

---

## 7. SMC MATHEMATICS — `src/smc/patternRecognizer.ts`

### 7.1 Tolerance & Intersections (No Strict Equality)

| Concept                   | Tolerance                                          | Implementation                                  |
| ------------------------- | -------------------------------------------------- | ----------------------------------------------- |
| **EQH/EQL**               | `max(0.1%, 0.5 * ATR / close)`                     | `detectEqualLevels()` dynamic threshold         |
| **Trading Range**         | `0.5 * ATR` for boundary "touch"                   | `detectTradingRange()` uses actual highs/lows   |
| **SFP/Sweep**             | Wick pierces, body closes inside                   | `high > level && close < level` (not `==`)      |
| **Breaker Block**         | Full body close beyond OB + displacement ≥ 1.5 ATR | `isValidBodyClose` + `isValidDisplacement(1.5)` |
| **All Price Comparisons** | `Decimal` with tolerance                           | **Never** `.eq()`                               |

### 7.2 Displacement Validation

- **Structure Break (BOS/CHoCH)**: Candle body ≥ **1.5 \* ATR** (`displacementMultiplier`).
- **SMS (Failure Swing)**: CHoCH candle body ≥ **1.5 \* ATR**.
- **Breaker Block**: Impulse candle body closes beyond OB + **1.5 \* ATR**.

### 7.3 Killzones (NY Time)

| Session    | Hours (NY)  | Phase        |
| ---------- | ----------- | ------------ |
| **Asian**  | 20:00–24:00 | Accumulation |
| **London** | 02:00–05:00 | Manipulation |
| **NY**     | 07:00–10:00 | Distribution |

Only **London/NY** valid for entry (Scenario 5, 7, etc.).

> **Bypass (v2026-10-18)**: Killzone gates can be disabled globally via `ENFORCE_KILLZONES=false` (e.g., for backtesting without session constraints). The bypass covers BOTH the `BaseScenario.isInKillzone()` helper (Scenarios 1, 3, 6, 10, 11) AND the direct `patternData.currentKillzone` checks (Scenarios 2, 4, 5, 7, 8, 9, 12). Entry filter ONLY — active trade management is never affected.

> **Scenario 13 (Top-Down Order Flow) is ARCHIVED** — see §8.6 and `src/engine/scenarios/archive/`. Scenario 12 is the only 1m producer registered in the live router.

### 7.4 V5 Sniper Mode (1m Execution) — v2026-09-30 (single-pass since v2026-10-21)

**Architecture**: One scenario, one pass. `Scenario 12 (Sniper Touch)` performs radar and trigger selection inside a single `ScenarioRouter.evaluate()` call on each **1m close** — there is no intermediate state transition and no cached active zone.

| Phase | Timeframe | Action |
|-------|-----------|--------|
| **Macro context** | 15m/4H | PDH/PDL/PWH/PWL levels are maintained by the macro refresher and read by Scenario 12; 15m ATR is used for proximity tolerance. Opt-in sources (`S12_SESSION_SWEEPS`, `S12_EQH_EQL_SWEEPS`) add the newest ASIAN high/low and 15m EQH/EQL pools |
| **Sweep pairing** | 1m lookback (50 min) | Each swept level keeps its **own** `sweptAt`; `pairChochsWithSweeps()` pairs a CHoCH only with same-direction sweeps that happened strictly **before** it. A later sweep of an unrelated level cannot invalidate an earlier CHoCH |
| **Trigger** | 1m | Fresh CHoCH (`detectStructureBreaks()`, displacement ≥ 1.5 ATR) from a valid pair, matched to an Order Block whose **midpoint** is within the source-aware band — `max(1.0 × atr15m, 0.3%)` for macro levels, `max(0.5 × atr15m, 0.3%)` for intraday sources (Invariant 51) |
| **Execute** | 1m | `idealEntry` = OB midpoint; take-profit resolved structurally (`tpResolver`, fixed `3R` when `ENABLE_DYNAMIC_TP=false`); Smart Pullback: Market if within 0.15% or at a discount, else Limit @ OB midpoint |

**State Machine** (`types.ts:26`): the live path is `SCANNING → ENTRY_STAGED → IN_TRADE`. `StrategyState.SNIPER_MODE` and `_activeSniperZone` remain in `types.ts` / `StrategyEngine` as reserved scaffolding for a future two-phase split (marked `@ts-expect-error` in the engine) and are **never entered** by the current live path.

**No-zone settlement**: Scenario 12 emits `structureDetails` only — it never calls `setZoneDetails()`. Macro liquidity pools are never burned; spam protection is exclusively 1m CHoCH structure burning (Invariant 21).

**Backtester** (`src/backtest/run.ts`): Main loop iterates 1m candles; 15m candles synthesized via timestamp sync; `ScenarioRouter` evaluates Scenario 12 on 1m closes.

> **Scenario 13 is ARCHIVED** (Top-Down Order Flow Matrix, documented in §8.6 for reference only). It is not registered in the router, so `process()` has no 1m scenario besides Scenario 12.

---

### 7.5 Macro Context (Bootstrap Only, ~5-10ms)

- **Loaded ONCE** at startup (single `PatternRecognizer` shared across engines).
- **1W/1D candles** (1000 each) → **linear O(N) passes only**:
  - ATH/ATL: max high / min low
  - PWH/PWL: `weekly[-2]` high/low
  - PDH/PDL: `daily[-2]` high/low
  - DO/WO: `daily[-1].open` / `weekly[-1].open`
  - FVG: last **20** daily candles only
- **NO** Order Blocks, Breakers, Mitigation on macro timeframes.
- Daily 00:00 UTC refresh: atomic cache replacement.

### 7.6 Strict Stop-Loss Calculation — `BaseScenario.calculateLevels()` — **SINGLE SOURCE OF TRUTH**

**Problem**: Zone objects (OB, FVG, Breaker, MB) can have arbitrary `top`/`bottom` ordering (not guaranteed `top > bottom`). Naive SL formulas like `zone.bottom - offset` fail when zone is inverted.

**Solution**: Centralized `BaseScenario.calculateLevels()` method — single source of truth for all bidirectional scenarios (S1, S5, S6, S10, S11).

**Evolution v2026-09-20 — Safety Hardening**:
1. **Minimum offset protection**: ATR can be near-zero in low volatility → zero offset → division by zero in RiskManager. Fixed by `offset = max(atr * 0.5, entry * 0.1%)`.
2. **Inverted zone defense**: `zone.top` may be < `zone.bottom`. Now uses `min/max` of **all three** (top, bottom, entry) for SL calculation.

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
  // Safety: minimum offset = 0.1% of entry (prevents zero offset when ATR is near zero)
  const minOffset = entry.mul(new Decimal('0.001'));
  const atrOffset = atr.mul(offsetMultiplier);
  const offset = Decimal.max(atrOffset, minOffset);
  
  // CRITICAL: Ensure SL is on correct side of Entry regardless of zone top/bottom convention
  // Use min/max of ALL THREE (top, bottom, entry) to handle inverted zones safely
  // BULLISH (Long): SL must be BELOW entry. Use min(zone.top, zone.bottom, entry) - offset
  // BEARISH (Short): SL must be ABOVE entry. Use max(zone.top, zone.bottom, entry) + offset
  const sl = direction === 'BULLISH'
    ? Decimal.min(zone.top, zone.bottom, entry).minus(offset)
    : Decimal.max(zone.top, zone.bottom, entry).plus(offset);
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
- **Offset floor**: `SL` always at least 0.1% from entry (prevents RiskManager division by zero)
- Used by Scenarios 1, 2, 3, 4, 5, 6, 7, 8, 10, 11 (all scenarios with zone-based entries)
- Tests call this method directly — no full pattern recognition needed

### 7.7 Dynamic Backtester Architecture — `src/backtest/run.ts`

**Problem**: Hardcoded '15m'/'240' timeframes and fixed 17280 candle count (180 days of 15m) prevented testing other timeframes. Cache filenames were hardcoded to '15', causing 5m cache to overwrite 15m cache.

**Solution**: Fully dynamic backtester using config-driven timeframes and a config-driven history window.

| Component | Detail |
|-----------|--------|
| **LTF/HTF Timeframes** | Read from `config.ltfTimeframe` / `config.htfTimeframe` (strings like '5', '15', '60') |
| **History Window** | `getTimeRangeForDays(config.backtestDays)` (`BACKTEST_DAYS`, default 60) — single source of truth for 1m, LTF and HTF loaders. **No hardcoded 180 / "six months".** |
| **Cache Filenames** | Dynamic: `BTCUSDT_5.json`, `BTCUSDT_15.json` (includes timeframe) |
| **Dynamic Timeframes in API** | `config.ltfTimeframe as Timeframe` / `config.htfTimeframe as Timeframe` |
| **Cache Key** | `getCachePath(symbol, timeframe)` uses timeframe in filename |
| **ScenarioRouter** | Receives LTF/HTF candle arrays + candleTimestamp; no hardcoded '15'/'240' |

**Removed Hardcoded Values:**
- ❌ `'15'` / `'240'` strings everywhere
- ❌ `17280` fixed candle count (180 days × 96 candles/day for 15m)
- ❌ `SIX_MONTHS_MS = 6 * 30 * 24 * 60 * 60 * 1000` / `getTimeRangeForSixMonths()` — replaced by `getTimeRangeForDays(config.backtestDays)`
- ❌ `'15'` in cache filenames (`BTCUSDT_15.json`)
- ❌ Hardcoded '15m' / '4H' strings in log messages

**Added Dynamic Calculations:**
- ✅ `getTimeRangeForDays(days)` (`historyLoader.ts`) — validates `days > 0` and returns `{ fromMs, toMs }`
- ✅ `run.ts` logs `[Backtest Range] BACKTEST_DAYS=N → <from> - <to>` before loading
- ✅ All loaders (`candles1m`, `candlesLtf`, `candlesHtf`) receive the same `fromMs`/`toMs` window
- ✅ Cache filename: `getCachePath(symbol, timeframe)` → `BTCUSDT_5.json` / `BTCUSDT_60.json`
- ✅ Dynamic log: `[SYMBOL] Starting backtest loop over 51840 5m candles...`
- ✅ Progress: `candle ${i}/${candlesLtf.length} (${((i / candlesLtf.length) * 100).toFixed(1)}%)`
- ✅ `runBacktestForSymbol` receives `ltfMinutes` parameter for dynamic calculations

### 7.7.1 Offline Cache Mode (`USE_LOCAL_CACHE_ONLY`) — **NEW v2026-10-07**

**Problem**: During development and CI/CD, hitting Bybit API rate limits (error 10016) causes backtest failures. Need a way to run backtests entirely from local cache without network calls.

**Solution**: Added `USE_LOCAL_CACHE_ONLY` boolean flag (default: `false`).

**Implementation** (`src/config/env.ts` + `src/backtest/historyLoader.ts` + `src/backtest/run.ts`):

```typescript
// In BotConfig interface
readonly useLocalCacheOnly: boolean;

// In loadConfig()
const useLocalCacheOnly = (optionalEnv(env, "USE_LOCAL_CACHE_ONLY") ?? "false").toLowerCase() === "true";

// In historyLoader.ts - loadCachedOrFetch()
if (useLocalCacheOnly) {
  if (fs.existsSync(cachePath)) {
    logger.info(`[OFFLINE MODE] Loaded ${symbol} ${timeframe} strictly from cache.`);
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } else {
    throw new Error(`[OFFLINE MODE] Cache file not found for ${symbol} ${timeframe}: ${filePath}`);
  }
}

// In run.ts - passed via config
loadCachedOrFetch(client, symbol, timeframe, fromMs, toMs, config.useLocalCacheOnly)
```

**Behavior**:
- **`USE_LOCAL_CACHE_ONLY=false` (default)**: Normal operation — fetch from Bybit if cache miss, update cache
- **`USE_LOCAL_CACHE_ONLY=true`**: **Zero network calls** — loads strictly from local `.json` cache files; throws if cache missing

**Use Cases**:
- CI/CD pipelines without API access
- Local development without API keys
- Re-running backtests with identical data for debugging
- Avoiding Bybit API rate limits (error 10016)

---

### 7.8 News Filter (News Embargo) — `src/services/newsService.ts`

**Problem**: High-impact USD macro news (NFP, CPI, FOMC, etc.) causes extreme volatility and spread widening. Trading during these windows produces random PnL with negative expectancy.

**Solution**: **News Embargo Filter** — blocks all trade scanning ±30 minutes around high-impact USD news.

**Implementation** (`src/services/newsService.ts`):

| Component | Detail |
|-----------|--------|
| **Source** | FXMacroData API: `https://api.fxmacrodata.com/v1/calendar/usd` (no API key, 100 req/day free) |
| **Filter** | `event_importance === 'high'` AND `release_date_confirmed === true` (or `market_tier === 1`) |
| **Cache** | In-memory array of `NewsEvent { name, timestamp }` for current week (±7 days) |
| **Refresh** | Daily at 00:00 UTC (via macro context refresher) + at startup |
| **Embargo Window** | ±30 minutes (configurable via `EMBARGO_WINDOW_MS = 30 * 60 * 1000`) |
| **Time Source** | `event.announcement_datetime * 1000` (Unix seconds) or `event.announcement_datetime_utc` (ISO string) |
| **Method** | `isNewsEmbargo(ts: number): boolean` — returns `true` if `ts` within ±30 min of any cached high-impact USD event |
| **Resilience** | Network/HTTP/parse errors → empty cache + `logger.warn`, never throws (fail-open) |

**Integration Points:**

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

### 7.9 Funding Monitor (Delta-Neutral Arbitrage) — `src/services/fundingMonitorService.ts`

**Problem**: Delta-neutral arbitrage positions (long spot + short perp) earn funding when rates are positive but lose money when rates turn negative. Need passive monitoring with alerts.

**Solution**: **FundingMonitorService** — independent passive service polling Bybit tickers every 30 min for funding rates.

**Implementation** (`src/services/fundingMonitorService.ts`):

| Component | Detail |
|-----------|--------|
| **Source** | Bybit V5 `getTickers({ category: 'linear' })` |
| **Poll Interval** | 30 minutes (`FUNDING_POLL_INTERVAL_MS = 30 * 60 * 1000`) |
| **Tracked Symbols** | `FUNDING_MONITOR_SYMBOLS` (default: BTCUSDT,ETHUSDT,SOLUSDT) |
| **Alert Threshold** | `FUNDING_ALERT_THRESHOLD_PCT=0.0` — rate ≤ 0% triggers alert |
| **Restore Threshold** | `FUNDING_RESTORE_THRESHOLD_PCT=0.015` — rate ≥ +0.015% triggers restore |
| **State Tracking** | Per-symbol `isAlerted` boolean to prevent spam |
| **Telegram Alert (Negative)** | `⚠️ [FUNDING ALERT]` — symbol, current rate, recommendation to close the arbitrage |
| **Telegram Alert (Restore)** | `🟢 [FUNDING RESTORED]` — symbol, rate and projected APY, recommendation to re-open the arbitrage |
| **Public API** | `getCurrentRates(): Map<string, Decimal>` for `/status` command |

**Integration Points:**

1. **Bootstrap** (`src/index.ts`):
   - Conditionally created if `ENABLE_FUNDING_MONITOR=true` and symbols configured
   - Started via `fundingMonitor.start()`
   - Injected into `TelegramNotifier` via `notifier.setFundingMonitor()`

2. **Graceful Shutdown** (`src/index.ts`):
   - `fundingMonitor.stop()` in `shutdown()` handler

3. **Telegram /status** (`src/telegram/notifier.ts`):
   - Shows `📊 Funding: BTC: +0.0100% | ETH: +0.0150% | SOL: +0.0200%` or `Disabled`

---

### 7.10 Dynamic Macro Context in Backtester — **Lookahead Bias Elimination** — `src/backtest/run.ts` — **NEW v2026-09-20**

**Problem**: `initializeMacroContext()` was called once before backtest loop, loading daily levels (PDH/PDL, PWH/PWL) from the **end of history** (e.g., September 2026). During simulation of March–August 2026, the bot incorrectly used future levels — causing Scenarios 5, 7, 8, 9 to miss valid sweeps.

**Solution**: Dynamic macro context updated on-the-fly during simulation, strictly using only data available up to the current candle.

**Implementation in `runBacktestForSymbol()`**:

```typescript
// Dynamic macro context tracking (no lookahead bias)
let currentDayUtc = -1;
let currentWeekUtc = -1;
let runningAth = new Decimal(0);
let runningAtl = new Decimal('Infinity');

for (let i = 0; i < candlesLtf.length; i++) {
  const candle = candlesLtf[i];
  const candleDate = new Date(candle.timestamp);
  const candleDay = candleDate.getUTCDate();
  const candleWeek = Math.floor(candleTime / (7 * 24 * 60 * 60 * 1000));

  // Update running ATH/ATL with current candle (historical data only)
  if (new Decimal(candle.high).gt(runningAth)) runningAth = new Decimal(candle.high);
  if (new Decimal(candle.low).lt(runningAtl)) runningAtl = new Decimal(candle.low);

  // Check for new day (00:00 UTC boundary)
  if (candleDay !== currentDayUtc) {
    currentDayUtc = candleDay;

    // Calculate yesterday's PDH/PDL from CLOSED candles BEFORE current candle
    const yesterdayCandles = candlesLtf.slice(Math.max(0, i - 96), i); // 96 = 24h/15m
    if (yesterdayCandles.length > 0) {
      const pdh = Decimal.max(...yesterdayCandles.map(c => new Decimal(c.high)));
      const pdl = Decimal.min(...yesterdayCandles.map(c => new Decimal(c.low)));
      const doPrice = new Decimal(candle.open);

      // Calculate weekly levels if new week (Monday)
      let pwh = runningAth, pwl = runningAtl, wo = doPrice;
      if (candleWeek !== currentWeekUtc) {
        currentWeekUtc = candleWeek;
        const lastWeekCandles = candlesLtf.slice(Math.max(0, i - 96 * 7), i);
        if (lastWeekCandles.length > 0) {
          pwh = Decimal.max(...lastWeekCandles.map(c => new Decimal(c.high)));
          pwl = Decimal.min(...lastWeekCandles.map(c => new Decimal(c.low)));
        }
      }

      // Atomic update — no lookahead!
      recognizer.setMacroContext(symbol, {
        ath: runningAth,
        atl: runningAtl,
        weeklyLevels: { pwh, pwl, wo },
        dailyLevels: { pdh, pdl, do: doPrice },
        liquidityPools: [/* PDH, PDL, PWH, PWL as pools */],
      });
    }
  }
  // ... rest of simulation loop
}
```

**Key points**:
- ❌ **Removed**: All `initializeMacroContext()` calls before backtest loop (both CSV and online modes)
- ✅ **Added**: `PatternRecognizer.setMacroContext()` / `getMacroContext()` for atomic cache updates
- ✅ **Sliding windows**: 96 candles (15m) = 24h for daily; 96×7 = 1 week for weekly
- ✅ **Strict causality**: Only uses `candlesLtf.slice(0, i)` — data strictly before current candle
- ✅ **Per-symbol scenarios**: `config.symbolScenarios.get(symbol)` fallback to global `ACTIVE_SCENARIOS` now respected in backtester
- ✅ **Full rejection stats**: All 8 scenarios (2,4,5,7,8,9,10,11) logged in both modes

---

### 7.11 Timezone Sanity Check (Docker + luxon) — **NEW v2026-09-22**

**Problem**: luxon's `setZone('America/New_York')` silently falls back to UTC in Docker Alpine containers because the base image lacks the IANA timezone database (`tzdata`). This caused killzone checks to fail at 11:15 UTC (07:15 NY) — the bot saw `hour=11` instead of `hour=7` and rejected valid NY session trades.

**Solution**: Two-layer fix at DevOps + Code level:

| Layer | Fix | Why |
|-------|-----|-----|
| **DevOps (Dockerfile)** | `RUN apk add --no-cache tzdata` in runner stage | Installs full IANA tz database; luxon can now resolve `America/New_York` with correct DST (EDT/EST) |
| **Code (patternRecognizer.ts)** | `DateTime.fromMillis(ts, { zone: 'utc' }).setZone('America/New_York')` | Explicit UTC → NY conversion; fails fast if tzdata missing |

**Timezone Sanity Check (Startup Log)** — `src/index.ts`:
```typescript
const nowMs = Date.now();
const utcTime = DateTime.fromMillis(nowMs).toUTC().toFormat('yyyy-MM-dd HH:mm:ss');
const nyTime = DateTime.fromMillis(nowMs).setZone('America/New_York');
const nyTimeStr = nyTime.toFormat('yyyy-MM-dd HH:mm:ss ZZZZ');
logger.info(`[Timezone Sanity Check] Server UTC: ${utcTime} | Wall Street (NY): ${nyTimeStr} | NY Hour: ${nyTime.hour}`);
```

**Example output**:
```
[Timezone Sanity Check] Server UTC: 2026-09-22 21:30:00 | Wall Street (NY): 2026-09-22 17:30:00 EDT | NY Hour: 17
```

**Critical**: Alpine base images lack `tzdata` by default. Always install `tzdata` when using luxon with named IANA zones in Docker.

---

### 7.12 Mitigated Structures (Ghost Signal Elimination) — **NEW v2026-09-24**

**Problem**: Scenario 6 (SMS) was generating duplicate entries on the same CHoCH structure. After a trade closed, the CHoCH structure that triggered the entry was NOT marked as "used". When a new killzone arrived, the bot re-detected the same old CHoCH and entered again — same price, 5 hours apart. This created "ghost signals" — fake setups that appeared valid but were actually re-entries on already-consumed structures.

**Solution**: **mitigatedStructures** tracking — structures (SMS, CHoCH, BOS) that have been traded and should never be re-used.

**Implementation**:

1. **`BacktestState`** (`executionSimulator.ts`) — new field:
```typescript
mitigatedStructures: MitigatedStructure[];
```

2. **`MitigatedStructure` interface** (`scenarioRouter.ts`):
```typescript
interface MitigatedStructure {
  type: 'SMS' | 'CHoCH' | 'BOS';
  timestamp: number;
  price: string;
  direction: 'BULLISH' | 'BEARISH';
}
```

3. **On trade close** (`checkAndCloseTrade` in `executionSimulator.ts`):
   - If trade has `structureTimestamp`, add to `mitigatedStructures`:
   ```typescript
   mitigatedStructures: structureTimestamp > 0 ? [...state.mitigatedStructures, {
     type: trade.structureType || 'CHoCH',
     timestamp: structureTimestamp,
     price: trade.structurePrice?.toString() || '0',
     direction: trade.side === 'Buy' ? 'BULLISH' : 'BEARISH',
   }] : state.mitigatedStructures
   ```

4. **ScenarioRouter** (`scenarioRouter.ts`):
   - New `evaluate()` param: `mitigatedStructures: MitigatedStructure[] = []`
   - `filterMitigatedStructures()` — filters `patternData.structures` by **timestamp ONLY** (updated v2026-10-16; direction/type matching removed per §16.4.3 — those fields may be lost or defaulted during mapping):
   ```typescript
   private filterMitigatedStructures(structures: any[], mitigatedStructures: MitigatedStructure[]): any[] {
     if (!mitigatedStructures.length) return structures;
     return structures.filter(s => !mitigatedStructures.some(ms => ms.timestamp === s.timestamp));
   }
   ```
   - Applied in `evaluate()`: `patternData.structures = this.filterMitigatedStructures(patternData.structures, mitigatedStructures)`

5. **`RouterResult`** includes `structureDetails: StructureDetails | null`

6. **Scenarios 6 & 11** now call `setStructureDetails()` with the trigger CHoCH:
   ```typescript
   this.setStructureDetails({
     type: 'CHoCH',
     timestamp: choch.timestamp,
     price: choch.price,
   });
   ```

7. **Run.ts** passes `state.mitigatedStructures` to `router.evaluate()` and `structureDetails` to `openTrade()`.

**Result**: Scenario 6 on ETHUSDT — the duplicate 06:30/11:30 entries at same price are eliminated. The CHoCH is marked as "used" after first trade.

### 7.13 Ghost Signals Protection (V5 Sniper) — **NEW v2026-10-01**

**Problem**: Scenario 12 (Sniper Touch) could generate duplicate entries on the same 1m CHoCH structure. After a trade closed at TP (within 2 minutes), the same CHoCH structure (still within the 30-minute freshness window) would be re-detected, causing re-entries at the same price — "ghost signals".

**Solution**: **mitigatedStructures** tracking for V5 CHoCH structures — structures that have been traded and should never be re-used.

**Implementation**:

1. **Router attaches mitigatedStructures** to `patternData` before scenario evaluation (`scenarioRouter.ts:149`):
   ```typescript
   (pd as any).mitigatedStructures = mitigatedStructures;
   ```

2. **Scenario 12 filters structures** against mitigated list before selecting CHoCH (`Scenario12_SniperTouch.ts:106-115`):
    ```typescript
    const mitigatedStructures = (patternData as any).mitigatedStructures || [];
    const isMitigated = (s: Structure) => 
      mitigatedStructures.some((ms: any) => 
        ms.timestamp === s.timestamp
      );

    const recentStructures = structures.filter(s => 
      s.type === 'CHOCH' && 
      s.direction === direction &&
      s.timestamp >= (candles1m[candles1m.length - 30]?.timestamp ?? 0) &&
      !isMitigated(s)
    );
    ```

    **Note v2026-10-05**: The direction check was removed from `isMitigated` because when structures are burned via `PendingTradeManager`, the `direction` field may be undefined (lost during `PendingTrade` mapping). Timestamp alone is sufficient since candle timestamps are unique.

3. **Scenario 12 returns `structureDetails` with direction** on trigger (`Scenario12_SniperTouch.ts:214-219`):
   ```typescript
   this.setStructureDetails({
     type: 'CHoCH',
     timestamp: choch.timestamp,
     price: choch.price,
     direction: choch.direction,
   });
   ```

4. **Engine burns structure on trade OPEN (Live) — v2026-10-21**: BOTH `executeStagedEntry()` (auto) and `handleTradeApproval()` (manual) push `this.plan.structureDetails` into `mitigatedStructures` **immediately after the exchange confirms the order — before `transition(StrategyState.IN_TRADE)` and before the `avgPrice` / DB bookkeeping**, with the standard 100-entry cap:
   ```typescript
   if (this.plan.structureDetails && this.plan.structureDetails.timestamp) {
     this.mitigatedStructures.push({
       type: (this.plan.structureDetails.type || 'CHoCH') as 'CHoCH' | 'SMS' | 'BOS',
       timestamp: this.plan.structureDetails.timestamp,
       price: this.plan.structureDetails.price?.toString() || this.plan.entryPrice.toString(),
       direction: this.plan.structureDetails.direction || (this.plan.side === 'Buy' ? 'BULLISH' : 'BEARISH'),
     });
     if (this.mitigatedStructures.length > 100) {
       this.mitigatedStructures = this.mitigatedStructures.slice(-100);
     }
   }
   ```
   The CHoCH is consumed the moment the exchange confirms the fill — not only on abort (`burnSetup`) or close. Burning after `db.openTrade()` is forbidden: a post-fill DB failure would otherwise leave a live position whose trigger structure is still re-detectable. Mirrors backtester burn-on-entry (Invariant 15).

5. **Engine auto-mitigates on trade close** (`executionSimulator.ts:626-631`, `strategyEngine.ts:363-365`):
   - Trade closes → `structureDetails` passed to DB
   - Reconciliation/WS close → `addMitigatedZone` + structure added to `mitigatedStructures`
   - Next 1m candle → same CHoCH filtered out, no ghost entry

**Result**: Scenario 12 on SOLUSDT — the rapid-fire 2-minute re-entries after TP are eliminated. The CHoCH is marked as "used" immediately at trade open and after first trade close.

#### 7.13.1 Sweep → CHoCH Causality & Spatial Proximity — **NEW v2026-10-20**

**Problem**: The sweep scan returned only a boolean, so a CHoCH that formed *before* the macro sweep could trigger a Sniper entry (causality inversion). Scenario 12 also accepted a 1m CHoCH/OB that formed far from the swept level, producing entries disconnected from the liquidity that justified the setup. Finally, it emitted a fake zero-width `MITIGATION` zone at the macro level, letting `burnSetup()` add PDH/PDL/PWH/PWL to `mitigatedZones` — a direct Invariant 21 violation.

**Implementation** (`src/engine/scenarios/Scenario12_SniperTouch.ts`) — **superseded by §7.13.2 for the causality anchor**:

1. **Latest-sweep causality anchor** *(legacy — replaced in v2026-10-23)*: A single global `sweptAt` is no longer used. See §7.13.2.
2. **Strict causality** *(still true)*: a CHoCH must form after the sweep that justifies it.
3. **Spatial proximity (midpoint-based)**: `obMidpoint = (OB.top + OB.bottom) / 2`; `distance = |obMidpoint − sweptPrice|`. Reject if `distance > tolerance` (band now source-aware, §7.13.2). **The measurement is STRICTLY from the Order Block midpoint, never from its edges** (Invariant 51) — a wide OB can straddle the level while its midpoint sits far away, so nearest-edge distance would approve disconnected entries. The CHoCH close distance is logged for observability but not gated (a strong displacement can close further away while the pullback OB stays at the level).
4. **No macro-pool burning**: `setZoneDetails()` is not called at all; Scenario 12 emits only `structureDetails` (the 1m CHoCH). Ghost-signal protection is structure-only, satisfying Invariant 21.
5. **Dead code removed**: `detectStructureBreaksAndOBs` → `detectStructureBreaks` (returns `Structure[]`); the unused OB extraction is gone.

**Tests**: `tests/scenarios/scenario12_sniper_touch.test.ts` covers valid entry, causality rejection, ATR/percentage proximity rejection, CHoCH-near/OB-far rejection, and mitigated-structure rejection.

---

#### 7.13.2 Scenario 12 Revival — Per-CHoCH Pairing & Opt-in Sweep Sources — **NEW v2026-10-23**

**Problem (frequency)**: the global `sweptAt = max(all levels)` rule made a *later* sweep of an unrelated level invalidate an *earlier* CHoCH. A valid PDL reversal at 10:05 was discarded because PDH was poked at 10:12 — the trigger existed, but the causality anchor had moved past it. Scenario 12 also only hunted four macro levels, so intraday liquidity (session extremes, equal highs/lows) could never trigger a sniper entry.

**Implementation** (`src/engine/scenarios/Scenario12_SniperTouch.ts`):

1. **Per-level sweep detection** — `detectLevelSweeps()` still scans the 50-minute 1m lookback newest → oldest per level, but records each swept level's **own** `sweptAt` instead of collapsing them into one maximum. `levelTouched` and the `weakWick` break-out semantics are unchanged.
2. **Per-CHoCH pairing** — `pairChochsWithSweeps()` builds `{ choch, swept }` pairs where `swept.direction === choch.direction` and `swept.sweptAt < choch.timestamp` (strict: a CHoCH on the sweep candle itself is ambiguous and rejected). A later sweep of another level simply produces no pair with an earlier CHoCH and cannot invalidate it.
3. **Winner selection (deterministic)** — newest CHoCH → nearest OB distance → most recent sweep. Rejection buckets stay exclusive: no pair → `noChoch`; all pairs fail HTF bias → `htfContradiction`; no pair passes body-close → `bodyClose`; no OB → `noOb`; any measured miss → `proximity`.
4. **Opt-in sweep sources** (`BotConfig.s12SessionSweeps?` / `s12EqhEqlSweeps?`, env `S12_SESSION_SWEEPS` / `S12_EQH_EQL_SWEEPS`, both default **false**):
   - `SESSION`: the newest ASIAN range's high (BEARISH) and low (BULLISH) from `patternData.sessionRanges`. Older Asian sessions are stale context and are ignored.
   - `EQH_EQL`: 15m-derived `EQH`/`EQL` pools (`EQH` → BEARISH, `EQL` → BULLISH).
5. **Price dedupe with source priority** — when two sources print the same price (exact `Decimal.eq()`), `MACRO` owns it over `SESSION`, and `SESSION` over `EQH_EQL` (`SWEEP_SOURCE_PRIORITY`, applied via a stable sort before dedupe). Without this, a macro level duplicated by a session extreme would be judged against the tighter intraday band.
6. **Source-aware proximity band** — macro levels keep `max(1.0 × atr15m, 0.3% of level)`; intraday sources use `max(0.5 × atr15m, 0.3% of level)`. The 0.3% floor is unconditional, so the gate stays meaningful when ATR collapses. The proximity rejection message names the band (`1xATR15m` / `0.5xATR15m`) and reports the CHoCH close distance and the OB-midpoint distance.
7. **Invariants preserved** — no `setZoneDetails()` (macro pools are never burned, Invariant 21), midpoint-only proximity (Invariant 51), mitigation filtered by timestamp alone (Invariant 25), and `structureDetails` still carries the triggering CHoCH for burn-on-entry (Invariant 39).

**Tests**: `tests/scenarios/scenario12_sniper_touch.test.ts` adds pairing (later unrelated sweep), per-source opt-in defaults, EQH/EQL and session triggering, macro-over-session dedupe, the 1.0 vs 0.5 ATR band split, and the 0.3% floor under near-zero ATR.

#### 7.13.3 Verified S12 "1C" Profile — 60-Day, 4-Symbol Baseline — **NEW v2026-10-23**

The reference S12 profile used for portfolio validation enables both opt-in sweep sources and structural take-profits, and keeps the Sniper limit lifetime at its documented 15 × 1m default:

| Variable | Value | Why |
| --- | --- | --- |
| `ENABLE_SNIPER_MODE` | `true` | Arms the single-pass 1m path |
| `ACTIVE_SCENARIOS` | `12` | Only S12 may produce 1m entries |
| `S12_SESSION_SWEEPS` | `true` | Adds the newest ASIAN high/low as sweepable liquidity |
| `S12_EQH_EQL_SWEEPS` | `true` | Adds 15m EQH/EQL pools |
| `ENABLE_DYNAMIC_TP` | `true` | Structural TP resolution via `tpResolver` |
| `DYNAMIC_TP_MIN_RR` / `DYNAMIC_TP_MAX_RR` | `1.5` / `6.0` | Structural target bounds |
| `SNIPER_LIMIT_EXPIRATION_CANDLES` | `15` | 15 × 1m = 15 min (not the Classic 6 × LTF) |
| `ENFORCE_KILLZONES` | `false` (backtest only) | Isolates S12 geometry; live keeps `true` |

**Measured baseline** (`USE_LOCAL_CACHE_ONLY=true`, `BACKTEST_DAYS=60`, 2026-08-24 → 2026-10-23, $1,000 per symbol):

| Symbol | Net | Trades | W/L | Win rate | PF | Max DD | Fees |
| --- | --- | --- | --- | --- | --- | --- | --- |
| NEARUSDT | +$203.86 (+20.39%) | 16 | 9/7 | 56.25% | 2.51 | 6.84% | $111.08 |
| AVAXUSDT | +$16.12 (+1.61%) | 10 | 5/5 | 50.00% | 1.25 | 5.18% | $79.74 |
| LINKUSDT | +$7.06 (+0.71%) | 14 | 7/7 | 50.00% | 1.06 | 5.48% | $135.48 |
| SUIUSDT | −$58.84 (−5.88%) | 15 | 6/9 | 40.00% | 0.69 | 11.95% | $125.68 |
| **Portfolio** | **+$168.20 (+4.21%)** | **55** | **27/28** | **49.09%** | — | — | **$451.98** |

> **Config-drift warning**: an ambient `.env` that sets `SNIPER_LIMIT_EXPIRATION_CANDLES=6` silently reproduces the Classic 6-candle lifetime in 1m units (6 minutes). The same 60-day run at 6 minutes produced **+$110.26** and AVAX **−$32.59**; at the documented 15 minutes it produced **+$168.20** and AVAX **+$16.12**. Always resolve the Sniper lifetime through `resolveLimitExpirationCandles()` and verify the resolved value in the run log.

#### 7.13.4 S12 Production Refinements — Persistent 4H Trend + Fee-Aware TP Floor — **NEW v2026-10-23**

Two hard gates close the audit's two largest loss sources: counter-trend shorts in an expanding 4H market and fee-dominated micro-targets.

| Gate | Rule | Rejection key |
| --- | --- | --- |
| **Persistent 4H trend (SMA50)** | `sma50 = mean(last min(50, len) closed 4H closes)` from `patternData.candles4h`. Shorts require the last 4H close `≤ sma50 × 1.002`; longs require `≥ sma50 × 0.998`. The only exception is price at the unmitigated opposing 4H POI (`isAtOpposingHtfZone`). Fewer than **20** closed 4H candles fails closed. The existing 4H BOS/CHoCH check remains as a secondary confirmation. | `htfContradiction` |
| **Fee-aware target floor** | After `resolveTakeProfit()` succeeds: `targetDistancePct = \|target − executionEntry\| / executionEntry`, where `executionEntry` is the price the entry will actually be booked at (`currentPrice` for a Market fill, `idealEntry` for a resting Limit — see §7.13.5). If it is below `MIN_TP_DISTANCE_PCT` (default `0.0035` = 0.35%) the setup is rejected. Applies to structural and fixed-R targets alike. | `insufficientRoom` |

**Config**: `MIN_TP_DISTANCE_PCT` is parsed into `BotConfig.minTpDistancePct` as a `Decimal`, must be `> 0` and `< 0.1`; an absent value defaults to `0.0035`. `SNIPER_LIMIT_EXPIRATION_CANDLES` remains `15`.

**Measured result** (same 60-day window and 1C flags as §7.13.3, NEAR/AVAX/LINK, `USE_LOCAL_CACHE_ONLY=true`):

| Symbol | Net | Trades | W/L | Win rate | PF | Max DD | Fees |
| --- | --- | --- | --- | --- | --- | --- | --- |
| NEARUSDT | +$271.20 (+27.12%) | 12 | 8/4 | 66.67% | 4.35 | 5.17% | $88.92 |
| AVAXUSDT | +$19.19 (+1.92%) | 3 | 2/1 | 66.67% | 1.70 | 2.69% | $23.20 |
| LINKUSDT | −$20.54 (−2.05%) | 6 | 2/4 | 33.33% | 0.74 | 7.49% | $49.81 |
| **Portfolio (3 symbols)** | **+$269.85 (+9.00%)** | **21** | **12/9** | **57.14%** | — | — | **$161.93** |

Against the 3-symbol subset of the §7.13.3 baseline (**+$227.04 / 40 trades / 52.50% WR / $326.30 fees**), the refinements add **+$42.81** net while cutting trades by **47.5%** and fees by **50.4%**. LINK is the only regression (−$27.60 vs +$7.06): the fee floor removed a micro-target short winner (2026-10-16, 0.192% target) and the SMA50 gate removed a counter-trend long winner (2026-10-18, 4H close 6.9% below SMA50), while the surviving losses clustered. The gates are behaving as designed — they trade frequency for directional and fee alignment.

> **Boundary note (resolved v2026-11-01)**: the floor originally measured against `idealEntry`, so a Market fill at a premium realised a shorter target distance — the LINK 2026-10-22 trade is the observed edge case (planned 0.353%, realized 0.287%). Both arithmetic shields now measure the **execution entry** (§7.13.5), which closes that gap by construction: the gate and the fill can no longer disagree.

#### 7.13.5 S12 P0 Arithmetic Shields — Net R:R + ATR-to-Fee Admission — **NEW v2026-10-26**

Two arithmetic gates reject fee-dominated geometry **before** an order is ever staged. Both read fees from `src/config/fees.ts` (`ROUND_TRIP_TAKER_FEE = 0.110%`), so the live engine, the backtester and the shields can never disagree about what a round trip costs.

| Gate | Env | Rejection bucket | Rule |
| --- | --- | --- | --- |
| **Volatility admission** | `MIN_VOLATILITY_FEE_RATIO` (default `1.0`) | `insufficientVolatility` | `atr1m / close ≥ ratio × ROUND_TRIP_TAKER_FEE`. At `1.5` the 1m ATR must be ≥ **~0.165%** of price. |
| **Net reward:risk** | `MIN_NET_RR` (default `1.0`) | `insufficientNetR` | `netRr = (targetDistance − roundTripFeeInPrice) / (stopDistance + roundTripFeeInPrice) ≥ ratio`, with both distances measured from `executionEntry` (below). Fees are added to the **denominator** as well, so a tight stop is punished exactly as much as a short target. |

**Execution-price anchoring** (`resolveShieldEntry()`, v2026-11-01): both gates price the entry the trade will actually be **booked at**, not the OB midpoint unconditionally.

| Condition | Order type | `executionEntry` |
| --- | --- | --- |
| Discount (`idealEntry` better than the market) or within `SMART_ENTRY_THRESHOLD_PCT` (0.15%) | Market | `currentPrice` — the signal 1m close, which is exactly the backtester's Market fill |
| Adverse move beyond the threshold | Limit @ OB midpoint | `idealEntry` |
| Market price already outside `SL..TP` | — | `idealEntry` (the setup is DEAD; pre-flight owns it and performs the burn) |

The Market/Limit decision is delegated to `shouldUseMarketEntry()` from `src/config/fees.ts` — the same helper used by `executeStagedEntry()`, `handleApproval()` and the backtester — so the shield and the executor can never disagree about the order type.

**Why it matters**: on a long, an adverse fill simultaneously **widens** the stop (`entry − SL`) and **shortens** the target (`TP − entry`). Judging the same geometry from `idealEntry` therefore understates risk and overstates reward. A measured example from the NEAR 60-day control: the 2026-10-05 04:54 trade passed the `MIN_NET_RR=1.0` gate at 1.004 on `idealEntry = 4.8537`, but filled at 4.854 — a 0.006% premium — where the realised geometry is (0.0240 − 0.0053) / (0.0138 + 0.0053) = **0.973**. The gate now rejects it with `insufficientNetR`.

**Measured effect (NEARUSDT, identical 60-day window 2026-09-01 → 2026-10-31, clock pinned so both runs read the same cache)**:

| Run | Trades | Net | WR | PF | Max DD | Fees |
| --- | --- | --- | --- | --- | --- | --- |
| Before (idealEntry) | 10 | +$284.94 (+28.49%) | 70.00% | 6.19 | 2.22% | $78.26 |
| After (execution entry) | 9 | +$252.24 (+25.22%) | 66.67% | 5.64 | 2.22% | $68.83 |

Nine of ten signals are byte-identical (same timestamps, same prices); the only delta is the 2026-10-05 trade above. The funnel shifts accordingly: `insufficientNetR` falls 84 → 38 because discount fills are now credited with the better price they actually pay, while `insufficientRoom` rises 550 → 614 as those setups advance one gate further. The removed trade was a winner (+$31.54), so the gate costs profit on this window — that is the price of enforcing a floor the trade violated at fill. Directionally this is a correctness fix, not a tuning knob: do not lower `MIN_NET_RR` to buy the trade back.

**Why both, and why two separate buckets**:
- The volatility gate answers *"is this market worth paying to trade at all?"* — a 1m ATR narrower than the round-trip fee makes the stop noise-wide relative to its own cost, and no win rate survives that. It fires **before** CHoCH detection, so a dead-volatility minute never even reaches structure matching.
- The net-R gate answers *"does this specific geometry still pay after both legs?"* — it fires **after** `resolveTakeProfit()`, because it needs the resolved target. A setup can clear the volatility gate and still fail here when the structural target sits close relative to the stop.
- Collapsing them into one bucket would destroy the funnel's diagnostic value: `insufficientVolatility` clusters by market regime, `insufficientNetR` clusters by stop/target geometry. They are reported separately in the backtest summary.

**Placement invariants**:
1. The volatility gate reads the **latest 1m close** as the ATR reference and fails closed on a non-positive price (`invalidAtr`).
2. The net-R gate runs on `baseLevels` (the pre-target geometry) and rejects on zero stop distance (`geometry`) before dividing.
3. Neither gate clamps, rounds or "adjusts" a target — rejection only. Widening a stop or shrinking a target to satisfy a ratio would silently rewrite the scenario's structure.
4. Both are resolved per symbol through `resolveSymbolConfig()`, so `MIN_NET_RR_<SYMBOL>` and `MIN_VOLATILITY_FEE_RATIO_<SYMBOL>` calibrate one pair without touching the portfolio.
5. The Net-R gate and the fee floor share **one** `executionEntry` per evaluation (`resolveShieldEntry`); neither may be measured from `idealEntry` while the other uses the fill. The emitted `levels.entry` stays the OB midpoint — the shield only prices the fill, so Limit placement and the pre-flight DEAD-setup guards keep their existing anchors.
6. A market price that has already left the `SL..TP` envelope is **not** priced as a fill: the setup is DEAD and the pre-flight path must own it so the mitigation burn still happens. Moving that rejection into the shield funnel would skip the burn and risk a ghost re-entry.

**Scope**: both parameters are read **exclusively** by `Scenario12_SniperTouch.ts`. Scenarios 1–11 never consult them, which is why a Classic deployment (`.env.subaru`) must not carry them — a knob that is never evaluated is worse than an absent one, because it reads as protection.

**Verified Sniper calibration** (`.env.emilia`): `MIN_NET_RR=1.5`, `MIN_VOLATILITY_FEE_RATIO=1.5` globally, with `MIN_VOLATILITY_FEE_RATIO_NEARUSDT=1.0` **and** `MIN_NET_RR_NEARUSDT=1.0` as the audited per-symbol exception (§7.23).

> **Endurance correction (v2026-10-28)**: the global `1.5` shields are **not uniformly protective**. On NEARUSDT's 180-day window they cut the return from +22.40% to +3.46%. They remain the correct default — they are what stopped AKE/WLD from fee-death in the 60-day screen — but they must be *calibrated per pair*, not assumed. A partial relaxation is also not enough: volatility alone at 1.0 yields +14.87%, so the ladder must be measured to its end (§7.23).

---

### 7.14 Backup Service CSV Export — **NEW v2026-10-01**

**Problem**: Database schema evolved with new columns (`order_type`, `limit_price`, `management_state` JSONB) but backup CSV export didn't include them.

**Solution**: Updated `tradesToCsv()` in `src/services/backupService.ts`:

1. **Added columns to CSV header**:
   ```typescript
   const headers = [
     // ... existing columns ...
     'order_type',
     'limit_price',
     'management_state',
   ];
   ```

2. **JSONB Serialization for `management_state`**:
   ```typescript
   // In row mapping:
   escape(JSON.stringify(t.management_state || {}))
   ```
   - Uses `JSON.stringify()` with `{}` fallback for null
   - Wrapped in existing `escape()` function (handles CSV escaping: doubles quotes, wraps in quotes if contains commas/quotes/newlines)
   - Empty object `{}` fallback for null/undefined

4. **Type Safety**: Updated `TradeRecord` interface in `database.ts` to include `management_state: any | null`

**CSV Output Example**:
```csv
id,symbol,...,order_type,limit_price,management_state
"trade_123","BTCUSDT",...,"Limit","50000.00","{\"milestone1Triggered\":true,\"milestone2Triggered\":false,\"initialTotalR\":\"5.2\",\"initialQty\":\"0.1\"}"
```

**Invariant**: JSONB always serialized as valid JSON string, CSV-safe via existing `escape()` function (doubles quotes, wraps in quotes if contains special chars).

---

### 7.15 Same-Candle SL/TP Resolution (Lookahead Bias Fix) — **NEW v2026-09-24**

**Problem**: In `checkAndCloseTrade()`, if a 15m candle's wick pierced BOTH SL and TP, the old code checked TP first → counted as WIN. This is lookahead bias — in reality, the SL was hit first (wick down), then price reversed to TP.

**Fix** (`checkAndCloseTrade` in `executionSimulator.ts`):
```typescript
// CRITICAL: Check SL FIRST - if both hit same candle, it's a LOSS (wick hit SL first)
const hitSL = isLong ? low.lte(trade.slPrice) : high.gte(trade.slPrice);
const hitTP = isLong ? high.gte(trade.tpPrice) : low.lte(trade.tpPrice);

// SL checked FIRST
if (hitSL) {
  exitPrice = trade.slPrice;
  closedBy = 'SL';
} else if (hitTP) {
  exitPrice = trade.tpPrice;
  closedBy = 'TP';
}
// If both hit same candle → LOSS (BOTH)
if (hitSL && hitTP) closedBy = 'BOTH';
```

**Rule**: On same-candle SL+TP hit → ALWAYS treat as LOSS (conservative). This eliminates the "20 wins in a row every 15 min" artifact.

---

### 7.16 Mitigated Zones Fix (Zone Re-entry Bug) — **NEW v2026-09-24**

**Problem**: `mitigatedZones` was only updated on trade CLOSE. Bot would enter, close, then re-enter same zone because the zone wasn't "burned" until after close.

**Fix** (`openTrade` in `executionSimulator.ts`):
```typescript
// Add zone to mitigatedZones to prevent re-entry on same zone
mitigatedZones: zoneDetails ? [...state.mitigatedZones, {
  type: zoneDetails.type as 'OB' | 'FVG' | 'BREAKER' | 'MITIGATION',
  top: zoneDetails.top.toString(),
  bottom: zoneDetails.bottom.toString(),
  timeframe: zoneDetails.timeframe,
  direction: zoneDetails.direction,
  timestamp: zoneDetails.timestamp,
}] : state.mitigatedZones,
```

**Result**: Zone is "burned" immediately on entry — no re-entry possible on same zone.

---

### 7.17 Cooldown Logic Fix — **NEW v2026-09-24** (Updated v2026-09-27: Dynamic Timeframe Support, **v2026-10-10: Reconciliation Cooldown**)

**Problem**: Cooldown (4h) was applied after ALL trades (wins and losses), blocking valid trend continuation. Also, the cooldown was hardcoded to 15-minute timeframe (`16 * 15 * 60 * 1000`), breaking when `LTF_TIMEFRAME` changed.

**Fix**: Cooldown ONLY after LOSS (revenge trading protection). After WIN → no cooldown. Cooldown duration is now fully dynamic: `COOLDOWN_CANDLES × LTF_TIMEFRAME` minutes. **Additionally, cooldown is now triggered not only on WS position close but also when a trade is closed via ReconciliationLoop (`reconcile()` / `reconcileWithTrade()`) with a negative PnL.**

```typescript
// executionSimulator.ts (backtest)
const ltfMinutes = Number(config.ltfTimeframe);
const cooldownMs = config.cooldownCandles * ltfMinutes * 60 * 1000;
cooldownUntil: netPnl.lt(0) ? candle.timestamp + cooldownMs : 0;

// strategyEngine.ts (live) — on WS position close
if (finalPnlString !== null && new Decimal(finalPnlString).lt(0)) {
  const ltfMinutes = Number(this.deps.config.ltfTimeframe);
  const cooldownMs = this.deps.config.cooldownCandles * ltfMinutes * 60 * 1000;
  this.cooldownUntil = Date.now() + cooldownMs;
  const cooldownHours = (cooldownMs / (60 * 60 * 1000)).toFixed(2);
  logger.info(`[${this.symbol}] Cooldown active after stop-loss. Skipping scan for ${cooldownHours}h.`);
}

// strategyEngine.ts (live) — on ReconciliationLoop close (reconcile / reconcileWithTrade)
if (finalPnlString !== null && new Decimal(finalPnlString).lt(0)) {
  const ltfMinutes = Number(this.deps.config.ltfTimeframe);
  const cooldownMs = this.deps.config.cooldownCandles * ltfMinutes * 60 * 1000;
  this.cooldownUntil = Date.now() + cooldownMs;
  const cooldownHours = (cooldownMs / (60 * 60 * 1000)).toFixed(2);
  logger.info(`[${this.symbol}] Cooldown activated via reconciliation for ${cooldownHours}h (until ${new Date(this.cooldownUntil).toISOString()}).`);
}
```

**Rule**: Cooldown = `COOLDOWN_CANDLES` candles (default 16) ONLY after LOSS. WIN = no cooldown, ride the trend. Triggered by WS position close, ReconciliationLoop, or `reconcileWithTrade()`.

### 7.18 Backtest Report Enhancements — **NEW v2026-09-24**

Added two new sections to backtest report (`reporter.ts`):

1. **🗓️ TRADE TIMELINE (Last 30 Days)** — daily calendar with UTC timestamps:
```
[2026-09-04] ✅ 10 trades | Daily PnL: +$4138.13
  ↳ 07:45:00 UTC - Scenario 6 (WIN: +$60.00)
  ↳ 08:30:00 UTC - Scenario 6 (WIN: +$67.49)
```

2. **🔍 DETAILED RECENT TRADES (Last 5 trades)** — full UTC timestamps:
```
↳ ETHUSDT | Scenario 6 (SMS) | WIN
   Entry: 2026-05-23 06:30:00 UTC | Exit: 2026-05-23 06:45:00 UTC
   Entry: 2128.21 | SL: 2135.81 | TP: 2105.42 | Qty: 2.63
   PnL: +$53.83 (+0.96%) | Fees: $6.12
```

3. **⏳ DRY SPELLS** — max consecutive days without trades, periods >3/5/7 days.

All timestamps in **UTC** for cross-referencing with live logs.

#### 7.18.1 HTML Equity Curve Generator — **NEW v2026-10-19**

**Artifact**: `writeBacktestArtifacts()` in `src/backtest/reporter.ts` emits `data/Backtest_Chart_<SYMBOL>.html` next to the text report on every run. The file is self-contained (inline CSS + serialized data arrays) and loads Chart.js 4.4.1 from the CDN. `generateEquityCurveHtml()` is a pure function so it is unit-testable without disk I/O. Artifact writing is non-fatal — a disk error logs a warning and never aborts the backtest.

**Data pipeline**: `buildEquitySeries(initialBalance, trades, periodStart)` sorts trades by `exitTime`, walks them once, and produces `{ label, equity, peak, drawdownPct }` per point plus one anchor point. Decimal math stays authoritative; values are converted to `number` only at the Chart.js boundary.

**X-axis anchoring**: the chart starts **one day before the earliest `entryTime`** — minimum across all trades, not `trades[0]` (the incoming array is unsorted) — clamped to `periodStart`. Without this, a 1m Sniper cache starting months after the 15m/4H window rendered a misleading months-long flat line (the "April Illusion").

**Two drawdown metrics — deliberate design**:

| Series | Data source | Purpose |
| --- | --- | --- |
| **Closed Drawdown %** | `(peak - balance) / peak` recomputed after each closed trade | Dips actually locked in by realized PnL; shows drawdown duration and shape |
| **Max Floating Drawdown** | Flat dashed line at `maxDrawdown` reported by `ExecutionSimulator` | Deepest **intra-trade** equity dip sampled continuously (entry fees, partial closes, adverse excursion) |

**Why both**: the closed-trade series is sampled only at exit, so a position that went 20% underwater before recovering to a small loss leaves almost no trace — the chart shows ~6% while the summary card reports 19.93%. That dissonance makes the report look broken. The floating reference line exposes the true "max pain" floor **without storing tick-by-tick equity**, which would balloon both artifact size and simulator memory.

**Rendering rules**:
- Drawdown is plotted as **positive magnitudes** on `y1`; the axis uses `reverse: true` + `min: 0` + `suggestedMin: 0` so `0%` sits at the top and deeper drawdowns point downwards. Tooltips and tick labels add the minus sign. Re-negating the data would flip the axis direction — never do it.
- `y1.suggestedMax = max(seriesMax, reportedMax) * 1.2` — 20% headroom below the deepest dip, because a reversed axis otherwise clips the red line at the plot floor. `reportedMax` is included because the simulator's figure can be deeper than any closed-trade point (fees, partial closes).
- The floating line dataset is **suppressed entirely** (`data: []`) when the reported max drawdown is `0` (or non-finite), so an all-time-high run does not get a meaningless line pinned at `0%`.
- Tooltip entries are prefixed by dataset name (`Closed Drawdown: -6.40%` / `Max Floating Drawdown: -19.93%`) so the two `y1` series never read as duplicates.

**Invariant**: The floating line value MUST come from the simulator's `maxDrawdown`, **never** from `max(series drawdown)`. Recomputing it from closed trades collapses both metrics into one and reintroduces the visual gap.

**Trade Overlay (Lightweight Charts)** — **NEW v2026-10-20**:

The same artifact also renders a second panel under the equity curve: an interactive OHLC candlestick terminal with every trade's entry and exit drawn as markers.

| Piece | Detail |
| --- | --- |
| **Wiring** | `printReport(..., candles = [])` → `writeBacktestArtifacts(..., dataDir = 'data', candles = [])` → `generateEquityCurveHtml(..., candles)`. `run.ts` passes `candlesLtf` to both artifact writers. |
| **Candle conversion** | `buildTradingViewCandles(candles)` — ms → seconds (`Math.floor(ts / 1000)`), string OHLC → number, malformed candles dropped, duplicates deduped (last wins), sorted ascending. Lightweight Charts requires strictly ascending unique times and throws on NaN. |
| **Marker alignment** | `buildTradingViewMarkers(trades, candles)` — binary-searches the latest candle time `<= event time`, so every marker timestamp exists in the series. Entries are arrows (`arrowUp`/`arrowDown`, `Buy` below bar / `Sell` above bar); exits are circles coloured by PnL sign and labelled `TP`/`SL`/`BOTH` from `TradeResult.closedBy`. Markers are sorted ascending (stable sort keeps entry before exit on a shared candle). |
| **Timeframe label** | `describeCandleInterval(candles)` derives `15m` / `4H` / `1D` from actual candle spacing — no hardcoded timeframe (see Invariant 12). |
| **Library loading** | Head script `https://unpkg.com/lightweight-charts/dist/lightweight-charts.standalone.production.js` (unversioned). The inline renderer supports **both** APIs: v5 `chart.addSeries(LightweightCharts.CandlestickSeries, …)` + `LightweightCharts.createSeriesMarkers(series, markers)` and v4 `chart.addCandlestickSeries(…)` + `series.setMarkers(…)`. Pinning to a single major version would silently break the artifact on a CDN bump. |
| **Isolation** | Chart.js and Lightweight Charts render in independent functions (`render()` / `renderTradeChart()`). A CDN failure in one library never blanks the other panel; an empty candle array shows an explanatory message instead of an empty canvas. |
| **X-axis** | `fitContent()` after `setData()` so the whole run (and all markers) is visible on open; users can scroll-zoom into individual trades. |

**Memory rule**: `cleanupMemory()` in `run.ts` MUST NOT clear `candlesLtf` — the LTF array is consumed downstream by the text/HTML artifact writers. HTF and 1m buffers are still released. Clearing the LTF array before `printReport` produced an artifact with a zero-candle chart.

**Invariant**: A marker time MUST exist in the candle series and markers MUST be sorted ascending, otherwise Lightweight Charts rejects the whole marker set. Never pass raw trade timestamps (they usually fall between two candles).

---

### 7.19 Backtester Critical Fixes (Ghost Signal & Data Integrity) — **NEW v2026-09-26**

**Problem**: Backtest was producing fake results — Scenario 6 (SMS) opened 20+ winning trades in a row every 15 minutes at the same entry price because:
1. **Mitigated structures not tracked on WIN**: When a trade closed in profit, its trigger structure (CHoCH/SMS) was not added to `mitigatedStructures`, allowing re-entry on the same structure.
2. **Mitigated zones not burned on entry**: Zones were only added to `mitigatedZones` on trade CLOSE, allowing re-entry on same zone before close.
3. **Same-candle SL/TP bias**: TP was checked before SL → fake wins when both hit same candle wick.
4. **DB `reason` field not updated**: Close reason (TP/SL/RECONCILIATION) not persisted.

**Fixes Applied** (`src/backtest/executionSimulator.ts` + `src/db/database.ts` + `src/engine/strategyEngine.ts`):

| Fix | Location | Change |
|-----|----------|--------|
| **Mitigated structures on ALL closes** | `checkAndCloseTrade()` | Always push trigger structure (`structureType`, `structureTimestamp`, `structurePrice`) to `state.mitigatedStructures` on close (win or loss) |
| **Zone burned on ENTRY** | `openTrade()` | Add zone to `mitigatedZones` immediately on trade open — prevents re-entry before close |
| **SL priority in same candle** | `checkAndCloseTrade()` | Check SL FIRST; if both SL+TP hit → `closedBy = 'BOTH'` = LOSS at SL price (conservative) |
| **DB closeTrade with reason** | `database.ts:closeTrade()` | Added `reason` parameter; callers pass `'TP' \| 'SL' \| 'RECONCILIATION'` based on PnL sign |
| **State propagation** | Both functions | Single unified `newState` return ensures `mitigatedStructures` + `mitigatedZones` flow to next candle |

**Result**: Ghost signals eliminated. Scenario 6 on ETHUSDT — duplicate 06:30/11:30 entries at same price removed. CHoCH marked "used" after first trade. Backtest results now reflect realistic execution.

---

### 7.20 Hybrid Smart Entry Architecture (Market vs Limit) — **NEW v2026-09-29**

**Problem**: Entering Market orders at the close of the 15m signal candle is mathematically unprofitable in SMC. Price has already "run away", SL becomes huge, R:R breaks, and Bybit rejects TP/SL with error [10001] (TP/SL limits).

**Solution**: **Hybrid Smart Pullback Limit Orders** — bot dynamically chooses between Market and Limit (GTC) based on price deviation from ideal entry.

#### 7.20.1 Decision Logic (`src/engine/strategyEngine.ts`)

```typescript
const idealEntry = new Decimal(result.levels.entry);      // Zone equilibrium (e.g., OB 0.5, FVG 0.5)
const currentPrice = new Decimal(lastCandle.close);       // Signal candle close
const smartThreshold = new Decimal(config.smartEntryThresholdPct); // 0.0015 = 0.15%

const priceDiffPct = idealEntry.minus(currentPrice).div(idealEntry).abs();
const useMarketOrder = priceDiffPct.lte(smartThreshold);

const orderType = useMarketOrder ? 'Market' : 'Limit';
const limitPrice = useMarketOrder ? null : idealEntry.toFixed(8);
```

| Condition | Order Type | Price |
|-----------|------------|-------|
| `|idealEntry - currentPrice| / idealEntry ≤ 0.15%` | **Market** (IOC) | — |
| `|idealEntry - currentPrice| / idealEntry > 0.15%` | **Limit** (GTC) | `idealEntry` |

**Config**: `SMART_ENTRY_THRESHOLD_PCT=0.15` (in `.env`, interpreted as 0.15% → 0.0015 in code).

#### 7.20.2 Smart Cancellation — Limit Order Lifecycle

**Expiration** is **mode-aware**, because the candle count is measured in the *execution* timeframe:

| Mode | Knob | Default lifetime |
|------|------|------------------|
| **V4 Classic** | `LIMIT_EXPIRATION_CANDLES` (LTF candles) | 6 × 15m = **90 min** |
| **V5 Sniper** | `SNIPER_LIMIT_EXPIRATION_CANDLES` (1m candles) | 15 × 1m = **15 min** |

Resolve both through `resolveLimitExpirationCandles()` / `resolveLimitExpirationMs()` (`src/config/env.ts`) — the live reconciliation loop and the backtest simulator MUST use the same helper so they cannot drift.

> **Why the split (v2026-10-22)**: 6 candles meant 90 minutes in Classic but only **6 minutes** in Sniper Mode, silently inheriting the LTF count. Measured on 60d 1m backtests, a 1m OB-midpoint pullback routinely needs 7–15 minutes: with a 6-minute lifetime SOL filled 1 placed limit and expired 4, while at 15 minutes it filled 3 and expired 1. The lifetimes are now independent, and Classic behaviour is unchanged.

**ReconciliationLoop** (`src/bootstrap/reconciliation.ts`): Every 10 min, calls `getOpenOrders(symbol)` → for each active Limit order:
- If `orderAge > resolveLimitExpirationMs(config)` → **cancel** on exchange (`cancelOrder`).
- Log: `Cancelled expired LIMIT order ${orderId} (age: X min, limit: N candles)` — `N` is the *resolved* count, not the raw Classic knob.

**Rationale**: If a Limit order has not filled within its mode's lifetime, the setup context is stale — price action has moved on.

#### 7.20.3 Backtester Simulation (`src/backtest/executionSimulator.ts`)

New state machine for Limit orders:

```
SCANNING → [Limit placed] → PENDING (limitPrice, placedAt, candlesWaited=0)
                                    │
                        ┌───────────┴───────────┐
                        ▼                       ▼
              Candle wick touches          candlesWaited > 6
              limitPrice?                     (expiration)
                        │                       │
                        ▼                       ▼
              PENDING → IN_TRADE          PENDING → CANCELLED
              (filled at limitPrice)       (no PnL, zone stays mitigated)
```

**Key points**:
- Zone added to `mitigatedZones` **immediately on Limit placement** (not on fill) — prevents re-entry before fill.
- Fill detection: current candle `low ≤ limitPrice` (Long) / `high ≥ limitPrice` (Short).
- Filled at exact `limitPrice` (not candle close) — realistic simulation.
- Expired Limit orders leave `mitigatedZones` intact (zone already "burned").

#### 7.20.4 Execution Engine (`src/execution/executionEngine.ts`)

```typescript
async execute(plan: PositionPlan): Promise<ExecutionResult> {
  if (plan.orderType === 'Limit' && plan.limitPrice) {
    return this.submitter.placeLimitOrderWithTpsl({
      symbol: plan.symbol,
      side: plan.side,
      qty: plan.qty,
      price: plan.limitPrice,        // idealEntry
      stopLoss: plan.stopLoss,
      takeProfit: plan.takeProfit,
      orderLinkId,
      timeInForce: 'GTC',
    });
  }
  // Market fallback
  return this.submitter.placeMarketOrderWithTpsl({...});
}
```

**BybitClient** (`src/api/bybitClient.ts`): New method `placeLimitOrderWithTpsl()` with `orderType: 'Limit'`, `timeInForce: 'GTC'`, and TP/SL attached.

---

### 7.21 Scenario 12 SL/TP Calculation Fix — **NEW v2026-10-02**

**Problem**: Scenario 12 (Sniper Touch) was generating mathematically impossible trades (invalid SL level for Buy side: entry=2722.00, sl=2726.16) because it used manual inline SL/TP calculation instead of the centralized `BaseScenario.calculateLevels()`.

**Root Cause**: Violation of §16.5.1 — inline SL/TP calculation instead of using `BaseScenario.calculateLevels()`.

**Fix**: Removed manual SL/TP calculation in `Scenario12_SniperTouch.ts`. Now uses:
1. Creates `obZone` from Order Block (top, bottom, direction)
2. Calls `this.calculateLevels(idealEntry, obZone, direction, atr1m, R:R=3, offsetMultiplier)`
3. Returns guaranteed correct SL/TP geometry

**Guarantees Restored** (per §6.5):
| Direction | Guarantee |
|-----------|-----------|
| **BULLISH (Long)** | `SL < Entry < TP` — always, even if `zone.top < zone.bottom` |
| **BEARISH (Short)** | `SL > Entry > TP` — always, even if `zone.top < zone.bottom` |
| **Offset floor** | SL always at least 0.1% from entry (prevents RiskManager division by zero) |

**Implementation** (`Scenario12_SniperTouch.ts:167-201`):
```typescript
const obZone = { top: entryOB.top, bottom: entryOB.bottom, direction };
const levels = this.calculateLevels(
  idealEntry, obZone, direction, atr1m, new Decimal(3),
  this.config.smcSlAtrOffset ? new Decimal(this.config.smcSlAtrOffset) : new Decimal('0.5')
);
this.setLevels({ entry: levels.entry, stopLoss: levels.stopLoss, takeProfit: levels.takeProfit });
```

---

### 7.22 Day-of-Week Entry Filter (ALLOWED_DAYS_OF_WEEK) — **NEW v2026-10-18**

**Problem**: Weekends (Sat/Sun) are toxic low-liquidity environments — thin order books, wide spreads, erratic moves → negative-expectancy trades. Additionally, backtests need the ability to compare "strict killzone" vs "killzone-free" performance.

**Solution**: Two configurable macro entry filters (see also §7.3 bypass note):

| Variable | Default | Semantics |
|----------|---------|-----------|
| `ALLOWED_DAYS_OF_WEEK` | `1,2,3,4,5` | Comma-separated ISO weekday numbers in **UTC** (1=Monday ... 7=Sunday). Days NOT in the list block NEW entries. |
| `ENFORCE_KILLZONES` | `true` | `false` = all killzone gates are bypassed globally. Backtesting use case. |

**Implementation**:
1. **Parsing** (`src/config/env.ts`): `parseAllowedDaysOfWeek()` filters to integers 1..7, deduplicates, sorts ascending; throws if no valid days remain. `enforceKillzones` parsed like other boolean flags.
2. **Day filter injection** (`src/engine/scenarioRouter.ts`): at the very top of `evaluate()`, the UTC weekday of `currentCandleTimestamp` is computed via luxon (`DateTime.fromMillis(ts, { zone: 'utc' }).weekday`). If not included in `config.allowedDaysOfWeek` → immediate untriggered return (`reason: 'Day-of-week filter'`) BEFORE any scenario evaluation. Router-level placement guarantees identical behavior in **Live Trading and Backtesting** (both go through `router.evaluate(...)`).
3. **Killzone bypass** (`src/engine/baseScenario.ts`): `if (this.config.enforceKillzones === false) return true;` at the top of `isInKillzone()`. Direct `patternData.currentKillzone` gates in Scenarios 2, 4, 5, 7, 8, 9, 12 are prefixed with `this.config.enforceKillzones !== false && ...`.

**CRITICAL INVARIANT**: Both filters are **entry filters ONLY**. They gate NEW setups at the router/scenario stage and NEVER affect active trade management — `checkAndManagePosition()` (Adaptive Fractioning: SL→entry, partial closes, trailing SL) runs on every incoming tick, completely independent of the router. A trade opened on Friday is fully managed (trailed/closed) through the weekend regardless of `ALLOWED_DAYS_OF_WEEK`.

**Config example** (24/7 crypto backtesting without session constraints):
```bash
ALLOWED_DAYS_OF_WEEK=1,2,3,4,5,6,7   # enable weekend entries
ENFORCE_KILLZONES=false              # bypass London/NY killzone gates
```

---

### 7.23 Long-Horizon Endurance Audit — **NEW v2026-10-28**

Development was frozen on the premise that both live engines had a real edge. This section records the two stress tests that were commissioned to challenge that premise, and the one configuration change they produced. Full write-up: `data/endurance_report.md`; artifacts in `data/endurance_run/`, `data/endurance_run_noshield/`, `data/endurance_run_override/`; logs in `data/backtest_logs/`.

| Run | Symbol | Engine | Window | Trades (T/W/L) | WR | Net | PF | Max DD | Fees | MAR |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | BTCUSDT | S14 Trend Following (Donchian, 15m/4H) | **365d** | 88 / 31 / 57 | 35.23% | **+$199.41 (+19.94%)** | 1.20 | **19.82%** | $196.76 | **1.01** |
| 2a | NEARUSDT | S12 (shields 1.5) | 180d | 5 / 2 / 3 | 40.00% | +$34.64 (+3.46%) | 1.67 | 5.19% | $25.37 | 0.67 |
| 2b | NEARUSDT | S12 (shields 1.0) | 180d | 12 / 7 / 5 | 58.33% | **+$223.96 (+22.40%)** | **3.24** | **4.74%** | $88.68 | **4.73** |

Both windows ran to completion with **no data truncation**: 35,040 × 15m candles and 259,200 × 1m candles.

> **Scope**: Run 1 validated **Scenario 14 (Donchian)**, forced with an inline `ACTIVE_SCENARIOS=14`. The local `.env` ships `ACTIVE_SCENARIOS=15` (Volatility Squeeze) and the frozen `.env.subaru` Tank preset runs **S1 + S5 + S14 + S15** — S1, S5 and S15 have not been through a 365-day window, so their annual behaviour is unmeasured (only S14 was measured in that run). Never transfer the +19.94% figure between presets: "Tank" is a nickname, not an engine identity.

#### 7.23.1 S14 / BTC — the annual truth is +20%, not +38%

| Period | Return |
| --- | --- |
| H1 2025-10-29 → 2026-04-28 | **−10.98%** |
| H2 2026-04-28 → 2026-10-24 | **+34.73%** |

Only **4 of 13 monthly buckets were positive**. Jun (+24.40%), Aug (+17.95%) and Sep (+8.31%) produced **+58.92%**; the remaining ten produced **−24.52%**. Quarterly path: Q4'25 −1.12% → Q1'26 −8.87% → Q2'26 +16.20% → Q3'26 +20.86% → Oct'26 −5.23%.

| Drawdown metric | Value |
| --- | --- |
| Peak | 2026-01-05, $1,035.48 |
| Trough | 2026-05-27, $830.29 |
| Peak → trough | **141.6 days** at **19.82%** depth |
| Recovery | 2026-06-15 |
| Total underwater | **160.4 days** |
| Trade-dates below running peak | **84.3%** (75 / 89) |

Fees were **$196.76 against $396.17 gross** — **49.7% of the gross edge**. Zero-fee counterfactual: **+39.62%**. Sampled stop width ~1.04% ⇒ ~0.11R of fee burden per trade, ~9.3R over 88 trades.

Funnel: `Total 30,924 | Triggered 88 | InsideChannel 28,714 | LowVolumeBreakout 1,595 | InsufficientRr 38 | TpInvalid 489`; trade rate 0.241/day, longest dry spell 25.8 days.

> **Window-selection warning**: the previously-cited 180-day S14 result (+38.64%, DD 9.57%, MAR 4.04) started **three days after the exact trough** of that drawdown. It is a real result of a deliberately lucky window, not a higher sustainable rate. Any future comparison must use ≥365 days (§16.6.4).

#### 7.23.2 S12 / NEAR — the +27% is a burst, not a run-rate

Identical symbol, data, window and flags; **only the two P0 admission thresholds differ**. Each row is a complete 259,200-candle run, not an interpolation:

| NEAR config (180d) | Net | Trades | WR | PF | Max DD | `InsufficientVolatility` |
| --- | --- | --- | --- | --- | --- | --- |
| Global `1.5` / `1.5` | **+3.46%** | 5 | 40.00% | 1.67 | 5.19% | **26,804 (41.7%)** |
| Volatility `1.0` / net-R `1.5` | +14.87% | 10 | 50.00% | 2.54 | 4.74% | 11,987 (18.7%) |
| Volatility `1.0` / net-R `1.0` | **+22.40%** | 12 | 58.33% | **3.24** | **4.74%** | 12,008 (18.7%) |

`InsufficientNetR` stayed at **0.3–0.5%** in all three configurations, so the volatility gate is the binding constraint and the net-R gate accounts for the residual $74 between rows 2 and 3.

> **Measurement note**: the original instruction was to set only `MIN_VOLATILITY_FEE_RATIO_NEARUSDT=1.0` and expect +22.40%. A full re-run of that exact configuration produced **+14.87%** (10 trades, PF 2.54, DD 4.74%). `MIN_NET_RR_NEARUSDT=1.0` was added to reach the verified +22.40% — the claim was only committed after the ladder reproduced it end-to-end.

Raising both shields from 1.0 to 1.5 removed **7 trades** and **$189.32 of net profit** ($223.96 → $34.64); the removed set contained **five winners against two losers**. On NEAR the volatility gate was **anti-selective** — the pair's quiet 1m minutes were profitable, so a shield fitted on a different regime simply starved the strategy.

**Cadence is episodic.** Run 2b trade distribution: May **0**, June **0**, July 1 (loss), August 1 (loss), September 3, October **7**. Equity $1,000 → **$952.55** by 2026-08-25 (the max DD) → $1,223.96 by 2026-10-26. **Seven of twelve trades and essentially the entire profit landed after 2026-10-01.** Longest dry spell **49.6 days**.

A 60-day control reproduces the documented baseline (+28.49%, 10 trades, PF 6.19, DD 2.22%), confirming harness determinism — which is the point: the 60-day window **was** the cluster, compressed. Ten of the twelve 180-day trades fall inside it. The 60-day annualisation (~332%) is therefore meaningless; the 180-day figure annualises to ~+49.8% and is still regime-bound.

#### 7.23.3 Dispositions and the one sanctioned change

| Item | Disposition |
| --- | --- |
| **S14 / BTC** | Freeze is defensible: PF 1.20 and MAR 1.01 across a full annual cycle. Expectations must be reset to **≈+20%/year with a ~20% drawdown lasting ~5 months**. |
| **S12 / NEAR** | **Do not size to the 60-day figure.** +22.40% at the audited calibration, zero opportunity in two of six months, 7/12 trades in the final month. |
| **P0 shields** | Regime-dependent. They saved AKE/WLD from fee death and cost NEAR 85% of its profit. **Never fitted on one window.** |
| **`MIN_VOLATILITY_FEE_RATIO_NEARUSDT=1.0` + `MIN_NET_RR_NEARUSDT=1.0`** | Added to `.env`, `.env.emilia` and `.env.example`. Relaxes both P0 shields **for one pair only**; the global `1.5` keeps covering APTUSDT. Per-symbol resolution via `resolveSymbolConfig()` (§7.13.5) guarantees no cross-symbol leakage. |

**Rule**: a per-symbol override that relaxes a P0 shield is legal only when (a) a ≥180-day run at the override documents the improvement, (b) the rejection funnel identifies the shield as the binding constraint, and (c) the global value is left untouched. All three hold here. A corollary learned the hard way: **measure the full ladder before writing a performance claim** — the volatility knob alone yields +14.87%, and committing "+22.40%" on the strength of one knob would have shipped a number the code cannot reproduce.

---

## 8. THE SCENARIOS (1, 5, 12, 14, 15 REGISTERED) — `src/engine/scenarios/`

**Live registry.** These five IDs are the only scenarios the router can construct and the only IDs accepted by `ACTIVE_SCENARIOS` / `SCENARIOS_<SYMBOL>`. `REGISTERED_SCENARIO_IDS` in `src/engine/scenarioRegistry.ts` is the single source of truth (imported by both the router and `src/config/env.ts`); any other id is a **hard boot error**, never a silent drop. `loadConfig()` additionally aborts when Scenario 12 is requested with `ENABLE_SNIPER_MODE=false`.

| ID     | Name                | Mode          | Core Logic                                                 | Key Filters                                                                   |
| ------ | ------------------- | ------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------- |
| **1**  | HTF Continuation    | 15m Classic   | Tested 4H OB → 15m CHoCH at/after the touch → 15m FVG at/after the CHoCH (both inside the 4h window) | 4H OB direction defines the side; 16-candle causality window; displacement + dynamic TP; `wrongMode` guard |
| **5**  | HTF Liquidity Sweep | 15m Classic   | PDH/PDL/PWH/PWL/BSL/SSL sweep on the LAST CLOSED 15m candle: wick pierces the pool, close returns inside (SFP), entry at that close | Killzone + deterministic pool priority (`PDH > PDL > PWH > PWL > BSL > SSL`) + volume confirmation (`SMC_SWEEP_VOLUME_MULTIPLIER` × 20-candle SMA baseline) + wick stop with a `0.5 × atr15m` volatility buffer + structural TP (`skipMinorObstacles: true`) + fee-inclusive net R:R ≥ `DYNAMIC_TP_MIN_RR`; `wrongMode` guard |
| **12** | Sniper Touch        | 1m Sniper     | 1m CHoCH after a PDH/PDL/PWH/PWL sweep, near its OB midpoint | Killzone (London/NY) + per-CHoCH sweep causality + proximity (1 ATR macro / 0.5 ATR intraday / 0.3% floor) + persistent 4H SMA50 trend (fail closed < 20 candles, POI exception) + P0 shields (`MIN_VOLATILITY_FEE_RATIO` ATR-to-fee admission, `MIN_NET_RR` fee-inclusive R:R) + fee-aware target floor (`MIN_TP_DISTANCE_PCT`, 0.35%) + 1m CHoCH + 1m OB entry |
| **14** | Trend Following Alpha | 15m Classic | 15m Donchian breakout with volume confirmation | Classic mode; structural TP and ATR stop; `wrongMode` guard |
| **15** | Volatility Compression Squeeze | 15m Classic | BB(20,2) fully inside KC(SMA20 ± 1.5×ATR20); first expansion after ≥5 compressed candles | 15m Classic only; regression-slope direction; KC-midline ±1.5×ATR stop; `tpResolver`; trigger candle burned by timestamp; `wrongMode` guard |

**Archived — not constructible, not tradeable:** 2 (FVG Fill), 3 (IDM), 4 (Mitigation Chain), 6 (SMS), 7 (AMD), 8 (Range Deviation), 9 (Turtle Soup), 10 (Breaker Block), 11 (Mitigation Block) live under `src/engine/scenarios/archive/legacy_smc/`; 13 (Top-Down Order Flow) lives under `src/engine/scenarios/archive/`. Their modules still compile and their suites still run, so the designs remain available for reference and possible revival — but no runtime path can schedule them, and their IDs fail validation.

### 8.1 Scenario Overview

`ScenarioRouter` constructs exactly five scenarios, in registry order: **1, 5, 12, 14, 15**. Scenario 12 is the only 1m producer and requires `ENABLE_SNIPER_MODE=true` — `loadConfig()` aborts the boot when `12` is requested with Sniper Mode off, and the router still rejects it with the `disabled` bucket as a defensive backstop. Scenarios 1, 5, 14 and 15 are Classic 15m entries and reject with the `wrongMode` bucket when Sniper Mode is active or `LTF_TIMEFRAME≠15`, so a stale 15m candle can never be re-scanned on 1m ticks. `ACTIVE_SCENARIOS` narrows the registry and can never add to it. Active implementations expose rejection statistics for observability.

### 8.7 Scenario 15 — Volatility Compression Squeeze

**Files**: `src/engine/quant/volatilitySqueeze.ts`, `src/engine/scenarios/Scenario15_VolatilitySqueeze.ts`.

- Classic mode only: `ENABLE_SNIPER_MODE=false` and `LTF_TIMEFRAME=15`; the current closed candle is evaluated once per 15m router pass.
- Bollinger Bands use SMA(20) ± 2 population standard deviations. Keltner Channels use SMA(20) ± 1.5 × SMA(True Range, 20), including gaps to the prior close.
- `isSqueezed` means both BB boundaries are inside the KC boundaries. `isFiring` is the first non-squeezed point after at least five consecutive squeezed evaluations.
- Direction is the sign of the least-squares regression slope over the current 20 closes; zero slope fails closed. All calculations are causal and use `Decimal` for price-derived values.
- Stop geometry is anchored to the Keltner midline and offset 1.5 × True Range ATR via `BaseScenario.calculateLevels()`. TP is resolved by `tpResolver` (dynamic structural target when enabled; otherwise the configured fixed-R fallback).
- The trigger candle timestamp is emitted as `structureDetails` (no synthetic zone) so the live engine and backtester burn the exact consumed breakout and prevent duplicate entries.
- Dedicated rejection counters are reset and printed per symbol by `src/backtest/reporter.ts`.

### S1 FVG Completion-Bar Timing

**Scenario 1 uses the FVG completion bar, not the candle timestamp that `detectFVGs()` stamps.** `detectFVGs()` assigns the zone timestamp to `c1` (the first candle), while the three-bar FVG becomes complete only on `c3`. S1 therefore evaluates `timestamp + 2 × LTF spacing` as the completion time (the spacing is measured from the series, never assumed to be 15 minutes — Invariant 12). CHoCH/FVG causality means the completed FVG must exist at or after the CHoCH; the impulse FVG left behind by the CHoCH is valid because the break candle is `c3`, but a later FVG can only be used within the 4H causality window. Comparing raw `c1` timestamps would incorrectly exclude a valid same-CHoCH FVG or admit a gap that is not yet complete.

> **Scenario 5 no longer uses FVG timing.** The Sweep → CHoCH → FVG chain was replaced by the volume-confirmed SFP (§8.8).

### 8.8 Scenario 5 — HTF Liquidity Sweep (Volume-Confirmed SFP)

**File**: `src/engine/scenarios/Scenario5_HTFLiquiditySweep.ts`

**Premise**: a sweep is self-confirming. The wick is the manipulation, the close back inside the level is the rejection, and volume expansion is the institutional participation that separates a real stop-run from a casual poke. Nothing is deferred to a later candle.

| Step | Rule |
| --- | --- |
| **1. Pool set** | PDH/PDL/PWH/PWL/BSL/SSL, untaken, finite and > 0. Consumed in `POOL_PRIORITY` order (`PDH > PDL > PWH > PWL > BSL > SSL`) so a candle piercing several levels always reports the same one. Side is fixed per pool type (`HIGH`: PDH/PWH/BSL, `LOW`: PDL/PWL/SSL) — a "PDH sweep" can never be manufactured by a move that took no buy-side liquidity. |
| **2. SFP** | Last **closed** candle only. High pool: `high > level && close < level` → BEARISH. Low pool: `low < level && close > level` → BULLISH. No lookback window: the entry IS that candle's close, so an older wick would trade a price disconnected from the liquidity event. |
| **3. Volume** | Baseline = SMA of the **20 confirmed candles immediately before** the sweep candle (the sweep candle is excluded from its own baseline — Invariant 56). Reject as `lowVolumeSweep` when `sweepVolume < baseline × SMC_SWEEP_VOLUME_MULTIPLIER` (default **1.3**). A sparse/unparseable baseline fails closed. |
| **4. Entry** | The sweep candle's close. |
| **5. Stop** | The sweep candle's pierced extreme routed through `calculateLevels()` with `atr = atr15m`, so the stop is the wick extreme pushed away by `max(0.5 × atr15m, 0.1% of entry)` (`SMC_SL_ATR_OFFSET`). A stop parked exactly on the wick is consumed by the next 15m noise candle — the double sweep — so the volatility buffer is what makes the invalidation survivable. A missing/non-positive `atr15m` degrades to the 0.1% floor; the stop never moves behind the entry. |
| **6. Target** | `resolveTakeProfit({ skipMinorObstacles: true })`: a major HTF sweep carries enough momentum to trade through internal 15m swings, so minor candidates (BSL/SSL, 15m zones, range equilibrium, session extremes) are stepped over and the resolver continues to the first candidate clearing `DYNAMIC_TP_MIN_RR`. A MAJOR barrier (PDH/PDL/PWH/PWL/EQH/EQL/DO/WO, 4H+ zones) inside the floor still rejects — genuine room is required, not manufactured room. |
| **7. Net R:R** | `(targetDistance − entry × ROUND_TRIP_TAKER_FEE) / (stopDistance + entry × ROUND_TRIP_TAKER_FEE) ≥ DYNAMIC_TP_MIN_RR`, else `tpInvalid`. Both legs are charged, so a 1:2 that survives only before fees is not a 1:2 trade. |
| **8. Mitigation** | No `zoneDetails` — macro pools are never burned (Invariant 21). The trigger is burned as `structureDetails` (`type: 'SWEEP'`, sweep candle timestamp, wick price, direction), matching the burn-on-entry contract (Invariant 39). |

**Rejection funnel**: `totalEvals`, `wrongMode`, `killzone`, `noPools`, `insufficientCandles` (< 21 candles — the 20-candle baseline cannot be built), `noSweep`, `lowVolumeSweep`, `tpInvalid`, `triggered`. Printed per symbol by `src/backtest/reporter.ts`.

**Invariant**: All volume and price math is `Decimal` — the baseline, the multiplier comparison and the net-R:R arithmetic never touch `number`.

**Baseline — 180 days, 2026-05-05 → 2026-11-01, $1,000/symbol, `ENFORCE_KILLZONES=false`, `ALLOWED_DAYS_OF_WEEK=1..7`, `ENABLE_DYNAMIC_TP=true`, `DYNAMIC_TP_MAX_RR=6.0`, wick-tight stop (`atr = 0`), `skipMinorObstacles: false`, `SMC_SWEEP_VOLUME_MULTIPLIER=1.5`:**

| `DYNAMIC_TP_MIN_RR` | Symbol | Trades | W/L | Win rate | Net | PF | Max DD | Fees |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1.5 | BTCUSDT | 7 | 3/4 | 42.86% | **+$43.70 (+4.37%)** | 1.65 | 5.92% | $42.25 |
| 1.5 | ETHUSDT | 14 | 5/9 | 35.71% | −$11.45 (−1.15%) | 0.95 | 9.86% | $97.09 |
| 1.5 | SOLUSDT | 12 | 2/10 | 16.67% | −$147.06 (−14.71%) | 0.26 | 14.71% | $65.45 |
| 1.5 | **Portfolio** | **33** | **10/23** | **30.30%** | **−$114.81 (−3.83%)** | — | — | **$204.79** |
| 2.0 | BTCUSDT | 1 | 1/0 | 100.00% | +$33.49 (+3.35%) | ∞ | 0.00% | $8.77 |
| 2.0 | ETHUSDT | 7 | 1/6 | 14.29% | −$124.71 (−12.47%) | 0.18 | 12.47% | $42.89 |
| 2.0 | SOLUSDT | 5 | 0/5 | 0.00% | −$98.13 (−9.81%) | 0.00 | 9.81% | $29.52 |
| 2.0 | **Portfolio** | **13** | **2/11** | **15.38%** | **−$189.35 (−6.31%)** | — | — | **$81.18** |

**Baseline funnel reading** (BTC, 17,172 evaluations): `NoSweep` 12,976 (75.6%), `LowVolumeSweep` 3,010 of 4,196 SFPs (71.7%), `TpInvalid` 1,179 of the 1,186 volume-confirmed survivors (**99.4%**), `Triggered` 7. The volume gate was selective but honest; the **target gate was the binding constraint**. With a wick-tight stop, 1R is 0.1–0.3% of price, so the fee-inclusive `MIN_NET_RR` demanded a structural target 3.5–5R away — and `skipMinorObstacles: false` took the NEAREST candidate, which on a 15m chart is almost always closer.

#### 8.8.1 Refined Geometry — Volatility Stop Buffer + Macro Targeting + 1.3 Volume (v2026-11-01)

Three changes, all inside Scenario 5 (no cross-scenario impact):

1. **Stop volatility buffer** — `calculateLevels()` now receives `atr15m` instead of `0`, so the stop sits `max(0.5 × atr15m, 0.1% of entry)` beyond the pierced wick (`SMC_SL_ATR_OFFSET`). This is the double-sweep defence: a stop on the wick is consumed by ordinary 15m noise.
2. **`skipMinorObstacles: true`** — the resolver steps over minor structure and targets major macro liquidity. A major barrier inside the floor still rejects.
3. **`SMC_SWEEP_VOLUME_MULTIPLIER` default 1.5 → 1.3** (`env.ts`, `.env.example`, `.env`) — +30% institutional expansion instead of +50%.

**Measured after the refinement** (identical window/flags, `DYNAMIC_TP_MIN_RR=1.5`, `SMC_SWEEP_VOLUME_MULTIPLIER=1.3`):

| Symbol | Trades | W/L | Win rate | Net | PF | Max DD | Fees | `tpInvalid` (of survivors) | Before |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| BTCUSDT | 31 | 13/18 | 41.94% | **+$176.28 (+17.63%)** | 1.48 | 13.44% | $163.79 | 1,333 / 1,364 (97.7%) | +$43.70, 7 trades |
| ETHUSDT | 44 | 14/30 | 31.82% | −$36.74 (−3.67%) | 0.94 | 19.49% | $190.53 | 1,129 / 1,173 (96.2%) | −$11.45, 14 trades |
| SOLUSDT | 67 | 22/45 | 32.84% | −$47.13 (−4.71%) | 0.94 | 12.56% | $229.32 | 976 / 1,043 (93.6%) | −$147.06, 12 trades |
| **Portfolio** | **142** | **49/93** | **34.51%** | **+$92.41 (+3.08%)** | — | — | **$583.64** | 3,438 / 3,580 (96.0%) | **−$114.81, 33 trades** |

**Funnel deltas** (portfolio, `tpInvalid` as a share of volume-confirmed survivors `total − noSweep − lowVolumeSweep`):

| Bucket | Baseline | Refined | Delta |
| --- | --- | --- | --- |
| Total evals | 51,330 | 48,385 | −2,945 (more time spent in trades/cooldown) |
| `NoSweep` | 40,172 | 37,952 | −2,220 |
| `LowVolumeSweep` | 7,944 | 6,853 | −1,091 (1.3 admits more SFPs) |
| Volume-confirmed survivors | 3,214 | 3,580 | +366 |
| `TpInvalid` | 3,181 (98.97%) | 3,438 (**96.03%**) | share −2.94 pp, count +257 |
| `Triggered` | 33 (1.03%) | 142 (**3.97%**) | **4.3×** |

**What actually moved the needle**: `Triggered` multiplied 4.3×, not because `tpInvalid` collapsed in absolute terms — the looser volume gate fed 366 extra survivors into the same gate — but because its **share** fell 2.94 pp, and every survivor now has a wider stop (larger 1R, so fewer R-multiples needed) and a further target (minors skipped). Per-symbol: BTC quadrupled its net (+$43.70 → +$176.28) on 4.4× the trades while keeping a 1.48 PF; SOL's win rate doubled (16.67% → 32.84%) and its loss shrank by two thirds (−$147.06 → −$47.13); ETH is the one regression (−$11.45 → −$36.74) with the deepest drawdown in the set (19.49%).

**Honest reading**: the portfolio sign flipped (+3.08%), but that is *one* symbol carrying it — BTC's +$176.28 against ETH+SOL's combined −$83.87 — and fees rose to $583.64 (6.3× the $92.41 net). Max DD widened on both BTC (5.92% → 13.44%) and ETH (9.86% → 19.49%). The refinement fixed the geometric deadlock it was aimed at (the scenario is alive and tradable, `Triggered` up 4.3×), but it did **not** produce a portfolio-wide edge: 34.51% win rate with a 1.48/0.94/0.94 PF spread means the distribution across symbols is still the dominant variable. Do not deploy on the strength of BTC alone.

### 8.2 Zone Mitigation (No Re-entry) — `ScenarioRouter` + `StrategyEngine`

- `mitigatedZones[]` in engine memory (max 100).
- On trade close: `addMitigatedZone(zoneDetails)` → Router filters by `type/timeframe/direction/top/bottom` before `evaluate()`.
- Scenarios setting `zoneDetails` in the live registry: **1, 14**. Scenario 12 never emits a zone because macro liquidity pools must never be burned (Invariant 21); Scenario 5 never emits a zone for the same reason (its trigger is burned as a `SWEEP` structure); Scenario 15 emits `structureDetails` only and burns the trigger candle by timestamp. Archived scenarios 2–4 and 6–11 keep their historical tagging inside the archive.

### 8.3 Contextual Quality Filters (Confluence) — **ARCHIVED SCENARIOS**

> None of the scenarios below is registered. They live under `src/engine/scenarios/archive/legacy_smc/`, still compile and still have suites, but no runtime path can schedule them. Retained as design reference.

| Scenario                  | Filter                                       | Rejection Stat               |
| ------------------------- | -------------------------------------------- | ---------------------------- |
| **6 (SMS)**               | Confirming 15m CHoCH with displacement, at/after the SMS, inside the 72h window | `noSms`, `noOb`, `noChoch`, `displacement`, `tpInvalid` |
| **10 (Breaker Block)**    | BOS-only break, whole-block body close, 24h block freshness, liquidity grab, displacement FVG, 4h retest | `noBreak`, `bodyClose`, `displacement`, `noBrokenOb`, `obNotFresh`, `noLiquiditySweep`, `noFvg`, `noRetest`, `tpInvalid` |
| **11 (Mitigation Block)** | Valid SMS chain (15m, ordered, 72h) + P/D on the SMS→CHoCH impulse | `noSms`, `noChoch`, `displacement`, `noMitigationBlock`, `noRetest`, `premiumDiscount`, `tpInvalid` |

All three also expose `totalEvals` / `noData` / `killzone`, and report only the **deepest** rejection of the chain (`fail()` keeps the highest stage), so the bucket describes how far the setup got rather than which gate happened to run first.

---

### 8.4 Scenario 11 — Mitigation Block — Full Implementation Details — **ARCHIVED**

> **ARCHIVED — not registered, not tradeable.** The module lives at `src/engine/scenarios/archive/legacy_smc/Scenario11_MitigationBlock.ts` and its suite at `tests/scenarios/archive/legacy_smc/`. Retained as design reference.

**File**: `src/engine/scenarios/archive/legacy_smc/Scenario11_MitigationBlock.ts`

**Core Logic**: Mitigation Block is a reversal pattern that forms after a Failed Swing (SMS):
1. Price attempts a higher high (bearish SMS) / lower low (bullish SMS) but fails
2. Price reverses with a CHoCH in opposite direction (≥1.5 ATR displacement)
3. The Order Block that formed the failed swing extreme becomes the Mitigation Block
4. Trade triggers on retest of this MB by current 15m candle

**Critical Implementation Details (refactored v2026-10-26):**

| Aspect | Implementation | Why Critical |
|--------|---------------|--------------|
| **SMS Selection** | `structures.filter(s => s.type === 'SMS' && s.timeframe === '15')` → sorted by timestamp descending → `slice(0, 3)` fan-out | Never trusts array order (`detectStructureBreaks()` appends SMS **after** the chronological pass); the fan-out lets a freshest-SMS-without-a-block fall through to a valid older chain |
| **CHoCH Selection** | `type === 'CHOCH' && direction === sms.direction && timeframe === '15' && ts >= sms.ts && ts <= sms.ts + 8h && ts <= retest.ts` → newest | Strict causality in **both** halves: the CHoCH confirms the SMS, so it can never precede it; the 8h budget blocks stale reversals |
| **MB Selection** | `type === 'OB' && direction === opposite(sms.direction) && timeframe === '15' && ts < sms.ts` and inside the 72h window of **both** the SMS and the CHoCH → newest | The block of the **failed leg** sits opposite the SMS direction and pre-exists it; the window stops a month-old block from being paired with a fresh break |
| **Retest Logic** | **Current 15m candle ONLY** (`candles15m[candles15m.length-1]`) | No historical search — trade triggers NOW |
| **Time Window** | `0 < timeSinceChoch ≤ 12h` | Blocks stale setups; 12h max hold |
| **Retest Condition** | Wick touches the block (`low ≤ mbTop && high ≥ mbBottom`) **and** the body closes inside it **in the trade direction** (bullish body for a long, bearish for a short) | Confirms institutional interest at the MB; a body closing against the trade absorbs the level instead of rejecting it |
| **Entry** | `retestClose` (documented S11 behaviour — unlike S6/S10, which enter at the block midpoint) | The mitigation print is the entry price |
| **Stop** | Block edge **widened by the retest wick**, then `calculateLevels()` | A wick that already traded through the edge is part of the entry, not a level the position may be stopped by afterwards |
| **Premium/Discount** | Dynamic equilibrium from the `SMS price → CHoCH price` impulse | Long = Discount (below eq), Short = Premium (above eq) |
| **Take-Profit** | `resolveTakeProfit({ skipMinorObstacles: false })` | Nearest obstacle is a hard wall: no room → reject (`tpInvalid`), never clamp |
| **Rejection Stats** | `noSms`, `noChoch`, `displacement`, `noMitigationBlock`, `noRetest`, `premiumDiscount`, `tpInvalid` (+ `noData`, `killzone`, `totalEvals`) | Full observability |

**Removed legacy logic (v2026-10-26)**:
- `validateSmsPattern()` returned a rejection **string** that the caller re-parsed with `includes()` to pick a stats bucket — a bucket could be mis-attributed by wording. The funnel now reports the stage directly.
- The fixed `calculateLevels(..., rr = 3)` target, which restated the stop distance instead of consulting the market.
- `!z.mitigated` as the only freshness guard: `Zone.mitigated` is always `false` from the recognizer, so it never filtered anything.

**Key Invariants:**
- `structures` and `zones` arrays are **not** guaranteed chronological for SMS (SMS entries are appended last) — always sort by timestamp before selecting
- **Never use `[0]` or a forward `.find()`** for "newest" — sort descending, or `[...arr].reverse().find(...)`
- Retest is **current candle only** — no historical search
- P/D equilibrium calculated from the `SMS price → CHoCH price` impulse
- Maximum 12h from CHoCH to retest (prevents stale setups)

---

### 8.5 V4 Classic Refactoring Standards (v2026-10-16)

All Scenarios 1–11 were overhauled to eliminate array access hazards, enforce single-source-of-truth SL/TP math, and mandate mitigation tagging. Three rules are now mandatory for every classic scenario.

> **Scope today**: only Scenarios **1** and **5** (plus 14 and 15, added later) are live. The standards below still bind every live Classic scenario and every archived module that might be revived; references to 2–4 and 6–11 describe the v2026-10-16 pass that produced the archived code.

#### 1. Freshness Guarantee (No `array[0]`)
Scenarios MUST NEVER access the 0-th index or use a forward `.find()` when looking for OBs, FVGs, or CHoCHs — this fetches the oldest, stale structures. They MUST use `array[array.length - 1]` or `[...array].reverse().find(...)` to guarantee trading on the most recent market data.

> **Why**: `structures`, `zones`, `fvgs`, and `sessionRanges` arrays are timestamp-ascending (oldest first). Trading `array[0]` means trading a days-old zone. This hazard was present in 10 of 11 scenarios and eliminated in the v2026-10-16 pass (see §16.5.4).

#### 2. SL/TP Single Source of Truth
Inline math for stop-loss or take-profit (e.g., `zone.bottom - offset`) is strictly forbidden. Every scenario must call `this.calculateLevels(...)` — the single source of truth for level geometry in `BaseScenario` — to ensure protection against inverted zones (`Decimal.min/max` of top, bottom, and entry) and to enforce the 0.1% minimum spread offset floor.

> **Why**: Naive inline SL formulas broke whenever a zone had arbitrary `top`/`bottom` ordering, producing `invalid SL level` exchange errors. Scenarios 5 and 9 were the last inline violators, refactored to `calculateLevels` in v2026-10-16.

#### 3. Mandatory Mitigation Tagging
Every scenario MUST populate `structureDetails` in its `RouterResult` — the trigger structure (`CHoCH`/`BOS`/`SMS` with `{ type, timestamp, price, direction }`). This allows `burnSetup()` and the live execution engine to instantly burn the trigger structure upon entry or abort, preventing Ghost Signal loops across all 11 classic patterns.

> **Why**: Structures without `structureDetails` are never added to `mitigatedStructures` — the same trigger CHoCH can be re-detected on the next scan, producing infinite ghost re-entries. Zones are additionally tagged via `zoneDetails` (live: Scenarios 1, 5 and 14; historically 1–8, 10, 11 in the archive). Scenario 12 never emits a zone because macro liquidity pools must never be burned (Invariant 21); Scenario 15 emits `structureDetails` only.

---

### 8.6 Scenario 13 — Top-Down Order Flow Matrix — **ARCHIVED v2026-10-23**

> **ARCHIVED — not registered, not tradeable.** As of v2026-10-23 Scenario 13 lives in `src/engine/scenarios/archive/Scenario13_TopDownOrderFlow.ts` and is no longer constructed by `ScenarioRouter`. `ACTIVE_SCENARIOS` / `SCENARIOS_<SYMBOL>` accept **1–12** only: a `13` in a per-symbol override is silently dropped during parsing, and a `13` in `ACTIVE_SCENARIOS` fails validation. The module still compiles and its test suite still runs (`tests/scenarios/archive/scenario13_top_down.test.ts`), and the rest of this section is retained as design reference for a possible revival. **Why archived**: the multi-timeframe cascade produced fee-dominated results at 1m granularity; effort moved to Scenario 12 frequency (per-CHoCH sweep pairing + opt-in sweep sources, §7.13.2).

**File**: `src/engine/scenarios/archive/Scenario13_TopDownOrderFlow.ts` (archived)
**Brain modules**: `src/engine/brain/htfRoadmap.ts`, `src/engine/brain/volumeExhaustion.ts`, `src/engine/tpResolver.ts`. The brain modules and `tpResolver` remain in the live tree — `tpResolver.resolveTakeProfit()` is used by Scenarios 1 and 5 for structural take-profit resolution.
**Runtime requirement (historical)**: `ENABLE_SNIPER_MODE=true` — the live engine forwards `candles1m` to the router only under that flag (`strategyEngine.ts:925`), and the backtester did the same. With the flag off, or with fewer than 15 1m candles, S13 failed closed with the `disabled` bucket; there was no blind 15m fallback. S13 and S12 could never share a symbol: both are 1m producers on the same per-symbol `IN_TRADE` slot.

**Premise**: S13 traded only when three independent timeframes agree **in a strict causal order**. The 4H answers *where* price is going, the 15m answers *whether the pullback is exhausted*, the 1m supplies *the trigger and the precision stop*. No timeframe is allowed to substitute for another, and every gate fails closed.

#### 8.6.1 Gate Funnel

| Gate | Timeframe | Question | Rejection keys |
| --- | --- | --- | --- |
| **1. Roadmap** | 4H | Is there a directional bias (`BULLISH`/`BEARISH`, never `NEUTRAL`) and a valid structural draw? | `noHtfRoadmap`, `htfNeutral` |
| **2. POI selection** | 15m | Which zone sits between current price and the 4H target, inside the `3 × atr15m` proximity band? Iterated **proximity-ranked** (R1) so the newest zone cannot shadow a closer testable one. | `noPoi` |
| **3. Volume exhaustion** | 15m | Did counter-pressure decay into the touch, and did the touch print a reaction surge? | `volumeInvalid`, `noPullbackOrigin`, `insufficientPullbackCandles`, `pullbackVolumeHeavy`, `poiViolated`, `noPoiTouch`, `noReaction`, `insufficientAsymmetry` |
| **4. Micro trigger** | 1m | Fresh CHoCH/BOS **strictly after** the touch minute (R2 causality) + precision stop layout. | `noReaction` |
| **5. TP resolution** | Structure | Is there a structural target beyond entry that clears `DYNAMIC_TP_MIN_RR`? | `tpInvalid` |
| **6. Mitigation tagging** | — | Emit `zoneDetails` + `structureDetails` so the trigger structure is burned on entry (Invariant 39). | `triggered` |

#### 8.6.2 Brain Module 1 — `htfRoadmap.ts`

A pure, read-only lens over the 4H market. It returns the active **dealing range** (bounded by the last validated 4H swing extremes), the dominant **institutional bias** and the **primary liquidity draw** (target).

- `Decimal`-only math; no I/O, no logger, no config mutation, no input mutation (sorting/filtering happens on shallow copies).
- Degenerate data **fails closed** (`isValid = false`) instead of fabricating a range or a target.
- `NEUTRAL` means *no trade allowed* — S13 rejects the setup at Gate 1 rather than guessing a direction.

#### 8.6.3 Brain Module 2 — `volumeExhaustion.ts`

A pure diagnostic layer over 15m candles that answers two questions:

1. **Did the pullback actually exhaust?** Average pullback volume is compared to a baseline SMA (`volumeSmaPeriod`, default 20) via `maxPullbackVolumeRatio` (default 1.5).
2. **Did the POI touch print an institutional reaction?** The touch candle's volume is compared to the same baseline via `minReactionVolumeRatio` (default 1.0).

**Volume Baseline Causality (Invariant 56)**: the baseline window ends **before the pullback origin** —
`baselineCandles = parsedCandles.slice(baselineStart, correctiveStart)` with `correctiveStart = origin.index + 1`. The impulse candle that created the pullback is therefore excluded from its own baseline; otherwise the average would be contaminated by the very volume it is supposed to judge, and every impulse would pass as "exhausted".

`failureCode` partitions the outcome (`NO_PULLBACK_ORIGIN`, `INSUFFICIENT_PULLBACK_CANDLES`, `PULLBACK_VOLUME_HEAVY`, `POI_VIOLATED`, `NO_POI_TOUCH`, `INVALID_VOLUME_SMA_PERIOD`, `ZERO_BASELINE_VOLUME`, …) so the funnel stays truthful instead of collapsing into one "not exhausted" bucket.

#### 8.6.4 Brain Module 3 — `tpResolver.ts`

Replaces the blind `k × R` target of `calculateLevels()` with a **structural** one. `calculateLevels()` derives TP arithmetically and never consults the market; on 1m entries two mechanisms make that negative-expectancy (fee-to-stop explosion in R units, and the MFE distribution).

- **Candidate set**: macro pools (PDH/PDL/PWH/PWL, session extremes), HTF/15m swings, range boundaries/equilibrium, zones, plus the roadmap target injected as a synthetic pool.
- **`major` classification**: each candidate is flagged `major` or not — `MAJOR_POOL_TYPES` (macro liquidity) and injected `majorTargets` are always major; internal swings are minor.
- **`skipMinorObstacles: true`** (used by archived S13): a *minor* swing inside the RR floor is skipped and resolution continues to the next candidate, while a **major** barrier (macro pool / HTF level) is treated as a genuine wall and blocks the candidate instead of being ignored.
- **`skipMinorObstacles: false`** (Scenarios 1 and 5 explicitly, Scenario 12 by omission): the nearest structural candidate is a hard wall — if it does not clear the floor the resolution fails with `Insufficient room` instead of drilling through minor structure.
- **Bounds**: `DYNAMIC_TP_MIN_RR` (default 1.5) is the floor; `DYNAMIC_TP_MAX_RR` (default 6.0) caps the target. S1, S5 and S12 resolve structurally only when `ENABLE_DYNAMIC_TP=true` — otherwise `resolveTakeProfit()` returns the fixed `FIXED_TP_RR × R` target. The archived S13 forced dynamic resolution regardless of the switch — a fixed `k × R` target contradicted its premise.

#### 8.6.5 Stop Anchoring — full reaction window (D5 reverted)

The stop is anchored to the **entire 1m reaction window**, including the minute that first touched the POI:

```typescript
const microExtreme = reaction.reduce(...); // min low (long) / max high (short)
```

The touch minute is not noise: its wick is part of the structure that must be violated before the reaction is invalid. Excluding it (the experimental D5 slice) pulled the stop **inside** the real invalidation and let a normal mitigation wick clip it. `BaseScenario.calculateLevels()` still enforces the **0.1% offset floor** and the inverted-zone defense.

**Invariant**: the stop reference MUST include the POI touch candle. Locked by two regression tests (`tests/scenarios/archive/scenario13_top_down.test.ts`): a bullish sweep wick to 102.20 produces `SL = 102.09595`, and a bearish spike to 108.60 produces `SL = 108.70675`.

**No blind 15m fallback**: S13 required `ENABLE_SNIPER_MODE=true` and **>= 15** 1m candles; otherwise it failed closed with the `disabled` funnel bucket. The midpoint-on-confirmed-15m-close experiment produced a fee-dominated **-$268.62** across the same three symbols and was removed.

#### 8.6.6 Verified Portfolio Baseline (strict 1m Sniper)

60-day 1m-cache runs, `ENABLE_SNIPER_MODE=true`, `ACTIVE_SCENARIOS=13` (historical — S13 is archived and `13` is no longer accepted), `ENABLE_DYNAMIC_TP=true`, `DYNAMIC_TP_MIN_RR=1.5`, `DYNAMIC_TP_MAX_RR=6.0`, `SMC_SWEEP_MIN_WICK_RATIO=0.25`, `SNIPER_LIMIT_EXPIRATION_CANDLES=6`:

| Symbol | Net | Trades | Win rate | PF | Max DD | Fees |
| --- | --- | --- | --- | --- | --- | --- |
| BTCUSDT | −$17.37 | 5 | 40.0% | 0.76 | 2.61% | $26.37 |
| SOLUSDT | +$0.13 | 3 | 33.3% | 1.01 | 2.60% | $10.52 |
| NEARUSDT | +$88.25 | 8 | 50.0% | 2.21 | 4.45% | $21.18 |
| **Combined** | **+$71.01** | 16 | 43.75% | — | **< 4.5%** | **$58.07** |

NEAR is identical to the earlier baseline (+8.83%, PF 2.21, 4.45% DD, $21.18 fees). BTC matches the documented pre-D5 −$17.37; SOL is +$0.13 vs the post-D5 +$0.47 (a single stop difference). The portfolio is net positive **+$71.01**, no symbol below −1.8%, and fee drag is **$58.07** — 75% lower than the removed blind 15m run ($231.79).

#### 8.6.7 Backtester Fidelity Notes

- **Cooldown gate**: the router is not evaluated while a cooldown is active (`run.ts`), so a rejected scan cannot emit phantom triggers.
- **Mitigation filter**: `mitigatedStructures` is passed to `router.evaluate()`; S13 filtered by **timestamp only** (Invariant 25).
- **Copy-on-write**: the router filters copies of `structures`/`zones`, never the cached `patternData` (Invariant 50).

---

## 9. DATABASE SCHEMA — `src/db/database.ts`

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
  zone_timestamp BIGINT,           -- zone formation timestamp
  order_type VARCHAR(10),          -- Market | Limit
  limit_price NUMERIC(24, 8),      -- limit price for Limit orders
  management_state JSONB DEFAULT '{}'::jsonb  -- adaptive fractioning state
);

CREATE TABLE symbol_state (
  symbol VARCHAR(20) PRIMARY KEY,
  state VARCHAR(20) CHECK (state IN ('SCANNING','WAITING','CONFIRMATION','ENTRY_STAGED','IN_TRADE')),
  updated_at BIGINT NOT NULL
);
```

**Connection Pool**: `max=5`, `idleTimeout=10s`, `keepAlive=true` (Supabase compatibility).
**Leak Proof**: Every method uses `const client = await pool.connect(); try {...} finally { client.release() }`.

### 9.1 CRUD Operations Audit — **v2026-10-05**

| Operation | SQL / Code | Status |
|-----------|------------|--------|
| **CREATE TABLE** | All 22 columns present: `scenario_id`, `reason`, `zone_type`, `zone_top`, `zone_bottom`, `zone_timeframe`, `zone_direction`, `zone_timestamp`, `order_type`, `limit_price`, `management_state` | ✅ |
| **INSERT (openTrade)** | 19 fields passed incl. all zoneDetails fields, `order_type`, `limit_price`, `management_state` with `?? null` fallback | ✅ **FIXED v2026-10-05: column/value count aligned** |
| **UPDATE (closeTrade)** | `reason` column now updated: `SET ..., reason = $4` | ✅ **FIXED v2026-09-26** |
| **SELECT (mapRowToTradeRecord)** | `zone_top/bottom` → `new Decimal(row.zone_top)`, `scenario_id` as `number \| null`, `reason` passed through, `management_state` parsed | ✅ |
| **BACKUP (tradesToCsv)** | All 22 columns exported including new fields | ✅ |

**DB Fix Applied**: `closeTrade(tradeId, pnl, exitPrice, closedAt, reason)` — callers in `strategyEngine.ts`:
- Line 348: `closeReason = PnL < 0 ? 'SL' : 'TP'`
- Line 572: `'RECONCILIATION'`
- Line 684: `closeReason = PnL < 0 ? 'SL' : 'TP'`

**Fix Applied v2026-10-05**: `openTrade` INSERT column/value count mismatch fixed — column list and VALUES clause now both have 20 items (19 columns + status='OPEN' literal).

**Critical Note — `order_id` (v2026-10-07)**: The `order_id` column (VARCHAR(255)) stores the Bybit exchange order ID (UUID). It is **critical** for linking DB records to exchange orders and is passed as the 20th parameter in `openTrade()`. Ensure `order_id` is always passed (even if null initially) to maintain DB-exchange linkage.

## 10. BACKTEST ENGINE — `src/backtest/`

- **State Machine**: `openTrade()` / `checkAndCloseTrade()` in `executionSimulator.ts`, guided by Hybrid Smart Entry (Market fill at `candle.close`, or a `PENDING` Limit that must be touched by a later wick).
- **Fees**: `TAKER_FEE_RATE = 0.00055` / `MAKER_FEE_RATE = 0.00020`. Entry fees accrue to a ledger and are settled **once** at closure — never debited from the running balance at open.
- **Drawdown Guard**: `consecutiveLosses` increments on loss → feeds `RiskManager.getEffectiveRiskPercent()`.
- **Max Drawdown**: continuous equity sampling, including intra-trade excursion — reported next to the closed-trade drawdown series (see §7.18.1).
- **Adaptive Fractioning**: `initializeTradeManagement(entry, sl, tp, qty)` captures the true `TotalR` before open, so milestones are simulated exactly as in live.
- **History window**: `BACKTEST_DAYS` (default 60) → `getTimeRangeForDays(config.backtestDays)` shared by the 1m/LTF/HTF loaders (see §7.7, Invariant 42).
- **CLI**: `npm run backtest -- BTCUSDT` (single symbol filter via `parseArgs`).
- **Performance**: linear in `BACKTEST_DAYS` and symbol count; the hot loop is 1m-driven with LTF/HTF state rebuilt only on timeframe boundaries. Timing is environment-dependent and intentionally not documented as a fixed figure.
- **Artifacts**: `data/Backtest_Report_<SYMBOL>.txt` + `data/Backtest_Chart_<SYMBOL>.html` (equity curve, drawdown, candlestick trade overlay).

---

## 11. ENVIRONMENT VARIABLES (`.env`)

```bash
# Required
BYBIT_API_KEY=...
BYBIT_API_SECRET=...
SYMBOLS=BTCUSDT,ETHUSDT,SOLUSDT
DATABASE_URL=postgresql://...
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...

# Risk & capacity
RISK_PERCENT=2                     # required, > 0
REDUCED_RISK_PERCENT=1             # must be <= RISK_PERCENT
LEVERAGE=10
MAX_WORKING_CAPITAL=20000          # unset = unlimited; a literal 0 fails validation

# Trading mode
DEMO_TRADING=false                 # true = Bybit Demo (forces TESTNET=false)
TESTNET=true                       # ignored when DEMO_TRADING=true; false = mainnet
AUTO_TRADING=false                 # true = auto-execute, false = manual approval
TRADE_APPROVAL_TIMEOUT_MINUTES=5

# Data
HISTORY_CANDLES=200                # LTF/HTF history (max 1000)
MACRO_CANDLES=1000                 # 1W/1D macro context (max 1000)
LTF_TIMEFRAME=15
HTF_TIMEFRAME=240
DATA_DIR=data

# Backtest
BACKTEST_DAYS=60                   # Shared window for 1m/LTF/HTF loaders
ENABLE_SNIPER_MODE=false
SNIPER_DISPLACEMENT_MULTIPLIER=1.5
USE_LOCAL_CACHE_ONLY=false         # true = offline backtest, cache only, zero API calls
BACKTEST_CSV_PATH=                 # optional local CSV source
ENABLE_HEALTHCHECK_SERVER=false    # required true on Render

# Scenarios
ACTIVE_SCENARIOS=15                # live registry: 1, 5, 12, 14, 15 only; S12 needs ENABLE_SNIPER_MODE=true
SCENARIOS_BTCUSDT=15               # optional per-symbol override (same five IDs; archived ids abort the boot)
ENABLE_LIVE_TEST_ORDERS=false

# Dynamic take-profit (structural targets instead of blind k * R)
# Scenarios 1, 5 and 12 use these bounds when ENABLE_DYNAMIC_TP=true
ENABLE_DYNAMIC_TP=true
FIXED_TP_RR=3.0                    # fallback target when dynamic resolution is disabled
DYNAMIC_TP_MIN_RR=1.5              # structural target floor (R multiples)
DYNAMIC_TP_MAX_RR=6.0              # hard cap on structural targets
DYNAMIC_TP_REQUIRE_TARGET=false    # true = reject the setup when no structural target exists

# Cooldown after SL hit (in LTF candles, default 16 = 4h for 15m timeframe)
COOLDOWN_CANDLES=16

# SMC parameters
SMC_SL_ATR_OFFSET=0.5              # ATR multiplier for SL offset
SMC_DISPLACEMENT_MULTIPLIER=1.5    # Displacement threshold in ATR
SMC_SWEEP_MIN_WICK_RATIO=0.25      # S12 + S9: min rejection wick share of candle range (0 < x < 1)
SMC_SWEEP_VOLUME_MULTIPLIER=1.3   # S5 only: sweep-candle volume as a multiple of the 20-candle SMA baseline

# S12 sweep sources (opt-in; macro PDH/PDL/PWH/PWL is always armed)
S12_SESSION_SWEEPS=false           # true = newest ASIAN high/low becomes a sweepable level
S12_EQH_EQL_SWEEPS=false           # true = 15m EQH/EQL pools become sweepable levels
MIN_TP_DISTANCE_PCT=0.0035         # S12 fee floor: reject targets < 0.35% from the execution entry (must be > 0 and < 0.1)

# S12 P0 shields (see §7.13.5). Inert for Scenarios 1-11.
MIN_NET_RR=1.0                     # fee-inclusive R:R floor: (target - fee) / (stop + fee)
MIN_VOLATILITY_FEE_RATIO=1.0       # require 1m ATR% >= ratio x round-trip taker fee (~0.110%)

# Per-symbol calibration overrides — `<PARAM>_<SYMBOL>` twins reach every scenario,
# tpResolver and the reconciliation sweep via resolveSymbolConfig(). Matched against
# SYMBOLS only: an override for an unconfigured pair is silently dropped.
#   SMC_SL_ATR_OFFSET_<SYMBOL>              DYNAMIC_TP_MIN_RR_<SYMBOL>
#   MIN_TP_DISTANCE_PCT_<SYMBOL>            MIN_NET_RR_<SYMBOL>
#   MIN_VOLATILITY_FEE_RATIO_<SYMBOL>       SMC_SWEEP_MIN_WICK_RATIO_<SYMBOL>
#   SNIPER_LIMIT_EXPIRATION_CANDLES_<SYMBOL>
# DYNAMIC_TP_MAX_RR is global only; each per-symbol floor is validated against it.
SMC_SL_ATR_OFFSET_APTUSDT=0.60       # verified V5 Sniper calibration (Emilia)
SNIPER_LIMIT_EXPIRATION_CANDLES_APTUSDT=25
MIN_VOLATILITY_FEE_RATIO_NEARUSDT=1.0 # audited 180d NEAR calibration (§7.23); both gates
MIN_NET_RR_NEARUSDT=1.0              # must move — volatility alone yields +14.87%, not +22.40%

# Entry filters (day-of-week + killzone)
ALLOWED_DAYS_OF_WEEK=1,2,3,4,5     # ISO weekdays in UTC (1=Mon ... 7=Sun) allowed for NEW entries
ENFORCE_KILLZONES=true             # false = bypass all killzone gates globally (backtesting)

# Entry physics
SMART_ENTRY_THRESHOLD_PCT=0.15     # Market vs Limit threshold (%)
LIMIT_EXPIRATION_CANDLES=6         # Limit lifetime in LTF candles (Classic)
SNIPER_LIMIT_EXPIRATION_CANDLES=15 # Limit lifetime in 1m candles (Sniper Mode)
PREFLIGHT_BUFFER_PCT=0.05          # Pre-flight SL spread buffer (%)

# Notifications & backup
ENABLE_TRADE_NOTIFICATIONS=true    # false = mute routine trades; logger.error alerts still delivered
BACKUP_PASSWORD=...                # AES-256-CBC key for /backup

# Funding monitor (delta-neutral arbitrage)
ENABLE_FUNDING_MONITOR=false
FUNDING_MONITOR_SYMBOLS=BTCUSDT,ETHUSDT,SOLUSDT
FUNDING_ALERT_THRESHOLD_PCT=0.0    # % — alert when rate <= this value
FUNDING_RESTORE_THRESHOLD_PCT=0.015 # % — restore alert when rate >= this value

# Logging
LOG_LEVEL=info                     # debug, info, warn, error
```

---

## 12. BUILD & VERIFICATION COMMANDS

```bash
npm run typecheck    # tsc --noEmit  (must pass)
npm test             # jest (853 tests / 43 suites, all green)
npm run build        # tsc → dist/
npm run backtest     # Full backtest all symbols
npm run backtest -- BTCUSDT  # Single symbol
# Long-window Sniper runs (>=180d) are safe since v2026-10-28: the 1m history is
# appended in a loop, not spread into push() (§16.6.8).
docker build -t smc-bot .
docker compose up -d
```

---

## 13. CRITICAL INVARIANTS (DO NOT BREAK)

> **Normative status**: this section is the single source of truth for architecture-level constraints. §16 documents *why* each rule exists (Root Cause → Fix → Rule); where the two ever disagree, **§13 wins**. Invariant numbers are a stable API — they are cited by `README.md`, source comments and tests, so they are never renumbered. New invariants are appended.

### Index by Domain

| Domain | Invariants |
| --- | --- |
| **Money, Precision & Capacity** | 1, 30, 34, 55 |
| **Execution Physics** (pre-flight → fill → bookkeeping) | 6, 18, 23, 24, 29, 31, 33, 34, 38, 39, 47, 49, 52, 54, 61 |
| **Exchange Truth & Reconciliation** | 7, 26, 27, 28, 35, 40, 53 |
| **State Machine & Concurrency** | 6, 16, 23, 36, 37, 47, 49, 60 |
| **Ghost Signals & Mitigation** | 4, 5, 14, 15, 19, 21, 25, 36, 39 |
| **SMC Mathematics** | 2, 3, 11, 18, 51, 56, 57 |
| **Adaptive Fractioning** | 26, 41, 53, 55 |
| **Backtester Fidelity** | 12, 13, 14, 15, 16, 17, 20, 42, 46, 48, 50 |
| **Infrastructure & Observability** | 8, 9, 10, 22, 32, 43, 44, 45 |

1. **No `number` for money** — only `Decimal` + string serialization.
2. **Single `PatternRecognizer`** instance shared across all engines.
3. **Macro context initialized ONCE** at bootstrap (live), **DYNAMICALLY UPDATED** in backtester — never static in hot path.
4. **Zone and structure mitigation are the ONLY re-entry protection** — `mitigatedZones` burns consumed zones, `mitigatedStructures` burns consumed CHoCH/SMS/BOS triggers (timestamp-only matching). No "freshness" heuristics. Macro liquidity pools (Invariant 21) are the sole exception.
5. **`reconcileWithTrade`** receives `zoneDetails` for mitigation tracking.
6. **Slippage Guard evaluates at the live tick, in BOTH entry paths** (manual `handleApproval` + auto `executeStagedEntry`), applies to **Market orders only**, and is **directional** (Invariant 52). A signal-time price is never trusted for execution.
7. **ClosedPnL** fetched after 2.5s delay on every close.
8. **Global 429 circuit breaker** pauses ALL REST for 5 min.
9. **WS Watchdog** 3-min silence = force reconnect.
10. **Daily clock sync** at 00:00 UTC + hourly in reconciliation.
11. **SL calculation** uses `Decimal.min(zone.top, zone.bottom, entry)` for Longs and `Decimal.max(zone.top, zone.bottom, entry)` for Shorts — guarantees correct SL side regardless of zone top/bottom ordering.
12. **Backtester is fully dynamic** — no hardcoded timeframes or candle counts; all derived from `config.ltfTimeframe` / `config.htfTimeframe`; cache filenames include timeframe.
13. **Backtester macro context is dynamic** — no lookahead bias; PDH/PDL/PWH/PWL calculated from sliding windows of closed candles only.
14. **Backtester mitigated structures tracked on ALL closes** — `mitigatedStructures` updated on both WIN and LOSS in `checkAndCloseTrade()`, preventing ghost signal re-entries.
15. **Backtester mitigated zones burned on ENTRY** — zone added to `mitigatedZones` immediately in `openTrade()`, not on close.
16. **Same-candle SL/TP resolution** — SL checked first; if both hit → `BOTH` = LOSS at SL price (conservative).
17. **DB `reason` field persisted on close** — `closeTrade()` accepts `reason` parameter ('TP'|'SL'|'RECONCILIATION'), all callers updated.
18. **Hybrid Smart Entry** — `idealEntry` always from scenario geometry (zone equilibrium), never `candle.close`. Market vs Limit decision uses `SMART_ENTRY_THRESHOLD_PCT` (default 0.15%) against `|idealEntry - currentPrice| / idealEntry`.
19. **Limit Order Cancellation** — ReconciliationLoop cancels Limit orders older than `resolveLimitExpirationMs(config)`: `LIMIT_EXPIRATION_CANDLES` in **LTF candles** for Classic, `SNIPER_LIMIT_EXPIRATION_CANDLES` in **1m candles** for Sniper (defaults 6 × 15m = 90 min vs 15 × 1m = 15 min). Both live and backtest resolve through the same helper. In the backtester the zone is burned on Limit **placement**, not on fill.
20. **Backtester Limit Simulation** — State machine: SCANNING → PENDING (limitPrice, placedAt, candlesWaited) → IN_TRADE (on wick touch) OR CANCELLED (after the mode-resolved expiration count). Filled at exact `limitPrice`, not candle close.
21. **Macro liquidity pools (PDH/PDL/PWH/PWL) are NEVER burned** — they may be swept multiple times. Adding them to `mitigatedZones` is forbidden. Spam protection works exclusively via burning 1m CHoCH structures via `mitigatedStructures`.

22. **DB Pool Safety** — All DB calls MUST use `const client = await pool.connect(); try {...} finally { client.release(); }`. Connection leaks are forbidden. Every method in `PostgresDatabase` follows this pattern.

23. **Execution Fail-Fast vs. Post-Fill Orphan Guard** — Before the exchange confirms an order, ANY error in `executionEngine.execute()` MUST call `burnSetup()` and transition to `SCANNING` (no ghost retry loops). After the exchange confirms the order, the bot MUST NOT reset to `SCANNING` or call `burnSetup()` — even if `db.openTrade()` fails — because the position is already live on the exchange and such a reset orphans it (Reconciliation only audits `IN_TRADE` engines and DB open trades). Post-fill bookkeeping failures are logged as `CRITICAL`, and the engine MUST run `panicCloseOrphan()` instead of a blind reset: `SCANNING` (plus `burnSetup()`) is reachable ONLY after the exchange is verified flat. If the emergency close fails or flatness cannot be verified, the engine remains `IN_TRADE` (Invariant 49). **Applies to BOTH manual approval (`handleTradeApproval`) and auto-trading (`executeStagedEntry`) paths.**

24. **Pre-flight Slippage Guard** — Before sending order to exchange, bot MUST fetch `getLivePrice()`. If live price has crossed SL during approval wait, setup is marked DEAD, burned, and cancelled. No order is sent. **Enforced in BOTH `handleTradeApproval()` (manual) and `executeStagedEntry()` (auto-trading).**

25. **Ghost Signal Prevention** — `isMitigated` (Scenario 12) AND `filterMitigatedStructures()` (ScenarioRouter) check ONLY timestamp (1m candle timestamps are unique). Direction and type are NOT checked (may be lost/defaulted during mapping). `structureDetails` must flow through Telegram approval pipeline end-to-end.

26. **PnL Summation (Adaptive Fractioning)** — PnL calculated via `.filter().reduce()` on `closedPnl` records where `symbol` matches AND `createdTime >= trade.openedAt`. This correctly sums all partial closes.

27. **Limit Order Awareness** — ReconciliationLoop MUST NOT reset `IN_TRADE` → `SCANNING` if active Limit orders exist (`status === 'New' | 'PartiallyFilled'`). Checked via `getOpenOrders()` before force-reset.

28. **Position Size Zero-Check** — WebSocket position closure detection MUST parse `item.size` using `Decimal.isZero()` with fallback to handle Bybit V5 formatted strings (`"0"`, `"0.0000"`, `""`). Prevents lingering `IN_TRADE` states.

29. **Live Price Resolution** — `getLivePrice()` returns `latestTickPrice` only (global tick memory written on every WS tick, before the `confirmed` guard). If it is null, the pre-flight path falls back to the **execution-context** feed: 1m in Sniper Mode, LTF otherwise. If that is also null, the setup is burned and the entry aborted — guards never silently skip validation.

30. **Limit Price Precision** — Limit order prices MUST be formatted using `formatPrice(idealEntry, instrument.tickSize)` from `utils/precision.ts`. NEVER use `toFixed()` or hardcoded decimal places. Instrument's `tickSize` is the single source of truth for price precision.

31. **Zero-Latency Hot Path** — In automated trading (`AUTO_TRADING=true`), no synchronous/blocking external messenger I/O is permitted prior to order submission. `notifySetupFound` must be fire-and-forget AFTER `executionEngine.execute()` succeeds, never awaited before order submission. The hot path `executeStagedEntry()` → `executionEngine.execute()` must remain zero-latency.

32. **No Unhandled Promises in WS Callbacks** — All WebSocket callbacks (`onKline`, `onPosition`, `onExecution`) and internal async handlers (`handleKline`, `handlePositionPayload`) MUST be wrapped in `.catch()` or `try/catch`. Unhandled rejections in high-frequency WS streams will crash the Node.js process.

33. **`positionIdx: 0` Mandatory for TP/SL Orders** — Every `submitOrder()` call with `tpslMode: 'Full'` MUST explicitly include `positionIdx: 0` for One-Way Mode. Omission causes order rejection or TP/SL attachment failure on Bybit V5.

34. **No Assumed Fill** — Database entry price MUST reflect the exchange's `avgPrice` (actual fill price), never the planned `entryPrice`. After `executionEngine.execute()` confirms, the bot waits 500 ms, fetches `getOpenPositions()`, and uses `avgPrice` for `db.openTrade()`. **Enforced in BOTH `executeStagedEntry()` (auto) and `handleTradeApproval()` (manual).**

35. **Dual-Channel Closure Detection** — The engine MUST monitor BOTH `Position` and `Execution` WS topics to reliably detect position closures. Relying solely on `Position` channel will miss SL/TP closures.

36. **Router Must Receive `mitigatedStructures`** — `scenarioRouter.evaluate()` MUST be called with `this.mitigatedStructures` (not empty array) to filter already-consumed CHoCH/SMS/BOS structures. Empty array bypasses ghost signal protection.

37. **Auto-Trading Must Clear Sniper Zone on Reset** — `transition(StrategyState.SCANNING)` MUST clear `this._activeSniperZone = null` to prevent stale macro zone reuse across state resets. Zone must be burned on `burnSetup()`, not left dangling.

38. **Context-Aware Slippage Guard** — The >0.2% slippage guard must never be applied to Limit orders, as it would cause valid pullback setups to be aborted. Slippage guard is strictly for Market orders; Limit orders wait for pullback by design.

39. **Burn Trigger Structure on Trade Open (Live)** — BOTH `executeStagedEntry()` (auto) and `handleTradeApproval()` (manual) MUST push `this.plan.structureDetails` into `mitigatedStructures` **immediately after the exchange confirms the order — before `transition(IN_TRADE)` and before the `avgPrice` / `db.openTrade()` bookkeeping** (standard 100-entry cap). Burning after the DB write is forbidden: a post-fill DB failure would leave a live position whose trigger structure is still re-detectable. This mirrors backtester burn-on-entry (Invariant 15) and never relies solely on `burnSetup()` (abort paths) or trade close.

40. **Bybit V5 Demo Account Balance Fetching** — Bybit Demo accounts act exclusively as Unified Trading Accounts (UTA). When fetching wallet balances in demo mode, the system MUST ONLY query `accountType: 'UNIFIED'` to prevent masking real errors with `[10001] accountType only support UNIFIED` errors from legacy `CONTRACT` queries.

41. **Profit-Direction Guard in Adaptive Fractioning** — `evaluateTradeManagement()` MUST verify `isProfitable` (`currentPrice.gt(entry)` for Long, `currentPrice.lt(entry)` for Short) BEFORE any progress math. If `!isProfitable` → return `{ action: 'none', reason: 'Trade is not in profit' }`. Absolute-value progress is FORBIDDEN — it makes adverse moves look like progress and triggers bogus SL→entry updates rejected by Bybit `[10001]`.

42. **Backtest History Window from `BACKTEST_DAYS`** — The backtest candle window MUST come from `getTimeRangeForDays(config.backtestDays)` and be shared by the 1m, LTF and HTF loaders. Hardcoding 180 days (`SIX_MONTHS_MS`, `6 * 30`, `Math.ceil((180 * 24 * 60) / ltfMinutes)`) is FORBIDDEN — the chart period, report period and simulated period must always match `.env`.

43. **Global Error Alerting via Logger Hook** — All `logger.error(...)` output MUST reach Telegram through `setLoggerTelegramHook` + `TelegramTransport`. Log lines containing `telegram`/`telegraf` MUST be filtered out to prevent infinite notification loops. The hook is fire-and-forget and must never block or throw inside `log()`.

44. **Routine Notification Toggle never gates Errors** — `ENABLE_TRADE_NOTIFICATIONS=false` mutes ONLY `notifySetupFound` / `notifyOrderOpened` / `notifyTradeClosed` (incl. `CANCELLED`). `notifyCriticalError`, the logger hook, fatal crash SOS and degradation/recovery alerts MUST always be delivered.

45. **Edge-Triggered Degradation Alerts** — REST (`isApiDegraded`) and WS (`isWsDegraded`) degradation flags are set on failure (retry exhaustion / watchdog timeout) and cleared on the first success (REST call success / resync success). Degradation is logged once per episode; recovery sends exactly one green alert per episode.

46. **Backtest Chunk Retry Guard** — Backtest history pagination MUST retry each chunk up to 8 attempts with a 3 s pause (`[WARN] Fetch chunk failed, retrying...`). A permanently failing chunk MUST NOT crash the backtest — pagination stops, partial history is kept, and an empty result MUST NOT overwrite the cache file.

47. **Post-Fill Transition Precedes Bookkeeping** — Immediately after `executionEngine.execute()` returns `{ ok: true }` (and the trigger structure is burned in memory), the engine MUST `transition(IN_TRADE)` BEFORE the 500 ms wait, `getOpenPositions()` and `db.openTrade()`. Both WS closure handlers (`handleExecutionPayload`, `handlePositionPayload`) ignore every event unless `state === IN_TRADE`, so a fill during the bookkeeping window would otherwise be invisible. There MUST be no second `transition(IN_TRADE)` after the DB write — a WS close event may have reset the state to `SCANNING`, and that reset must never be clobbered.

48. **Backtest Entry Gate Accepts zoneDetails OR structureDetails** — The backtester MUST commit a trade when `levels` exist AND (`zoneDetails` OR `structureDetails`) is present. Scenarios that intentionally omit `zoneDetails` (Scenario 9 Turtle Soup) carry their burn anchor in `structureDetails`; gating on `zoneDetails` alone silently excluded them from backtests while they trade live.

49. **Panic Close & Strict Recovery State** — If `db.openTrade()` fails AFTER the exchange confirms the order, the engine MUST invoke `panicCloseOrphan(orderId, orderType)` (cancel resting Limit order + reduce-only Market flatten + flatness verification). It may `burnSetup()` and return to `SCANNING` ONLY after the exchange is verified flat (`true`). If the emergency close fails or flatness cannot be verified (`false`), the engine MUST remain `IN_TRADE` — an unverified position is never abandoned by a state reset, so Reconciliation and manual supervision can still see it. **Transition to `SCANNING` while an uncontrolled position exists is strictly forbidden.** See §5.12.

50. **Copy-on-Write for the Pattern Cache** — `ScenarioRouter.evaluate()` MUST NEVER mutate the cached `patternData` in place. `filterMitigatedStructures()` / `filterMitigatedZones()` are applied ONLY to shallow copies (`[...baseStructures]`, `[...baseZones]`), and the result is assembled into a new `evaluationData` object (`{ ...basePd, zones: safeZones, structures: safeStructures }`). The backtester reuses one `PatternData` object across every 1m iteration — in-place filtering would permanently strip structures/zones from the cache until the next LTF rebuild, destroying historical context and changing later results. See §16.6.3.

51. **Sniper Midpoint Proximity** — In Scenario 12 (Sniper Touch), the spatial gap between the swept macro level and the entry Order Block MUST be measured from the **OB midpoint** (`(top + bottom) / 2`), never from `top`/`bottom` edges: `obDistance = |obMidpoint − sweptPrice|`, `tolerance = max(atr15m, sweptPrice × 0.003)`. Nearest-edge distance is forbidden — a wide OB can straddle the level while its midpoint is far away, producing entries disconnected from the swept liquidity. The same midpoint is the entry anchor (`idealEntry`). The CHoCH close distance is logging-only and MUST NOT gate the setup.

52. **Directional Slippage Guard** — The >0.2% slippage guard MUST be vectorial: `movedTowardTp = isLong ? currentPrice − plannedEntry : plannedEntry − currentPrice`, gated by `movedTowardTp.gt(0)`. `Math.abs()` / `.abs()` is **FORBIDDEN** here — an absolute deviation would reject favorable discounts (Discount Trap) and cannot distinguish adverse movement from progress. The guard applies to Market orders only (Limit orders wait for a pullback — Invariant 38) and MUST be semantically identical in the manual (`pendingTradeManager.handleApproval`) and auto (`executeStagedEntry`) paths. See §4.4.3.

53. **PartiallyFilled Limit Safety** — A `PartiallyFilled` limit order MUST NEVER be closed in the DB as `CANCELLED` by the Reconciliation sweep. The resting portion may be cancelled on the exchange, but the already-filled portion MUST remain `IN_TRADE` so it is managed by Adaptive Fractioning and audited by Reconciliation. Closing the whole record as `CANCELLED` would orphan live exposure and hallucinate a zero-PnL trade.

54. **Ambiguous Execution Pre-Submit Key** — `orderLinkId` is the ultimate source of truth for ambiguous submissions. If `execute()` returns `ok: false` while an `orderLinkId` was issued, the engine MUST poll `getActiveOrders` / `getOpenPositions` (via `panicCloseOrphan()`) before concluding anything. The engine may transition to `SCANNING` ONLY once the exchange is verifiably flat and no live order remains; otherwise it stays `IN_TRADE` (Invariant 49).

55. **Live Capacity Sizing** — `RiskManager` MUST always receive `maxWorkingCapital` from the config in `src/index.ts`. Position sizing (`marginBuffer`, `riskAmount`, leverage cap) and Drawdown Guard risk calculations MUST be strictly capped against this working balance in both live and backtest modes. A missing/zero cap means "unlimited" only when explicitly configured as `0`; an omitted wiring is a configuration bug, not a silent fallback.

56. **Volume Baseline Causality** — The volume-exhaustion baseline SMA MUST exclude the impulse candle. `baselineCandles = parsedCandles.slice(baselineStart, correctiveStart)` with `correctiveStart = origin.index + 1`, i.e. the window ends strictly **before** the pullback origin that created the move being judged. Including the impulse contaminates the baseline with the very volume it is supposed to classify, so every impulse would pass as "exhausted". Corollary: the pullback-origin candle is never part of its own reference distribution.

57. **Bidirectional Construction** — Every scenario MUST evaluate **both directions**. A scenario that only builds a long setup (or infers `side` from a label) is incomplete: the `direction` is derived from structure/geometry, the POI search runs for `BULLISH` and `BEARISH`, and `side = idealEntry.gt(SL) ? 'Buy' : 'Sell'` is decided at the RiskManager boundary (Invariant §16.5.3). Scenario 1 is the live reference implementation (the tested 4H OB decides the direction, then the identical CHoCH → FVG continuation funnel runs for the mirrored case); the archived Scenario 13 follows the same rule, and both suites lock the mirrored side.

58. **Persistent 4H Trend Gate (S12)** — Scenario 12 MUST require the last **closed** 4H close to be aligned with the reversal via a causal SMA50 of `patternData.candles4h`: shorts need `close ≤ sma50 × 1.002`, longs need `close ≥ sma50 × 0.998`, unless price is at the unmitigated opposing 4H POI (`isAtOpposingHtfZone`). With fewer than **20** closed 4H candles the gate fails closed. The SMA is the primary gate; the 4H BOS/CHoCH direction check remains secondary. The SMA is never recomputed from the forming 4H candle.

59. **Fee-Aware TP Distance Floor (S12)** — After `resolveTakeProfit()` succeeds, Scenario 12 MUST reject any setup whose resolved target sits closer than `MIN_TP_DISTANCE_PCT` (default `0.35%`) from the **execution entry**: `|target − executionEntry| / executionEntry`, where `executionEntry` is the price the entry will actually be booked at (Market → market price, resting Limit → `idealEntry`; Invariant 61). The floor applies to structural and fixed-R targets alike, uses `Decimal`, and rejects with the `insufficientRoom` bucket. `MIN_TP_DISTANCE_PCT` is parsed as `Decimal` and validated in `(0, 0.1)`.

60. **A WS Close Event May Only End a Trade It Can See** — In `processClosedPosition()`, when `db.getOpenTrade(symbol)` returns `null`, the handler MUST log and `return` **without** calling `transition(...)` or `burnSetup()`. An empty DB row while the engine is `IN_TRADE` means the entry pipeline is still inside the Invariant 47 bookkeeping window (`transition(IN_TRADE)` → 500 ms → `getOpenPositions()` → `db.openTrade()`), not that the state must be reset. Forcing `SCANNING` there leaves a live trade whose Adaptive Fractioning is permanently disabled — the position rides an unmanaged full stop-loss. Any genuine instant close during that window is adopted by the 10-minute ReconciliationLoop (Invariant 27, §3.4) once the row lands as `OPEN`. Resetting on absence of evidence is strictly forbidden. See §16.3.9.

61. **P0 Shields Price the Execution Entry, Not the Plan** — Scenario 12's `MIN_NET_RR` and `MIN_TP_DISTANCE_PCT` gates MUST be evaluated against the price the entry will actually be booked at. `resolveShieldEntry()` delegates the Market/Limit decision to `shouldUseMarketEntry()` (`src/config/fees.ts`): a discount or an at-entry/adverse move inside `SMART_ENTRY_THRESHOLD_PCT` is a Market fill priced at `currentPrice`; an adverse move beyond the threshold rests a Limit priced at `idealEntry`. Both gates share that single entry. Measuring a Market fill from `idealEntry` understates risk and overstates reward, so a nominal 1.5R can be a realised sub-1.0R trade with both gates "passed". Two boundaries are mandatory: the emitted `levels.entry` remains the OB midpoint (the shield re-prices the fill only), and a market price already outside `SL..TP` is left to the pre-flight DEAD-setup guard — pricing it here would move the rejection into the funnel and skip the mitigation burn. See §7.13.5.

---

## 14. DOCKER & DEPLOYMENT

### 14.1 Dockerfile (Multi-stage, Node 26)

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

### 14.2 docker-compose.yml (Single Service for Render/Oracle Cloud)

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
    logging:
      driver: "json-file"
      options:
        max-size: "50m"
        max-file: "3"
    deploy:
      resources:
        limits:
          cpus: '0.5'
          memory: 512M
```

**Log Rotation**: Each service in docker-compose.yml (bot and DB) **MUST** include a `logging` block with `driver: "json-file"` and options `max-size: "50m"`, `max-file: "3"`. This prevents "No space left on device" errors by capping log files at 50 MB each, keeping only the 3 most recent (total 150 MB per service). Server can run for years without manual log cleanup.
- **Port 3000** — health check (`GET /health`) for Render/load balancer
- **stop_grace_period: 30s** — matches `SIGTERM` handler in `index.ts`
- **Resource limits**: 0.5 CPU / 512MB — fits Oracle Cloud Free Tier (ARM) or Render free tier
- **Single `.env` file** with all configuration

### 14.3 Render Deployment (Recommended)

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

### 14.4 Local Development Commands

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

### 14.5 Health Checks & Monitoring

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

## 15. LEGACY BACKTEST BENCHMARK (Pre-V5.1 Execution Physics)

> **Historical reference only.** These figures were produced before the V5.1 Execution Physics overhaul. Current simulations apply exact Bybit Taker/Maker fees, zero-latency slippage, limit-order expiration, burn-on-entry mitigation and true `TotalR` initialization — a deliberately pessimistic environment used for strict quantitative tuning. Do not treat the numbers below as a performance forecast.

| Symbol      | Final Balance | Net Profit | Trades | Win Rate | Max DD |
| ----------- | ------------- | ---------- | ------ | -------- | ------ |
| **BTCUSDT** | $23,490.32    | +2249%     | 150    | 80.00%   | 17.82% |
| **ETHUSDT** | $11,553.88    | +1055%     | 118    | 64.41%   | 41.59% |
| **SOLUSDT** | $107,584.02   | +10658%    | 189    | 66.14%   | 31.81% |

**Top Drivers**: S6 (SMS), S1 (HTF Continuation), S5 (HTF Sweep).
**Filters Working**: S2 `NoLiqCtx: 120`, S4 `NoBOS: 1570`, S11 strict SMS = 0 noise trades.

---

## 16. CRITICAL ANTI-PATTERNS & LESSONS LEARNED

> Each entry below records a failure that cost real money, uptime or debugging time. Format is **Root Cause → Fix → Rule**. The rules are already enforced by the current architecture; they are documented so no future refactor silently reintroduces the failure. Where wording differs from §13, §13 wins.

### 16.1 Execution Physics & Fill Truth

#### 16.1.1 Pre-flight validation is mandatory on BOTH entry paths
**Root Cause**: Manual approval waited 5–60 seconds while price crossed the SL → Bybit `[10001]`. Auto-trading originally skipped the suite entirely and re-submitted the same dead setup every 1m candle (LINKUSDT: 60+ rejections in 5 minutes).
**Fix**: `handleTradeApproval()` and `executeStagedEntry()` share one live-tick suite: SL-breach check with the `PREFLIGHT_BUFFER_PCT` spread buffer, TP-reached check, discount-aware Market/Limit re-decision, directional slippage guard, and fail-fast `burnSetup()`.
**Rule**: No order reaches `submitOrder()` without the full suite. Any failure burns the setup and returns to `SCANNING` — never retry a dead setup.

#### 16.1.2 Discount Trap
**Root Cause**: A Limit placed at `idealEntry` while price was already **better** filled immediately at market, while TP/SL stayed anchored to the ideal entry — the SL ended on the wrong side of the fill (`[10001]`).
**Fix**: The decision checks for a discount first — `isDiscount = isLong ? livePrice <= idealEntry : livePrice >= idealEntry`. A discount always routes to **Market**; only a premium beyond `SMART_ENTRY_THRESHOLD_PCT` uses Limit.
**Rule**: A better-than-planned price is never filled with a Limit order.

#### 16.1.3 Slippage Guard is Market-only
**Root Cause**: The 0.2% guard was applied uniformly, so valid pullback Limits were aborted precisely because price had moved away — the condition they exist to exploit. This is the Slippage Guard Paradox.
**Fix**: The guard runs only when `useMarketOrder` is true. Pre-flight SL/TP checks remain unconditional for every order type.
**Rule**: Limit orders wait for a pullback by design; Market constraints must never gate them.

#### 16.1.4 No assumed fills
**Root Cause**: Persisting `plan.entryPrice` for a Market order recorded a price that never traded. Adaptive Fractioning then measured R-multiples from a fiction and could trail the SL into losing territory.
**Fix**: After confirmation, wait 500 ms, read `avgPrice` from `getOpenPositions()` and persist that as `entry_price`. Fall back to the plan only if the read fails. Both entry paths are identical.
**Rule**: The database records exchange truth, never intent.

#### 16.1.5 `positionIdx: 0` on every TP/SL order
**Root Cause**: One-Way Mode requires `positionIdx: 0`; omitting it caused rejections or silently unattached TP/SL.
**Fix**: `placeMarketOrderWithTpsl()` and `placeLimitOrderWithTpsl()` both send `positionIdx: 0` alongside `tpslMode: 'Full'`.
**Rule**: Every `submitOrder()` with attached TP/SL carries `positionIdx: 0`.

#### 16.1.6 `amendOrder` never touches an open position
**Root Cause**: Bybit V5 keeps pending orders and live positions on different endpoints. `amendOrder` against a filled position fails silently or rejects.
**Fix**: Position-level SL/TP management (breakeven, trailing, post-partial-close) uses `client.setTradingStop({ positionIdx: 0 })`.
**Rule**: `amendOrder` = pending orders. `setTradingStop` = open positions.

#### 16.1.7 Zero-latency hot path
**Root Cause**: Awaiting `notifySetupFound()` before `execute()` injected Telegram latency — and a new failure mode — ahead of order submission.
**Fix**: Notifications are fire-and-forget **after** the exchange confirms: `notifySetupFound(...).catch(...)`.
**Rule**: No blocking messenger I/O before `executionEngine.execute()`.

#### 16.1.8 Shields measured the plan, not the fill
**Root Cause**: `MIN_NET_RR` and `MIN_TP_DISTANCE_PCT` were computed from `idealEntry` (the OB midpoint) while Smart Entry could route the same signal to a **Market** fill at the signal close. On a long, a premium fill widens the stop `entry − SL` and shortens the target `TP − entry` simultaneously, so a geometry that scored 1.5R at the plan could be a sub-1.0R trade at fill with both gates "passed". OPUSDT 2026-09-08 realised net R 0.69 (target 0.396% / stop 0.303%); 2026-09-25 realised 0.59 on a 0.330% target — under the 0.35% floor it was supposed to respect.
**Fix**: `resolveShieldEntry()` prices the entry the trade will actually be booked at — `currentPrice` for a Market fill (discount or within `SMART_ENTRY_THRESHOLD_PCT`), `idealEntry` for a resting Limit — reusing `shouldUseMarketEntry()` so the gate and the executor cannot disagree. A price already outside `SL..TP` is deliberately not priced as a fill: that setup is DEAD and the pre-flight guard owns it, including the mitigation burn.
**Rule**: An arithmetic gate must be evaluated on the same price the trade will be booked at. Measuring a fill at the plan is an assumed fill (Invariant 34) wearing a risk check's clothes. See §7.13.5, Invariant 61.

### 16.2 Closure Detection & PnL Truth

#### 16.2.1 Both WS channels are mandatory
**Root Cause**: Bybit often omits a `Position` update on SL/TP, sending only `execution` (`execType: 'Trade'`, `closedSize > 0`). A Position-only listener stayed `IN_TRADE` until reconciliation.
**Fix**: `ws.onExecution` → `handleExecutionPayload()` detects `closedSize > 0` and triggers `onExchangePositionClosed()`.
**Rule**: Closure detection consumes BOTH `Position` and `Execution`.

#### 16.2.2 Sum PnL, filter on `createdTime`
**Root Cause**: `.find()` kept only the first record and silently discarded partial-close PnL; filtering on the non-existent `closedTime` returned an empty set and forced a fake local calculation.
**Fix**: `filter(symbol matches && createdTime >= trade.openedAt).reduce(...)`, with the exit price taken from the record with the latest `createdTime`.
**Rule**: Partial closes are always summed. The V5 field is `createdTime`.

#### 16.2.3 Fallback exit price is the WS `execPrice`
**Root Cause**: Using `getLivePrice()` as the fallback exit price, seconds after the fill, hallucinated PnL and corrupted both DB integrity and Adaptive Fractioning.
**Fix**: `handleExecutionPayload()` forwards `item.execPrice` into `onExchangePositionClosed(null, execPrice)`; that value is authoritative whenever `getClosedPnl` is delayed or empty.
**Rule**: Live price is never an exit price.

#### 16.2.4 Missing exchange PnL on a Limit means CANCELLED
**Root Cause**: The mathematical fallback invented profit (e.g. $67) for a limit that never filled.
**Fix**: `reconcileWithTrade()`: empty `getClosedPnl` + `order_type === 'Limit'` → `pnl = 0`, `reason = 'CANCELLED'`.
**Rule**: Mathematical PnL fallback is reserved for Market orders.

#### 16.2.5 Parse WS position size as `Decimal`
**Root Cause**: V5 sends sizes as `"0"`, `"0.0000"`, `""` with `side: 'None'`; truthiness or bare `Number()` checks missed closures and stranded the engine `IN_TRADE`.
**Fix**:
```typescript
const sizeStr = String(item.size ?? '0');
let isZeroSize = false;
try { isZeroSize = new Decimal(sizeStr).isZero(); } catch { isZeroSize = Number(sizeStr) === 0; }
const isClosedSide = item.side === 'None' || !item.side;
if (isZeroSize || isClosedSide) { /* position closed */ }
```
**Rule**: `Decimal.isZero()` plus `side === 'None'` — never bare `Number()`.

### 16.3 State Machine & Orphan Safety

#### 16.3.1 Serialize `process()`
**Root Cause**: Simultaneous 1m/15m closes fired `process()` twice in the same millisecond. The second pass staged a duplicate trade, and a later rejection reset the state while the first position was live.
**Fix**: `isProcessing` mutex with `try/finally`, plus an `ENTRY_STAGED` guard on every Telegram callback.
**Rule**: One evaluation at a time; verify state before mutating it.

#### 16.3.2 One trade per symbol
**Root Cause**: A missing `IN_TRADE` guard produced 400 trades/day on a choppy market.
**Fix**: `ScenarioRouter` hard-blocks unless the engine is `SCANNING`.
**Rule**: `SCANNING → ENTRY_STAGED → IN_TRADE → SCANNING`. No parallel exposure.

#### 16.3.3 A zero position is not a closed trade
**Root Cause**: Reconciliation reset `IN_TRADE` while a Limit order was still working — amnesia followed by duplicate entries.
**Fix**: `getOpenOrders()` runs first; `New` / `PartiallyFilled` blocks the reset. An expired `New` order is cancelled and closed as `CANCELLED`; a `PartiallyFilled` order only has its remainder cancelled and stays `IN_TRADE` (Invariant 53).
**Rule**: Absence of position does not mean absence of trade.

#### 16.3.4 No unhandled WS rejections
**Root Cause**: A single unhandled rejection in a high-frequency stream kills the process — unacceptable for a burn-in deployment.
**Fix**: Every `onKline` / `onPosition` / `onExecution` registration uses `.catch()`; every internal handler uses `try/catch` and logs.
**Rule**: No async WS callback is ever left unguarded.

#### 16.3.5 Milestones update only after exchange success
**Root Cause**: `checkAndManagePosition()` ignored `{ ok: false }`, flagged the milestone and logged success while 100% exposure remained. The failed partial close was then never retried — Silent State Desync.
**Fix**: `if (!result.ok) { log; return; }` before any SL update or `updateTradeManagementState()`. The identical signal re-fires on the next tick, which is the natural retry.
**Rule**: No local or DB state transition without a confirmed exchange result.

#### 16.3.6 Progress is directional, never absolute
**Root Cause**: `|currentPrice − entry|` grew as price moved toward the SL, so losing trades "reached" the 33%/66% milestones and fired SL→entry updates rejected with `[10001]`.
**Fix**: Hard `isProfitable` guard, then directional movement (`currentPrice − entry` for longs, `entry − currentPrice` for shorts), which the guard guarantees is positive.
**Rule**: `.abs()` is forbidden in progress math.

#### 16.3.7 Live price is global, not per-timeframe
**Root Cause**: `getLivePrice()` read the 15m feed. In 1m Sniper Mode a null feed fell back to a candle up to 14 minutes stale, bypassing pre-flight and corrupting management math.
**Fix**: `latestTickPrice` is written on every WS tick before the `confirmed` guard. The pre-flight fallback uses the execution-context feed — 1m in Sniper Mode, LTF otherwise.
**Rule**: Live price is never coupled to one timeframe's buffer.

#### 16.3.8 V4 and V5 never share a process
**Root Cause**: Classic (15m/4H) and Sniper (1m) share the per-symbol `IN_TRADE` state. Running both produces cross-mode blocking, double exposure and concurrent `trades` writes.
**Fix**: Full infrastructure separation from one image: separate process, database, Telegram bot, Bybit sub-account and `.env`.
**Rule**: One mode per instance.

#### 16.3.9 A close event must never steal the state machine from the entry pipeline
**Root Cause**: `executeStagedEntry()` / `handleTradeApproval()` transition to `IN_TRADE` on exchange confirmation (Invariant 47) and only write the `trades` row afterwards — a 500 ms wait, `getOpenPositions()`, then the DB round-trip. A WS `Execution`/`Position` close event landing inside that window found an empty table, and the `!trade` branch of `processClosedPosition()` forced `SCANNING`. The row then landed one tick later, leaving the engine `SCANNING` with a **live trade whose Adaptive Fractioning was permanently disabled** — the position rode an unmanaged full stop-loss. Two consecutive live trades on NEARUSDT reproduced it:

```
00:58:00 [INFO]  NEARUSDT: state → IN_TRADE
00:58:00 [WARN]  NEARUSDT: position close event but no open trade found
00:58:00 [INFO]  NEARUSDT: state → SCANNING
00:58:01 [INFO]  NEARUSDT: order ... recorded, entering trade
```

**Fix**: The `!trade` branch now logs and returns. It calls neither `transition()` nor `burnSetup()`. The entry pipeline owns the state until bookkeeping completes; if the position genuinely closed during that window, the row lands as `OPEN` and the 10-minute ReconciliationLoop detects the missing exchange position and closes it (Invariant 27, §3.4). A bounded self-healing delay is strictly better than blinding the state machine mid-entry. The early return also precedes the `3 × 2s` `getClosedPnl` retry loop, so a phantom event cannot trigger a REST storm.
**Rule**: A WS close event may only end a trade it can actually see. An empty DB row inside `IN_TRADE` means **bookkeeping is in flight**, not that the state must be reset — never transition on absence of evidence.

### 16.4 Ghost Signals & Mitigation

#### 16.4.1 The router must receive `mitigatedStructures`
**Root Cause**: `process()` passed a hardcoded `[]`, disabling structure filtering entirely and allowing rapid-fire re-entries on the same 1m CHoCH.
**Fix**: `scenarioRouter.evaluate(..., this.mitigatedStructures, candles1m)`.
**Rule**: Never pass an empty array to the router.

#### 16.4.2 `burnSetup()` burns zone and structure independently
**Root Cause**: Structure burning was nested inside the zone validation. An incomplete zone skipped the structure, while the log still claimed it was burned — the ghost loop survived the "fix".
**Fix**: Zone and structure burn on separate paths; structure comes from `structureDetails`, falling back to `zoneDetails` only when absent. The log states exactly what was burned: zone only, structure only, both, or neither.
**Rule**: An incomplete zone must never block a structure burn, and logs must never overstate what happened.

#### 16.4.3 Match structures by timestamp only
**Root Cause**: Burned structures can lose `direction` (and be defaulted to `type: 'CHoCH'`) while passing through `PendingTradeManager`. Matching on direction/type failed to filter the very structure it had just burned.
**Fix**: `isMitigated` (Scenario 12) and `filterMitigatedStructures()` (Router) compare **timestamp only** — 1m candle timestamps are globally unique. `structureDetails` flows through the Telegram pipeline end-to-end.
**Rule**: Timestamp is the identity of a structure.

#### 16.4.4 Burn the trigger on fill, not on close
**Root Cause**: Structures were burned only by `burnSetup()` (abort paths) and on close. A successful entry left the trigger re-detectable, so the next scan could re-enter the same CHoCH before the trade even closed.
**Fix**: Both live paths push `structureDetails` into `mitigatedStructures` **immediately after exchange confirmation**, before `transition(IN_TRADE)` and before the `avgPrice` / DB bookkeeping (100-entry cap). Mirrors the backtester (Invariant 15).
**Rule**: Burn before transition. Burning after `db.openTrade()` is forbidden — a DB failure would leave a live position with a re-detectable trigger.

#### 16.4.5 One global sweep anchor invalidates earlier CHoCHs
**Root Cause**: Scenario 12 collapsed every swept level into a single `sweptAt = max(all levels)`. A valid PDL reversal at 10:05 was discarded because PDH was poked at 10:12 — the trigger existed, but the causality anchor had moved past it. Setup frequency collapsed for no market reason.
**Fix**: `detectLevelSweeps()` keeps each level's own `sweptAt`; `pairChochsWithSweeps()` pairs a CHoCH only with **same-direction** sweeps that happened strictly before it (§7.13.2). A later sweep of an unrelated level produces no pair and therefore cannot invalidate the earlier CHoCH.
**Rule**: Causality is a property of a (sweep, CHoCH) pair, never of the scan as a whole. Never reduce per-level timestamps to a single global maximum.

#### 16.4.6 Dedupe sweep sources by price with deterministic priority
**Root Cause**: Enabling session or EQH/EQL sources made the same price appear twice (e.g. PDH equal to the Asian high). The duplicate was then judged by the tighter intraday proximity band, silently rejecting setups that the macro band allowed.
**Fix**: `dedupeSweepLevels()` collapses exact `Decimal.eq()` duplicates after a stable sort by `SWEEP_SOURCE_PRIORITY` (`MACRO` > `SESSION` > `EQH_EQL`), so the macro identity — and its wider band — always wins.
**Rule**: When two sources print the same price, the higher-priority source owns the level and its tolerance.

### 16.5 SMC Mathematics & Geometry

#### 16.5.1 No inline SL/TP math
**Root Cause**: Scenarios computed stops inline (`zone.bottom − offset`). Because zone `top`/`bottom` ordering is arbitrary, an inverted zone put the SL *above* the entry for a long → `invalid SL level`.
**Fix**: Every scenario calls `BaseScenario.calculateLevels()`.
**Rule**: Zero inline SL/TP math. One implementation, one source of truth.

#### 16.5.2 Offset floor and inverted-zone defense
**Root Cause**: Two independent failures — ATR ≈ 0 produced a zero offset, SL = entry and a division by zero in position sizing; and `min(zone.bottom, entry)` placed the stop on the wrong side whenever the zone was inverted.
**Fix**: `offset = max(atr × multiplier, entry × 0.1%)`, then `SL = min(top, bottom, entry) − offset` for longs and `max(top, bottom, entry) + offset` for shorts.
**Rule**: The stop is always at least 0.1% from entry and always on the correct side, regardless of zone ordering.

#### 16.5.3 Side comes from geometry
**Root Cause**: Hardcoded `side: 'Buy'`, or deriving it from `direction` labels, broke whenever sweep direction ≠ zone direction — producing `invalid SL level for Buy side` with short geometry.
**Fix**: `side = idealEntry.gt(SL) ? 'Buy' : 'Sell'`, computed at the point of the RiskManager call.
**Rule**: Math decides direction; text labels never do.

#### 16.5.4 Freshness AND timeframe filters
**Root Cause**: Arrays are timestamp-ascending, so `array[0]` and forward `.find()` selected days-old structures (present in 10 of 11 scenarios). The same arrays also merge 15m and 4H objects, so `[length−1]` alone could return a 4H structure where a 15m one was required.
**Fix**: The v2026-10-16 refactor replaced every such access with `[length−1]` or `[...arr].reverse().find(...)`, always after an explicit `.timeframe` filter. Standards live in §8.5.
**Rule**: Freshness and timeframe are two separate filters — apply both before selecting a structure.

#### 16.5.5 Timeframe asymmetry (the 100R illusion)
**Root Cause**: Applying macro targets (PDH/PDL/PWH/PWL) to 1m scalps produced 1:15+ R:R. Micro-stops were noise-stopped before targets, while commissions ate the partial profits.
**Fix**: Scenario 12 resolves every target through `tpResolver.resolveTakeProfit()`: the fixed fallback is 3R (`FIXED_TP_RR`), and structural targets are bounded by `DYNAMIC_TP_MIN_RR` / `DYNAMIC_TP_MAX_RR`, so a macro pool cannot become the target of a micro-stop.
**Rule**: Never target macro liquidity with micro-stops. Scalping math demands fast takes.

#### 16.5.6 Linear scans only
**Root Cause**: `detectEqualLevels()` used nested loops over 17,000 candles → 100% CPU and a blocked event loop.
**Fix**: Single-pass indexed `for` loops; macro context builds in milliseconds.
**Rule**: No nested candle loops, no `while (true)` scan loops. Pre-compute arrays and advance pointers.

#### 16.5.7 Confirm a sweep with volume on the sweep candle itself
**Root Cause**: Scenario 5 originally searched for the sweep only in the latest 15m candle, so a CHoCH printed two or three candles later — the normal confirmation lag — was rejected as `NoSweep`. Widening the scan to 16 candles fixed the frequency but replaced the problem: Sweep → CHoCH → FVG is a chain of lagging structures, so by the time the gap retraced the sweep was 3–10 candles old and the entry sat far from the liquidity that justified it. The FVG was a proxy for the reaction, not the reaction.
**Fix**: The chain is gone (§8.8). The SFP is evaluated on the last closed candle — wick pierces the pool, close returns inside — and countersigned by volume: the sweep candle must print ≥ `SMC_SWEEP_VOLUME_MULTIPLIER` × the SMA of the 20 candles before it. Entry is that candle's close, the stop is its pierced extreme pushed `0.5 × atr15m` further (v2026-11-01), and the target is structural (`skipMinorObstacles: true`) with a fee-inclusive net R:R floor.
**Rule**: A liquidity event is confirmed by the candle that printed it plus its volume, not by structure that forms afterwards. The baseline window always excludes the candle it judges.

#### 16.5.8 A wick-tight stop plus a nearest-wall filter is a mathematical deadlock
**Root Cause**: Scenario 5's original geometry combined a stop placed exactly on the pierced wick (0.1–0.3% of price) with `skipMinorObstacles: false`. Because 1R was so small, the fee-inclusive net-R:R floor demanded a structural target 3.5–5R away, while the nearest-wall filter capped the target at the first 15m bump — almost always closer than the floor required. The two gates could not both be satisfied: 99.4% of volume-confirmed survivors died at `tpInvalid` and the scenario produced 7–14 trades per symbol over 180 days.
**Fix**: Two changes that attack the numerator and the denominator at once (v2026-11-01, §8.8.1). The stop receives a volatility buffer (`atr = atr15m` through `calculateLevels()`, so `max(0.5 × atr15m, 0.1%)`), which enlarges 1R and reduces the R-multiple the target must clear; and the resolver runs with `skipMinorObstacles: true`, so a minor swing is stepped over instead of becoming the target. A MAJOR barrier inside the floor still rejects. `Triggered` rose 4.3× (33 → 142 trades) and `tpInvalid`'s share of survivors fell 2.94 pp.
**Rule**: A stop so tight that the fee-inclusive reward gate can never be met is not a conservative setting, it is a silent off-switch. When a stop is tightened, the target filter must be loosened by the same amount — or the scenario is guaranteed to reject its own valid setups.

### 16.6 Backtester Fidelity

#### 16.6.1 Macro context is causal
**Root Cause**: `initializeMacroContext()` ran once before the loop, loading PDH/PDL/PWH/PWL from the **end** of history. Simulating earlier months used future levels, so S5/S7/S8/S9 missed or invented sweeps.
**Fix**: Dynamic context in `runBacktestForSymbol()`: running ATH/ATL from candles seen so far, daily levels from `slice(0, i)`, weekly levels from the last 7 days of closed candles, atomically applied via `recognizer.setMacroContext()`.
**Rule**: A backtest may only consume data strictly older than the candle being simulated.

#### 16.6.2 Macro context is not recomputed per 1m candle
**Root Cause**: Rebuilding heavy context on every 1m candle burned CPU and propagated inconsistent state.
**Fix**: `PatternData` is rebuilt only on LTF close; the 1m loop reuses the cached context.
**Rule**: Heavy context updates on timeframe boundaries only.

#### 16.6.3 Copy-on-write for the pattern cache
**Root Cause**: Filtering in place (`patternData.structures = ...`, `splice`, `sort`) permanently stripped mitigated objects from a `PatternData` reference reused across every 1m iteration. Later candles saw a hollowed-out market, making results iteration-order dependent.
**Fix**:
```typescript
const safeStructures = this.filterMitigatedStructures([...(basePd.structures ?? [])], mitigatedStructures);
const safeZones = this.filterMitigatedZones([...(basePd.zones ?? [])], mitigatedZones);
const evaluationData: PatternData = { ...basePd, structures: safeStructures, zones: safeZones, candles1m };
```
**Rule**: `evaluate()` is a read-only consumer. Filter copies, never the cache (Invariant 50).

#### 16.6.4 One history window
**Root Cause**: `SIX_MONTHS_MS` / `getTimeRangeForSixMonths()` fed the LTF and HTF loaders while the 1m loader used `BACKTEST_DAYS` — the report claimed 180 days while `.env` requested 60, and loaders disagreed.
**Fix**: `getTimeRangeForDays(config.backtestDays)` produces one `{ fromMs, toMs }` used by all three loaders, the report and the artifacts.
**Rule**: No hardcoded day counts anywhere in the backtester (Invariant 42).

#### 16.6.5 Fees settle exactly once
**Root Cause**: The entry fee was debited from `state.balance` at open *and* again inside `TradeResult.pnl` at close — double-charged and inflating Max Floating Drawdown.
**Fix**: Entry fees accrue to `trade.entryFee`; entry + exit are settled once in `netPnl` at closure.
**Rule**: Never debit the running balance at open.

#### 16.6.6 No perfect-pullback fills
**Root Cause**: The simulator routed every entry as Market but filled at `idealEntry` — zero slippage and a 100% fill rate for pullbacks that should have been Limits and could expire.
**Fix**: Hybrid Smart Entry is replicated: Market fills at `candle.close`; a deviation beyond the threshold creates a `PENDING` Limit that must be touched by a later wick.
**Rule**: A Market order never receives a Limit-quality fill (Invariant 48 gate accepts `zoneDetails` OR `structureDetails`).

#### 16.6.7 True `TotalR` at open
**Root Cause**: The simulator hardcoded `initialTotalR: "0"`, so every trade fell into the Classic branch and the Sniper partial-close / trailing logic never executed.
**Fix**: `initializeTradeManagement(entry, sl, tp, qty)` runs in both live and backtest before opening, capturing the real R:R.
**Rule**: Never hardcode management state; derive it from geometry.

#### 16.6.8 Spread `push` caps the Sniper window at ~100k 1m candles
**Root Cause**: `run.ts` collected the 1m history with `candles1m.push(...fetched1m)`. A 60-day Sniper window (86,400 candles) fits inside V8's argument limit; a 180-day window (259,200) does not. The run died with `Maximum call stack size exceeded` **after** the history had already been fetched and cached — so it looked like a data problem while the data was fine, only the copy failed.
**Fix**: `for (const candle of fetched1m) candles1m.push(candle);` — no spread, no argument stack.
**Rule**: A `push(...array)` over a history-sized array is a latent crash, not a micro-optimisation. Bulk-append loops instead. Any future long-window Sniper run must be validated end-to-end, not inferred from the 60-day case.

### 16.7 Precision & Exchange Contracts

#### 16.7.1 Instrument precision, never `toFixed`
**Root Cause**: `toFixed(2)` / `toFixed(8)` truncated or over-specified prices for instruments with different `tickSize`, producing `Invalid price precision` rejections.
**Fix**: `formatPrice(value, instrument.tickSize)` and `formatQuantity(qty, instrument.qtyStep)` from `utils/precision.ts` are the only formatters.
**Rule**: Decimal places are a property of the instrument, never of the code.

#### 16.7.2 Quantities are formatted and min-lot checked
**Root Cause**: A 25% partial close produced values like `0.7875`, rejected for precision, leaving the position unmanaged and unprotected.
**Fix**: Every calculated quantity passes through `formatQuantity(qty, qtyStep)` and is validated against `minOrderQty` before submission.
**Rule**: No order or partial close leaves the process unformatted.

#### 16.7.3 Active orders go through the client wrapper
**Root Cause**: Code called `rest.getOpenOrders()` on the Bybit V5 SDK — that endpoint does not exist (`getActiveOrders` does), so the reconciliation sweep crashed instead of seeing pending limits.
**Fix**: All order queries use `BybitClient.getOpenOrders()` (`src/api/bybitClient.ts:486`), a thin wrapper over `rest.getActiveOrders()`.
**Rule**: Verify SDK surface against the V5 docs; engine code talks to the wrapper, not the raw SDK.

#### 16.7.4 Demo accounts are UNIFIED-only
**Root Cause**: Demo accounts are exclusively Unified Trading Accounts. Querying `CONTRACT` returned `[10001] accountType only support UNIFIED`, which masked the original failure and surfaced a misleading error in `process()`.
**Fix**: `getUsdtBalance()` queries only `accountType: 'UNIFIED'` when `demoTrading` is true; the legacy fallback (non-demo) ignores the expected `[10001]` so it never masks the `UNIFIED` error.
**Rule**: Never query `CONTRACT` on demo.

#### 16.7.5 Buffers are configurable
**Root Cause**: A hardcoded `0.0005` pre-flight buffer either rejected valid trades on liquid pairs or failed to cover the spread on illiquid ones.
**Fix**: `PREFLIGHT_BUFFER_PCT` (default `0.05`).
**Rule**: Liquidity-dependent percentages belong in `.env`, not in source.

### 16.8 Operational Hygiene

#### 16.8.1 UTC for every scheduler
**Root Cause**: `new Date().setHours(0,0,0,0)` uses the host's local timezone, so the macro refresh fired at the wrong hour on Render versus a dev machine.
**Fix**: `setUTCHours` / `setUTCDate`, or luxon with an explicit zone.
**Rule**: Schedulers are defined in UTC only.

#### 16.8.2 No local disk in the Telegram backup
**Root Cause**: Node 26 + Telegraf `sendDocument({ source: buffer })` fails with `socket hang up` / `ECONNRESET`, and the container is stateless anyway.
**Fix**: Buffer → `Uint8Array` → Web API `Blob` → `fetch` + `FormData` straight to `api.telegram.org`.
**Rule**: No `fs` in Telegram delivery.

#### 16.8.3 English only
**Root Cause**: Legacy Telegram notifications carried Russian bodies, splitting the operational vocabulary and breaking log greps.
**Fix**: `src/telegram/notifier.ts` and engine logs are English-only; reviews reject non-English strings. The funding-monitor alert bodies are the single documented exception, tracked as a localization item.
**Rule**: New user-facing strings are English. No new Cyrillic is introduced anywhere.

---

_Last updated: 2026-11-01. **Scenario 5 rebuilt — volume-confirmed SFP.** *(Superseded the same day by the geometry unlock above: the stop is now buffered, `skipMinorObstacles` is `true`, and the volume default is 1.3.)* The Sweep → CHoCH → FVG chain is gone (§8.8): S5 now evaluates an SFP on the **last closed** 15m candle (wick pierces a ranked PDH/PDL/PWH/PWL/BSL/SSL pool, close returns inside), requires the sweep candle to print ≥ `SMC_SWEEP_VOLUME_MULTIPLIER` (default 1.5) × the SMA volume of the 20 candles before it, enters at that close, stops just beyond the pierced wick through `calculateLevels()` with `atr = 0` (exact 0.1% floor), resolves the target with `skipMinorObstacles: false`, and rejects below a fee-inclusive net R:R (`(target − fee) / (stop + fee) ≥ DYNAMIC_TP_MIN_RR`). Macro pools are never burned; the trigger is burned as a `SWEEP` structure. New config: `SMC_SWEEP_VOLUME_MULTIPLIER`. Funnel: `noSweep` / `lowVolumeSweep` / `tpInvalid` / `insufficientCandles`. Measured 180 days (2026-05-05 → 2026-11-01, $1,000/symbol, killzones bypassed, `DYNAMIC_TP_MIN_RR=1.5`): BTC **+4.37% / 7 trades / PF 1.65**, ETH **−1.15% / 14 / 0.95**, SOL **−14.71% / 12 / 0.26**, portfolio **−3.83% / 33 trades / $204.79 fees**. At `2.0` the scenario is dormant (13 trades across the three symbols, portfolio −6.31%). The binding constraint is the target gate, not the volume gate: with a 0.1–0.3% stop, a fee-inclusive 1.5–2.0R demands a 3.5–5R structural target that the nearest-wall filter (`skipMinorObstacles: false`) rarely finds. Harness note: the S5 suite caught a sparse-array fixture whose `reduce()` silently skipped holes and averaged 11 of 20 baseline candles; the baseline is now summed with an explicit loop that fails closed. Toolchain: typecheck clean, **875 tests / 43 suites green**, build passing.

_Last updated: 2026-11-01. **Scenario 5 geometry unlock.** Three refinements, all scoped to Scenario 5 (§8.8.1, §16.5.8): the stop is buffered by `max(0.5 × atr15m, 0.1%)` beyond the pierced wick instead of sitting on it; `resolveTakeProfit()` runs with `skipMinorObstacles: true` so minor 15m swings are stepped over (a MAJOR pool inside the floor still rejects); and `SMC_SWEEP_VOLUME_MULTIPLIER` defaults to **1.3** in `env.ts`, `.env.example` and `.env`. Rationale: a wick-tight stop made 1R 0.1–0.3% of price, so the fee-inclusive net-R:R floor demanded a 3.5–5R structural target that the nearest-wall filter could almost never deliver — 99.4% of volume-confirmed survivors died at `tpInvalid`. Measured over the identical 180 days (2026-05-05 → 2026-11-01, $1,000/symbol, killzones bypassed, `DYNAMIC_TP_MIN_RR=1.5`): BTC **+$176.28 (+17.63%) / 31 trades / PF 1.48**, ETH **−$36.74 (−3.67%) / 44 / 0.94**, SOL **−$47.13 (−4.71%) / 67 / 0.94**, portfolio **+$92.41 (+3.08%) / 142 trades / 34.51% WR / $583.64 fees** — up from **−$114.81 / 33 trades**. `Triggered` rose 4.3× and `tpInvalid`'s share of survivors fell 98.97% → 96.03%, but the absolute count rose (3,181 → 3,438) because the looser volume gate fed 366 more survivors into the same gate. The portfolio sign flip is carried by BTC alone (ETH+SOL combined −$83.87) and Max DD widened to 13.44% / 19.49% / 12.56%, so this is a geometric repair, not a validated portfolio edge. Toolchain: typecheck clean, **878 tests / 43 suites green**.

_Last updated: 2026-11-01. **S12 shield execution-price fix.** `MIN_NET_RR` and `MIN_TP_DISTANCE_PCT` are no longer measured against `idealEntry`; `resolveShieldEntry()` prices the entry the trade will actually be booked at — the market price for a Market fill (discount or within `SMART_ENTRY_THRESHOLD_PCT`), `idealEntry` for a resting Limit — delegating the routing decision to `shouldUseMarketEntry()` so the gate and the executor cannot disagree (§7.13.5, Invariant 61, §16.1.8). A market price already outside `SL..TP` stays with the pre-flight DEAD-setup guard so its mitigation burn is preserved. Measured on the identical NEARUSDT 60-day window with a pinned clock: **+$252.24 / 9 trades / PF 5.64 / DD 2.22%** vs **+$284.94 / 10 trades / PF 6.19 / DD 2.22%** — nine signals unchanged, the single removed trade realised net R 0.973 (below the 1.0 floor) and was a winner, so the gate costs profit to enforce correctness. Test suite: **866 tests / 43 suites green**, typecheck clean.

_Last updated: 2026-10-28. **Endurance freeze release.** Two long-horizon audits are now recorded in §7.23: S14 Tank on BTCUSDT over **365 days** (+19.94%, PF 1.20, Max DD 19.82%, MAR 1.01 — 160.4 days underwater, fees eating 49.7% of gross) and S12 Sniper on NEARUSDT over **180 days** (+22.40%, PF 3.24, Max DD 4.74% at the audited calibration; the global `1.5` volatility shield starved the same window to +3.46%). The audit produced exactly one configuration change — `MIN_VOLATILITY_FEE_RATIO_NEARUSDT=1.0` in `.env` and `.env.emilia`, with the global shield left untouched for every other pair. Harness fix: `src/backtest/run.ts` appends the 1m history in a loop instead of `push(...fetched1m)`, which had thrown `Maximum call stack size exceeded` on any Sniper window beyond ~100k candles (§16.6.8). Also carried over from v2026-10-26: the V4 Classic scenario refactor (batches 1–4), Invariants 1–60, anti-patterns consolidated into §16.1–§16.8, and the live hotfix that stopped `processClosedPosition()` from resetting the state machine during the entry-bookkeeping window (§16.3.9, Invariant 60). Toolchain: typecheck clean, **853 tests / 43 suites green**, build passing.
