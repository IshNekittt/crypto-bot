# CRYPTO BOT SMC — ARCHITECTURAL BIBLE (v2026-10-01)

> **Single source of truth for any AI agent working on this codebase.**
> Every architectural decision, invariant, convention, and lesson learned in blood is documented here.
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

### 1.1 V5 Matrix — Sniper Mode (Two-Loop Architecture)

| Layer | Technology | Description |
|-------|------------|-------------|
| **Radar (LTF)** | 15m/4H candles | Scans for macro POI (Order Blocks, FVGs, HTF Sweeps, SMS) via existing 11 scenarios |
| **Sniper (1m)** | 1m candles | Once POI found, switches to `SNIPER_MODE` state; waits for 1m CHoCH inside the zone |
| **Execution** | Smart Pullback | On 1m CHoCH: `idealEntry = midpoint of CHoCH impulse`; SL under 1m extreme; uses existing Market/Limit logic |

**State Machine Extension** (`types.ts:26`):
- `StrategyState.SNIPER_MODE` — new state between `SCANNING` and `ENTRY_STAGED`
- `activeSniperZone` in `StrategyEngine` (live) and `BacktestState` (backtest): `{ top, bottom, direction, scenarioId, scenarioName }`

**Invariant**: Only scenarios 1, 5, 6, 10 (HTF Continuation, HTF Sweep, SMS, Breaker) can trigger Sniper Mode — they produce high-probability zones with clear direction.

### 1.2 Dual-Mode Architecture (V4 Classic & V5 Sniper)

The codebase now supports **two distinct operational modes** running from the same codebase, controlled by `ENABLE_SNIPER_MODE`:

| Aspect | **V4 Classic (ENABLE_SNIPER_MODE=false)** | **V5 Sniper (ENABLE_SNIPER_MODE=true)** |
|--------|-------------------------------------------|-----------------------------------------|
| **Timeframes** | 15m LTF / 4H HTF | 1m Sniper / 15m Radar / 4H Macro |
| **Entry Logic** | Close of 15m signal candle | 1m CHoCH inside 15m macro zone |
| **Scenarios** | 1-11 (all classic SMC) | **12 only** (Sniper Touch) |
| **State Machine** | SCANNING → ENTRY_STAGED → IN_TRADE | SCANNING → SNIPER_MODE → ENTRY_STAGED |
| **WS Subscription** | 15m, 240m | 1m, 15m, 240m |
| **Killzone** | London/NY only | London/NY only (enforced in Scenario 12) |
| **Cooldown** | After SL only (loss) | After SL only (loss) |

**Critical Invariant**: V4 and V5 **MUST NOT** run on the same process/instance. The `IN_TRADE` state machine is per-symbol and mutually exclusive. Running both modes simultaneously would cause state conflicts, double position risk, and `IN_TRADE` blocking.

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

**Deployment Pattern**: Use two Render/Oracle Cloud services pointing to the same Docker image but with different `.env` files:
```bash
# V4 Service
ENABLE_SNIPER_MODE=false
ACTIVE_SCENARIOS=1,5,6,10
DATABASE_URL=postgresql://v4-db...

# V5 Service  
ENABLE_SNIPER_MODE=true
ACTIVE_SCENARIOS=12
DATABASE_URL=postgresql://v5-db...
```

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
│   ├── baseScenario.ts    # Shared calculateLevels() — single SL source of truth
│   └── scenarios/         # 11 scenario implementations (S1–S11)
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

### 4.4 Dynamic Approval (Anti-Slippage) — **NEW v2026-09-30**

**Problem**: In manual approval mode (`AUTO_TRADING=false`), price can move significantly between signal generation and user clicking "Approve". The old logic always sent a Market order on approval, causing slippage.

**Solution**: Order type (Market vs Limit) is decided **AT APPROVAL TIME** by comparing live price vs `idealEntry` (zone equilibrium from scenario geometry):

| Condition | Order Type | Limit Price |
|-----------|------------|-------------|
| `|idealEntry - livePrice| / idealEntry ≤ 0.15%` | **Market** (IOC) | — |
| `|idealEntry - livePrice| / idealEntry > 0.15%` | **Limit** (GTC) | `idealEntry` |

**Config**: `SMART_ENTRY_THRESHOLD_PCT=0.15` (in `.env`, interpreted as 0.15% → 0.0015 in code).

