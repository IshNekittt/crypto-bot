<div align="center">

# 🤖 CRYPTO BOT SMC — Smart Money Concepts Trading Bot

[![Node.js](https://img.shields.io/badge/Node.js-26.x-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9+-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Bybit V5](https://img.shields.io/badge/Bybit-V5%20API-FF6B35?logo=bybit&logoColor=white)](https://bybit-exchange.github.io/docs/v5/intro)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-Supabase-4169E1?logo=postgresql&logoColor=white)](https://supabase.com/)
[![Docker](https://img.shields.io/badge/Docker-Multi--stage-2496ED?logo=docker&logoColor=white)](https://www.docker.com/)
[![Tests](https://img.shields.io/badge/Tests-240%20passing-brightgreen?logo=jest)](https://jestjs.io/)
[![Version](https://img.shields.io/badge/Version-v2026--10--10-blue)](https://github.com/)

**Enterprise-grade autonomous trading bot** implementing **Smart Money Concepts (SMC)** on Bybit V5 Linear Perpetuals.
Built for **reliability**, **observability**, and **mathematical precision** — zero `number` for money, only `decimal.js`.

**v2026-10-10**: Hardened auto-trading pre-flight checks, robust Bybit V5 position parsing, reconciliation cooldown, and fail-fast burnSetup guarantees.

</div>

---

## 🎯 Features at a Glance

| Category                    | Capability                                                                                                                                                             |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **12 SMC Scenarios**        | HTF Continuation, FVG Fill, IDM, Mitigation Chain, HTF Liquidity Sweep, SMS, AMD, Range Deviation, Turtle Soup, Breaker Block, Mitigation Block, **Sniper Touch (1m)** |
| **🎯 V5 Sniper Mode**       | **Two-loop execution**: Radar (15m/4H) finds macro POI → Sniper (1m) waits for CHoCH inside zone → Smart Pullback entry (Market/Limit)                                 |
| **📊 Dynamic Approval**     | **Market vs Limit decided at approval time**: compares live price vs `idealEntry` (zone equilibrium) with `SMART_ENTRY_THRESHOLD_PCT` (default 0.15%)                  |
| **🛡 Pre-flight SL Check**  | **Validates SL at approval**: If price crossed SL during wait, setup is auto-cancelled — prevents "SL below base_price" Bybit rejection                                |
| **👻 Ghost Signal Guard**   | **V5 CHoCH mitigation**: 1m CHoCH structures auto-marked "used" after trade close — prevents rapid-fire re-entries on same structure                                   |
| **⚙️ Adaptive Fractioning** | **Dynamic position management**: Classic mode (SL→entry at 66%) vs Sniper mode (close 25% at 33%, trail SL at 66%) — adapts to initial R:R                             |
| **🧮 Strict Math Side**     | **Side determined by geometry**: `side = idealEntry.gt(SL) ? 'Buy' : 'Sell'` — eliminates text-based direction errors and invalid SL levels                            |

---

## 📊 Backtest Results (180 days, 3 symbols, Scenarios 1–11 Classic / Scenario 12 Sniper)

| Symbol      | Final Balance | Net Profit   | Trades | Win Rate   | Max DD |
| ----------- | ------------- | ------------ | ------ | ---------- | ------ |
| **BTCUSDT** | $23,490.32    | **+2,249%**  | 150    | **80.00%** | 17.82% |
| **ETHUSDT** | $11,553.88    | **+1,055%**  | 118    | **64.41%** | 41.59% |
| **SOLUSDT** | $107,584.02   | **+10,658%** | 189    | **66.14%** | 31.81% |

**Total**: 457 trades | Σ PnL ≈ **$141,628** | Avg Win Rate **~70%** | Max DD **< 42%**

> **Top Drivers**: SMS (S6), HTF Continuation (S1), HTF Sweep (S5)
> **Filters Working**: S2 `NoLiqCtx: 120`, S4 `NoBOS: 1,570`, S11 strict SMS = 0 noise trades

---

## ⚡ Hybrid Smart Entry Architecture (Market vs Limit) — v2026-09-29

**Problem**: Entering Market orders at the close of the 15m signal candle is mathematically unprofitable in SMC. Price has already "run away", SL becomes huge, R:R breaks, and Bybit rejects TP/SL with error [10001] (TP/SL limits).

**Solution**: **Hybrid Smart Pullback Limit Orders** — bot dynamically chooses between Market and Limit (GTC) based on price deviation from ideal entry.

### Decision Logic (`src/engine/strategyEngine.ts`)

```typescript
const idealEntry = new Decimal(result.levels.entry); // Zone equilibrium (e.g., OB 0.5, FVG 0.5)
const currentPrice = new Decimal(lastCandle.close); // Signal candle close
const smartThreshold = new Decimal(config.smartEntryThresholdPct); // 0.0015 = 0.15%

const priceDiffPct = idealEntry.minus(currentPrice).div(idealEntry).abs();
const useMarketOrder = priceDiffPct.lte(smartThreshold);

const orderType = useMarketOrder ? "Market" : "Limit";
const limitPrice = useMarketOrder ? null : idealEntry.toFixed(8);
```

| Condition                                            | Order Type       | Price        |
| ---------------------------------------------------- | ---------------- | ------------ |
| `\|idealEntry - currentPrice\| / idealEntry ≤ 0.15%` | **Market** (IOC) | —            |
| `\|idealEntry - currentPrice\| / idealEntry > 0.15%` | **Limit** (GTC)  | `idealEntry` |

**Config**: `SMART_ENTRY_THRESHOLD_PCT=0.15` (in `.env`, interpreted as 0.15% → 0.0015 in code).

### Smart Cancellation — Limit Order Lifecycle

**Expiration**: `LIMIT_EXPIRATION_CANDLES=6` (default 6 × 15m = 1.5 hours).

**ReconciliationLoop** (`src/bootstrap/reconciliation.ts`): Every 10 min, calls `getOpenOrders(symbol)` → for each active Limit order:

- If `orderAge > LIMIT_EXPIRATION_CANDLES × LTF_TIMEFRAME` → **cancel** on exchange (`cancelOrder`).
- Log: `Cancelled expired LIMIT order ${orderId} (age: X min, limit: 6 candles)`.

**Rationale**: If limit order hasn't filled in 6 candles, the setup context is stale — price action has moved on.

### Pre-flight SL & TP Checks (Manual & Auto-Trading) — Hardened v2026-10-10

**Problem**: In manual approval mode (`AUTO_TRADING=false`), price can move significantly between signal generation and user clicking "Approve". If price crosses the calculated SL during this wait, the order would be rejected by Bybit with error [10001] (StopLoss set for Buy position should lower than base_price). The same risk exists in auto-trading mode (`AUTO_TRADING=true`) where `executeStagedEntry()` fires immediately after signal detection.

**Solution**: **Pre-flight SL & TP validation** at two points:
1. **At approval time** (manual mode): Before sending order to ExecutionEngine (in `StrategyEngine.handleTradeApproval`)
2. **At auto-execution time** (auto mode): Inside `executeStagedEntry()` before calling `executionEngine.execute()`

Both paths fetch `getLivePrice()` (with fallback to last closed candle) and validate against the calculated SL/TP:

1. **Pre-flight SL breach check** — abort if live price already breached SL
2. **Pre-flight TP reached check** — abort if live price already reached TP  
3. **Slippage Guard (0.2% toward TP)** — abort if price moved >0.2% toward TP (R:R degraded)
4. **Dynamic Market vs Limit Re-evaluation** — re-evaluate at live tick using `smartEntryThresholdPct` (0.15%)

If any check fails, the setup is **burned** (zone + structure added to mitigation lists) and state returns to `SCANNING`. This prevents the dead setup from being re-detected on the next minute.

**Fail-Fast on Execution Failure** (auto-trading path): If `executionEngine.execute()` returns `{ ok: false }` or throws, `burnSetup()` is **guaranteed** to be called before transitioning to `SCANNING`. This prevents rejection loops (e.g., Bybit error [10001] spam) by immediately burning the zone/structure so the bot doesn't re-detect the dead setup on the next candle.

Both paths fetch `getLivePrice()` (with fallback to last closed candle) and validate against the calculated SL/TP.

```typescript
const currentPrice = this.feedLtf.getCurrentLivePrice();
if (currentPrice) {
  const currentPriceDecimal = new Decimal(currentPrice);
  const slDecimal = new Decimal(this.plan.stopLoss);
  const isLong = this.plan.side === "Buy";

  if (isLong && currentPriceDecimal.lte(slDecimal)) {
    logger.warn(
      `Setup DEAD: Current price (${currentPrice}) is already below SL (${this.plan.stopLoss})`,
    );
    this.burnSetup(this.plan); // Burn zone + structure to prevent spam
    this.transition(StrategyState.SCANNING);
    return;
  }
  if (!isLong && currentPriceDecimal.gte(slDecimal)) {
    logger.warn(
      `Setup DEAD: Current price (${currentPrice}) is already above SL (${this.plan.stopLoss})`,
    );
    this.burnSetup(this.plan); // Burn zone + structure to prevent spam
    this.transition(StrategyState.SCANNING);
    return;
  }
}
```

### Slippage Guard Paradox Fix (Auto-Trading) — v2026-10-12

**Problem**: The 0.2% Slippage Guard was applied uniformly to all order types. When price deviation exceeded 0.2%, valid Limit orders (which wait for a pullback by design) were incorrectly aborted. This caused mass rejection of valid pullback setups — the very orders meant to protect against slippage.

**Solution**: The logic order in `executeStagedEntry()` was corrected to eliminate the **Slippage Guard Paradox**:

1. **Market vs Limit determination occurs FIRST** (at live tick).
2. **Pre-flight SL breach and TP reached checks remain UNCONDITIONAL** for all orders.
3. The **0.2% Slippage Guard (deviation toward TP) is applied ONLY to Market orders**.
4. **Limit orders bypass the slippage guard** — they wait for a pullback by design; a slippage check would incorrectly abort valid pullback setups.

| Order Type | SL Breach Check | TP Reached Check | 0.2% Slippage Guard |
|------------|-----------------|------------------|---------------------|
| **Market** | ✅ Unconditional | ✅ Unconditional | ✅ Applied (>0.2% aborts) |
| **Limit** | ✅ Unconditional | ✅ Unconditional | ❌ Bypassed (waits for pullback) |

**Invariant**: Market vs Limit decision is **purely at live tick** — no pre-commitment at signal time. Slippage Guard is **context-aware**: Market orders only.

### State Guard in `handleTradeApproval` — v2026-10-05

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

### Concurrency Lock in `process()` — v2026-10-05

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

### Live Price Provider for Pre-flight & Slippage Guard — v2026-10-06

**Problem**: `PendingTradeManager` used the last closed 15m candle close price as "live price" for slippage guard and pre-flight checks. In volatile markets, this price can be minutes stale, causing the bot to approve setups that are already invalid.

**Solution**: New `getLivePrice()` method on `StrategyEngine` that returns the live tick price from the LTF candle feed:

```typescript
getLivePrice(): string | null {
  return this.feedLtf.getCurrentLivePrice()?.toString() || null;
}
```

Updated `src/index.ts` to wire this provider:

```typescript
pendingTradeManager.setPriceProvider((symbol: string) => {
  const engine = engines.find((e) => e.symbol === symbol);
  return engine?.getLivePrice() ?? null;
});
```

**Impact**: Slippage Guard and Pre-flight Check now use real-time tick price instead of stale candle close.

### Guaranteed Ghost Signal Burning via `structureDetails` — v2026-10-06

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

### Zero-NULL Database Guarantee for Closed Trades — v2026-10-06

**Problem**: `closeTrade` was called with NULL `pnl`/`exit_price` when exchange data was unavailable, polluting the database.

**Solution**: Comprehensive fallback logic in three locations:

1. **`onExchangePositionClosed`** (lines 495-510): Calculates fallback PnL from trade data + `getLivePrice()` for exit price
2. **`reconcile`** (lines 851-875): Calculates PnL from live price instead of passing null
3. **`reconcileWithTrade`** (lines 990-1010): Fallback PnL calculation + live price for exit price

**Guarantee**: `closeTrade` is never called with NULL `pnl` or `exit_price` — database integrity maintained.

---

### Strict Mathematical Side Determination — v2026-10-05

**Problem**: Previously, trade side (`Buy`/`Sell`) was derived from text-based direction fields (`zoneDetails.direction`, `sweepDirection`, `BULLISH`/`BEARISH` strings). This led to fatal errors when the text label disagreed with the actual SL/TP geometry (e.g., "BULLISH" label but SL above entry).

**Solution**: Trade side is determined **EXCLUSIVELY by geometry** — `side = idealEntry.gt(SL) ? 'Buy' : 'Sell'`. Math never lies.

```typescript
const idealEntry = new Decimal(result.levels.entry);
const slDecimal = new Decimal(result.levels.stopLoss);
const side = idealEntry.gt(slDecimal) ? "Buy" : "Sell";
```

**Rule**: Never hardcode `side`. Never derive side from text labels. Always compute from Entry vs SL geometry at the point of RiskManager call.

---

### Backtester Simulation (`src/backtest/executionSimulator.ts`)

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

### Execution Engine (`src/execution/executionEngine.ts`)

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

## 📚 Technical Deep-Dives (see AGENTS.md for full details)

| Topic                                                                     | Section in AGENTS.md |
| ------------------------------------------------------------------------- | -------------------- |
| **Adaptive Fractioning** (dynamic position management)                    | §6                   |
| **Hybrid Smart Entry** (Market vs Limit at approval time)                 | §7.20                |
| **Strict SL Calculation** (single source of truth, inverted zone defense) | §7.6                 |
| **V5 Sniper Mode** (1m execution inside 15m macro zones)                  | §7.4                 |
| **Ghost Signal Elimination** (mitigated structures/zone tracking)         | §7.12, §7.13, §7.19  |
| **News Embargo Filter** (±30 min around high-impact USD news)             | §7.8                 |
| **Funding Monitor** (delta-neutral arbitrage alerts)                      | §7.9                 |
| **Dynamic Macro Context** (lookahead bias elimination in backtest)        | §7.10                |
| **Timezone Sanity Check** (Docker + luxon + tzdata)                       | §7.11                |
| **Same-Candle SL/TP Resolution** (conservative lookahead fix)             | §7.15                |
| **Cooldown Logic** (only after LOSS, dynamic timeframe)                   | §7.17                |
| **Scenario 11** (Mitigation Block implementation)                         | §7.24                |
| **Database CRUD Audit**                                                   | §9.1                 |
| **Critical Anti-Patterns** (blood-signed lessons)                         | §14                  |

---

## 🎯 Strict Stop-Loss Calculation (v2026-09-20 — Safety Hardened)

**Problem**: Zone objects (OB, FVG, Breaker, Mitigation) can have arbitrary `top`/`bottom` ordering — not guaranteed `top > bottom`. Naive SL formulas fail when zone is inverted.

**Solution**: Centralized `BaseScenario.calculateLevels()` — single source of truth for all bidirectional scenarios (S1, S5, S6, S10, S11).

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

**Key invariants guaranteed:**

- **BULLISH (Long)**: `SL < Entry < TP` — always, even if `zone.top < zone.bottom`
- **BEARISH (Short)**: `SL > Entry > TP` — always, even if `zone.top < zone.bottom`
- `Decimal.min/max` handles inverted zones automatically
- **Offset floor**: `SL` always at least 0.1% from entry (prevents RiskManager division by zero)
- Used by Scenarios 1, 2, 3, 4, 5, 6, 7, 8, 10, 11 (all scenarios with zone-based entries)
- 16 dedicated tests verify geometry: 4 scenarios × 2 directions × 2 zone orientations

---

## 📰 News Filter (News Embargo) — v2026-09-12

**Problem**: High-impact USD macro news (NFP, CPI, FOMC, etc.) causes extreme volatility and spread widening. Trading during these windows produces random PnL with negative expectancy.

**Solution**: **News Embargo Filter** — blocks all trade scanning ±30 minutes around high-impact USD news.

| Component          | Detail                                                                                                          |
| ------------------ | --------------------------------------------------------------------------------------------------------------- |
| **Source**         | **FXMacroData API**: `https://api.fxmacrodata.com/v1/calendar/usd` (free, no API key, 100 req/day)              |
| **Filter**         | `event_importance === 'high'` AND `release_date_confirmed === true` (or `market_tier === 1`)                    |
| **Cache**          | In-memory array of `NewsEvent { name, timestamp }` for current week (±7 days)                                   |
| **Refresh**        | Daily at 00:00 UTC (via macro context refresher) + at startup                                                   |
| **Embargo Window** | ±30 minutes (configurable via `EMBARGO_WINDOW_MS = 30 * 60 * 1000`)                                             |
| **Check**          | In `StrategyEngine.process()` (15m candle close): `if (newsService.isNewsEmbargo(candleTimestamp)) → skip scan` |
| **Resilience**     | Network/HTTP/parse errors → empty cache + `logger.warn`, never throws (fail-open)                               |

**Telegram /status**: `📰 Next USD High-Impact News: NFP at 2026-09-15 14:00:00 UTC` or `None for today`

_Full implementation details: [AGENTS.md §7.8](AGENTS.md#78-news-filter-news-embargo--srcservicesnewsservicets)_

---

## 📊 Funding Monitor (Delta-Neutral Arbitrage) — v2026-09-16

**Problem**: Delta-neutral arbitrage positions (long spot + short perp) earn funding when rates are positive but lose money when rates turn negative. Need passive monitoring with alerts.

**Solution**: **FundingMonitorService** — independent passive service polling Bybit tickers every 30 min for funding rates.

| Component                     | Detail                                                                                                      |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------- |
| **Source**                    | Bybit V5 `getTickers({ category: 'linear' })`                                                               |
| **Poll Interval**             | 30 minutes                                                                                                  |
| **Tracked Symbols**           | `FUNDING_MONITOR_SYMBOLS` (default: `BTCUSDT,ETHUSDT,SOLUSDT`)                                              |
| **Alert Threshold**           | `FUNDING_ALERT_THRESHOLD=0.0` — rate ≤ 0 triggers alert                                                     |
| **Restore Threshold**         | `FUNDING_RESTORE_THRESHOLD=0.0001` — rate ≥ +0.01% triggers restore                                         |
| **State Tracking**            | Per-symbol `isAlerted` boolean to prevent spam                                                              |
| **Telegram Alert (Negative)** | `⚠️ [FUNDING ALERT]\nМонета: {symbol}\nСтавка: {rate}%\nРекомендуется закрыть арбитраж!`                    |
| **Telegram Alert (Restore)**  | `🟢 [FUNDING RESTORED]\nМонета: {symbol}\nСтавка: +{rate}% (APY: ~{apy}%)\nМожно снова открывать арбитраж!` |
| **Public API**                | `getCurrentRates(): Map<string, Decimal>` for `/status` command                                             |

**Integration**: Conditionally created if `ENABLE_FUNDING_MONITOR=true`, started via `fundingMonitor.start()`, graceful shutdown via `fundingMonitor.stop()`. `/status` shows funding rates.

_Full implementation details: [AGENTS.md §7.9](AGENTS.md#79-funding-monitor-delta-neutral-arbitrage--srcservicesfundingmonitorservicets)_

---

## 📈 Dynamic Macro Context in Backtester — **Lookahead Bias Elimination** — v2026-09-20

**Problem**: `initializeMacroContext()` was called once before backtest loop, loading daily levels (PDH/PDL, PWH/PWL) from the **end of history** (e.g., September 2026). During simulation of March–August 2026, the bot incorrectly used future levels — causing Scenarios 5, 7, 8, 9 to miss valid sweeps.

**Solution**: Dynamic macro context updated on-the-fly during simulation, strictly using only data available up to the current candle.

**Implementation in `runBacktestForSymbol()`**:

| Component           | Detail                                                                                         |
| ------------------- | ---------------------------------------------------------------------------------------------- |
| **Tracking**        | `currentDayUtc`, `currentWeekUtc`, running ATH/ATL                                             |
| **Daily Update**    | On new day (00:00 UTC): PDH/PDL from yesterday's **closed** candles (`candlesLtf.slice(0, i)`) |
| **Weekly Update**   | On Monday: PWH/PWL from last 7 days of **closed** candles                                      |
| **Atomic Update**   | `recognizer.setMacroContext(symbol, {...})` — no lookahead!                                    |
| **Sliding Windows** | 96 candles (15m) = 24h for daily; 96×7 = 1 week for weekly                                     |

**Key Changes**: Removed all `initializeMacroContext()` calls before backtest loop; Added `PatternRecognizer.setMacroContext()` / `getMacroContext()` for atomic cache updates; Strict causality using only data before current candle; Per-symbol scenarios now respected in backtester; Full rejection stats logged.

_Full implementation details: [AGENTS.md §7.10](AGENTS.md#710-dynamic-macro-context-in-backtester--lookahead-bias-elimination--srcbacktestrunts--new-v2026-09-20)_

---

## 🕐 Timezone Sanity Check (Docker + luxon) — v2026-09-22

**Problem**: luxon's `setZone('America/New_York')` silently falls back to UTC in Docker Alpine containers because the base image lacks the IANA timezone database (`tzdata`). This caused killzone checks to fail at 11:15 UTC (07:15 NY) — the bot saw `hour=11` instead of `hour=7` and rejected valid NY session trades.

**Solution**: Two-layer fix at DevOps + Code level:

| Layer                           | Fix                                                                    | Why                                                                                                 |
| ------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| **DevOps (Dockerfile)**         | `RUN apk add --no-cache tzdata` in runner stage                        | Installs full IANA tz database; luxon can now resolve `America/New_York` with correct DST (EDT/EST) |
| **Code (patternRecognizer.ts)** | `DateTime.fromMillis(ts, { zone: 'utc' }).setZone('America/New_York')` | Explicit UTC → NY conversion; fails fast if tzdata missing                                          |

**Timezone Sanity Check (Startup Log)** — `src/index.ts`:

```typescript
const nowMs = Date.now();
const utcTime = DateTime.fromMillis(nowMs)
  .toUTC()
  .toFormat("yyyy-MM-dd HH:mm:ss");
const nyTime = DateTime.fromMillis(nowMs).setZone("America/New_York");
const nyTimeStr = nyTime.toFormat("yyyy-MM-dd HH:mm:ss ZZZZ");
logger.info(
  `[Timezone Sanity Check] Server UTC: ${utcTime} | Wall Street (NY): ${nyTimeStr} | NY Hour: ${nyTime.hour}`,
);
```

**Example output**:

```
[Timezone Sanity Check] Server UTC: 2026-09-22 21:30:00 | Wall Street (NY): 2026-09-22 17:30:00 EDT | NY Hour: 17
```

**Critical**: Alpine base images lack `tzdata` by default. Always install `tzdata` when using luxon with named IANA zones in Docker.

_Full implementation details: [AGENTS.md §7.11](AGENTS.md#711-timezone-sanity-check-docker--luxon--new-v2026-09-22)_

---

## 🎯 Scenario 11 — Mitigation Block — Full Implementation Details — v2026-09-21

**File**: `src/engine/scenarios/Scenario11_MitigationBlock.ts`

**Core Logic**: Mitigation Block is a reversal pattern that forms after a Failed Swing (SMS):

1. Price attempts a higher high (bearish SMS) / lower low (bullish SMS) but fails
2. Price reverses with a CHoCH in opposite direction (≥1.5 ATR displacement)
3. The Order Block that formed the failed swing extreme becomes the Mitigation Block
4. Trade triggers on retest of this MB by current 15m candle

---

## 🧠 Mitigated Structures (Ghost Signal Elimination) — v2026-09-24

**Problem**: Scenario 6 (SMS) was generating duplicate entries on the same CHoCH structure. After a trade closed, the CHoCH structure that triggered the entry was NOT marked as "used". When a new killzone arrived, the bot re-detected the same old CHoCH and entered again — same price, 5 hours apart.

**Solution**: **mitigatedStructures** tracking — structures (SMS, CHoCH, BOS) that have been traded and should never be re-used.

| Component              | Implementation                                                                                             |
| ---------------------- | ---------------------------------------------------------------------------------------------------------- |
| **BacktestState**      | Added `mitigatedStructures: MitigatedStructure[]`                                                          |
| **MitigatedStructure** | `{ type: 'SMS' \| 'CHoCH' \| 'BOS', timestamp: number, price: string, direction: 'BULLISH' \| 'BEARISH' }` |
| **On trade close**     | Trigger structure (CHoCH/SMS) timestamp added to `mitigatedStructures`                                     |
| **ScenarioRouter**     | Filters `patternData.structures` via `filterMitigatedStructures()`                                         |
| **Scenarios 6 & 11**   | Call `setStructureDetails()` with trigger CHoCH                                                            |

**Result**: Scenario 6 on ETHUSDT — the duplicate 06:30/11:30 entries at same price are eliminated. The CHoCH is marked as "used" after first trade.

_Note v2026-10-05_: In Scenario 12 (Sniper Touch), the `isMitigated` check now uses only `timestamp` (not `direction`) because when structures are burned via `PendingTradeManager`, the `direction` field may be undefined. Timestamp alone is sufficient since candle timestamps are unique.

_Full implementation details: [AGENTS.md §7.12, §7.13](AGENTS.md#712-mitigated-structures-ghost-signal-elimination--new-v2026-09-24)_

---

## ⚡ Same-Candle SL/TP Resolution (Lookahead Bias Fix) — v2026-09-24

**Problem**: In `checkAndCloseTrade()`, if a 15m candle's wick pierced BOTH SL and TP, the old code checked TP first → counted as WIN. This is lookahead bias — in reality, the SL was hit first (wick down), then price reversed to TP.

**Fix** (`checkAndCloseTrade` in `executionSimulator.ts`):

```typescript
const hitSL = isLong ? low.lte(trade.slPrice) : high.gte(trade.slPrice);
const hitTP = isLong ? high.gte(trade.tpPrice) : low.lte(trade.tpPrice);
if (hitSL) {
  exitPrice = trade.slPrice;
  closedBy = "SL";
} else if (hitTP) {
  exitPrice = trade.tpPrice;
  closedBy = "TP";
}
if (hitSL && hitTP) closedBy = "BOTH";
```

**Rule**: On same-candle SL+TP hit → ALWAYS treat as LOSS (conservative). This eliminates the "20 wins in a row every 15 min" artifact.

_Full implementation details: [AGENTS.md §7.15](AGENTS.md#715-same-candle-sltp-resolution-lookahead-bias-fix--new-v2026-09-24)_

---

## 🔥 Mitigated Zones Fix (Zone Re-entry Bug) — v2026-09-24

**Problem**: `mitigatedZones` was only updated on trade CLOSE. Bot would enter, close, then re-enter same zone because the zone wasn't "burned" until after close.

**Fix** (`openTrade` in `executionSimulator.ts`):

```typescript
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

_Full implementation details: [AGENTS.md §7.16](AGENTS.md#716-mitigated-zones-fix-zone-re-entry-bug--new-v2026-09-24)_

---

## 🛡 Cooldown Logic Fix — v2026-09-24 (Updated v2026-09-27: Dynamic Timeframe Support, **v2026-10-10: Reconciliation Cooldown**)

**Problem**: Cooldown (4h) was applied after ALL trades (wins and losses), blocking valid trend continuation. Also, the cooldown was hardcoded to 15-minute timeframe (`16 * 15 * 60 * 1000`), breaking when LTF_TIMEFRAME changed.

**Fix**: Cooldown ONLY after LOSS (revenge trading protection). WIN trades have NO cooldown. Cooldown duration is now fully dynamic: `COOLDOWN_CANDLES × LTF_TIMEFRAME` minutes. **Additionally, cooldown is now triggered not only on WS position close but also when a trade is closed via ReconciliationLoop (`reconcile()` / `reconcileWithTrade()`) with a negative PnL.**

```typescript
// executionSimulator.ts (backtest)
const ltfMinutes = Number(config.ltfTimeframe);
const cooldownMs = config.cooldownCandles * ltfMinutes * 60 * 1000;
cooldownUntil: netPnl.lt(0) ? candle.timestamp + cooldownMs : 0,

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

**Rule**: Cooldown = `COOLDOWN_CANDLES` candles (default 16) ONLY after LOSS. WIN = no cooldown, ride the trend.
**Examples**: `LTF=15` → 4h; `LTF=5` → 1h 20m; `LTF=60` → 16h

_Full implementation details: [AGENTS.md §7.17](AGENTS.md#717-cooldown-logic-fix--new-v2026-09-24-updated-v2026-09-27-dynamic-timeframe-support)_

---

## 📈 Backtest Report Enhancements — v2026-09-24

Added two new sections to backtest report (`reporter.ts`):

### 🗓️ TRADE TIMELINE (Last 30 Days) [Timezone: UTC]

Daily calendar with UTC timestamps:

```
[2026-09-04] ✅ 10 trades | Daily PnL: +$4138.13
  ↳ 07:45:00 UTC - Scenario 6 (WIN: +$60.00)
  ↳ 08:30:00 UTC - Scenario 6 (WIN: +$67.49)
```

### 🔍 DETAILED RECENT TRADES (Last 5 trades)

Full details with exact UTC timestamps:

```
↳ ETHUSDT | Scenario 6 (SMS) | WIN
   Entry: 2026-05-23 06:30:00 UTC | Exit: 2026-05-23 06:45:00 UTC
   Entry: 2128.21 | SL: 2135.81 | TP: 2105.42 | Qty: 2.63
   PnL: +$53.83 (+0.96%) | Fees: $6.12
```

### ⏳ DRY SPELLS

Max consecutive days without trades, periods >3/5/7 days.

All timestamps in **UTC** for cross-referencing with live logs.

_Full implementation details: [AGENTS.md §7.18](AGENTS.md#718-backtest-report-enhancements--new-v2026-09-24)_

---

## 🚀 Quick Start

### Prerequisites

- Node.js **26.x** (LTS)
- Bybit API Key/Secret (Demo or Mainnet)
- Supabase PostgreSQL database
- Telegram Bot Token + Chat ID

#### Getting Telegram Credentials

1. **Bot Token**: Message `@BotFather` on Telegram → `/newbot` → follow instructions → copy token
2. **Chat ID**: Message `@userinfobot` or `@RawDataBot` → copy your numeric `id`
3. Add both to `.env`:
   ```bash
   TELEGRAM_BOT_TOKEN=123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ
   TELEGRAM_CHAT_ID=123456789
   ```

### Understanding Trading Modes: DEMO_TRADING vs TESTNET

| Mode             | `DEMO_TRADING` | `TESTNET`         | Use Case                                                                                              |
| ---------------- | -------------- | ----------------- | ----------------------------------------------------------------------------------------------------- |
| **Demo Trading** | `true`         | `false` (ignored) | **Production-like** — real market data, virtual balance, no real money. Recommended for live testing. |
| **Testnet**      | `false`        | `true`            | Legacy Bybit testnet — separate environment, may have different liquidity.                            |
| **Mainnet**      | `false`        | `false`           | **Real money** — only when you're confident.                                                          |

> ⚠️ **Critical**: `DEMO_TRADING=true` forces `TESTNET=false`. They cannot both be true.
>
> - **Demo Trading** uses your mainnet API keys but routes to Bybit's demo environment (virtual funds, real market data).
> - **Testnet** requires separate testnet API keys from `testnet.bybit.com`.

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

### Docker (Production) — Stateless Architecture

This bot is **fully stateless** — no local database, no persistent volumes. All state lives in **Supabase (PostgreSQL)**.

```bash
# Build image (~85 MB final, multi-stage)
docker build -t smc-bot .

# Run with .env (loads all environment variables)
docker run -d \
  --name smc-bot \
  --restart unless-stopped \
  --env-file .env \
  -p 3000:3000 \
  smc-bot

# Or use docker-compose (recommended)
docker compose up -d
```

**Why no volumes?**

- Database = Supabase (external, managed PostgreSQL)
- Logs = stdout/stderr (captured by Docker/Render)
- Config = `.env` file (mounted via `--env-file` or Render dashboard)
- Backups = sent to Telegram (no local disk needed)

---

## ⚙️ Environment Variables

| Variable                           | Required |          Default          | Description                                                                                                                            |
| ---------------------------------- | :------: | :-----------------------: | -------------------------------------------------------------------------------------------------------------------------------------- |
| **BYBIT_API_KEY**                  |    ✅    |             —             | Bybit API Key                                                                                                                          |
| **BYBIT_API_SECRET**               |    ✅    |             —             | Bybit API Secret                                                                                                                       |
| **SYMBOLS**                        |    ✅    |             —             | Comma-separated: `BTCUSDT,ETHUSDT,SOLUSDT`                                                                                             |
| **DATABASE_URL**                   |    ✅    |             —             | Supabase Direct Connection string                                                                                                      |
| **TELEGRAM_BOT_TOKEN**             |    ✅    |             —             | BotFather token                                                                                                                        |
| **TELEGRAM_CHAT_ID**               |    ✅    |             —             | Your numeric chat ID (security)                                                                                                        |
| **DEMO_TRADING**                   |          |          `true`           | `true` = Demo, `false` = Mainnet                                                                                                       |
| **TESTNET**                        |          |          `false`          | Ignored if `DEMO_TRADING=true`                                                                                                         |
| **RISK_PERCENT**                   |          |            `2`            | Base risk per trade (%)                                                                                                                |
| **REDUCED_RISK_PERCENT**           |          |            `1`            | Risk after 3 consecutive losses (%)                                                                                                    |
| **LEVERAGE**                       |          |           `10`            | Isolated margin leverage                                                                                                               |
| **AUTO_TRADING**                   |          |          `false`          | `true` = auto-execute, `false` = manual approval                                                                                       |
| **TRADE_APPROVAL_TIMEOUT_MINUTES** |          |            `5`            | Approval window for manual trades                                                                                                      |
| **HISTORY_CANDLES**                |          |           `200`           | 15m/4H history (max 1000)                                                                                                              |
| **MACRO_CANDLES**                  |          |          `1000`           | 1W/1D macro context (max 1000)                                                                                                         |
| **LTF_TIMEFRAME**                  |          |           `15`            | Lower timeframe (15m)                                                                                                                  |
| **HTF_TIMEFRAME**                  |          |           `240`           | Higher timeframe (4H)                                                                                                                  |
| **ENABLE_LIVE_TEST_ORDERS**        |          |          `false`          | Enable `/test_live_order` (real Demo orders)                                                                                           |
| **ACTIVE_SCENARIOS**               |          |          `1-11`           | Comma-separated: `1,2,3,5,7`                                                                                                           |
| **LOG_LEVEL**                      |          |          `info`           | `debug`, `info`, `warn`, `error`                                                                                                       |
| **BACKUP_PASSWORD**                |          |             —             | AES-256-CBC encryption password for backups                                                                                            |
| **ENABLE_FUNDING_MONITOR**         |          |          `false`          | Enable funding rate monitoring                                                                                                         |
| **FUNDING_MONITOR_SYMBOLS**        |          | `BTCUSDT,ETHUSDT,SOLUSDT` | Symbols to monitor for funding rates                                                                                                   |
| **FUNDING_ALERT_THRESHOLD**        |          |           `0.0`           | Alert when funding rate ≤ this value                                                                                                   |
| **FUNDING_RESTORE_THRESHOLD**      |          |         `0.0001`          | Restore alert when funding rate ≥ this value                                                                                           |
| **SCENARIOS\_<SYMBOL>**            |          |             —             | Per-symbol active scenarios (e.g., `SCENARIOS_BTCUSDT=1,5,6`). Overrides `ACTIVE_SCENARIOS` for that symbol.                           |
| **COOLDOWN_CANDLES**               |          |           `16`            | Cooldown after SL hit (in LTF candles). Duration = COOLDOWN_CANDLES × LTF_TIMEFRAME minutes. Default 16 = 4h for 15m.                  |
| **SMC_SL_ATR_OFFSET**              |          |           `0.5`           | ATR multiplier for SL offset (default 0.5)                                                                                             |
| **SMC_DISPLACEMENT_MULTIPLIER**    |          |           `1.5`           | Displacement threshold in ATR (default 1.5)                                                                                            |
| **SMART_ENTRY_THRESHOLD_PCT**      |          |          `0.15`           | Market vs Limit threshold in % (default 0.15 = 0.15%)                                                                                  |
| **LIMIT_EXPIRATION_CANDLES**       |          |            `6`            | Limit order lifetime in LTF candles (default 6 = 1.5h for 15m)                                                                         |
| **ENABLE_SNIPER_MODE**             |          |          `false`          | Enable V5 Sniper Mode (1m execution inside 15m zones)                                                                                  |
| **BACKTEST_DAYS**                  |          |           `60`            | History depth for 1m candles in backtest (Sniper Mode)                                                                                 |
| **SNIPER_DISPLACEMENT_MULTIPLIER** |          |           `1.5`           | Displacement threshold in ATR for 1m CHoCH detection (Sniper Mode). `1.5` = 1.5×ATR                                                    |
| **DATA_DIR**                       |          |          `data`           | Local data directory for CSV backtest files                                                                                            |
| **MAX_WORKING_CAPITAL**            |          |            `0`            | Strategy capacity limit in USDT. 0 = unlimited. If balance > cap, risk calc uses cap. Drawdown guard uses capped balance.              |
| **USE_LOCAL_CACHE_ONLY**           |          |          `false`          | Offline backtest mode. `true` = load strictly from local `.json` cache files (no Bybit API calls). For CI/CD and dev without API keys. |
| **ENABLE_HEALTHCHECK_SERVER**      |          |          `false`          | Enable Express health check server for cloud platforms (e.g., Render.com). Default `false` for security (Secure Mode). **Required `true` on Render.com.** |

---

---

## 🎯 Per-Symbol Scenario Configuration (Asset-Specific DNA)

Different trading pairs have different market structures ("DNA") and may require different scenario combinations. The bot supports per-symbol scenario overrides:

```bash
# Global default (applies to all symbols without override)
ACTIVE_SCENARIOS=1,2,3,4,5,6,7,8,9,10,11

# BTC-specific: Only HTF Liquidity Sweep (5), HTF Continuation (1), SMS (6)
SCENARIOS_BTCUSDT=1,5,6

# ETH-specific: FVG Fill (2), IDM (3), Mitigation Chain (4)
SCENARIOS_ETHUSDT=2,3,4

# SOL-specific: HTF Liquidity Sweep (5), SMS (6), AMD (7), Breaker Block (10)
SCENARIOS_SOLUSDT=5,6,7,10
```

**How it works:**

- If `SCENARIOS_<SYMBOL>` is set, that symbol uses **only** those scenarios
- If not set, the symbol falls back to `ACTIVE_SCENARIOS`
- The `ScenarioRouter` for each symbol is instantiated with its specific active scenarios
- Allows fine-tuning strategies per asset's market character

---

## ⚙️ Ready-to-Use Configuration Presets

### 🛡️ V4 Classic SMC (Heavy Tank) — 15m/4H Execution

**Philosophy**: High win-rate, fewer trades, institutional SMC on 15m closes. Best for stable trending markets.

**File: `.env.subaru`** (for `db-subaru` + `bot-subaru` via docker-compose)

```bash
# --- Bybit API ---
BYBIT_API_KEY=your_bybit_api_key_here
BYBIT_API_SECRET=your_bybit_api_secret_here

# Database (read by postgres:15-alpine directly)
POSTGRES_USER=postgres
POSTGRES_PASSWORD=SubaruSecurePass123
POSTGRES_DB=smc_subaru
DATABASE_URL=postgresql://postgres:SubaruSecurePass123@db-subaru:5432/smc_subaru

# --- Telegram ---
TELEGRAM_BOT_TOKEN=your_telegram_bot_token_here
TELEGRAM_CHAT_ID=your_numeric_chat_id_here

# --- Trading Mode ---
DEMO_TRADING=true
TESTNET=false

# Core
ENABLE_SNIPER_MODE=false
BACKTEST_DAYS=60
SMART_ENTRY_THRESHOLD_PCT=0.15
LIMIT_EXPIRATION_CANDLES=6
SMC_SL_ATR_OFFSET=0.5
SMC_DISPLACEMENT_MULTIPLIER=1.5
SNIPER_DISPLACEMENT_MULTIPLIER=1.5

# Strategy Capacity Limit
MAX_WORKING_CAPITAL=20000

# Symbols & Scenarios (per-symbol overrides)
SYMBOLS=LINKUSDT,BTCUSDT,SOLUSDT,AVAXUSDT,NEARUSDT
ACTIVE_SCENARIOS=1
SCENARIOS_LINKUSDT=1,5
SCENARIOS_BTCUSDT=1,5
SCENARIOS_SOLUSDT=1,5
SCENARIOS_AVAXUSDT=1
SCENARIOS_NEARUSDT=1

# Funding Monitor
ENABLE_FUNDING_MONITOR=true
FUNDING_MONITOR_SYMBOLS=BTCUSDT,ETHUSDT,SOLUSDT,AVAXUSDT,SUIUSDT,NEARUSDT
FUNDING_ALERT_THRESHOLD=0.0
FUNDING_RESTORE_THRESHOLD=0.00015

# Trading Settings
RISK_PERCENT=2
REDUCED_RISK_PERCENT=1
LEVERAGE=10
AUTO_TRADING=false
TRADE_APPROVAL_TIMEOUT_MINUTES=5
ENABLE_LIVE_TEST_ORDERS=false

# Timeframes (V4 Classic: 15m / 4H)
LTF_TIMEFRAME=15
HTF_TIMEFRAME=240
HISTORY_CANDLES=200
MACRO_CANDLES=1000

# Risk Management
COOLDOWN_CANDLES=16

# Logging & Data
LOG_LEVEL=info
DATA_DIR=data
USE_LOCAL_CACHE_ONLY=true

# Health Check
ENABLE_HEALTHCHECK_SERVER=false

# Backup
BACKUP_PASSWORD=your_backup_encryption_password_here

# --- Local CSV Backtest (optional) ---
# Раскомментируй для прогона локального CSV бэктеста конкретного актива:
# BACKTEST_CSV_PATH=./data/csv/EURUSD_15m.csv
```

| Aspect              | Setting                           | Rationale                                  |
| ------------------- | --------------------------------- | ------------------------------------------ |
| **Timeframes**      | 15m / 4H                          | Classic SMC timeframe                      |
| **Scenarios**       | 1 (global), 1,5 per major symbols | HTF Continuation + HTF Sweep only          |
| **Entry**           | 15m close                         | Classic SMC execution                      |
| **Funding Monitor** | Enabled                           | Tracks funding for delta-neutral awareness |
| **Win Rate**        | ~70-80%                           | Fewer, higher-quality setups               |

---

### 🎯 V5 Sniper Touch (1m Execution) — Jewel Precision

**Philosophy**: Surgical entries inside macro zones. Lower win-rate but superior R:R. Best for ranging/choppy markets.

**File: `.env.emilia`** (for `db-emilia` + `bot-emilia` via docker-compose)

```bash
# --- Bybit API ---
BYBIT_API_KEY=your_bybit_api_key_here
BYBIT_API_SECRET=your_bybit_api_secret_here

# Database (read by postgres:15-alpine directly)
POSTGRES_USER=postgres
POSTGRES_PASSWORD=EmiliaSecurePass123
POSTGRES_DB=smc_emilia
DATABASE_URL=postgresql://postgres:EmiliaSecurePass123@db-emilia:5432/smc_emilia

# --- Telegram ---
TELEGRAM_BOT_TOKEN=your_telegram_bot_token_here
TELEGRAM_CHAT_ID=your_numeric_chat_id_here

# --- Trading Mode ---
DEMO_TRADING=true
TESTNET=false

# Core
ENABLE_SNIPER_MODE=true
BACKTEST_DAYS=60
SMART_ENTRY_THRESHOLD_PCT=0.15
LIMIT_EXPIRATION_CANDLES=6
SMC_SL_ATR_OFFSET=0.5
SMC_DISPLACEMENT_MULTIPLIER=1.5
SNIPER_DISPLACEMENT_MULTIPLIER=1.5

# Strategy Capacity Limit
MAX_WORKING_CAPITAL=3000

# Symbols & Scenarios (Sniper uses ONLY scenario 12)
SYMBOLS=SOLUSDT,AVAXUSDT
ACTIVE_SCENARIOS=12
SCENARIOS_SOLUSDT=12
SCENARIOS_AVAXUSDT=12

# Funding Monitor DISABLED for V5
ENABLE_FUNDING_MONITOR=false

# Trading Settings
RISK_PERCENT=2
REDUCED_RISK_PERCENT=1
LEVERAGE=10
AUTO_TRADING=false
TRADE_APPROVAL_TIMEOUT_MINUTES=5
ENABLE_LIVE_TEST_ORDERS=false

# Timeframes (V5 Sniper: 1m entry / 15m radar / 4H macro)
LTF_TIMEFRAME=15
HTF_TIMEFRAME=240
HISTORY_CANDLES=300
MACRO_CANDLES=1000

# Risk Management
COOLDOWN_CANDLES=16

# Logging & Data
LOG_LEVEL=info
DATA_DIR=data
USE_LOCAL_CACHE_ONLY=true

# Health Check
ENABLE_HEALTHCHECK_SERVER=false

# Backup
BACKUP_PASSWORD=your_backup_encryption_password_here
```

| Aspect         | Setting                               | Rationale                  |
| -------------- | ------------------------------------- | -------------------------- |
| **Timeframes** | 1m (entry) / 15m (radar) / 4H (macro) | Two-loop architecture      |
| **Scenario**   | 12 only (Sniper Touch)                | Specialized 1m macro touch |
| **Entry**      | 1m CHoCH inside macro zone            | Jewel precision            |
| **Symbols**    | SOLUSDT, AVAXUSDT                     | Focused 2-coin portfolio   |
| **Filters**    | Killzone + Sweep + CHoCH + OB         | Institutional grade        |

---

### ⚠️ Critical: Running Both Simultaneously

**V4 and V5 CANNOT run on the same process** — they share the `IN_TRADE` state machine. To run both:

| Component | V4 Instance        | V5 Instance        |
| --------- | ------------------ | ------------------ |
| Process   | Separate Node.js   | Separate Node.js   |
| Database  | Separate Supabase  | Separate Supabase  |
| Telegram  | Separate bot token | Separate bot token |
| Bybit     | Sub-account A      | Sub-account B      |
| WS        | 15m, 240m          | 1m, 15m, 240m      |

Deploy as two separate Render services with different `.env` files pointing to the same Docker image.

---

## 🐳 Docker Management Commands

### Single Container (Development / Production)

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
```

**docker-compose.yml** (single service with resource limits and log rotation):

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
          cpus: "0.5"
          memory: 512M
```

**Log Rotation**: Each service in docker-compose.yml **MUST** include a `logging` block with `driver: "json-file"` and options `max-size: "50m"`, `max-file: "3"`. This prevents "No space left on device" errors by capping log files at 50 MB each, keeping only the 3 most recent (total 150 MB per service). Server can run for years without manual log cleanup.

- **No volumes** — fully stateless (Supabase for persistence)
- **Port 3000** — health check (`GET /health`) for Render/load balancer
- **stop_grace_period: 30s** — matches `SIGTERM` handler in `index.ts`
- **Resource limits**: 0.5 CPU / 512MB — fits Oracle Cloud Free Tier (ARM) or Render free tier
- **Single `.env` file** with all configuration

```bash
# ─── Logs ───
docker logs -f smc-bot                   # Follow logs
docker logs --tail 100 smc-bot           # Last 100 lines
docker logs --since 1h smc-bot           # Last hour

# ─── Lifecycle ───
docker stop smc-bot                      # Graceful stop (30s SIGTERM)
docker start smc-bot                     # Start existing
docker restart smc-bot                   # Restart
docker rm -f smc-bot                     # Force remove

# ─── Debug ───
docker exec -it smc-bot sh               # Shell into container
docker inspect smc-bot                   # Container details
docker stats smc-bot                     # Resource usage
```

---

## 📊 Backup CSV Export (Updated v2026-10-01)

The `/backup` command now exports **22 columns** (previously 19) including new fields:

| Column             | Description                                                                                                                                           |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `order_type`       | `Market` or `Limit`                                                                                                                                   |
| `limit_price`      | Limit price for Limit orders (null for Market)                                                                                                        |
| `management_state` | JSON string of adaptive fractioning state (e.g., `{"milestone1Triggered":true,"milestone2Triggered":false,"initialTotalR":"5.2","initialQty":"0.1"}`) |

**CSV Export Process**:

1. Bot queries `SELECT * FROM trades` (all **22 columns** including new fields)
2. Converts to CSV with headers (now includes `order_type`, `limit_price`, `management_state`)
3. `management_state` JSONB serialized via `JSON.stringify()` and CSV-escaped
4. Gzips the CSV in memory
5. Encrypts with AES-256-CBC (if `BACKUP_PASSWORD` set)
6. Sends via **native `fetch` + `Blob` + `FormData`** to `api.telegram.org/bot<token>/sendDocument`
7. **No `fs.writeFileSync`, no local files, no Telegraf `sendDocument` buffer bug**

---

## 🔐 Backup Decryption

Backup files are encrypted with AES-256-CBC (IV prepended, gzipped before encryption). The Node.js crypto format is not compatible with the standard `openssl` CLI tool.

**Use the provided decrypt script:**

```bash
# Decrypt backup file (replace with actual password and filename)
npm run decrypt ./trades_backup_2026-09-16_14-30-00.csv.enc YOUR_BACKUP_PASSWORD
```

This will create a `trades_backup_2026-09-16_14-30-00.csv` file in the same directory.

> **Note**: The backup password is set via the `BACKUP_PASSWORD` environment variable. The encrypted file has a `.csv.enc` extension and includes a human-readable date in the filename (e.g., `trades_backup_2026-09-16_14-30-00.csv.enc`).

---

## 📱 Telegram Commands — Detailed Reference

| Command            | Description                                                                                                                                                                                          | Auth Required |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| `/status`          | **Live X-Ray** per engine: Live Price, Last Candle, 4H Trend, Zones in Memory, Nearest Macro %dist, State. Also shows next high-impact USD news and funding rates.                                   | ✅            |
| `/backup`          | Full DB dump (all **22** trades columns) → gzip → Telegram via `fetch`+Blob (no disk I/O, no `fs` usage). Encrypted with AES-256-CBC if `BACKUP_PASSWORD` set.                                       | ✅            |
| `/test_signal`     | **Dry-run** — creates a fake setup (BTCUSDT, entry 45000, SL 44000, TP 48000) → Inline Approve/Reject buttons → logs `✅ Test trade approved (DRY RUN)`. No real order placed.                       | ✅            |
| `/test_live_order` | **E2E Live Demo** — places REAL order on Bybit Demo when approved. Requires `ENABLE_LIVE_TEST_ORDERS=true`. Uses real balance, real position sizing via RiskManager. Full Bybit API response logged. | ✅            |
| `/test_db`         | Integration test: INSERT/SELECT/DELETE with Decimal zoneDetails. Verifies database connectivity and NUMERIC(24,8) precision.                                                                         | ✅            |

> **Security**: Only `TELEGRAM_CHAT_ID` from `.env` receives responses. All other users are **silently ignored** — no errors, no visibility, no `setMyCommands` (bot invisible to strangers).

### `/status` Output Example

```
📊 SYSTEM STATUS REPORT

🔸 Symbol: BTCUSDT
📈 Live Price: 67432.5
⏱ Last Candle: 2026-09-20 14:15:00
🧭 4H Trend: BULLISH
🧱 Zones in Memory: 23
💧 Nearest Macro: 0.85%
💼 State: SCANNING

🔸 Symbol: ETHUSDT
📈 Live Price: 2654.2
⏱ Last Candle: 2026-09-20 14:15:00
🧭 4H Trend: BEARISH
🧱 Zones in Memory: 19
💧 Nearest Macro: 1.20%
💼 State: SCANNING

📰 Next USD High-Impact News: NFP at 2026-09-15 14:00:00 UTC

📊 Funding Rates:
🟢 BTC: +0.0100%
🟢 ETH: +0.0150%
🟢 SOL: +0.0200%
```

### `/test_live_order` — End-to-End Verification

This is the **ultimate integration test**:

1. Fetches last closed 15m candle price from engine
2. Calculates SL/TP (1% risk, 1:3 R:R)
3. Calls `RiskManager.calculatePosition()` with real balance
4. Queues trade in `PendingTradeManager` with `isLiveDemoTest: true`
5. You approve via ✅ button → **REAL order sent to Bybit Demo**
6. Full Bybit API response logged: `orderId`, `retCode`, `retMsg`, `ok`
7. Trade cleaned up (no DB record created)

---

## 🌐 Render Deployment (Recommended)

The bot is designed for **Render's Stateless Web Service** (free tier compatible).

### render.yaml

```yaml
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

### Render Setup Steps

1. **Create PostgreSQL Database** (Render → New → PostgreSQL)
   - Name: `smc-db`
   - Plan: Free (or Starter for production)
   - Copy **External Connection String** → `DATABASE_URL`

2. **Create Web Service** (Render → New → Web Service)
   - Connect your GitHub repo
   - Render detects `render.yaml` automatically
   - Set secrets in Environment Variables:
     - `BYBIT_API_KEY`, `BYBIT_API_SECRET` (sync: false = secret)
     - `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` (sync: false)
     - `BACKUP_PASSWORD` (optional, for encrypted backups)
     - `ENABLE_HEALTHCHECK_SERVER=true` **(REQUIRED for Render.com - enables health check HTTP server)**

3. **Deploy** — auto-deploys on push to main

### Why Render Works Perfectly

- **Stateless** — no persistent disk needed (Supabase for DB)
- **Health check** on `/health` → Render monitors liveness
- **Auto-deploy** on git push
- **Free tier**: 750 hrs/month, 512 MB RAM, 0.5 CPU
- **UTC timezone** — matches SMC killzone calculations

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
│  Evaluates 12 scenarios → filters mitigatedZones → returns      │
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
2. **ScenarioRouter** evaluates 12 scenarios against `PatternRecognizer` patterns
3. **RiskManager** calculates position size with Drawdown Guard
4. **Smart Entry Decision** — compares `idealEntry` (zone equilibrium) vs `lastCandle.close`:
   - If `|idealEntry - currentPrice| / idealEntry ≤ 0.15%` → **Market** (IOC)
   - If `|idealEntry - currentPrice| / idealEntry > 0.15%` → **Limit** (GTC) at `idealEntry`
5. **PendingTradeManager** queues for approval (or auto-executes)
6. **Slippage Guard** validates price at approval time (0.2% threshold)
7. **ExecutionEngine** places order (Market IOC or Limit GTC with TP/SL)
8. **DB** records trade with `zoneDetails` (OB/FVG/BREAKER/MITIGATION) + `orderType`
9. **WS Position/Execution** OR **ReconciliationLoop** detects close
10. **2.5s delay** → `GET /v5/position/closed-pnl` → exact PnL (fees + funding)
11. **MitigatedZone** recorded → no re-entry on same zone
12. **ReconciliationLoop** (every 10 min) cancels expired Limit orders (> 6 candles)

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
- **Strict Side Determination**: `side = idealEntry.gt(SL) ? 'Buy' : 'Sell'` — math-only, never text direction

---

## 🛡 Risk Management Rules

| Guard                | Logic                                                                                                          | Config                                        |
| -------------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| **Drawdown Guard**   | 3 consecutive losing trades → risk reduced to 1%                                                               | `RISK_PERCENT` (base), `REDUCED_RISK_PERCENT` |
| **Position Sizing**  | `qty = (balance × risk%) / SL_distance` → rounded to `qtyStep`                                                 | `LEVERAGE` (default 10x) via isolated margin  |
| **Min Order Qty**    | If `rounded_qty < minOrderQty` → **ABORT** + `[WARN]` + state→`SCANNING`                                       | Exchange `minOrderQty`                        |
| **Max Order Qty**    | If `qty > maxOrderQty` → **ABORT**                                                                             | Exchange `maxOrderQty`                        |
| **Micro-Stop Guard** | SL distance must be **> 0.1%** (prevents noise stops)                                                          | Hardcoded in `RiskManager`                    |
| **Leverage Cap**     | `maxAllowedQty = marginBuffer * leverage / entry` — caps qty if stop too tight                                 | `LEVERAGE` from config                        |
| **Capacity Limit**   | `workingBalance = min(balance, MAX_WORKING_CAPITAL)` — caps risk base                                          | `MAX_WORKING_CAPITAL` (0 = unlimited)         |
| **PnL Summation**    | Sums all `closedPnl` records where `symbol` matches & `createdTime >= trade.openedAt` for Adaptive Fractioning | `getClosedPnl` + filter/reduce logic          |

**Leverage**: Set once at bootstrap via `setupMarginAndLeverage(symbol, leverage)` (isolated margin).

### 🔒 Execution Pipeline Hardening (v2026-09-21)

All three execution pipeline fixes applied in single pass:

1. **Order Idempotency** (`bybitClient.ts:372`): `orderLinkId` now passed to `submitOrder()` — prevents duplicate orders on retry via `executeWithRetry()`.

2. **Leverage Cap** (`riskManager.ts:146-155`): `maxAllowedQty = marginBuffer * leverage / entry`. If `rawQty > maxAllowedQty`, caps it. Prevents "Insufficient Margin" when stop is very tight.

3. **No Double Rounding** (`riskManager.ts:115-116`): Removed `roundDownToStep()` for entry/SL. Now `formatPrice(input.entryPrice, tickSize)` and `formatPrice(input.stopLossRaw, tickSize)` — single precision step.

4. **TP From Scenario** (`riskManager.ts:131`): Removed internal `TAKE_PROFIT_RR_RATIO` recalculation. Takes `input.takeProfitRaw` (already calculated by `BaseScenario.calculateLevels()` with correct geometry). RiskManager only formats via `formatPrice()`.

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
# All tests (240)
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

**docker-compose.yml**: See [🐳 Docker Management Commands](#-docker-management-commands) for the full configuration with resource limits and log rotation.

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
npm test             # Jest (240 tests)
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
│   ├── scenarioRouter.ts       # 12 scenarios + mitigatedZones filter
│   ├── pendingTradeManager.ts  # Approval queue + Slippage Guard
│   └── scenarios/              # S1–S12 implementations
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
