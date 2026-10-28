<div align="center">

# 🤖 CRYPTO BOT SMC — Smart Money Concepts Trading Bot

[![Node.js](https://img.shields.io/badge/Node.js-26.x-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9+-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Bybit V5](https://img.shields.io/badge/Bybit-V5%20API-FF6B35?logo=bybit&logoColor=white)](https://bybit-exchange.github.io/docs/v5/intro)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-Supabase-4169E1?logo=postgresql&logoColor=white)](https://supabase.com/)
[![Docker](https://img.shields.io/badge/Docker-Multi--stage-2496ED?logo=docker&logoColor=white)](https://www.docker.com/)
[![Tests](https://img.shields.io/badge/Tests-853%20passing-brightgreen?logo=jest)](https://jestjs.io/)
[![Version](https://img.shields.io/badge/Version-v2026--10--28-blue)](https://github.com/)

**Enterprise-grade autonomous trading bot** implementing **Smart Money Concepts (SMC)** on Bybit V5 Linear Perpetuals.
Built for **reliability**, **observability**, and **mathematical precision** — zero `number` for money, only `decimal.js`.

> **Normative specification**: [`AGENTS.md`](AGENTS.md) is the single source of truth (60 critical invariants + consolidated anti-patterns). This README is the operator-facing overview — where the two disagree, `AGENTS.md` wins.

### Architecture Baseline — V5.1 Execution Physics

| Pillar                                 | Guarantee                                                                                                                              |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **Hybrid Smart Entry**                 | Market vs Limit is decided at the **live tick**, never pre-committed at signal time (discount-first, then 0.15% threshold).            |
| **Panic Close & Orphan Guard**         | A post-fill `db.openTrade()` failure can never orphan a live position — the exchange is flattened and verified before any state reset. |
| **Strict Mathematical Side**           | `Buy`/`Sell` is derived purely from Entry vs SL geometry, never from a `BULLISH`/`BEARISH` label.                                      |
| **Tick-Agnostic Adaptive Fractioning** | Milestones (SL→entry, partials, trailing) are evaluated on **every tick**, not only on candle close.                                   |
| **Live ↔ Backtest Parity (1:1)**       | Identical entry routing, taker/maker fees, SL-first same-candle resolution, limit expiration and fee settlement in both engines.       |

</div>

---

## 🎯 Features at a Glance

| Category                                  | Capability                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **12 SMC Scenarios**                      | HTF Continuation, FVG Fill, IDM, Mitigation Chain, HTF Liquidity Sweep, SMS, AMD, Range Deviation, Turtle Soup, Breaker Block, Mitigation Block, **Sniper Touch (1m)**. Scenario 13 (Top-Down Order Flow) is **archived** in `src/engine/scenarios/archive/` — IDs accepted are **1–12**                                                                                           |
| **🎯 V5 Sniper Mode**                     | **Single-pass 1m execution**: Scenario 12 on each 1m close runs per-CHoCH sweep pairing → CHoCH → OB-midpoint proximity → Smart Pullback entry (Market/Limit). Sweep sources: macro PDH/PDL/PWH/PWL always armed, `S12_SESSION_SWEEPS` / `S12_EQH_EQL_SWEEPS` opt-in. Entry gates: persistent 4H SMA50 trend (POI exception) + fee-aware TP distance floor (`MIN_TP_DISTANCE_PCT`) |
| **🧮 Structural Take-Profit**             | **`tpResolver.ts`**: replaces the blind `k × R` target with a structural one drawn from macro pools, swings, range boundaries and zones — bounded by `DYNAMIC_TP_MIN_RR` / `DYNAMIC_TP_MAX_RR`. Used by Scenarios 1, 5 and 12; the S13 brain modules (`htfRoadmap.ts`, `volumeExhaustion.ts`) remain in the tree with the archived scenario                                        |
| **⚡ Hybrid Smart Entry**                 | **Market vs Limit at the live tick**: a discount (price better than `idealEntry`) always forces **Market**; otherwise `SMART_ENTRY_THRESHOLD_PCT` (default 0.15%) decides Market vs Limit (GTC)                                                                                                                                                                                    |
| **🛡 Pre-flight Guards**                  | **SL breach + TP reached + 0.2% directional slippage**, validated against global tick memory immediately before submission — pre-flight SL/TP checks are unconditional, the slippage guard is Market-only                                                                                                                                                                          |
| **🚨 Panic Close & Orphan Guard**         | **Post-fill DB failure recovery**: `panicCloseOrphan()` cancels a resting Limit order, flattens any filled exposure with a reduce-only Market order and verifies flatness. `SCANNING` is only reachable once the exchange is verified flat — otherwise the engine stays `IN_TRADE` under Reconciliation supervision                                                                |
| **👻 Ghost Signal Guard**                 | **Structure mitigation**: the trigger CHoCH is burned **on trade open** in both entry paths (auto + manual); the router filters by timestamp only — no rapid-fire re-entries on the same structure                                                                                                                                                                                 |
| **⚙️ Tick-Agnostic Adaptive Fractioning** | **Position management on every tick**: Classic mode (SL→entry at 66%) vs Sniper mode (close 25% at 33%, trail SL at 66%) — with a hard profit-direction guard before any progress math                                                                                                                                                                                             |
| **🧮 Strict Mathematical Side**           | **Side determined by geometry**: `side = idealEntry.gt(SL) ? 'Buy' : 'Sell'` — eliminates text-based direction errors and invalid SL levels                                                                                                                                                                                                                                        |

---

## 📊 Legacy Backtest Benchmark (Pre-V5.1 Execution Physics)

> **⚠️ NOTE — LEGACY BENCHMARK, NOT A FORECAST.**
> These legacy results were generated prior to the V5.1 Execution Physics overhaul. Current institutional-grade simulations (with exact Bybit Taker/Maker fees, zero-latency slippage, and limit order expiration) reflect a highly pessimistic, realistic environment used for strict quantitative tuning.
>
> The table below is retained **only** as a historical reference point. It must never be quoted as expected performance, and it is not reproducible on the current simulator — the modern engine charges 0.055% taker / 0.020% maker fees, routes every entry through Hybrid Smart Entry, resolves same-candle SL+TP as a loss, expires unfilled limits, and settles fees exactly once at closure.

| Symbol      | Final Balance | Net Profit   | Trades | Win Rate   | Max DD |
| ----------- | ------------- | ------------ | ------ | ---------- | ------ |
| **BTCUSDT** | $23,490.32    | **+2,249%**  | 150    | **80.00%** | 17.82% |
| **ETHUSDT** | $11,553.88    | **+1,055%**  | 118    | **64.41%** | 41.59% |
| **SOLUSDT** | $107,584.02   | **+10,658%** | 189    | **66.14%** | 31.81% |

**Legacy aggregate** (superseded): 457 trades | Σ PnL ≈ **$141,628** | Avg Win Rate **~70%** | Max DD **< 42%**

> **Top Drivers**: SMS (S6), HTF Continuation (S1), HTF Sweep (S5)
> **Filters Working**: S2 `NoLiqCtx: 120`, S4 `NoBOS: 1,570`, S11 strict SMS = 0 noise trades
>
> **Re-baselining**: run `npm run backtest -- <SYMBOL>` on the current engine and treat the fresh report as the only valid quantitative reference. See [AGENTS.md §15](AGENTS.md) for the same legacy numbers under the same caveat.

---

## 🧭 Long-Horizon Endurance Audit — v2026-10-28

Two stress tests were run to answer the only question that matters before freezing development: **does the edge survive a regime it was not fitted on?**

| Run | Symbol   | Engine                                 | Window   | Trades (T/W/L) | WR     | Net         | PF       | Max DD     | Fees    | MAR      |
| --- | -------- | -------------------------------------- | -------- | -------------- | ------ | ----------- | -------- | ---------- | ------- | -------- |
| 1   | BTCUSDT  | S14 Trend Following (Donchian, 15m/4H) | **365d** | 88 / 31 / 57   | 35.23% | **+19.94%** | 1.20     | **19.82%** | $196.76 | **1.01** |
| 2a  | NEARUSDT | S12 Sniper (shields **1.5**)           | 180d     | 5 / 2 / 3      | 40.00% | +3.46%      | 1.67     | 5.19%      | $25.37  | 0.67     |
| 2b  | NEARUSDT | S12 Sniper (shields **1.0**)           | 180d     | 12 / 7 / 5     | 58.33% | **+22.40%** | **3.24** | **4.74%**  | $88.68  | **4.73** |

Both windows ran to completion with no data truncation (35,040 × 15m candles; 259,200 × 1m candles). Full write-up and rejection funnels: [`data/endurance_report.md`](data/endurance_report.md); artifacts in `data/endurance_run/`, `data/endurance_run_noshield/`, `data/endurance_run_override/`.

> **Scope note — which "Tank"?** The 365-day audit validated **Scenario 14 (Donchian trend)**, forced with an inline `ACTIVE_SCENARIOS=14`. The local `.env` ships `ACTIVE_SCENARIOS=15` (Volatility Squeeze) and the frozen `.env.subaru` Tank preset runs **S1 + S5** — neither of those has been through a 365-day window. Do not transfer the +19.94% figure to any other preset: "Tank" is a nickname, not an engine identity.

### Run 1 — the trend engine survives the year, in a shape nobody wants to look at

| Period                     | Return      |
| -------------------------- | ----------- |
| H1 2025-10-29 → 2026-04-28 | **−10.98%** |
| H2 2026-04-28 → 2026-10-24 | **+34.73%** |

Only **4 of 13 months were positive**; Jun +24.40%, Aug +17.95% and Sep +8.31% produced **+58.92%**, while the other ten produced **−24.52%**. Peak $1,035.48 (2026-01-05) → trough $830.29 (2026-05-27) was **141.6 days at 19.82% depth**; full recovery took **160.4 days**, and **84.3% of all trade-dates** sat below the running peak. Fees consumed **49.7%** of gross PnL ($196.76 of $396.17) — the zero-fee counterfactual is +39.62%, not +19.94%.

The previously-cited 180-day result (+38.64%, DD 9.57%, MAR 4.04) began _three days after the exact trough of that drawdown_. It was window-selected by construction, not evidence of a higher sustainable rate. The defensible annual expectation is **≈+20% with a ~20% drawdown and a ~5-month recovery**.

### Run 2 — the Sniper's +27% is a burst, not a run-rate

Same symbol, same 1m data, same window, same everything except the two P0 admission thresholds. The ladder is measured, not assumed — each row is a full 259,200-candle run:

| NEAR config (180d)                         | Net         | Trades | WR     | PF       | Max DD    |
| ------------------------------------------ | ----------- | ------ | ------ | -------- | --------- |
| Global `1.5` / `1.5` (production default)  | **+3.46%**  | 5      | 40.00% | 1.67     | 5.19%     |
| Volatility `1.0` / net-R `1.5`             | +14.87%     | 10     | 50.00% | 2.54     | 4.74%     |
| Volatility `1.0` / net-R `1.0` (committed) | **+22.40%** | 12     | 58.33% | **3.24** | **4.74%** |

`InsufficientVolatility` fell from **41.7%** of post-sweep candidates to **18.7%**, while `InsufficientNetR` stayed at **0.3–0.5%** in every configuration — the volatility gate is the binding constraint, and the net-R gate accounts for the residual $74 between rows 2 and 3. Both had to be relaxed: the volatility knob alone leaves **7.5 percentage points** on the table.

Raising both shields from 1.0 to 1.5 removed **7 trades** and **$189.32 of net profit** ($223.96 → $34.64); the removed set contained **five winners against two losers**. On NEAR the volatility gate was **anti-selective** — the pair's quiet 1m minutes were profitable, so a shield fitted on a different regime simply starved the strategy.

The opportunity set is episodic, not steady: **0 trades in May, 0 in June**, then 1 / 1 / 3 / **7** across July–October. Equity went $1,000 → **$952.55** by 2026-08-25 (the max DD) and then to $1,223.96 by 2026-10-26 — **seven of twelve trades, and essentially the entire profit, landed after 2026-10-01**. Longest dry spell: **49.6 days**.

A 60-day control run reproduces the documented baseline (**+28.49%**, 10 trades, PF 6.19, DD 2.22%), confirming the harness is deterministic — which is exactly the point: the 60-day window _was_ the cluster, compressed. Ten of the twelve 180-day trades fall inside it.

### What this changed in the repository

| Action                                                                                                      | Rationale                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MIN_VOLATILITY_FEE_RATIO_NEARUSDT=1.0` + `MIN_NET_RR_NEARUSDT=1.0` (`.env`, `.env.emilia`, `.env.example`) | Unlocks the audited NEAR configuration while the global `1.5` shields stay armed for every other symbol (APTUSDT included). Both gates had to move: volatility alone measures +14.87%, not +22.40%. Per-symbol resolution goes through `resolveSymbolConfig()`, so no other pair is affected. |
| `src/backtest/run.ts` — `for (const c of fetched1m) candles1m.push(c)`                                      | `push(...fetched1m)` spread 259,200 arguments and threw `Maximum call stack size exceeded` **after** the 1m history had already been fetched. Any Sniper window beyond ~100k 1m candles crashed.                                                                                              |
| This section + `data/endurance_report.md`                                                                   | The numbers above are the only quantitative reference the repository endorses for these two engines. Superseded figures are left in place but marked as window-selected.                                                                                                                      |

> **Standing caveat**: both engines remain **regime-dependent**. S14 needs a trending year and costs half its gross edge in fees; S12 needs volatility to pay a 0.110% round trip and can go two months without a single valid setup. Neither result should be extrapolated into a monthly return target.

---

## ⚡ Hybrid Smart Entry Architecture (Market vs Limit) — v2026-09-29

**Problem**: Entering Market orders at the close of the 15m signal candle is mathematically unprofitable in SMC. Price has already "run away", SL becomes huge, R:R breaks, and Bybit rejects TP/SL with error [10001] (TP/SL limits).

**Solution**: **Hybrid Smart Pullback Limit Orders** — bot dynamically chooses between Market and Limit (GTC) based on price deviation from ideal entry.

### Decision Logic (`src/engine/strategyEngine.ts`)

```typescript
const idealEntry = new Decimal(result.levels.entry); // Zone equilibrium (e.g., OB 0.5, FVG 0.5)
const currentPrice = new Decimal(this.getLivePrice()); // global tick memory — re-evaluated at the live tick before execution
const smartThreshold = new Decimal(config.smartEntryThresholdPct); // 0.0015 = 0.15%

const priceDiffPct = idealEntry.minus(currentPrice).div(idealEntry).abs();

// Discount Trap fix: a better-than-ideal price MUST be taken at Market. A Limit at
// idealEntry would be marketable on arrival and fill at a different price, breaking SL geometry.
const isLong = idealEntry.gt(new Decimal(result.levels.stopLoss));
const isDiscount = isLong
  ? currentPrice.lte(idealEntry)
  : currentPrice.gte(idealEntry);
const useMarketOrder = isDiscount || priceDiffPct.lte(smartThreshold);

const orderType = useMarketOrder ? "Market" : "Limit";
const limitPrice = useMarketOrder
  ? null
  : formatPrice(idealEntry, new Decimal(instrument.tickSize)); // never toFixed()
```

| Condition                                                             | Order Type       | Price        |
| --------------------------------------------------------------------- | ---------------- | ------------ |
| **Discount** — live price better than `idealEntry` (Long ≤ / Short ≥) | **Market** (IOC) | —            |
| No discount AND `\|idealEntry - livePrice\| / idealEntry ≤ 0.15%`     | **Market** (IOC) | —            |
| No discount AND `\|idealEntry - livePrice\| / idealEntry > 0.15%`     | **Limit** (GTC)  | `idealEntry` |

**Config**: `SMART_ENTRY_THRESHOLD_PCT=0.15` (in `.env`, interpreted as 0.15% → 0.0015 in code).

Both entry paths (`executeStagedEntry()` auto, `handleTradeApproval()` manual) re-evaluate this rule at the **live tick** — the signal-time value is only preliminary, never a pre-commitment.

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

```typescript
const currentPrice = this.getLivePrice(); // global tick memory, never a stale feed read
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

| Order Type | SL Breach Check  | TP Reached Check | 0.2% Slippage Guard              |
| ---------- | ---------------- | ---------------- | -------------------------------- |
| **Market** | ✅ Unconditional | ✅ Unconditional | ✅ Applied (>0.2% aborts)        |
| **Limit**  | ✅ Unconditional | ✅ Unconditional | ❌ Bypassed (waits for pullback) |

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

### Live Price Provider for Pre-flight & Slippage Guard

**Problem**: `PendingTradeManager` used the last closed 15m candle close price as "live price" for slippage guard and pre-flight checks. In volatile markets, this price can be minutes stale, causing the bot to approve setups that are already invalid.

**Solution**: `StrategyEngine.getLivePrice()` returns the **global tick memory** — `latestTickPrice`, updated at the top of `handleKline()` from every incoming WS tick, before the `confirmed` guard and before any processing:

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

**Impact**: Slippage Guard, Pre-flight Check and Adaptive Fractioning all evaluate against the freshest tick — including in Sniper Mode, where a 15m feed read could be up to 14 minutes stale.

> **Invariant 29**: `getLivePrice()` MUST NOT be coupled to a specific timeframe feed (`feedLtf`, `feed1m`). Live price is global tick memory; the pre-flight fallback uses the execution-context feed and aborts if neither is available.

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

_Update v2026-10-21_: The trigger CHoCH is now burned **immediately after the exchange confirms the fill** in both live entry paths (`executeStagedEntry()` / `handleTradeApproval()`) — before `transition(IN_TRADE)` and before the DB bookkeeping, not only on abort (`burnSetup`) or close. See the Mitigated Structures section below.

### Zero-NULL Database Guarantee for Closed Trades — v2026-10-06

**Problem**: `closeTrade` was called with NULL `pnl`/`exit_price` when exchange data was unavailable, polluting the database.

**Solution**: Comprehensive fallback logic in three locations:

1. **`onExchangePositionClosed`**: Calculates fallback PnL from trade data using the Bybit **Execution WS `execPrice`** (authoritative), falling back to the live tick only if no execution price was supplied
2. **`reconcile`**: Calculates PnL from the live tick instead of passing null
3. **`reconcileWithTrade`**: Fallback PnL calculation + resolved exit price

**Guarantee**: `closeTrade` is never called with NULL `pnl` or `exit_price` — database integrity maintained.

> **Anti-Pattern 16.2.3**: `getLivePrice()` MUST NOT be used as the exit price when a WS `execPrice` is available. After a network delay the live price has drifted away from the actual fill, which would hallucinate PnL and corrupt Adaptive Fractioning.

---

### ⚡ Post-Fill Bookkeeping & Orphan Guard

**Problem**: After `executionEngine.execute()` returned success, the engine stayed in `ENTRY_STAGED` while it waited 500 ms, fetched `getOpenPositions()` and wrote `db.openTrade()` — with an awaited Telegram notification stacked on top. Bybit can hit SL/TP inside that window, but both WS closure handlers (`handleExecutionPayload`, `handlePositionPayload`) deliberately ignore events unless the state is `IN_TRADE`. A position could therefore be closed while invisible to the bot, leaving the engine stuck until the ReconciliationLoop.

**Fix** — both entry paths (`executeStagedEntry()` auto and `handleTradeApproval()` manual) now:

1. Burn the trigger structure in memory (zero latency, Invariant 39).
2. `transition(IN_TRADE)` **immediately after the exchange confirmation** — before the 500 ms wait, `getOpenPositions()` and `db.openTrade()`.
3. Only then fetch the real `avgPrice` and persist the trade record.
4. **Never transition a second time** — a WS close event may already have reset the state to `SCANNING`, and that reset must not be clobbered.

Telegram `notifyOrderOpened` is fire-and-forget (a send failure is logged, never treated as an order failure). If `db.openTrade()` throws **after** the fill, the engine logs `CRITICAL` and invokes **`panicCloseOrphan()`**:

1. **Cancel the resting order first** (Limit only) — `getOpenOrders()` → `cancelOrder()` for a `New`/`PartiallyFilled` order.
2. **Flatten exposure** — `getOpenPositions()` → reduce-only Market order for the filled size, formatted via `formatQuantity(size, qtyStep)`.
3. **Verify flatness** — up to 3 × 500 ms polls of `getOpenPositions()`.

The engine may `burnSetup()` and return to `SCANNING` **only** when the exchange is verified flat (`true`). If flatness cannot be verified (`false`), it **remains `IN_TRADE`** — an unverified position is never abandoned by a state reset, so Reconciliation and manual supervision can still see it. Fail-fast burning is reserved for errors **before** the exchange confirms.

_See [AGENTS.md §5.12, Invariants 23 / 34 / 47 / 49](AGENTS.md)._

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

| Topic                                                                         | Section in AGENTS.md                 |
| ----------------------------------------------------------------------------- | ------------------------------------ |
| **Adaptive Fractioning** (tick-agnostic, profit-guarded management)           | §6, Invariant 41                     |
| **Hybrid Smart Entry** (Market vs Limit at the live tick)                     | §7.20                                |
| **Directional Slippage Guard** (vector, Market-only, 0.2%)                    | §4.4.3                               |
| **Strict SL Calculation** (single source of truth, inverted zone defense)     | §7.6                                 |
| **V5 Sniper Mode** (single-pass Scenario 12 on 1m closes)                     | §7.4, §7.13.2                        |
| **Ghost Signal Elimination** (mitigated structures/zone tracking)             | §7.12, §7.13, §7.19                  |
| **News Embargo Filter** (±30 min around high-impact USD news)                 | §7.8                                 |
| **Funding Monitor** (delta-neutral arbitrage alerts)                          | §7.9                                 |
| **Dynamic Macro Context** (lookahead bias elimination in backtest)            | §7.10                                |
| **Timezone Sanity Check** (Docker + luxon + tzdata)                           | §7.11                                |
| **Same-Candle SL/TP Resolution** (conservative lookahead fix)                 | §7.15                                |
| **Cooldown Logic** (only after LOSS, dynamic timeframe)                       | §7.17                                |
| **Scenario 11** (Mitigation Block implementation)                             | §8.4                                 |
| **Scenario 13** (Top-Down Order Flow Matrix + 3 Brain modules — **ARCHIVED**) | §8.6                                 |
| **Volume Baseline Causality** (SMA excludes the impulse candle)               | Invariant 56                         |
| **Bidirectional Construction** (both directions evaluated)                    | Invariant 57                         |
| **Post-Fill Bookkeeping & Panic Close** (orphan guard, verified flatness)     | §5.11, §5.12, Invariants 23/34/47/49 |
| **Partial-Fill Limit Safety** (`PartiallyFilled` never closed as CANCELLED)   | §3.4, Invariant 53                   |
| **Backtest Entry Gate** (`zoneDetails` OR `structureDetails`)                 | Invariant 48                         |
| **Database CRUD Audit**                                                       | §9.1                                 |
| **Critical Anti-Patterns** (consolidated, grouped)                            | §16                                  |

---

## 🎯 Strict Stop-Loss Calculation (v2026-09-20 — Safety Hardened)

**Problem**: Zone objects (OB, FVG, Breaker, Mitigation) can have arbitrary `top`/`bottom` ordering — not guaranteed `top > bottom`. Naive SL formulas fail when zone is inverted.

**Solution**: Centralized `BaseScenario.calculateLevels()` — single source of truth for all bidirectional scenarios (S1, S5, S6, S10, S11, S12).

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
- Used by Scenarios 1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12 (all scenarios with zone-based entries)
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

| Component                     | Detail                                                                                             |
| ----------------------------- | -------------------------------------------------------------------------------------------------- |
| **Source**                    | Bybit V5 `getTickers({ category: 'linear' })`                                                      |
| **Poll Interval**             | 30 minutes                                                                                         |
| **Tracked Symbols**           | `FUNDING_MONITOR_SYMBOLS` (default: `BTCUSDT,ETHUSDT,SOLUSDT`)                                     |
| **Alert Threshold**           | `FUNDING_ALERT_THRESHOLD_PCT=0.0` — rate ≤ 0% triggers alert                                       |
| **Restore Threshold**         | `FUNDING_RESTORE_THRESHOLD_PCT=0.015` — rate ≥ +0.015% triggers restore                            |
| **State Tracking**            | Per-symbol `isAlerted` boolean to prevent spam                                                     |
| **Telegram Alert (Negative)** | `⚠️ [FUNDING ALERT]\nCoin: {symbol}\nRate: {rate}%\nRecommend closing arbitrage!`                  |
| **Telegram Alert (Restore)**  | `🟢 [FUNDING RESTORED]\nCoin: {symbol}\nRate: +{rate}% (APY: ~{apy}%)\nArbitrage can be reopened!` |
| **Public API**                | `getCurrentRates(): Map<string, Decimal>` for `/status` command                                    |

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

## 🧠 Scenario 13 — Top-Down Order Flow Matrix — **ARCHIVED v2026-10-23**

> **⚠️ ARCHIVED — not registered, not tradeable.** The implementation moved to `src/engine/scenarios/archive/Scenario13_TopDownOrderFlow.ts` and `ScenarioRouter` no longer constructs it. `ACTIVE_SCENARIOS` / `SCENARIOS_<SYMBOL>` accept **1–12** only (`13` is dropped from per-symbol overrides and fails validation globally). The module still compiles and its Jest suite still runs (`tests/scenarios/archive/`). **Why**: the multi-timeframe cascade produced fee-dominated results at 1m granularity, so effort moved to Scenario 12 frequency — per-CHoCH sweep pairing plus opt-in sweep sources (§7.13.2). Everything below is retained as design reference. `tpResolver.ts` is **not** archived: Scenarios 1, 5 and 12 use it for structural take-profit.

**File**: `src/engine/scenarios/archive/Scenario13_TopDownOrderFlow.ts` (archived)
**Brain modules**: `src/engine/brain/htfRoadmap.ts`, `src/engine/brain/volumeExhaustion.ts`, `src/engine/tpResolver.ts`
**Runtime requirement (historical)**: `ENABLE_SNIPER_MODE=true` — the live engine only forwards 1m candles to the router under that flag, and S13 failed closed without them.

**Core premise**: no entry unless **three independent timeframes agree in a strict causal order**. S13 was the apex orchestrator — the 4H defined _where_ price is going, the 15m decided _whether_ the pullback is exhausted, and the 1m only provided the trigger and the precision stop.

| Gate                      | Timeframe | Question answered                                                                          | Rejection keys                                                                                                                                                |
| ------------------------- | --------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1. Roadmap**            | 4H        | Is there a directional bias and a structural liquidity draw?                               | `noHtfRoadmap`, `htfNeutral`                                                                                                                                  |
| **2. POI selection**      | 15m       | Which zone sits between price and the 4H target, inside the proximity band (`3 × atr15m`)? | `noPoi`                                                                                                                                                       |
| **3. Volume exhaustion**  | 15m       | Did counter-pressure decay into the touch, and did the touch print a reaction surge?       | `volumeInvalid`, `noPullbackOrigin`, `insufficientPullbackCandles`, `pullbackVolumeHeavy`, `poiViolated`, `noPoiTouch`, `noReaction`, `insufficientAsymmetry` |
| **4. Micro trigger**      | 1m        | Fresh CHoCH/BOS after the touch minute (strict causality) + precision stop                 | `noReaction`                                                                                                                                                  |
| **5. TP resolution**      | Structure | Is there a real target beyond entry that clears the `DYNAMIC_TP_MIN_RR` floor?             | `tpInvalid`                                                                                                                                                   |
| **6. Mitigation tagging** | —         | Emit `zoneDetails` + `structureDetails` so the trigger is burned on entry                  | `triggered`                                                                                                                                                   |

### The three Brain modules

| Module                               | Responsibility                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`htfRoadmap.ts`** — Module 1       | Builds the 4H dealing range, the dominant institutional bias and the primary liquidity draw. Pure read-only lens: `Decimal`-only math, no I/O, no input mutation, and **fails closed** (`isValid = false`) on degenerate data instead of fabricating a range. `NEUTRAL` bias means "no trade allowed".                                                                                                                                                                                                                                                                                                          |
| **`volumeExhaustion.ts`** — Module 2 | Answers two questions on 15m candles: _(1)_ did selling/buying pressure actually dry up during the pullback, and _(2)_ did the POI touch print an institutional volume surge? The baseline SMA ends **before** the pullback origin, so the impulse candle is excluded from the average (Invariant 56). Returns a partitioned `failureCode` so the funnel stays truthful instead of collapsing into one "not exhausted" bucket.                                                                                                                                                                                  |
| **`tpResolver.ts`** — Module 3       | Replaces the blind `k × R` target with a **structural** one. Collects candidates (macro pools, HTF/15m swings, range boundaries, session extremes, zones, the roadmap target) and picks the first that clears `DYNAMIC_TP_MIN_RR`, capped by `DYNAMIC_TP_MAX_RR`. Each candidate carries a `major` classification; with `skipMinorObstacles: true` (the archived S13 setting) a _minor_ swing inside the floor is skipped, while a **major** barrier (macro pool / HTF level) is treated as a genuine wall and blocks the candidate. Scenarios 1, 5 and 12 pass `false` — the nearest candidate is a hard wall. |

### Stop anchoring — full reaction window

The stop is derived from the **entire 1m reaction window**, including the minute that first touched the POI:

```typescript
const microExtreme = reaction.reduce(...); // min low (long) / max high (short)
```

The touch minute is part of the structure that must be violated before the reaction is invalid. Excluding it (the experimental D5 slice) pulled the stop inside the real invalidation and let a normal mitigation wick clip it. The offset floor from `BaseScenario.calculateLevels()` still applies, so the stop is never closer than **0.1%** from entry.

**Strict Sniper gate**: S13 required `ENABLE_SNIPER_MODE=true` and **>= 15** 1m candles. Without them it failed closed with the `disabled` funnel bucket — there was no blind 15m fallback (that experiment lost −$268.62 across the same portfolio in 60 days).

### Historical portfolio baseline (archived scenario)

`ENABLE_SNIPER_MODE=true`, `ACTIVE_SCENARIOS=13` (historical — `13` is no longer accepted), `DYNAMIC_TP_MIN_RR=1.5`, `DYNAMIC_TP_MAX_RR=6.0`, `SNIPER_LIMIT_EXPIRATION_CANDLES=6`, `MAX_WORKING_CAPITAL=3000`:

| Symbol       | Net         | Trades | Win rate   | PF   | Max DD     | Fees       |
| ------------ | ----------- | ------ | ---------- | ---- | ---------- | ---------- |
| BTCUSDT      | −$17.37     | 5      | 40.0%      | 0.76 | 2.61%      | $26.37     |
| SOLUSDT      | +$0.13      | 3      | 33.3%      | 1.01 | 2.60%      | $10.52     |
| NEARUSDT     | +$88.25     | 8      | 50.0%      | 2.21 | 4.45%      | $21.18     |
| **Combined** | **+$71.01** | **16** | **43.75%** | —    | **< 4.5%** | **$58.07** |

NEAR is identical to the earlier baseline (+8.83%, PF 2.21, 4.45% DD). BTC matches the documented pre-D5 −$17.37 and SOL is breakeven at +$0.13. Fee drag is 75% lower than the removed blind 15m run ($231.79).

---

## 🧠 Mitigated Structures (Ghost Signal Elimination) — v2026-09-24

**Problem**: Scenario 6 (SMS) was generating duplicate entries on the same CHoCH structure. After a trade closed, the CHoCH structure that triggered the entry was NOT marked as "used". When a new killzone arrived, the bot re-detected the same old CHoCH and entered again — same price, 5 hours apart.

**Solution**: **mitigatedStructures** tracking — structures (SMS, CHoCH, BOS) that have been traded and should never be re-used.

| Component                | Implementation                                                                                                                                                                                                                                                           |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **BacktestState**        | Added `mitigatedStructures: MitigatedStructure[]`                                                                                                                                                                                                                        |
| **MitigatedStructure**   | `{ type: 'SMS' \| 'CHoCH' \| 'BOS', timestamp: number, price: string, direction: 'BULLISH' \| 'BEARISH' }`                                                                                                                                                               |
| **On trade open (live)** | Both `executeStagedEntry()` & `handleTradeApproval()` push the trigger `structureDetails` to `mitigatedStructures` **immediately after the exchange confirms the order — before `transition(IN_TRADE)`**, the 500 ms `avgPrice` fetch and `db.openTrade()` (v2026-10-21) |
| **On trade close**       | Trigger structure (CHoCH/SMS) timestamp added to `mitigatedStructures`                                                                                                                                                                                                   |
| **ScenarioRouter**       | Filters `patternData.structures` via `filterMitigatedStructures()` — **timestamp-only match** (v2026-10-16)                                                                                                                                                              |
| **Scenarios 6 & 11**     | Call `setStructureDetails()` with trigger CHoCH                                                                                                                                                                                                                          |

**Result**: Scenario 6 on ETHUSDT — the duplicate 06:30/11:30 entries at same price are eliminated. The CHoCH is marked as "used" at entry (live) and after first trade.

_Note v2026-10-05_: In Scenario 12 (Sniper Touch), the `isMitigated` check now uses only `timestamp` (not `direction`) because when structures are burned via `PendingTradeManager`, the `direction` field may be undefined. Timestamp alone is sufficient since candle timestamps are unique.

_Note v2026-10-16_: `filterMitigatedStructures()` in `ScenarioRouter` now also matches **timestamp only** — direction/type checks removed entirely (§16.4.3). This closed the live ghost-signal gap where defaulted `'BULLISH'` direction on burned structures defeated router-level filtering. Additionally, both live entry paths now burn the trigger CHoCH **immediately after the exchange confirms the fill** — structures are no longer burned only via `burnSetup()` (abort paths) and trade close.

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
   PnL: +$53.83 | Fees: $6.12
```

### ⏳ DRY SPELLS

Max consecutive days without trades, periods >3/5/7 days.

All timestamps in **UTC** for cross-referencing with live logs.

### 📈 HTML Equity Curve (`Backtest_Chart_<SYMBOL>.html`)

Alongside the text report, the backtester writes an interactive equity curve to `data/`:

| File                                | Content                                                                                  |
| ----------------------------------- | ---------------------------------------------------------------------------------------- |
| `data/Backtest_Report_<SYMBOL>.txt` | Full text report (printed to console too)                                                |
| `data/Backtest_Chart_<SYMBOL>.html` | Self-contained Chart.js equity curve + Lightweight Charts candlestick panel (CDN-loaded) |

The chart is generated automatically on every run — no extra flag needed. It renders four series:

| Series                        | Axis  | Meaning                                                                             |
| ----------------------------- | ----- | ----------------------------------------------------------------------------------- |
| **Balance (USDT)**            | Left  | Account equity after each closed trade, sorted by exit time                         |
| **Running Peak**              | Left  | High-water mark — the maximum balance reached so far                                |
| **Closed Drawdown (%)**       | Right | Dip below the running peak as locked in by each closed trade                        |
| **Max Floating Drawdown (%)** | Right | Flat dashed reference line at the deepest intra-trade dip reported by the simulator |

Equity segments are **green** while the account is making new highs and **red** while it is below its
running peak, making drawdown duration visible at a glance. The drawdown axis is inverted (`0%` at the
top, deeper drawdowns pointing downwards) and tooltips render depths as negative percentages.

**Why two drawdown metrics?** The right axis is a closed-trade series, so it cannot show a position
that was, say, 20% underwater before recovering to a small loss. The simulator samples equity
continuously, so its `Max Drawdown` card includes those intra-trade dips. The dashed **Max Floating
Drawdown** line bridges that gap: it shows where the true "max pain" floor sits relative to the
closed-trade curve.

The X-axis is anchored to **one day before the first executed trade** (clamped to the backtest start),
so a late-starting dataset (e.g. 1m Sniper cache) does not produce a months-long flat line. All
timestamps are UTC. Artifact writing is non-fatal — a disk error logs a warning and never aborts the
backtest run.

### 🕯️ Asset Price & Trade Overlay (Lightweight Charts)

Directly below the equity curve, the same HTML file renders an interactive **TradingView Lightweight
Charts** terminal built from the exact `candlesLtf` array the simulation ran on:

| Element                 | Meaning                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------- |
| **Green / red candles** | LTF OHLC (15m by default; the panel title is derived from the actual candle spacing)                    |
| **▲ arrow (below bar)** | `Buy` entry — green                                                                                     |
| **▼ arrow (above bar)** | `Sell` entry — red                                                                                      |
| **● circle**            | Exit marker: green above the bar for a win, red below the bar for a loss, labelled `TP` / `SL` / `BOTH` |

Marker timestamps are snapped to the nearest preceding candle (Lightweight Charts requires every
marker time to exist in the series) and sorted ascending. The renderer detects the CDN version at
runtime and supports both the v5 API (`addSeries` + `createSeriesMarkers`) and the v4 API
(`addCandlestickSeries` + `setMarkers`). The equity panel and the price panel render independently —
if one CDN is unreachable, the other still draws.

_Full implementation details: [AGENTS.md §7.18.1](AGENTS.md#7181-html-equity-curve-generator--new-v2026-10-19)_

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

| Variable                            | Required |          Default          | Description                                                                                                                                                                                                                      |
| ----------------------------------- | :------: | :-----------------------: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **BYBIT_API_KEY**                   |    ✅    |             —             | Bybit API Key                                                                                                                                                                                                                    |
| **BYBIT_API_SECRET**                |    ✅    |             —             | Bybit API Secret                                                                                                                                                                                                                 |
| **SYMBOLS**                         |    ✅    |             —             | Comma-separated: `BTCUSDT,ETHUSDT,SOLUSDT`                                                                                                                                                                                       |
| **DATABASE_URL**                    |    ✅    |             —             | Supabase Direct Connection string                                                                                                                                                                                                |
| **TELEGRAM_BOT_TOKEN**              |    ✅    |             —             | BotFather token                                                                                                                                                                                                                  |
| **TELEGRAM_CHAT_ID**                |    ✅    |             —             | Your numeric chat ID (security)                                                                                                                                                                                                  |
| **DEMO_TRADING**                    |          |          `false`          | `true` = Bybit Demo environment (virtual balance, real market data). Forces `TESTNET=false`.                                                                                                                                     |
| **TESTNET**                         |          |          `true`           | `true` = Bybit testnet. `false` = mainnet (real money) unless `DEMO_TRADING=true`. Ignored when `DEMO_TRADING=true`.                                                                                                             |
| **RISK_PERCENT**                    |    ✅    |             —             | Base risk per trade (%). Required, must be > 0.                                                                                                                                                                                  |
| **REDUCED_RISK_PERCENT**            |          |            `1`            | Risk after 3 consecutive losses (%). Must be ≤ `RISK_PERCENT`.                                                                                                                                                                   |
| **LEVERAGE**                        |          |           `10`            | Isolated margin leverage                                                                                                                                                                                                         |
| **AUTO_TRADING**                    |          |          `false`          | `true` = auto-execute, `false` = manual approval                                                                                                                                                                                 |
| **TRADE_APPROVAL_TIMEOUT_MINUTES**  |          |            `5`            | Approval window for manual trades                                                                                                                                                                                                |
| **HISTORY_CANDLES**                 |          |           `200`           | 15m/4H history (max 1000)                                                                                                                                                                                                        |
| **MACRO_CANDLES**                   |          |          `1000`           | 1W/1D macro context (max 1000)                                                                                                                                                                                                   |
| **LTF_TIMEFRAME**                   |          |           `15`            | Lower timeframe (15m)                                                                                                                                                                                                            |
| **HTF_TIMEFRAME**                   |          |           `240`           | Higher timeframe (4H)                                                                                                                                                                                                            |
| **ENABLE_LIVE_TEST_ORDERS**         |          |          `false`          | Enable `/test_live_order` (real Demo orders)                                                                                                                                                                                     |
| **ACTIVE_SCENARIOS**                |          |          `1-12`           | Comma-separated scenario IDs, e.g. `1,2,3,5,7`. Unset = all 12 active. Scenario 13 is archived — `13` fails validation.                                                                                                          |
| **LOG_LEVEL**                       |          |          `info`           | `debug`, `info`, `warn`, `error`                                                                                                                                                                                                 |
| **BACKUP_PASSWORD**                 |          |             —             | AES-256-CBC encryption password for backups                                                                                                                                                                                      |
| **ENABLE_FUNDING_MONITOR**          |          |          `false`          | Enable funding rate monitoring                                                                                                                                                                                                   |
| **FUNDING_MONITOR_SYMBOLS**         |          | `BTCUSDT,ETHUSDT,SOLUSDT` | Symbols to monitor for funding rates                                                                                                                                                                                             |
| **FUNDING_ALERT_THRESHOLD_PCT**     |          |           `0.0`           | Alert when funding rate ≤ this value (%)                                                                                                                                                                                         |
| **FUNDING_RESTORE_THRESHOLD_PCT**   |          |          `0.015`          | Restore alert when funding rate ≥ this value (%)                                                                                                                                                                                 |
| **SCENARIOS\_<SYMBOL>**             |          |             —             | Per-symbol active scenarios (e.g., `SCENARIOS_BTCUSDT=1,5,6`). Overrides `ACTIVE_SCENARIOS` for that symbol.                                                                                                                     |
| **COOLDOWN_CANDLES**                |          |           `16`            | Cooldown after SL hit (in LTF candles). Duration = COOLDOWN_CANDLES × LTF_TIMEFRAME minutes. Default 16 = 4h for 15m.                                                                                                            |
| **SMC_SL_ATR_OFFSET**               |          |           `0.5`           | ATR multiplier for SL offset (default 0.5)                                                                                                                                                                                       |
| **SMC_DISPLACEMENT_MULTIPLIER**     |          |           `1.5`           | Displacement threshold in ATR (default 1.5)                                                                                                                                                                                      |
| **SMC_SWEEP_MIN_WICK_RATIO**        |          |          `0.25`           | Sweep absorption: minimum rejection wick as a share of the candle range. Must be strictly between 0 and 1. Read by **Scenario 12** and **Scenario 9** (Turtle Soup).                                                             |
| **S12_SESSION_SWEEPS**              |          |          `false`          | Opt-in S12 sweep source: the newest ASIAN session high/low becomes a sweepable level (macro PDH/PDL/PWH/PWL are always armed).                                                                                                   |
| **S12_EQH_EQL_SWEEPS**              |          |          `false`          | Opt-in S12 sweep source: 15m EQH/EQL pools become sweepable levels.                                                                                                                                                              |
| **MIN_TP_DISTANCE_PCT**             |          |         `0.0035`          | S12 fee-aware target floor: reject setups whose resolved TP sits closer than this fraction of `idealEntry` (0.0035 = 0.35%). Must be `> 0` and `< 0.1`.                                                                          |
| **MIN_NET_RR**                      |          |           `1.0`           | **S12 only.** Fee-inclusive reward:risk floor: `(target − roundTripFee) / (stop + roundTripFee) ≥ MIN_NET_RR`. Rejects with the `insufficientNetR` bucket. The verified Sniper profile uses `1.5`.                               |
| **MIN_VOLATILITY_FEE_RATIO**        |          |           `1.0`           | **S12 only.** ATR-to-fee admission multiple: requires `1m ATR% ≥ ratio × round-trip taker fee (~0.110%)`. Rejects with the `insufficientVolatility` bucket. The verified Sniper profile uses `1.5` (ATR ≥ ~0.165%).              |
| **SMART_ENTRY_THRESHOLD_PCT**       |          |          `0.15`           | Market vs Limit threshold in % (default 0.15 = 0.15%)                                                                                                                                                                            |
| **LIMIT_EXPIRATION_CANDLES**        |          |            `6`            | Limit order lifetime in LTF candles (default 6 = 1.5h for 15m)                                                                                                                                                                   |
| **SNIPER_LIMIT_EXPIRATION_CANDLES** |          |           `15`            | Limit order lifetime in **1m** candles for Sniper Mode (default 15 = 15 min). Independent of the Classic knob.                                                                                                                   |
| **ENABLE_DYNAMIC_TP**               |          |          `false`          | Structural take-profit resolution for Scenarios 1, 5 and 12 via `tpResolver.ts`. `false` = fixed `FIXED_TP_RR × R` target.                                                                                                       |
| **DYNAMIC_TP_MIN_RR**               |          |           `1.5`           | Structural target floor in R multiples                                                                                                                                                                                           |
| **DYNAMIC_TP_MAX_RR**               |          |           `6.0`           | Hard cap on structural targets in R multiples                                                                                                                                                                                    |
| **FIXED_TP_RR**                     |          |           `3.0`           | Fallback take-profit in R multiples when `ENABLE_DYNAMIC_TP=false` (or when no structural target resolves)                                                                                                                       |
| **DYNAMIC_TP_REQUIRE_TARGET**       |          |          `false`          | `true` = reject the setup when no structural target clears `DYNAMIC_TP_MIN_RR`; `false` = fall back to `FIXED_TP_RR × R`                                                                                                         |
| **PREFLIGHT_BUFFER_PCT**            |          |          `0.05`           | Pre-flight spread buffer in % (default 0.05 = 0.05%)                                                                                                                                                                             |
| **ENABLE_SNIPER_MODE**              |          |          `false`          | Enable the 1m execution path — Scenario 12 (Sniper Touch) evaluated on every 1m close (single-pass, no intermediate state)                                                                                                       |
| **BACKTEST_DAYS**                   |          |           `60`            | History window for the backtest — shared by 1m, LTF and HTF loaders                                                                                                                                                              |
| **BACKTEST_CSV_PATH**               |          |             —             | Path to local CSV file for offline backtesting                                                                                                                                                                                   |
| **SNIPER_DISPLACEMENT_MULTIPLIER**  |          |           `1.5`           | Displacement threshold in ATR for 1m CHoCH detection (Sniper Mode). `1.5` = 1.5×ATR                                                                                                                                              |
| **DATA_DIR**                        |          |          `data`           | Local data directory for CSV backtest files                                                                                                                                                                                      |
| **MAX_WORKING_CAPITAL**             |          |     unset (unlimited)     | Strategy capacity limit in USDT. When set, it must be a **positive** number — a literal `0` fails config validation. If balance > cap, position sizing, margin buffer and the Drawdown Guard all use the capped working balance. |
| **USE_LOCAL_CACHE_ONLY**            |          |          `false`          | Offline backtest mode. `true` = load strictly from local `.json` cache files (no Bybit API calls). For CI/CD and dev without API keys.                                                                                           |
| **ENABLE_HEALTHCHECK_SERVER**       |          |          `false`          | Enable Express health check server for cloud platforms (e.g., Render.com). Default `false` for security (Secure Mode). **Required `true` on Render.com.**                                                                        |
| **ALLOWED_DAYS_OF_WEEK**            |          |        `1,2,3,4,5`        | ISO weekdays in **UTC** (1=Monday ... 7=Sunday) allowed for **NEW entries**. Default blocks weekend entries. Set `1,2,3,4,5,6,7` to enable weekend entries. Entry filter only — never blocks active trade management.            |
| **ENFORCE_KILLZONES**               |          |          `true`           | `true` = entries require London/NY killzone. `false` = bypass ALL killzone gates globally (backtesting without session constraints). Entry filter only — active trade management is never affected.                              |
| **ENABLE_TRADE_NOTIFICATIONS**      |          |          `true`           | `false` = mute routine trade messages (Setup Found / Order Opened / Position Closed / Cancelled Limit). Critical `logger.error` alerts are still delivered via the global Telegram hook.                                         |

> **Removed variables**: `BREAKEVEN_RR_TRIGGER` and `TAKE_PROFIT_RR_RATIO` no longer exist. Break-even management is handled by **Adaptive Fractioning** (`src/risk/tradeManager.ts`); take-profit is always taken from `BaseScenario.calculateLevels()` geometry.

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

### Per-Symbol Calibration Overrides

Scenario selection is only half of the per-symbol story. The same `<PARAM>_<SYMBOL>` suffix also calibrates **geometry, fees and execution** for one pair without touching the global defaults.

Resolution happens exactly once per symbol through `resolveSymbolConfig()`, and the resolved config is handed to every scenario, to `tpResolver`, and to the reconciliation sweep — **live and backtest alike**. A symbol with no overrides receives the global object unchanged (same identity, zero allocation).

| Overridable parameter                      | Effect                                                         | Where it applies                             |
| ------------------------------------------ | -------------------------------------------------------------- | -------------------------------------------- |
| `SMC_SL_ATR_OFFSET_<SYMBOL>`               | ATR multiple used to offset the stop                           | All zone-based scenarios                     |
| `DYNAMIC_TP_MIN_RR_<SYMBOL>`               | Structural target floor (must be ≤ global `DYNAMIC_TP_MAX_RR`) | S1, S5, S12 (and S3/S6/S9)                   |
| `MIN_TP_DISTANCE_PCT_<SYMBOL>`             | Fee-aware target floor                                         | S12 only                                     |
| `MIN_NET_RR_<SYMBOL>`                      | Fee-inclusive net R:R floor                                    | S12 only                                     |
| `MIN_VOLATILITY_FEE_RATIO_<SYMBOL>`        | ATR-to-fee admission multiple                                  | S12 only                                     |
| `SMC_SWEEP_MIN_WICK_RATIO_<SYMBOL>`        | Sweep absorption floor                                         | S12, S9                                      |
| `SNIPER_LIMIT_EXPIRATION_CANDLES_<SYMBOL>` | Limit lifetime in 1m candles                                   | Sniper Mode (live reconciliation + backtest) |

**Not overridable per symbol**: `DYNAMIC_TP_MAX_RR` is global only — `loadConfig()` therefore validates every per-symbol floor against the global ceiling at parse time, so a symbol can never be configured with floor > cap.

**Silent-ignore hazard**: overrides are matched against the `SYMBOLS` list. An override for a pair that is not configured (a stale key from an earlier run, or a typo in the suffix) is **silently dropped** — it cannot resurrect calibration for an untraded symbol, but it also cannot warn you. If a calibration appears to have no effect, confirm the symbol is in `SYMBOLS`.

```bash
# Verified V5 Sniper calibration (.env.emilia)
MIN_VOLATILITY_FEE_RATIO_NEARUSDT=1.0   # 180d audit: 1.5 → +3.46%, 1.0 → +22.40%
SMC_SL_ATR_OFFSET_APTUSDT=0.60
SNIPER_LIMIT_EXPIRATION_CANDLES_APTUSDT=25
```

---

## ⚙️ Ready-to-Use Configuration Presets

### 🛡️ V4 Classic Tank — 15m/4H Execution (Scenarios 1 + 5)

**Philosophy**: high win-rate, fewer trades, institutional SMC confirmed on 15m closes. The Tank runs the two highest-conviction classic patterns — **S1 HTF Continuation** and **S5 HTF Liquidity Sweep** — and nothing else, so every rejection bucket in the backtest report belongs to one of them. Both resolve take-profit structurally through `tpResolver.ts` (`skipMinorObstacles: false`: the nearest candidate is a hard wall — reject, never clamp).

**File: `.env.subaru`** — the shipped profile is **secret-free**. Inject `BYBIT_API_KEY`, `BYBIT_API_SECRET`, `DATABASE_URL`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` and `BACKUP_PASSWORD` at deploy time or `loadConfig()` refuses to boot.

```bash
SYMBOLS=BTCUSDT,ETHUSDT,SOLUSDT
ENABLE_SNIPER_MODE=false
ACTIVE_SCENARIOS=1,5

LTF_TIMEFRAME=15
HTF_TIMEFRAME=240
HISTORY_CANDLES=200
MACRO_CANDLES=1000
COOLDOWN_CANDLES=16
LIMIT_EXPIRATION_CANDLES=6

# Dynamic TP
ENABLE_DYNAMIC_TP=true
DYNAMIC_TP_MIN_RR=1.5
DYNAMIC_TP_MAX_RR=6.0

# General SMC
SMC_SL_ATR_OFFSET=0.5
SMC_DISPLACEMENT_MULTIPLIER=1.5
SMART_ENTRY_THRESHOLD_PCT=0.15
PREFLIGHT_BUFFER_PCT=0.05

# Entry filters
ALLOWED_DAYS_OF_WEEK=1,2,3,4,5
ENFORCE_KILLZONES=true

# Risk & capacity
RISK_PERCENT=2
REDUCED_RISK_PERCENT=1
LEVERAGE=10
MAX_WORKING_CAPITAL=20000
```

> **Deliberately absent from the Tank profile**
>
> - `SCENARIOS_<SYMBOL>` — `ACTIVE_SCENARIOS=1,5` already covers all three symbols. A per-symbol override _narrows_ that symbol to exactly the listed scenarios; it never adds to the global list.
> - `MIN_NET_RR`, `MIN_VOLATILITY_FEE_RATIO`, `MIN_TP_DISTANCE_PCT`, `S12_*`, `SNIPER_*` — every one of these gates is evaluated **inside Scenario 12** (plus S9 for the wick ratio). In a Classic deployment they would be dead configuration that reads as protection.

| Aspect              | Setting                   | Rationale                                                 |
| ------------------- | ------------------------- | --------------------------------------------------------- |
| **Timeframes**      | 15m entry / 4H context    | Classic SMC confirmation timeframe                        |
| **Scenarios**       | 1, 5                      | HTF Continuation + HTF Liquidity Sweep                    |
| **Entry**           | 15m close                 | Hybrid Smart Entry (0.15% Market/Limit threshold)         |
| **Take-profit**     | Structural (`tpResolver`) | Nearest obstacle is a hard wall — rejection over clamping |
| **Funding Monitor** | Enabled                   | Delta-neutral funding awareness                           |

---

### 🎯 V5 Sniper Touch — 1m Execution (Scenario 12)

**Philosophy**: 1m entries anchored to a swept level — macro (PDH/PDL/PWH/PWL) by default, optionally session extremes and 15m EQH/EQL. Each CHoCH is paired with the sweep that actually preceded it, and take-profit is resolved structurally (fixed `3R` when dynamic resolution is off) so micro-stops never blindly target distant macro liquidity. The P0 shields reject fee-dominated geometry before an order is ever staged.

**File: `.env.emilia`** — the shipped profile is **secret-free**, same injection rule as the Tank.

```bash
SYMBOLS=NEARUSDT,APTUSDT
ENABLE_SNIPER_MODE=true
ACTIVE_SCENARIOS=12

# Dynamic TP
ENABLE_DYNAMIC_TP=true
DYNAMIC_TP_MIN_RR=1.5
DYNAMIC_TP_MAX_RR=6.0

# S12 Sweep Sources
S12_SESSION_SWEEPS=true
S12_EQH_EQL_SWEEPS=true

# Global P0 Shields & Execution
MIN_NET_RR=1.5
MIN_VOLATILITY_FEE_RATIO=1.5
SMC_SWEEP_MIN_WICK_RATIO=0.25
SMC_SL_ATR_OFFSET=0.5
MIN_TP_DISTANCE_PCT=0.0035
SNIPER_LIMIT_EXPIRATION_CANDLES=15

# Per-Symbol Overrides
# NEARUSDT: the 180d audit shows both P0 gates must be relaxed for this pair —
# global 1.5/1.5 → +3.46%, volatility-only 1.0 → +14.87%, both 1.0 → +22.40%
# (PF 3.24, DD 4.74%). Global 1.5 still covers APTUSDT.
MIN_VOLATILITY_FEE_RATIO_NEARUSDT=1.0
MIN_NET_RR_NEARUSDT=1.0

SMC_SL_ATR_OFFSET_APTUSDT=0.60
SNIPER_LIMIT_EXPIRATION_CANDLES_APTUSDT=25
```

| Aspect             | Setting                                                                        | Rationale                                                     |
| ------------------ | ------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| **Timeframes**     | 1m entry / 15m + 4H macro                                                      | Single-pass 1m evaluation (no intermediate state)             |
| **Scenario**       | 12                                                                             | Only 1m producer registered in the router                     |
| **Entry**          | 1m CHoCH after a sweep, near its OB midpoint                                   | Per-CHoCH causality + midpoint proximity (Inv. 51)            |
| **Symbols**        | NEARUSDT, APTUSDT                                                              | Focused 2-coin roster                                         |
| **Shields**        | Net R:R ≥ 1.5, 1m ATR ≥ 1.5× round-trip fee; NEAR runs both at 1.0, TP ≥ 0.35% | Fee-dominated geometry is rejected, never clamped             |
| **Limit lifetime** | 15 min (NEAR) / 25 min (APT)                                                   | Via `resolveLimitExpirationCandles()` — verify in the run log |

> **Why NEAR carries both P0 overrides at 1.0**: the 180-day endurance audit produced a measured ladder on the same 259,200 candles — global `1.5`/`1.5` → **+3.46%**, volatility `1.0` alone → **+14.87%**, both `1.0` → **+22.40%** (see the Endurance Audit section above). The volatility gate is the binding constraint (41.7% → 18.7% of candidates), the net-R gate accounts for the residual. Both are per-symbol, so APTUSDT and any future pair keep the stricter `1.5` admission. This is _calibration_ backed by a measured rejection funnel — not a global weakening of the gates.

> **Why the shields are S12-only**: `minNetRr`, `minVolatilityFeeRatio` and `minTpDistancePct` are read exclusively by `Scenario12_SniperTouch.ts` and wired per symbol through `resolveSymbolConfig()`. Scenarios 1–11 never consult them — which is precisely why the Tank profile omits them instead of listing them as inert protection.

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

### Trade Lifecycle Notifications

Micro-rejections are handled **silently** — Slippage Guard aborts and Pre-flight DEAD setups are burned server-side only and never reach Telegram, keeping the chat clean. Every meaningful lifecycle event produces a clear, minimalist notification instead:

| Notification                 | When                                                                                                                                                                            |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Setup Found**              | Manual mode only (`AUTO_TRADING=false`) — inline ✅/❌ Approve/Reject buttons                                                                                                   |
| **🚀 Order Opened**          | Every order successfully placed on the exchange (Market & Limit, both auto and manual modes)                                                                                    |
| **✅/❌ Position Closed**    | TP / SL / Reconciliation close — accurate exchange PnL (fees + funding included)                                                                                                |
| **🗑️ Limit Order Cancelled** | Limit order expired unfilled (`LIMIT_EXPIRATION_CANDLES`) or cancelled by Reconciliation — formally closes the loop on the earlier `🚀 Order Opened` alert (0 PnL, no PnL line) |

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

### Why Render Fits This Architecture

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
│  SCANNING →    │     │  SCANNING →    │     │  SCANNING →    │
│  ENTRY_STAGED  │     │  ENTRY_STAGED  │     │  ENTRY_STAGED  │
│  → IN_TRADE    │     │  → IN_TRADE    │     │  → IN_TRADE    │
│  → SCANNING    │     │  → SCANNING    │     │  → SCANNING    │
└───────┬────────┘     └────────┬───────┘     └─────────┬──────┘
        │                       │                       │
        ▼                       ▼                       ▼
┌─────────────────────────────────────────────────────────────────┐
│                      ScenarioRouter                             │
│  Evaluates 12 scenarios → filters mitigatedZones/Structures     │
│  (copy-on-write) → returns PositionPlan                         │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      RiskManager                                │
│  Position sizing, Drawdown Guard, capacity cap, minOrderQty     │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    PendingTradeManager                          │
│  Manual approval queue + directional Slippage Guard (Market)    │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    ExecutionEngine                              │
│  Market (IOC) / Limit (GTC) + TP/SL via Bybit REST              │
│  (Circuit Breaker wrapped)                                      │
└─────────────────────────────────────────────────────────────────┘
```

### Data Flow (Live Trade)

1. **WS Kline** → `CandleFeed` → `StrategyEngine.process()`
2. **ScenarioRouter** evaluates 12 scenarios against `PatternRecognizer` patterns (copy-on-write filtering — the cached `PatternData` is never mutated)
3. **RiskManager** calculates position size against the capped working balance, with Drawdown Guard
4. **Smart Entry Decision** — re-evaluated at the **live tick** (`getLivePrice()` = global tick memory), never pre-committed at signal time:
   - **Discount** (price already better than `idealEntry`) → **Market** (IOC)
   - Otherwise, `|idealEntry - livePrice| / idealEntry ≤ 0.15%` → **Market** (IOC)
   - Otherwise, `|idealEntry - livePrice| / idealEntry > 0.15%` → **Limit** (GTC) at `idealEntry`
5. **PendingTradeManager** queues for approval (or auto-executes)
6. **Pre-flight suite** — unconditional SL breach + TP reached checks; 0.2% **directional** slippage guard for Market orders only
7. **ExecutionEngine** places order (Market IOC or Limit GTC with TP/SL, `positionIdx: 0`)
8. **Trigger structure burned** in memory, then `transition(IN_TRADE)` — _before_ bookkeeping
9. **DB** records the trade with the exchange's real `avgPrice`, plus `zoneDetails` (OB/FVG/BREAKER/MITIGATION) and `orderType`
10. **WS Position/Execution** OR **ReconciliationLoop** detects the close (dual-channel)
11. **2.5s delay** → `GET /v5/position/closed-pnl` → exact PnL (fees + funding), summed across partial closes
12. **MitigatedZone** recorded → no re-entry on the same zone
13. **ReconciliationLoop** (every 10 min) cancels expired Limit orders (> `LIMIT_EXPIRATION_CANDLES`), without ever closing a `PartiallyFilled` order as `CANCELLED`

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

- Step 1: `IN_TRADE` engines → `getOpenPositions()`. A position of size 0 is **not** proof of closure — active Limit orders (`New` / `PartiallyFilled`) block the reset, and only genuinely expired orders are cancelled.
- Step 2: All open trades in DB → check the exchange → `reconcileWithTrade()` with `zoneDetails` for mitigation tracking.
- **Limit fallback**: when `getClosedPnl` is empty and `order_type === 'Limit'`, the trade is recorded as `CANCELLED` with **0 PnL** (no mathematical fallback — that is reserved for Market fills).
- **Partial-fill safety**: a `PartiallyFilled` order is never closed as `CANCELLED`; the filled portion stays `IN_TRADE` under Adaptive Fractioning (Invariant 53).
- Idempotent, safe with concurrent WS events

---

## 🧮 SMC Math Highlights

- **EQH/EQL Tolerance**: `max(0.1%, 0.5 * ATR / close)` — dynamic, noise-resistant
- **Trading Range**: Real highs/lows + `0.5 * ATR` touch tolerance
- **SFP/Sweep**: `wick > level && close < level` (never strict equality)
- **Displacement**: Body ≥ **1.5 × ATR** on BOS/CHoCH/SMS/Breaker candles
- **Killzones**: London (02-05 NY) / NY (07-10 NY) only for entries — globally bypassable via `ENFORCE_KILLZONES=false`
- **Day filter**: `ALLOWED_DAYS_OF_WEEK` (ISO weekday numbers in UTC) blocks NEW entries only; active management is never gated
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
| **Capacity Limit**   | `workingBalance = min(balance, MAX_WORKING_CAPITAL)` — caps risk base                                          | `MAX_WORKING_CAPITAL` (unset = unlimited)     |
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
# All tests (853 across 43 suites)
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
npm run backtest     # Full backtest over BACKTEST_DAYS (all symbols)
npm run backtest -- BTCUSDT  # Single symbol
npm test             # Jest (853 tests, 43 suites)
npm run test:watch   # Watch mode
npm run decrypt      # Decrypt an encrypted /backup archive
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
│   ├── tpResolver.ts           # Module 3: structural TP resolution (major/minor obstacles)
│   ├── brain/
│   │   ├── htfRoadmap.ts       # Module 1: 4H dealing range, bias, primary liquidity draw
│   │   └── volumeExhaustion.ts # Module 2: 15m pullback exhaustion + reaction surge
│   └── scenarios/              # S1–S12 implementations + archive/ (S13)
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

Distributed under the **MIT License**. See [`LICENSE`](LICENSE) for more information.

Copyright (c) 2026 [Nikita Ishchenko](https://github.com/IshNekittt)

---

## ⚠️ Disclaimer & Risk Warning

**This software is strictly for educational, research, and technical evaluation purposes.**

- Cryptocurrency trading, especially using leverage and perpetual contracts, involves substantial risk of financial loss and is not suitable for every individual.
- **Do not trade with funds you cannot afford to lose.**
- Past performance, historical backtesting, and simulation metrics do not guarantee future results.
- The author and contributors assume **zero liability** for any financial, technical, or consequential damages resulting from the direct or indirect use of this software, exchange API failures, latency spikes, or third-party service interruptions.
- Users are solely responsible for compliance with their local regulations, exchange terms of service, and risk management policies.

---

<div align="center">

_Enterprise-grade reliability. High-fidelity simulation. Zero-lookahead quantitative architecture._

</div>