**Implementation** (`src/engine/pendingTradeManager.ts`):
- `queueTrade()` stores `idealEntry` alongside setup.
- `handleApproval()` fetches live price via `priceProvider()` (injected from `StrategyEngine` → `candleFeed.getCurrentLivePrice()`).
- Returns `{ approved: true, orderType: 'Market'|'Limit', limitPrice?: string }`.
- **Slippage Guard still runs**: If live price ≥ TP → reject; if > 0.2% toward TP → reject.

**Invariant**: Decision is **purely at approval moment** — no pre-commitment to order type at signal time.

### 4.5 Breakeven Protection — **NEW v2026-09-30**

**Logic** (`src/backtest/executionSimulator.ts:532-560`, `src/engine/strategyEngine.ts`):
- Trigger: Price moves in favor by `BREAKEVEN_RR_TRIGGER` × risk distance (e.g., 2R)
- Action: Stop Loss permanently moved to entry price
- Backtester: Implemented in `checkAndCloseTrade()` — updates `openTrade.slPrice` in state when breakeven hit and trade continues
- Live: To be implemented in `StrategyEngine` position management

**Config**: `BREAKEVEN_RR_TRIGGER=2` (in `.env`, integer R-multiples)

**Behavior**: 
- Long: SL → entry when `high ≥ entry + (entry - SL) × trigger`
- Short: SL → entry when `low ≤ entry - (SL - entry) × trigger`
- Once moved, SL stays at entry for remainder of trade
- If price retraces to entry → closes at ~0 PnL (minus fees)

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
| **Breakeven**        | When price reaches `BREAKEVEN_RR_TRIGGER` × risk distance, SL moves to entry price    | `BREAKEVEN_RR_TRIGGER` (default 2)            |

**Leverage**: Set once at bootstrap via `setupMarginAndLeverage(symbol, leverage)` (isolated margin).

### 5.1 RiskManager Hardening (v2026-09-21)

All three execution pipeline fixes applied in single pass:

1. **Order Idempotency** (`bybitClient.ts:372`): `orderLinkId` now passed to `submitOrder()` — prevents duplicate orders on retry via `executeWithRetry()`.

2. **Leverage Cap** (`riskManager.ts:146-155`): `maxAllowedQty = marginBuffer.mul(leverage).div(entryDecimal)`. If `rawQty > maxAllowedQty`, caps it. Prevents "Insufficient Margin" when stop is very tight.

3. **No Double Rounding** (`riskManager.ts:115-116`): Removed `roundDownToStep()` for entry/SL. Now `formatPrice(input.entryPrice, tickSize)` and `formatPrice(input.stopLossRaw, tickSize)` — single precision step.

4. **TP From Scenario** (`riskManager.ts:131`): Removed internal `TAKE_PROFIT_RR_RATIO` recalculation. Takes `input.takeProfitRaw` (already calculated by `BaseScenario.calculateLevels()` with correct geometry). RiskManager only formats via `formatPrice()`.

### 5.2 Breakeven Protection (v2026-09-30)

**Logic** (`src/backtest/executionSimulator.ts:532-560`, `src/engine/strategyEngine.ts`):
- Trigger: Price moves in favor by `BREAKEVEN_RR_TRIGGER` × risk distance (e.g., 2R)
- Action: Stop Loss permanently moved to entry price
- Backtester: Implemented in `checkAndCloseTrade()` — updates `openTrade.slPrice` in state when breakeven hit and trade continues
- Live: To be implemented in `StrategyEngine` position management

**Config**: `BREAKEVEN_RR_TRIGGER=2` (in `.env`, integer R-multiples)

**Behavior**: 
- Long: SL → entry when `high ≥ entry + (entry - SL) × trigger`
- Short: SL → entry when `low ≤ entry - (SL - entry) × trigger`
- Once moved, SL stays at entry for remainder of trade
- If price retraces to entry → closes at ~0 PnL (minus fees)

## 6. ADAPTIVE FRACTIONING — Trade Management (`src/risk/tradeManager.ts`)

**Problem**: Static position management (fixed SL/TP) leaves profit on the table in trending markets and exposes full risk in choppy markets.

**Solution**: **Adaptive Fractioning** — Dynamic position management that adapts to the trade's initial R:R ratio.

### 6.1 Core Concept: Two Management Modes

| Trade Type | Condition | Management Strategy |
|------------|-----------|---------------------|
| **Classic** | TotalR < 4 (e.g., 1:3 R:R) | Single milestone: Move SL to entry at 66% progress |
| **Sniper** | TotalR ≥ 4 (e.g., 1:5+ R:R) | Two milestones: 33% (close 25%, SL→entry) → 66% (close 25%, trail SL) |

### 6.2 Progress Calculation

```
progress = |currentPrice - entry| / |takeProfit - entry|  // 0.0 to 1.0
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

Called on **every 1m candle** when `state === IN_TRADE`:
1. Fetch open trade + `management_state` from DB
2. Call `evaluateTradeManagement()` with current 1m candle price
3. Execute signal:
   - `move_sl_to_entry` / `trail_sl_to_profit` → `client.amendOrder()`
   - `close_partial_25` / `close_partial_50` → `executePartialClose()` (reduceOnly market order)
   - Update `management_state` in DB via `updateTradeManagementState()`

### 6.6 Backtest Simulation (`executionSimulator.ts`)

In `checkAndCloseTrade()`:
1. Evaluate management signal on each candle
2. For partial closes: Calculate PnL for closed portion, reduce `qty`, update balance
3. Update `managementState` in `openTrade` state
4. Track partial close PnL in balance immediately

---

## 7. SMC MATHEMATICS — `src/smc/patternRecognizer.ts`

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

### 6.5 V5 Sniper Mode (1m Execution) — **NEW v2026-09-30**

**Architecture**: Two-loop system — Radar (15m/4H) scans for macro POI, Sniper (1m) waits for precise entry inside zone.

| Phase | Timeframe | Action |
|-------|-----------|--------|
| **Radar** | 15m/4H | Scenarios 1, 5, 6, 10 evaluate 15m candles; on valid zone → store in `activeSniperZone`, state → `SNIPER_MODE` |
| **Sniper** | 1m | Each 1m candle: check zone invalidation (price breaks through zone); run `detectStructureBreaks()` on last 200 1m candles |
| **Trigger** | 1m | Fresh CHoCH in zone direction (after zone entry) with displacement ≥ 1.5 ATR → calculate `idealEntry` = midpoint of CHoCH impulse |
| **Execute** | 1m | Smart Pullback: Market if `|idealEntry - currentPrice|/idealEntry ≤ 0.15%`, else Limit @ `idealEntry` |

**State Machine** (`types.ts:26`):
- `StrategyState.SNIPER_MODE` — between `SCANNING` and `ENTRY_STAGED`
- `activeSniperZone` in `StrategyEngine` (live) and `BacktestState` (backtest): `{ top, bottom, direction, scenarioId, scenarioName }`

**Zone Invalidation**: Long → `candle.low < zone.bottom`; Short → `candle.high > zone.top` → reset to `SCANNING`.

**Backtester** (`src/backtest/run.ts`): Main loop iterates 1m candles; 15m candles synthesized via timestamp sync; `ScenarioRouter` evaluates on 15m closes only.

---

### 6.6 Macro Context (Bootstrap Only, ~5-10ms)

- **Loaded ONCE** at startup (single `PatternRecognizer` shared across engines).
- **1W/1D candles** (1000 each) → **linear O(N) passes only**:
  - ATH/ATL: max high / min low
  - PWH/PWL: `weekly[-2]` high/low
  - PDH/PDL: `daily[-2]` high/low
  - DO/WO: `daily[-1].open` / `weekly[-1].open`
  - FVG: last **20** daily candles only
- **NO** Order Blocks, Breakers, Mitigation on macro timeframes.
- Daily 00:00 UTC refresh: atomic cache replacement.

### 6.5 Strict Stop-Loss Calculation — `BaseScenario.calculateLevels()` — **SINGLE SOURCE OF TRUTH**

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

### 6.6 Dynamic Backtester Architecture — `src/backtest/run.ts`

**Problem**: Hardcoded '15m'/'240' timeframes and fixed 17280 candle count (180 days of 15m) prevented testing other timeframes. Cache filenames were hardcoded to '15', causing 5m cache to overwrite 15m cache.

**Solution**: Fully dynamic backtester using config-driven timeframes.

| Component | Detail |
|-----------|--------|
| **LTF/HTF Timeframes** | Read from `config.ltfTimeframe` / `config.htfTimeframe` (strings like '5', '15', '60') |
| **Dynamic Candle Count** | `Math.ceil((180 * 24 * 60) / ltfMinutes)` → 51840 for 5m, 17280 for 15m, 7200 for 60m |
| **Cache Filenames** | Dynamic: `BTCUSDT_5.json`, `BTCUSDT_15.json` (includes timeframe) |
| **Dynamic Timeframes in API** | `config.ltfTimeframe as Timeframe` / `config.htfTimeframe as Timeframe` |
| **Cache Key** | `getCachePath(symbol, timeframe)` uses timeframe in filename |
| **ScenarioRouter** | Receives LTF/HTF candle arrays + candleTimestamp; no hardcoded '15'/'240' |

**Removed Hardcoded Values:**
- ❌ `'15'` / `'240'` strings everywhere
- ❌ `17280` fixed candle count (180 days × 96 candles/day for 15m)
- ❌ `'15'` in cache filenames (`BTCUSDT_15.json`)
- ❌ Hardcoded '15m' / '4H' strings in log messages

**Added Dynamic Calculations:**
- ✅ `totalCandles = Math.ceil((180 * 24 * 60) / ltfMinutes)`
- ✅ Cache filename: `getCachePath(symbol, timeframe)` → `BTCUSDT_5.json` / `BTCUSDT_60.json`
- ✅ Dynamic log: `[SYMBOL] Starting backtest loop over 51840 5m candles...`
- ✅ Progress: `candle ${i}/${candlesLtf.length} (${((i / candlesLtf.length) * 100).toFixed(1)}%)`
- ✅ `runBacktestForSymbol` receives `ltfMinutes` parameter for dynamic calculations

### 6.7 News Filter (News Embargo) — `src/services/newsService.ts`

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

### 6.8 Funding Monitor (Delta-Neutral Arbitrage) — `src/services/fundingMonitorService.ts`

**Problem**: Delta-neutral arbitrage positions (long spot + short perp) earn funding when rates are positive but lose money when rates turn negative. Need passive monitoring with alerts.

**Solution**: **FundingMonitorService** — independent passive service polling Bybit tickers every 30 min for funding rates.

**Implementation** (`src/services/fundingMonitorService.ts`):

| Component | Detail |
|-----------|--------|
| **Source** | Bybit V5 `getTickers({ category: 'linear' })` |
| **Poll Interval** | 30 minutes (`FUNDING_POLL_INTERVAL_MS = 30 * 60 * 1000`) |
| **Tracked Symbols** | `FUNDING_MONITOR_SYMBOLS` (default: BTCUSDT,ETHUSDT,SOLUSDT) |
| **Alert Threshold** | `FUNDING_ALERT_THRESHOLD=0.0` — rate ≤ 0 triggers alert |
| **Restore Threshold** | `FUNDING_RESTORE_THRESHOLD=0.0001` — rate ≥ +0.01% triggers restore |
| **State Tracking** | Per-symbol `isAlerted` boolean to prevent spam |
| **Telegram Alert (Negative)** | `⚠️ [FUNDING ALERT]\nМонета: {symbol}\nСтавка: {rate*100}%\nРекомендуется закрыть арбитраж!` |
| **Telegram Alert (Restore)** | `🟢 [FUNDING RESTORED]\nМонета: {symbol}\nСтавка: +{rate*100}% (APY: ~{rate*3*365*100}%)\nМожно снова открывать арбитраж!` |
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

### 6.9 Dynamic Macro Context in Backtester — **Lookahead Bias Elimination** — `src/backtest/run.ts` — **NEW v2026-09-20**

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

### 6.10 Timezone Sanity Check (Docker + luxon) — **NEW v2026-09-22**

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

### 6.11 Mitigated Structures (Ghost Signal Elimination) — **NEW v2026-09-24**

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
   - New `filterMitigatedStructures()` — filters `patternData.structures` by timestamp+type+direction
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

### 6.18 Ghost Signals Protection (V5 Sniper) — **NEW v2026-10-01**

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
       ms.type === s.type && 
       ms.timestamp === s.timestamp && 
       ms.direction === s.direction
     );

   const recentStructures = structures.filter(s => 
     s.type === 'CHOCH' && 
     s.direction === direction &&
     s.timestamp >= (candles1m[candles1m.length - 30]?.timestamp ?? 0) &&
     !isMitigated(s)
   );
   ```

3. **Scenario 12 returns `structureDetails` with direction** on trigger (`Scenario12_SniperTouch.ts:214-219`):
   ```typescript
   this.setStructureDetails({
     type: 'CHoCH',
     timestamp: choch.timestamp,
     price: choch.price,
     direction: choch.direction,
   });
   ```

4. **Engine auto-mitigates on trade close** (`executionSimulator.ts:626-631`, `strategyEngine.ts:363-365`):
   - Trade closes → `structureDetails` passed to DB
   - Reconciliation/WS close → `addMitigatedZone` + structure added to `mitigatedStructures`
   - Next 1m candle → same CHoCH filtered out, no ghost entry

**Result**: Scenario 12 on SOLUSDT — the rapid-fire 2-minute re-entries after TP are eliminated. The CHoCH is marked as "used" immediately after first trade closes.

---

### 6.19 Backup Service CSV Export — **NEW v2026-10-01**

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

### 6.12 Same-Candle SL/TP Resolution (Lookahead Bias Fix) — **NEW v2026-09-24**

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

### 6.13 Mitigated Zones Fix (Zone Re-entry Bug) — **NEW v2026-09-24**

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

### 6.14 Cooldown Logic Fix — **NEW v2026-09-24** (Updated v2026-09-27: Dynamic Timeframe Support)

**Problem**: Cooldown (4h) was applied after ALL trades (wins and losses), blocking valid trend continuation. Also, the cooldown was hardcoded to 15-minute timeframe (`16 * 15 * 60 * 1000`), breaking when `LTF_TIMEFRAME` changed.

**Fix**: Cooldown ONLY after LOSS (revenge trading protection). After WIN → no cooldown. Cooldown duration is now fully dynamic: `COOLDOWN_CANDLES × LTF_TIMEFRAME` minutes.

```typescript
// executionSimulator.ts (backtest)
const ltfMinutes = Number(config.ltfTimeframe);
const cooldownMs = config.cooldownCandles * ltfMinutes * 60 * 1000;
cooldownUntil: netPnl.lt(0) ? candle.timestamp + cooldownMs : 0;

// strategyEngine.ts (live)
if (finalPnlString !== null && new Decimal(finalPnlString).lt(0)) {
  const ltfMinutes = Number(this.deps.config.ltfTimeframe);
  const cooldownMs = this.deps.config.cooldownCandles * ltfMinutes * 60 * 1000;
  this.cooldownUntil = Date.now() + cooldownMs;
  const cooldownHours = (cooldownMs / (60 * 60 * 1000)).toFixed(2);
  logger.info(`[${this.symbol}] Cooldown active after stop-loss. Skipping scan for ${cooldownHours}h.`);
}
```

**Rule**: Cooldown = `COOLDOWN_CANDLES` candles (default 16) ONLY after LOSS. WIN = no cooldown, ride the trend.
**Examples**:
- `LTF_TIMEFRAME=15`, `COOLDOWN_CANDLES=16` → 4 hours (default)
- `LTF_TIMEFRAME=5`, `COOLDOWN_CANDLES=16` → 1h 20min
- `LTF_TIMEFRAME=60`, `COOLDOWN_CANDLES=16` → 16 hours

---

### 6.15 Backtest Report Enhancements — **NEW v2026-09-24**

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

---

### 6.16 Backtester Critical Fixes (Ghost Signal & Data Integrity) — **NEW v2026-09-26**

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

### 6.17 Hybrid Smart Entry Architecture (Market vs Limit) — **NEW v2026-09-29**

**Problem**: Entering Market orders at the close of the 15m signal candle is mathematically unprofitable in SMC. Price has already "run away", SL becomes huge, R:R breaks, and Bybit rejects TP/SL with error [10001] (TP/SL limits).

**Solution**: **Hybrid Smart Pullback Limit Orders** — bot dynamically chooses between Market and Limit (GTC) based on price deviation from ideal entry.

#### 6.17.1 Decision Logic (`src/engine/strategyEngine.ts`)

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

#### 6.17.2 Smart Cancellation — Limit Order Lifecycle

**Expiration**: `LIMIT_EXPIRATION_CANDLES=6` (default 6 × 15m = 1.5 hours).

**ReconciliationLoop** (`src/bootstrap/reconciliation.ts`): Every 10 min, calls `getOpenOrders(symbol)` → for each active Limit order:
- If `orderAge > LIMIT_EXPIRATION_CANDLES × LTF_TIMEFRAME` → **cancel** on exchange (`cancelOrder`).
- Log: `Cancelled expired LIMIT order ${orderId} (age: X min, limit: 6 candles)`.

**Rationale**: If limit order hasn't filled in 6 candles, the setup context is stale — price action has moved on.

#### 6.17.3 Backtester Simulation (`src/backtest/executionSimulator.ts`)

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

#### 6.17.4 Execution Engine (`src/execution/executionEngine.ts`)

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

## 7. THE 12 SCENARIOS — `src/engine/scenarios/`

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
| **11** | Mitigation Block    | **Only after SMS** → retest block that formed failed swing | **Strict SMS pattern**: failed HH → CHoCH down (`NoSms`, `InvalidSmsPattern`). **FRESHNESS**: Always takes newest SMS (`smsList[smsList.length-1]`), newest CHoCH after SMS (`validChochs[validChochs.length-1]`), newest OB before SMS (`mbObs[mbObs.length-1]`). **RETEST**: Current 15m candle must test MB zone with wicks, close inside zone in trade direction, within 12h of CHoCH. **P/D**: Entry close tested against SMS→CHoCH impulse equilibrium (Long=Discount, Short=Premium). |
| **12** | Sniper Touch        | 1m CHoCH inside 15m macro zone (PDH/PDL/PWH/PWL)           | Killzone (London/NY) + Sweep validation + 1m CHoCH + 1m OB entry              |

### 7.1 Zone Mitigation (No Re-entry) — `ScenarioRouter` + `StrategyEngine`

- `mitigatedZones[]` in engine memory (max 100).
- On trade close: `addMitigatedZone(zoneDetails)` → Router filters by `type/timeframe/direction/top/bottom` before `evaluate()`.
- Scenarios setting `zoneDetails`: **1, 2, 4, 5, 7, 8, 10, 11, 12**.

### 7.2 Contextual Quality Filters (Confluence)

| Scenario                  | Filter                                       | Rejection Stat               |
| ------------------------- | -------------------------------------------- | ---------------------------- |
| **11 (Mitigation Block)** | Valid SMS pattern (failed HH → CHoCH down)   | `NoSms`, `InvalidSmsPattern` |

---

### 7.3 Scenario 11 — Mitigation Block — Full Implementation Details

**File**: `src/engine/scenarios/Scenario11_MitigationBlock.ts`

**Core Logic**: Mitigation Block is a reversal pattern that forms after a Failed Swing (SMS):
1. Price attempts a higher high (bearish SMS) / lower low (bullish SMS) but fails
2. Price reverses with a CHoCH in opposite direction (≥1.5 ATR displacement)
3. The Order Block that formed the failed swing extreme becomes the Mitigation Block
4. Trade triggers on retest of this MB by current 15m candle

**Critical Implementation Details (v2026-09-21 — Critical Bug Fixes):**

| Aspect | Implementation | Why Critical |
|--------|---------------|--------------|
| **SMS Selection** | `structures.filter(s => s.type === 'SMS')` → `smsList[smsList.length-1]` | `.find()` returns OLDEST; must take NEWEST SMS |
| **CHoCH Selection** | `structures.filter(s => ...)` → `validChochs[validChochs.length-1]` | Must take NEWEST CHoCH after the chosen SMS |
| **MB Selection** | `zones.filter(...)` → `mbObs[mbObs.length-1]` | Must take NEWEST OB before SMS (formed the failed swing) |
| **Retest Logic** | **Current 15m candle ONLY** (`candles15m[candles15m.length-1]`) | No historical search — trade triggers NOW |
| **Time Window** | `0 < timeSinceChoch ≤ 12h` | Blocks stale setups; 12h max hold |
| **Retest Condition** | Current candle wicks touch MB zone (`high ≥ mbBottom && low ≤ mbTop`) AND closes inside zone in trade direction | Confirms institutional interest at MB |
| **Premium/Discount** | Dynamic equilibrium from `SMS price → CHoCH price` impulse | Long = Discount (below eq), Short = Premium (above eq) |
| **Rejection Stats** | `NoSms`, `InvalidSmsPattern`, `NoChoch`, `Displacement`, `NoMB`, `NoRetest`, `PremDisc` | Full observability |

**Key Invariants:**
- `structures` and `zones` arrays are timestamp-ascending (oldest first)
- **Always use `[array.length-1]` for "newest"** — never `[0]` or `.find()`
- Retest is **current candle only** — no historical search
- P/D equilibrium calculated from `SMS price → CHoCH price` impulse
- Maximum 12h from CHoCH to retest (prevents stale setups)

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

### 8.1 CRUD Operations Audit — **v2026-09-26**

| Operation | SQL / Code | Status |
|-----------|------------|--------|
| **CREATE TABLE** | All 19 columns present: `scenario_id`, `reason`, `zone_type`, `zone_top`, `zone_bottom`, `zone_timeframe`, `zone_direction`, `zone_timestamp` | ✅ |
| **INSERT (openTrade)** | 16 fields passed incl. all 6 zoneDetails fields with `?? null` fallback | ✅ |
| **UPDATE (closeTrade)** | `reason` column now updated: `SET ..., reason = $4` | ✅ **FIXED v2026-09-26** |
| **SELECT (mapRowToTradeRecord)** | `zone_top/bottom` → `new Decimal(row.zone_top)`, `scenario_id` as `number \| null`, `reason` passed through | ✅ |
| **BACKUP (tradesToCsv)** | All 19 columns exported including zone details | ✅ |

**DB Fix Applied**: `closeTrade(tradeId, pnl, exitPrice, closedAt, reason)` — callers in `strategyEngine.ts`:
- Line 348: `closeReason = PnL < 0 ? 'SL' : 'TP'`
- Line 572: `'RECONCILIATION'`
- Line 684: `closeReason = PnL < 0 ? 'SL' : 'TP'`

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

# Cooldown after SL hit (in LTF candles, default 16 = 4h for 15m timeframe)
COOLDOWN_CANDLES=16

# SMC Parameters
SMC_SL_ATR_OFFSET=0.5              # ATR multiplier for SL offset (default 0.5)
SMC_DISPLACEMENT_MULTIPLIER=1.5    # Displacement threshold in ATR (default 1.5)

# Hybrid Smart Entry
SMART_ENTRY_THRESHOLD_PCT=0.15     # Market vs Limit threshold in % (default 0.15 = 0.15%)
LIMIT_EXPIRATION_CANDLES=6         # Limit order lifetime in LTF candles (default 6 = 1.5h for 15m)

# Funding Monitor (delta-neutral arbitrage)
ENABLE_FUNDING_MONITOR=false
FUNDING_MONITOR_SYMBOLS=BTCUSDT,ETHUSDT,SOLUSDT
FUNDING_ALERT_THRESHOLD=0.0
FUNDING_RESTORE_THRESHOLD=0.0001

# Logging
LOG_LEVEL=info             # debug, info, warn, error
```

---

## 11. BUILD & VERIFICATION COMMANDS

```bash
npm run typecheck    # tsc --noEmit  (must pass)
npm test             # jest (231 tests, all green)
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
3. **Macro context initialized ONCE** at bootstrap (live), **DYNAMICALLY UPDATED** in backtester — never static in hot path.
4. **`mitigatedZones`** is the ONLY re-entry protection (no "freshness" hacks).
5. **`reconcileWithTrade`** receives `zoneDetails` for mitigation tracking.
6. **Slippage Guard** runs at approval time, not order time.
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
19. **Limit Order Cancellation** — ReconciliationLoop cancels Limit orders older than `LIMIT_EXPIRATION_CANDLES × LTF_TIMEFRAME` minutes. Zone burned immediately on Limit placement (not on fill).
20. **Backtester Limit Simulation** — State machine: SCANNING → PENDING (limitPrice, placedAt, candlesWaited) → IN_TRADE (on wick touch) OR CANCELLED (after LIMIT_EXPIRATION_CANDLES). Filled at exact `limitPrice`, not candle close.

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

### 13.2 docker-compose.yml (Single Service for Render/Oracle Cloud)

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
    deploy:
      resources:
        limits:
          cpus: '0.5'
          memory: 512M
```

- **No volumes** — fully stateless (Supabase for persistence)
- **Port 3000** — health check (`GET /health`) for Render/load balancer
- **stop_grace_period: 30s** — matches `SIGTERM` handler in `index.ts`
- **Resource limits**: 0.5 CPU / 512MB — fits Oracle Cloud Free Tier (ARM) or Render free tier
- **Single `.env` file** with all configuration

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

## 15. CRITICAL ANTI-PATTERNS & LESSONS LEARNED (BLOOD-SIGNED)

> These rules exist because we **lost money, time, or sanity** discovering them. Do NOT "optimize" them away.

### 15.1 ❌ FORBIDDEN: O(N²) and `while` loops in Math Hot Paths
**Root Cause**: `detectEqualLevels()` used nested `for` loops on 17,000 candles → 100% CPU, event loop blocked.
**Fix**: All candle iteration is **strictly `for (let i = 0; i < n; i++)`** with index pointers. Macro context builds in <10ms via single linear passes.
**Rule**: No nested loops over candles. No `while (true)` with break conditions. Use pre-computed arrays + pointer advancement.

### 15.2 ❌ FORBIDDEN: Inline Stop-Loss Calculations in Scenarios
**Root Cause**: `invalid SL level` errors — zone `top`/`bottom` ordering was arbitrary (not guaranteed `top > bottom`). `zone.bottom - offset` produced SL *above* entry for Longs when zone was inverted.
**Fix**: **ONLY** `BaseScenario.calculateLevels()` — single source of truth.
- **Long**: `Decimal.min(zone.bottom, entry).minus(offset)` — SL *always* below entry
- **Short**: `Decimal.max(zone.top, entry).plus(offset)` — SL *always* above entry
**Rule**: Zero inline SL math in scenarios. Call `this.calculateLevels(...)` and use returned levels.

### 15.3 ❌ FORBIDDEN: `toFixed(2)` or Hardcoded Decimal Places for Prices
**Root Cause**: Forex pairs (JPY) and crypto with 4-5 decimals got truncated. Bybit rejected orders with `Invalid price precision`.
**Fix**: `utils/precision.ts` — `formatPrice(price, tickSize, 'nearest')` and `formatQuantity(qty, qtyStep, 'down')`. Rounding uses instrument's actual `tickSize`/`qtyStep`.
**Rule**: Never hardcode decimal places. Always format via instrument precision.

### 15.4 ❌ FORBIDDEN: `fs.writeFileSync` / Local File I/O in Telegram Backup
**Root Cause**: Node 26 + Telegraf `sendDocument({ source: buffer })` → `socket hang up` / `ECONNRESET`. Telegraf's internal `form-data` + `fs.createReadStream` from Buffer is broken on Node 26.
**Fix**: Convert Buffer → `Uint8Array` → **Web API `Blob`** → `fetch` + `FormData` to `api.telegram.org/bot<token>/sendDocument`. **Zero disk I/O**.
**Rule**: No `fs` in Telegram file sending. Use native `fetch` + `Blob` + `FormData`.

### 15.5 ❌ FORBIDDEN: Local Time for Daily Schedulers
**Root Cause**: `new Date().setHours(0,0,0,0)` uses **local timezone**. On Render (UTC) vs dev machine (local) → macro refresh at wrong hour, clock drift unnoticed.
**Fix**: `new Date().setUTCHours(0,0,0,0); tomorrow.setUTCDate(tomorrow.getUTCDate() + 1)` — **strictly UTC**.
**Rule**: All time calculations use `DateTime.setZone('UTC')` or `setUTCHours`/`setUTCDate`. Never `Date.now()` + local offsets.

### 15.6 ❌ FORBIDDEN: Multiple Concurrent Trades per Symbol
**Root Cause**: Missing `IN_TRADE` guard in `ScenarioRouter` → 400 trades/day on choppy market (machine gun). Account blown.
**Fix**: `ScenarioRouter` **hard-blocked** if `engine.openTrade !== null` (or `state === IN_TRADE`). Strictly **1 trade per symbol**.
**Rule**: State machine must be `SCANNING` → `ENTRY_STAGED` → `IN_TRADE` → `SCANNING`. No parallel entries.

### 15.8 ❌ FORBIDDEN: Static Macro Context in Backtester (Lookahead Bias)
**Root Cause**: `initializeMacroContext()` called once before backtest loop loaded daily levels (PDH/PDL, PWH/PWL) from **end of history** (e.g., September 2026). During simulation of March–August, the bot used future levels — Scenarios 5, 7, 8, 9 missed valid sweeps.
**Fix**: Dynamic macro context in `runBacktestForSymbol()`:
- Track `currentDayUtc` / `currentWeekUtc` per candle
- Running ATH/ATL updated with each candle (historical only)
- On new day (00:00 UTC): PDH/PDL from yesterday's **closed** candles (`slice(0, i)`)
- On new week (Monday): PWH/PWL from last 7 days of closed candles
- Atomic `recognizer.setMacroContext()` update
**Rule**: Never call `initializeMacroContext()` before backtest loop. Macro levels must be computed on-the-fly from data strictly before current candle.

### 15.9 ❌ FORBIDDEN: Zero Stop-Loss Offset (Division by Zero in RiskManager)
**Root Cause**: In low volatility, ATR ≈ 0 → offset = 0 → SL = Entry → `slDistance = 0` → division by zero in RiskManager position sizing.
**Fix**: Minimum offset floor in `BaseScenario.calculateLevels()`: `offset = max(atr * 0.5, entry * 0.1%)`. SL always at least 0.1% from entry.
**Rule**: Always enforce minimum offset in SL calculation. Never allow SL == Entry.

### 15.10 ❌ FORBIDDEN: Inverted Zone Stop-Loss (Stop Inside Entry Block)
**Root Cause**: Zone objects can have `top < bottom` (not guaranteed `top > bottom`). `min(zone.bottom, entry)` for Long fails when zone is inverted — SL ends up *above* entry.
**Fix**: `Decimal.min(zone.top, zone.bottom, entry)` for Long, `Decimal.max(zone.top, zone.bottom, entry)` for Short — min/max of ALL THREE guarantees correct SL side.
**Rule**: Always use min/max of top, bottom, AND entry for SL. Never assume zone ordering.

_Last updated: 2026-09-26. All 231 tests green. Build passes. Enterprise-ready._