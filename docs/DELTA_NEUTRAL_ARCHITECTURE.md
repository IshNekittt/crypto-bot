# Delta-Neutral Funding-Rate Engine
## Architecture Blueprint & Backtester Specification

**Status:** DESIGN ONLY — no source file has been modified.
**Date:** 2026-10-27
**Scope:** A new, process-isolated `DeltaNeutralEngine` for Bybit V5 UTA: spot long + linear perpetual short, funding-rate carry, portfolio allocation, execution/rollback, reconciliation, and historical simulation.
**Reference:** `AGENTS.md` invariants 1–60 and §16 anti-patterns, `README.md`, `src/api/bybitClient.ts`, `src/config/fees.ts`, `src/db/database.ts`, `src/backtest/historyLoader.ts`, `src/backtest/executionSimulator.ts`, `src/backtest/reporter.ts`, `src/services/fundingMonitorService.ts`.

---

## Contents

| § | Section | What it answers |
| --- | --- | --- |
| 0 | Executive Summary | Verdict, the five corrections, scope boundaries |
| 1 | Problem Definition & Scope | What is being traded and why, in/out of scope |
| 2 | Venue Reality | UTA model, instrument mapping, funding mechanics, fees, API limits |
| 3 | System Architecture | Process topology, module map, data flow, separation invariants |
| 4 | Screener & Funding Filter | Universe, causal MA, gates, scoring, rejection funnel |
| 5 | Capital & Portfolio Manager | Equity, caps, water-filling, sizing, drawdown |
| 6 | Execution Engine & Legging Risk | Preflight, order policy, state machine, partial fills, rollback, panic |
| 7 | Position Lifecycle | Time-lock, exit conditions, hysteresis, unwind, cooldown, settlement |
| 8 | Accounting & Yield Mathematics | PnL decomposition, basis, funding, fees, slippage, net yield, APR |
| 9 | Backtester Specification | Modes, causality, simulator, portfolio, metrics, stress, artifacts |
| 10 | Reconciliation & Recovery | 10-min audit, startup recovery, orphan table, drift, incidents, runbooks |
| 11 | Configuration | `DN_*` reference, validation rules, deployment profiles, overrides |
| 12 | Database Schema | Additive `dn_*` tables, state keys, migration, retention |
| 13 | Observability & Telegram | Log schema, metrics, commands, alert taxonomy, heartbeat, reports |
| 14 | Testing Strategy | Unit, property, integration, replay, fault injection, CI gates |
| 15 | Phased Rollout | Phase gates, burn-in, scale-up steps, rollback playbook |
| 16 | Risks & Mitigations | Register, narratives, residual risk, concentration, capital at risk |
| 17 | Architecture Decision Records | 16 binding decisions and their consequences |
| 18 | Delta-Neutral Invariants | DN-1 … DN-48, the normative constraints |
| 19 | What Not To Do | Anti-patterns with root cause and rule |
| 20 | Future Work | Deferred features and why they are deferred |
| A–G | Appendices | Formula sheet, API reference, config cheat sheet, glossary, file map, bucket dictionary, document control |

---

## 0. Executive Summary

### 0.1 Verdict

| Question | Answer |
| --- | --- |
| Is this a new trading mode? | **Yes.** It must run as a separate process, sub-account, database, Telegram bot and deployment profile. It must never share an account or process with the SMC engine. |
| Core position | **Spot long + linear perpetual short**, equal **base quantity** (not equal notional). |
| Entry | Screener over 50+ linear tickers, 3–5 epoch funding moving average, liquidity/basis gates, fee-aware break-even and net-APR hurdle. |
| Exit | Economic time-lock + funding-MA decay + risk overrides (basis blowout, margin, negative funding streak, delisting). |
| Backtester | Bybit `/v5/market/funding/history` plus spot/perp OHLC; `FundingExecutionSimulator` with two modes (funding-only and full OHLC), portfolio-level allocation, causal MA, rejection funnel, stress matrix. |
| Existing SMC code | **Untouched.** The new module is additive under `src/delta/` and `tests/delta/`. |
| First release | Paper → demo → mainnet canary. No auto-trading on day one. |

### 0.2 The five corrections that shape the design

1. **1:1 delta-neutral means equal base quantity, not equal notional.**
   Matching dollar notional leaves a residual base delta of `Q × (1 − S/P)`. At a 1% basis that is ~1% of the position still directionally exposed. Equal base quantity gives `Δ_base = Q_spot − Q_perp = 0`; the residual is only a small notional basis exposure, which is the intended carry bet.
2. **Spot fees are not perpetual fees.**
   The existing `TAKER_FEE_RATE = 0.00055` / `MAKER_FEE_RATE = 0.00020` describe **linear perpetuals only**. Bybit spot standard fees are materially higher (currently 0.1% maker/taker for non-VIP). The engine must fetch `getFeeRate({ category: 'spot' | 'linear', symbol })` per leg and never inherit the SMC constants.
3. **`~0.15%` round-trip is not the retail all-taker cost.**
   Four taker fills at standard rates are `2 × (0.1% + 0.055%) = 0.31%` of notional. `~0.15%` is reachable only with maker fills on the perpetual legs and/or VIP/rebate tiers and spot fee discounts. The engine must compute break-even from **actual** fees and refuse setups that do not clear them.
4. **`predictedFundingRate` is not part of the installed SDK typings.**
   `TickerLinearInverseV5` exposes `fundingRate`, `nextFundingTime`, `fundingIntervalHour`, `fundingCap`, `basisRate` and `basis`, but no `predictedFundingRate`. The field may exist in a raw REST response on some deployments; treat it as **optional** and never make it the sole entry gate. The core signal is the moving average of **realized** funding history.
5. **The safe legging order is spot first, perpetual second.**
   An unhedged long spot has a bounded loss (the asset can go to zero). An unhedged short perpetual has an unbounded loss (the asset can go to infinity). Spot-first is therefore strictly safer. On exit the order reverses: close the perpetual first, then sell spot.

### 0.3 What the engine is and is not

**It is:** a market-neutral carry engine that earns the funding rate plus any basis convergence, while accepting fee drag, basis risk, execution risk and exchange counterparty risk.

**It is not:** risk-free, a yield farm, a substitute for the SMC directional engine, or a strategy that can be bolted onto the existing process/account. Funding can flip negative, basis can blow out, and the perpetual leg can be liquidated.

### 0.4 Delivery phases

| Phase | Deliverable | Orders? |
| --- | --- | --- |
| 0 | This document, pure math modules, `FundingExecutionSimulator`, golden datasets | No |
| 1 | Read-only screener against live data, full rejection funnel | No |
| 2 | Paper trading, simulated fills, accounting parity | No |
| 3 | Bybit demo, real orders, manual then auto, 14-day burn-in, rollback drills | Demo |
| 4 | Mainnet canary, 1–2 symbols, ≤5% equity, manual kill switch | Mainnet |
| 5 | Scale to target deployment, per-coin caps, portfolio allocation | Mainnet |

Phase gates, durations and rollback criteria are specified in §15.

---

## 1. Problem Definition & Scope

### 1.1 Strategy premise

A perpetual future has no expiry. To keep its price anchored to spot, the venue periodically transfers a **funding payment** between longs and shorts. When the rate is positive, longs pay shorts; when negative, shorts pay longs. A position that is long spot and short the same quantity of the perpetual:

- has **zero base delta** (price moves cancel),
- **receives** funding when the rate is positive,
- **earns or loses the basis** as spot and perpetual prices converge or diverge,
- pays four fills (spot buy, perp sell, perp buy-back, spot sell) plus slippage.

The edge is therefore:

```
net carry = accumulated funding + basis convergence − round-trip fees − slippage
```

The strategy is viable only when the **persistence** of positive funding is high enough to amortize the round-trip cost. A single epoch is never enough. This is why the engine uses a 3–5 epoch moving average, a fee-aware break-even, and a minimum holding period.

### 1.2 Why a separate engine is mandatory

The existing SMC engine is directional and stateful per symbol (`SCANNING → ENTRY_STAGED → IN_TRADE`). Its `IN_TRADE` slot is mutually exclusive, and its reconciliation loop treats every exchange position on a configured symbol as its own. Running a delta-neutral position in the same account would cause:

- **Position collision** — SMC could be long the perp while the DN engine is short it; each engine would misread the net position.
- **Reconciliation corruption** — SMC's `getOpenPositions()` would see the DN hedge and attempt to manage or close it.
- **Margin coupling** — a DN margin call could force liquidation of SMC positions, and vice versa.
- **State-machine ambiguity** — one symbol cannot be simultaneously `IN_TRADE` for two strategies.
- **Rate-limit contention** — both engines polling the same endpoints.
- **Database contamination** — directional `trades` rows and delta-neutral position rows have different semantics.

**Rule:** one process, one sub-account, one database, one Telegram bot, one deployment profile per engine. This mirrors `AGENTS.md` §1.3 and Invariant 16.3.8.

### 1.3 In scope

- Screening 50+ linear USDT perpetuals with a matching spot pair.
- Funding-rate moving average over 3–5 epochs, with stability metrics.
- Portfolio capital allocation with per-coin, per-sector, deployment and reserve caps.
- Two-leg execution with preflight checks, legging detection, rollback and orphan handling.
- Position monitoring: funding accrual, basis, margin, liquidation distance.
- Time-lock and exit logic with hysteresis and risk overrides.
- Reconciliation with the exchange (spot balances, perp positions, funding settlements, fees).
- Historical backtesting with `FundingExecutionSimulator`.
- Separate configuration, schema, observability, alerts and runbooks.

### 1.4 Out of scope (v1)

- Cross-exchange arbitrage (Bybit only).
- Options or dated futures hedging.
- Spot margin borrowing / short spot.
- Multi-quote currencies beyond USDT (USDC pairs deferred).
- Non-1:1 contract multipliers (`1000PEPE`, `1000BONK`, etc.).
- Automatic tax lot accounting.
- Machine-learned funding forecasting.
- Portfolio-margin optimization beyond using the venue's reported equity/margin.

### 1.5 Definitions

| Term | Meaning |
| --- | --- |
| **Epoch** | One funding interval. Bybit defaults to 8h; some symbols use 4h or 1h. |
| **Leg** | One side of the position: spot or perpetual. |
| **Basis** | `(P_perp − S_spot) / S_spot`. Positive = perp premium. |
| **Carry** | Funding plus basis convergence. |
| **Delta** | Net base-asset exposure: `Q_spot − Q_perp`. |
| **Allocated equity** | Spot notional + perpetual margin + configured buffer. The capital the position can lose. |
| **Deployed equity** | Sum of allocated equity across open positions. |
| **Break-even epochs** | Number of funding epochs needed to recover round-trip costs. |
| **Hedge** | The perpetual short that offsets the spot long. |
| **Legging** | The interval between the first and second leg fills. |
| **Orphan** | A leg that exists on the exchange without its counterpart. |

---

## 2. Venue Reality: Bybit UTA & API Constraints

### 2.1 Account model

Bybit's Unified Trading Account (UTA) shares collateral across spot, linear perpetuals and options. This is the only account model in which the strategy is capital-efficient: the spot long can offset the perpetual short's margin requirement, and the account reports a single `totalEquity`.

**Preflight requirements:**

| Requirement | Check | Failure action |
| --- | --- | --- |
| UTA mode | `getAccountInfo()` returns a unified-margin status; do not hardcode a numeric enum — read the response and require UTA | Fail closed, alert |
| One-way position mode | `positionIdx: 0` is valid; hedge mode is rejected | Fail closed |
| Cross margin (recommended) | `getAccountInfo().marginMode` or account setting | Warn; isolated is supported but lower efficiency |
| Demo mode | `DEMO_TRADING` / `TESTNET` match the intended environment | Fail closed on mismatch |
| API permissions | Spot trade + derivatives trade; **no withdrawal** | Fail closed |
| IP whitelist | Key restricted to the deployment egress IPs | Warn if absent |

> **Delta-neutral account mode:** `setDeltaNeutralMode({ deltaEnable: '1' | '0' })` exists in the SDK and `getAccountInfo()`/`getUserSettingConfig()` may expose `deltaEnable`. Its exact margin effect is **not documented here as verified**. Treat it as an optional optimization for Phase 3+, never as a dependency. The engine must be economically correct with the mode off.

### 2.2 Instrument model and 1:1 mapping

A valid pair requires **exact** spot and linear-perp symbols with the same base and quote asset, and a **1:1 contract multiplier**.

| Check | Example pass | Example fail |
| --- | --- | --- |
| Same symbol | `NEARUSDT` spot + `NEARUSDT` linear | `PEPEUSDT` spot + `1000PEPEUSDT` linear |
| Same base | `NEAR` = `NEAR` | `BTC` vs `WBTC` |
| Same quote | `USDT` = `USDT` | `NEARUSDT` vs `NEARUSDC` |
| Status `Trading` | Both instruments trading | One delisted / pre-listing |
| Multiplier 1:1 | Perp `contract multiplier = 1` | `1000*` contracts |
| Min notional compatible | Spot `minOrderAmt` and perp `minNotionalValue` both fit the allocation | Allocation below both minimums |

`getInstrumentsInfo({ category: 'spot' | 'linear', symbol })` returns:

- spot: `lotSizeFilter.minOrderQty`, `maxOrderQty`, `minOrderAmt`, `maxOrderAmt`, `priceFilter.tickSize`;
- linear: `lotSizeFilter.minOrderQty`, `qtyStep`, `minNotionalValue`, `priceFilter.tickSize`, `fundingInterval`, `upperFundingRate`, `lowerFundingRate`, `leverageFilter`.

The engine caches instrument info for 1 hour and refreshes immediately after any precision rejection.

### 2.3 Funding mechanics

- Funding is settled at the venue's **funding timestamps** (typically 00:00, 08:00, 16:00 UTC for 8h intervals; some symbols use 4h or 1h).
- The payment is calculated on the **position notional at mark price**, not on the initial notional.
- **Positive rate:** longs pay shorts → the short leg receives `+Q × mark × rate`.
- **Negative rate:** shorts pay longs → the short leg pays `−Q × mark × |rate|`.
- The position must be open at the settlement snapshot. Entering seconds before is a race; the engine avoids the final 60 seconds before funding for entries unless explicitly configured.
- `fundingRate` from the ticker is the **current/latest** rate; it is not a guarantee of the next settlement.
- `nextFundingTime` and `fundingIntervalHour` must be read from the ticker; never assume 8h.
- `fundingCap` (ticker) and `upperFundingRate` / `lowerFundingRate` (instrument) bound the rate. A rate pinned at the cap is a warning sign, not a green light.
- **`predictedFundingRate` is not in the installed `TickerLinearInverseV5` typing.** If a raw response includes it, parse defensively; otherwise fall back to `fundingRate` and history. Never gate entry on it alone.

### 2.4 Fee model: spot vs perpetual

| Venue | Standard maker | Standard taker | Fee currency |
| --- | --- | --- | --- |
| Bybit spot | 0.10% | 0.10% | Buy: base asset; Sell: quote asset |
| Bybit linear perp | 0.02% | 0.055% | USDT (settle coin) |

These are **standard non-VIP** rates. Actual rates depend on VIP level, promotions, maker rebates and fee-tier programs. The engine must call `getFeeRate({ category, symbol })` and store the result. `getFeeRate` returns `takerFeeRate` and `makerFeeRate` as strings.

**Round-trip cost on notional, all taker:**

```
2 × (spot_taker + perp_taker) = 2 × (0.0010 + 0.00055) = 0.0031 = 0.31%
```

**Round-trip with maker perpetual legs:**

```
2 × spot_taker + 2 × perp_maker = 2 × 0.0010 + 2 × 0.0002 = 0.0024 = 0.24%
```

**Where `0.15%` comes from:** VIP tiers, spot fee discounts, maker rebates, or a blended fill mix. It is **not** the default retail all-taker cost. A design that hardcodes `0.15%` will overstate net yield by roughly 0.16% per round trip, which is material when funding is 0.01–0.03% per epoch.

> **Fee currency is part of the hedge math.** A spot buy charged in the base asset delivers less base quantity than ordered. The perpetual short must hedge the **received** quantity, not the ordered quantity. See §6.9.

### 2.5 API surface

| Purpose | SDK method | Key fields / notes |
| --- | --- | --- |
| Linear tickers | `getTickers({ category: 'linear' })` | `fundingRate`, `nextFundingTime`, `fundingIntervalHour`, `fundingCap`, `markPrice`, `indexPrice`, `basis`, `basisRate`, `turnover24h`, `bid1/ask1` |
| Spot tickers | `getTickers({ category: 'spot' })` | `lastPrice`, `bid1/ask1`, `turnover24h` |
| Funding history | `getFundingRateHistory({ category: 'linear', symbol, startTime?, endTime?, limit? })` | `fundingRate`, `fundingRateTimestamp`; limit max 200; paginate |
| Instrument info | `getInstrumentsInfo({ category, symbol })` | `tickSize`, `qtyStep`, `minOrderQty`, `minNotionalValue`, `fundingInterval`, `upper/lowerFundingRate` |
| Order book | `getOrderbook({ category, symbol, limit })` | `b`/`a` price-size levels for depth/slippage |
| Fee rate | `getFeeRate({ category, symbol })` | `takerFeeRate`, `makerFeeRate` |
| Wallet | `getWalletBalance({ accountType: 'UNIFIED' })` | `totalEquity`, `totalAvailableBalance`, `totalPerpUPL`, `totalInitialMargin`, `totalMaintenanceMargin`, `accountIMRate`, `accountMMRate`, `coin[]` |
| Perp positions | `getPositions({ category: 'linear', symbol? })` | `size`, `avgPrice`, `liqPrice`, `positionIM`, `positionMM`, `unrealisedPnl`, `adlRankIndicator`, `leverage` |
| Open orders | `getActiveOrders({ category, symbol? })` | Limit/conditional orders; use for legging/recovery |
| Executions | `getExecutions({ category, symbol, startTime, endTime })` | Fill price, qty, fee, `execId`, `orderLinkId` |
| Transaction log | `getTransactionLog({ type: 'SETTLEMENT', ... })` | `funding`, `fee`, `cashFlow`, `change`, `currency`, `transactionTime`, `tradeId`, `orderId` |
| Place order | `submitOrder({ category, symbol, side, orderType, qty, price?, timeInForce, reduceOnly?, orderLinkId, positionIdx })` | Spot and linear |
| Cancel order | `cancelOrder({ category, symbol, orderId? , orderLinkId? })` | Recovery |
| Leverage | `setLeverage({ category: 'linear', symbol, buyLeverage, sellLeverage })` | Perp only |
| Margin mode | `setMarginMode({ setMarginMode: 'CROSS' / 'ISOLATED' })` | Account-level; verify |
| Position mode | `switchPositionMode({ category, mode: 'MergedSingle' / 'BothSide' })` | One-way required |
| Account info | `getAccountInfo()` | UTA status, margin mode, spot hedging status |
| Delta-neutral mode | `setDeltaNeutralMode({ deltaEnable })` | Optional; unverified margin effect |
| Time sync | `syncServerTime()` | Reuse the SMC pattern: startup + hourly |

### 2.6 SDK gaps and defensive parsing

| Gap | Impact | Mitigation |
| --- | --- | --- |
| No `predictedFundingRate` in `TickerLinearInverseV5` | Cannot rely on a forward-looking rate | Optional raw-field parse; core gate uses realized history |
| `TransactionLogV5` has no `id` field | Cannot use a single tx id for idempotency | Deterministic composite key: `sha256(symbol + transactionTime + funding + fee + cashFlow + currency)` |
| Existing `BybitClient.getTickers` wrapper is linear-only | Spot tickers need a new call | `DnBybitClient` adds spot overloads; no change to SMC |
| `getFundingRateHistory` is linear/inverse only | No spot funding (expected) | Use linear perp history only |
| `fundingFloor` not in ticker typing | Negative cap not directly available | Use `lowerFundingRate` from instrument info; treat missing as unbounded |
| `setDeltaNeutralMode` semantics unverified | Cannot depend on margin savings | Feature-flag off by default; verify on demo |
| Spot market order `timeInForce` nuances | Some spot order types reject `IOC` | Use `Market` with venue-supported `timeInForce`; verify on demo |

### 2.7 Rate-limit and data-freshness budget

| Call | Cadence | Approx. volume | Notes |
| --- | --- | --- | --- |
| Linear tickers | 5 min | 288/day | One call returns all symbols |
| Spot tickers | 5 min | 288/day | One call returns all symbols |
| Funding history (top 20) | 1 hour cache | ~480/day | 20 symbols × 24 |
| Instrument info | 1 hour cache | ~50/day | Per symbol pair |
| Fee rates | 24 hours | ~50/day | Per symbol/category |
| Positions/wallet | 10 s | 8,640/day | Can use WS for pushes |
| Transaction log | 10 min | 144/day | Paginated |
| Reconciliation | 10 min | 144/day | Full audit |

All calls go through the same retry/circuit-breaker semantics as `BybitClient.executeWithRetry`: max 3 retries, 1s → 2s → 4s; per-symbol breaker after 3 failures in 60s; global 5-minute pause after 3 consecutive 429s. The DN engine must have its **own** breaker state; it must not share the SMC process's memory.

### 2.8 Clock and timezone rules

- All timestamps are **UTC milliseconds**.
- Call `syncServerTime()` at startup and hourly. Log `[DN Clock Drift] offset=Xms roundTrip=Yms`.
- Funding timestamps come from the exchange (`fundingRateTimestamp`, `nextFundingTime`), never from local arithmetic.
- Never use `new Date().setHours(...)`; use UTC setters or `luxon` with `{ zone: 'utc' }`.
- Backtests and live reports use the same UTC formatting.

---
## 3. System Architecture

### 3.1 Process topology

```
┌─────────────────────────────────────────────────────────────────────┐
│  SMC Engine (existing)          │  DeltaNeutralEngine (new)         │
│  ─────────────────────────────  │  ───────────────────────────────  │
│  Process:  smc-bot              │  Process:  dn-bot                 │
│  Account:  sub-account A        │  Account:  sub-account B          │
│  Database: smc project/schema   │  Database: dn project/schema      │
│  Telegram: bot token A          │  Telegram: bot token B            │
│  Mode:     directional SMC      │  Mode:     delta-neutral carry    │
│  State:    per-symbol IN_TRADE  │  State:    per-position lifecycle │
│  WS:       klines/positions     │  WS:       executions/positions   │
└─────────────────────────────────────────────────────────────────────┘
```

**Hard separation invariants (DN-15):**

1. Never reuse the SMC `trades`, `symbol_state` or `mitigated*` tables.
2. Never point the DN engine at the SMC database or sub-account.
3. Never run both engines from the same Telegram bot or process.
4. Never let the DN engine place orders on a symbol the SMC engine is managing in the same account. The account boundary makes this impossible; the rule is a final guard.
5. The DN engine may read the SMC's **public** code patterns (Decimal, precision, logger, retry semantics) but must not import process-global state.

### 3.2 Module map

```
src/delta/
├── index.ts                     # Bootstrap, DI, healthcheck, graceful shutdown
├── config.ts                    # DN_* env parsing and validation
├── types.ts                     # Domain types (strings for money, Decimal in memory)
├── constants.ts                 # Timeouts, bucket names, defaults
├── api/
│   ├── dnBybitClient.ts         # Spot+perp REST wrapper, retry, breaker, time sync
│   ├── dnWsClient.ts            # Execution/position/wallet stream + watchdog
│   └── dnRateLimiter.ts         # Token bucket per category
├── screener/
│   ├── universe.ts              # Symbol mapping, 1:1 filters, status
│   ├── fundingMa.ts             # Causal MA, positive ratio, stdev, normalization
│   ├── eligibility.ts           # Pure gate function + rejection funnel
│   └── scorer.ts                # Net-APR score, stability/liquidity factors
├── portfolio/
│   ├── equity.ts                # Wallet equity, deployed, reserve
│   ├── allocator.ts             # Caps, water-filling, score weights
│   └── sizing.ts                # Equity → qty → precision → min notional
├── execution/
│   ├── preflight.ts             # All checks before the first order
│   ├── orderPolicy.ts           # Market/limit, slippage caps, fee currency
│   ├── legging.ts               # Two-leg state machine, watchdog, rollback
│   ├── panic.ts                 # Orphan close and flatness verification
│   └── idempotency.ts           # orderLinkId generation and lookup
├── position/
│   ├── manager.ts               # Lifecycle, funding accrual, exit signals
│   ├── funding.ts               # Epoch tracking, accrual, settlement sync
│   ├── exits.ts                 # Time-lock, hysteresis, risk overrides
│   └── margin.ts                # Margin ratio, liquidation distance, ADL
├── accounting/
│   ├── pnl.ts                   # Spot/perp/funding/fee decomposition
│   ├── fees.ts                  # Actual fee snapshots and fee-currency model
│   └── reports.ts               # Daily/weekly report builders
├── reconciliation/
│   ├── loop.ts                  # 10-minute audit
│   ├── legs.ts                  # Spot vs perp qty comparison
│   └── transactions.ts          # Funding/fee ingestion and idempotency
├── db/
│   ├── schema.ts                # Additive DDL (dn_* tables)
│   └── repository.ts            # Pool-safe CRUD, NUMERIC(24,8)
├── telegram/
│   ├── notifier.ts              # Separate bot, security middleware
│   └── commands.ts              # /dn_* commands
└── backtest/
    ├── run.ts                   # CLI entry
    ├── historyLoader.ts         # Funding + OHLC pagination/cache
    ├── fundingExecutionSimulator.ts
    ├── portfolioSimulator.ts    # Shared equity across symbols
    ├── metrics.ts               # PnL, ROE, APR, PF, drawdown, Sharpe
    └── reporter.ts              # Text + HTML + CSV artifacts
```

### 3.3 Data flow

```
[5 min]  Tickers (linear + spot)
            │
            ▼
[Stage A] Cheap filters: pair, status, turnover, spread, basis, funding floor
            │
            ▼
[Stage B] Funding history (cached) → MA, positive ratio, stdev, score
            │
            ▼
[Allocator] Equity caps, sector caps, water-filling → allocations
            │
            ▼
[Preflight] Instruments, fees, balance, depth, freshness, cooldown
            │
            ▼
[Legging] Spot buy → hedge perp short → HEDGED
            │
            ▼
[Position] Funding accrual, basis, margin, exit signals
            │
            ▼
[Exit] Perp buy-back → spot sell → CLOSED
            │
            ▼
[Reconciliation] Exchange truth, funding settlements, drift, incidents
```

### 3.4 Shared vs new code

| Concern | Reuse | New |
| --- | --- | --- |
| Decimal money | `decimal.js` | No change |
| Precision | `src/utils/precision.ts` (`formatPrice`, `formatQuantity`) | No change |
| Logger | `src/utils/logger.ts` (winston, Telegram error hook) | New `[DN]` context |
| DB pool pattern | `pg.Pool` with `try/finally release` | New repository |
| Retry/breaker | Same semantics as `BybitClient.executeWithRetry` | New `DnBybitClient` implementation |
| Healthcheck | Express `/health` pattern | New `/dn/health` and `/dn/metrics` |
| Telegram security | Chat-ID whitelist middleware | New bot instance |
| Backtest cache/retry | Same pagination/retry semantics as `historyLoader.ts` | New funding/OHLC loader |
| Fees | `src/config/fees.ts` constants are **perp-only** | New per-category fee snapshots |

**No source file under `src/` is modified by this design.** The only shared imports are pure utilities (`decimal.js`, logger, precision). If a shared retry utility is later extracted, that is a separate additive refactor with its own tests.

### 3.5 Runtime cadences

| Loop | Interval | Responsibility | Failure mode |
| --- | --- | --- | --- |
| Screener | 5 min | Universe, funding MA, score, allocation proposals | Stale data → skip entries |
| Preflight/entry | Event-driven | Validate and execute an allocation | Fail closed |
| Position monitor | 30 s | Margin, basis, liquidation distance, exit signals | Alert, pause entries |
| Funding sync | 10 min | Transaction log → accruals | Retry, alert on drift |
| Reconciliation | 10 min | Both legs, qty, orphan, fees | Freeze entries until clean |
| Daily report | 00:00 UTC | PnL, funding, APR, incidents | Log and retry |
| Time sync | Hourly | Clock drift | Log, alert if > 500ms |
| WS watchdog | 60 s silence | Force reconnect | Resync positions |

### 3.6 Failure domains

| Domain | Example | Blast radius | Containment |
| --- | --- | --- | --- |
| Market | Funding flips negative | Position PnL | Exit rule, time-lock override |
| Basis | Perp premium collapses / widens | Mark-to-market | Basis gate, exit override |
| Execution | Perp leg fails after spot fill | Unhedged long spot | Rollback, max unhedged time |
| Margin | Perp leg approaches liquidation | Forced close, orphan spot | Leverage cap, buffer, monitor |
| Exchange | API outage / maintenance | Cannot exit | Circuit breaker, alert, hold |
| Data | Missing funding history | Wrong signal | Fail closed, no entry |
| Process | Crash mid-entry | Orphan leg | Startup reconciliation, panic close |
| Database | Write failure after fill | Untracked position | Panic close, verify flat |
| Configuration | Wrong fee assumption | Overstated yield | Actual fee fetch, backtest parity |

---

## 4. Screener & Funding Filter

### 4.1 Universe construction

The universe is built from the **linear perpetual** ticker list intersected with the **spot** ticker list.

**Hard exclusions:**

- No exact spot pair, or quote/base mismatch.
- Non-1:1 contract multiplier (`1000*`, `10000*`).
- Instrument status not `Trading` on either leg.
- Pre-listing / auction phase.
- Stablecoin/base pairs used for cash management (e.g., USDCUSDT) — not a carry candidate.
- Less than `DN_MIN_HISTORY_EPOCHS` funding events or less than `DN_MIN_LISTING_DAYS` of history.
- 24h turnover below `DN_MIN_TURNOVER_24H_USDT` on either leg.
- Spread above `DN_MAX_SPREAD_BPS` on either leg.
- Symbol in the manual blacklist or in cooldown.

**Optional whitelist:** `DN_SYMBOLS` restricts the universe for canary phases. Empty means "all eligible".

### 4.2 Data acquisition

**Stage A — cheap ticker screen (one call per category):**

For each linear symbol:

```
fundingRate, nextFundingTime, fundingIntervalHour, fundingCap,
markPrice, indexPrice, basis, basisRate,
turnover24h, bid1Price, ask1Price, bid1Size, ask1Size
```

For the matching spot symbol:

```
lastPrice, bid1Price, ask1Price, bid1Size, ask1Size, turnover24h
```

Compute:

```
spot_mid = (spot_bid + spot_ask) / 2
perp_mid = (perp_bid + perp_ask) / 2
basis = (perp_mid − spot_mid) / spot_mid
spot_spread_bps = (spot_ask − spot_bid) / spot_mid × 10_000
perp_spread_bps = (perp_ask − perp_bid) / perp_mid × 10_000
```

**Stage B — funding history (cached):**

Call `getFundingRateHistory` for the top `DN_HISTORY_CANDIDATES` (default 20) Stage-A survivors. Cache per symbol for one funding interval or 1 hour, whichever is shorter. The cache stores:

```
{ symbol, fundingIntervalHour, events: [{ timestamp, rate }], fetchedAt }
```

Paginate backwards with `startTime`/`endTime` until `N + buffer` events are collected. Never fabricate missing epochs. If the history has a gap larger than 2× the expected interval, mark the symbol `dataGap` and exclude it.

### 4.3 Funding moving-average math

Let `f_i` be the realized funding rate of epoch `i`, ordered oldest → newest, and `t` the current time. Only events with `timestamp < t` are eligible.

```
f_ma(N) = (1 / N) × Σ_{i=1..N} f_i
```

**Normalization.** Funding intervals differ. Convert to a common annualized basis for comparison:

```
epochs_per_year = (24 / fundingIntervalHour) × 365
f_apr = f_ma × epochs_per_year
```

**Persistence.**

```
positive_ratio = count(f_i > 0) / N
```

**Dispersion.**

```
σ_f = sqrt( (1 / N) × Σ (f_i − f_ma)² )
stability = f_ma > 0 ? f_ma / (f_ma + σ_f) : 0
```

`stability ∈ [0, 1]`. A steady 0.02% rate scores higher than a 0.02% average built from +0.06%, −0.02%, +0.04%, −0.01%, +0.01%.

**Trend (optional, diagnostic only).**

```
slope = linear_regression_slope(f_i vs i)
```

A negative slope is a warning, not a hard gate (the exit rules handle decay). A positive slope can be a tie-breaker.

**Why 3–5 epochs:**

- 1 epoch is noise and cannot amortize fees.
- 2 epochs still flips easily.
- 3–5 balances responsiveness against persistence.
- More than 5 lags regime changes and overstates a rate that has already turned.

Default `DN_FUNDING_MA_EPOCHS=5`. The config accepts 3–5 for the standard profile; values outside 2–10 fail validation.

### 4.4 Eligibility gates

Every gate returns a **single, stable rejection bucket**. The funnel records the deepest gate reached, not the first incidental failure.

| # | Gate | Condition | Rejection bucket |
| --- | --- | --- | --- |
| 1 | Spot pair | Exact 1:1 symbol/base/quote/multiplier | `noSpotPair` |
| 2 | Status | Both `Trading` | `notTrading` |
| 3 | History | ≥ `DN_MIN_HISTORY_EPOCHS` and ≥ `DN_MIN_LISTING_DAYS` | `insufficientHistory` |
| 4 | Data integrity | No gap > 2× interval | `dataGap` |
| 5 | Turnover | `turnover24h ≥ DN_MIN_TURNOVER_24H_USDT` on both legs | `lowLiquidity` |
| 6 | Spread | `spread_bps ≤ DN_MAX_SPREAD_BPS` on both legs | `wideSpread` |
| 7 | Funding floor | `f_ma ≥ DN_MIN_FUNDING_RATE` | `fundingBelowFloor` |
| 8 | Persistence | `positive_ratio ≥ DN_MIN_POSITIVE_RATIO` | `fundingUnstable` |
| 9 | Dispersion | `σ_f ≤ DN_MAX_FUNDING_STDEV` | `fundingUnstable` |
| 10 | Cap | `f_ma < fundingCap × DN_CAP_WARN_RATIO` | `fundingAtCap` |
| 11 | Basis band | `−DN_MAX_NEGATIVE_BASIS ≤ basis ≤ DN_MAX_BASIS` | `basisOutOfBand` |
| 12 | Fee hurdle | `f_ma × k_expected > round_trip_cost` | `feeHurdle` |
| 13 | Net APR | `expected_net_apr ≥ DN_MIN_NET_APR` | `belowHurdle` |
| 14 | Cooldown | Symbol not in `DN_COOLDOWN_EPOCHS` after exit | `cooldown` |
| 15 | Portfolio | Allocation ≥ minimum after caps | `allocationCap` |
| 16 | Kill switch | Engine not halted | `killSwitch` |

**Bucket semantics:**

- `fundingBelowFloor` and `fundingUnstable` are **regime** rejections; they cluster by market conditions.
- `feeHurdle` and `belowHurdle` are **geometry** rejections; they cluster by fee tier and holding horizon.
- `basisOutOfBand` is a **relative-value** rejection; it protects against shorting the perp at a discount or entering after a premium blowout.
- `allocationCap` is a **portfolio** rejection; the setup is valid but there is no capital.

### 4.5 Scoring

The score ranks eligible candidates. It must be **net of fees** and **comparable across funding intervals**.

```
expected_hold_days = max(DN_EXPECTED_HOLD_DAYS, min_hold_days)
expected_hold_epochs = expected_hold_days × 24 / fundingIntervalHour

expected_funding_apr =
  f_ma × epochs_per_year × (perp_mid / spot_mid) × L / (L + 1 + βL)

expected_fee_drag_apr =
  round_trip_fee_fraction × (365 / expected_hold_days)

expected_basis_apr =
  (basis_entry − basis_exit_assumed) × (365 / expected_hold_days)

score_apr = expected_funding_apr − expected_fee_drag_apr + expected_basis_apr

liquidity_factor = min(1, min(spot_turnover, perp_turnover) / (2 × DN_MIN_TURNOVER_24H_USDT))
score = max(0, score_apr) × stability × liquidity_factor
```

Where:

- `L` = perp leverage (margin efficiency).
- `β` = buffer fraction of spot notional.
- `round_trip_fee_fraction = 2 × (spot_fee + perp_fee)` from **actual** snapshots.
- `basis_exit_assumed = 0` by default (conservative convergence assumption). A configurable `DN_BASIS_EXIT_ASSUMPTION_PCT` allows stress testing.
- `expected_hold_days` is an assumption for **ranking**, not a promise. It must be at least the fee break-even horizon; otherwise the score is negative by construction.

**Important:** the score is a ranking heuristic, not a forecast. It must never override the hard gates. A high score with a failed basis gate is still ineligible.

### 4.6 Candidate ranking and handoff

1. Sort eligible candidates by `score` descending.
2. Tie-breakers: higher `positive_ratio`, lower `σ_f`, higher turnover, lower spread.
3. Cap the list at `DN_MAX_CANDIDATES` (default 10).
4. Hand off to the allocator with the full metric bundle, not just the score. The allocator needs `f_ma`, `basis`, `fee`, `interval`, `stability`, `turnover`, `spread`.

### 4.7 Worked screening example

Assume:

```
spot_mid = 100.00
perp_mid = 100.50
basis = 0.50%
funding interval = 8h
f_ma(5) = 0.020% per epoch
positive_ratio = 1.0
σ_f = 0.004%
spot_taker = 0.10%
perp_taker = 0.055%
L = 3
β = 0.05
expected_hold_days = 30
```

Compute:

```
epochs_per_year = (24/8) × 365 = 1,095
funding APR on notional = 0.0002 × 1,095 = 21.90%
funding APR on equity = 21.90% × (100.50/100.00) × 3/(3+1+0.15)
                      = 21.90% × 1.005 × 0.7229 ≈ 15.91%
round-trip fee = 2 × (0.0010 + 0.00055) = 0.31%
fee drag APR = 0.31% × (365/30) = 3.77%
basis APR (assume convergence) = 0.50% × (365/30) = 6.08%
score APR ≈ 15.91% − 3.77% + 6.08% = 18.22%
stability = 0.0002 / (0.0002 + 0.00004) = 0.833
liquidity factor = 1.0 (assume deep)
score ≈ 15.18
```

If basis is assumed to stay at 0.50% (no convergence), the score drops to ≈ 12.14. Both are above a 10% hurdle; the setup is eligible. If fees are 0.31% but the holding horizon is 10 days, fee drag becomes 11.32% and the score collapses — which is exactly why the time-lock and expected-hold assumptions must be consistent.

### 4.8 Screener pseudocode

```ts
async function screen(now: number): Promise<Candidate[]> {
  const [linear, spot] = await Promise.all([
    client.getTickers({ category: 'linear' }),
    client.getTickers({ category: 'spot' }),
  ]);

  const stageA = buildUniverse(linear, spot)
    .filter((u) => u.status === 'Trading')
    .filter((u) => u.turnover24h.gte(config.minTurnover))
    .filter((u) => u.spreadBps.lte(config.maxSpreadBps))
    .filter((u) => u.currentFunding.gte(config.minFundingRate))
    .sort((a, b) => b.currentFunding.cmp(a.currentFunding))
    .slice(0, config.historyCandidates);

  const histories = await Promise.all(
    stageA.map((u) => fundingCache.getOrFetch(u.symbol, now)),
  );

  return stageA
    .map((u, i) => evaluateCandidate(u, histories[i], config, now))
    .filter((c) => c.eligible)
    .sort((a, b) => b.score - a.score)
    .slice(0, config.maxCandidates);
}
```

`evaluateCandidate` is a **pure function** shared by live and backtest. It returns `{ eligible, bucket, metrics }` and never performs I/O. This is the parity guarantee.

---
## 5. Capital & Portfolio Manager

### 5.1 Equity definitions

All values are `Decimal` in memory and strings in the database.

| Term | Definition | Source |
| --- | --- | --- |
| `E_total` | Account equity | `getWalletBalance().totalEquity` |
| `E_available` | Free collateral | `totalAvailableBalance` |
| `E_deployable` | Capital allowed in positions | `E_total × DN_DEPLOYMENT_TARGET_PCT` |
| `E_reserve` | Untouched buffer | `E_total − E_deployable` |
| `E_alloc_i` | Allocated equity for position `i` | Spot notional + perp margin + buffer |
| `E_deployed` | Sum of `E_alloc_i` across open positions | Calculated |
| `E_free` | `E_deployable − E_deployed` | Calculated |

**Do not confuse allocated equity with notional.** A position with `E_alloc = $1,000`, `L = 3`, `β = 5%` has a spot notional of about `$723`, not `$1,000`. The cap `DN_MAX_COIN_EQUITY_PCT = 10%` means "at most 10% of account equity can be lost/committed to this coin", not "10% notional".

### 5.2 Hard caps

| Cap | Env | Default | Enforcement |
| --- | --- | --- | --- |
| Per coin | `DN_MAX_COIN_EQUITY_PCT` | 10% | `E_alloc_i ≤ E_total × cap` |
| Deployment | `DN_DEPLOYMENT_TARGET_PCT` | 80% | `E_deployed ≤ E_deployable` |
| Reserve | `DN_MIN_RESERVE_PCT` | 20% | `E_total − E_deployed ≥ E_total × reserve` |
| Sector | `DN_MAX_SECTOR_EQUITY_PCT` | 30% | Sum by sector tag |
| Max positions | `DN_MAX_POSITIONS` | 8 | Count of open positions |
| Effective leverage | `DN_MAX_EFFECTIVE_LEVERAGE` | 3.0 | `Σ perp notional / E_total ≤ cap` |
| Unhedged notional | `DN_MAX_UNHEDGED_PCT` | 0.5% | `abs(Q_spot − Q_perp) × price ≤ E_total × cap` |
| Min position | `DN_MIN_POSITION_USDT` | 100 | `E_alloc_i ≥ min` |
| Min notional | Instrument | Exchange | Both legs above minimum |
| Drawdown | `DN_MAX_DRAWDOWN_PCT` | 10% | Stop new entries; flatten at 15% |

The caps must be mutually consistent. With `DN_MAX_COIN_EQUITY_PCT=10%` and `DN_DEPLOYMENT_TARGET_PCT=80%`, the portfolio holds at most 8 full-size positions. If the allocator cannot fill 8 positions above the minimum, the remainder stays in reserve; it is never forced into a sub-scale position.

### 5.3 Allocation algorithm

**Inputs:** eligible candidates with `score`, `E_total`, caps, existing positions, sector tags.

**Step 1 — Available capital.**

```
E_deployable = E_total × DN_DEPLOYMENT_TARGET_PCT
E_free = E_deployable − E_deployed
```

If `E_free < DN_MIN_POSITION_USDT`, stop.

**Step 2 — Score weights.**

```
W = Σ max(score_i, 0)
weight_i = max(score_i, 0) / W
```

If `W = 0`, stop.

**Step 3 — Water-filling with caps.**

```
remaining = E_free
for candidate in ranked:
  target = E_deployable × weight_i
  alloc = min(target, E_total × DN_MAX_COIN_EQUITY_PCT, remaining)
  if sector_cap_would_breach: alloc = min(alloc, sector_remaining)
  if alloc < DN_MIN_POSITION_USDT: skip
  allocate(alloc)
  remaining -= alloc
  if remaining <= 0: break
```

**Step 4 — Sector caps.** Maintain `sector_deployed[sector]`. A candidate's sector tag comes from a static map (`L1`, `L2`, `DeFi`, `AI`, `Meme`, `GameFi`, `RWA`, `Unknown`). If the map is missing, use `Unknown`; do not pretend diversification.

**Step 5 — Correlation guard (optional).** A simple cluster map can cap 2 positions per cluster (e.g., `ETH`/`ARB`/`OP` in one L2 cluster). This is a heuristic, not a covariance model.

**Step 6 — Convert to quantity.** See §5.4. If the converted `E_alloc` falls below the minimum, release the allocation and continue.

**Step 7 — Persist the allocation proposal.** The proposal is not an order. It is written to `dn_engine_state` with a short TTL (e.g., 10 minutes) so a restart cannot execute stale intent.

**Fallback:** if score-weighted allocation produces a highly concentrated book, use equal-weight top-N (`E_deployable / N`) capped by the per-coin cap. This is more robust when scores are noisy. The mode is configurable (`DN_ALLOCATION_MODE=score|equal`).

### 5.4 Equity-to-notional conversion

Given `E_alloc`, spot price `S`, perp price `P`, perp leverage `L`, and buffer fraction `β`:

```
E_alloc = N_s + N_p / L + β × N_s
N_p ≈ N_s × (P / S)

N_s = E_alloc / (1 + (P / S) / L + β)
Q_raw = N_s / S
```

Round **down** to the tightest common quantity step so both legs can be equal:

```
Q_spot = floorToStep(Q_raw, spot.qtyStep)
Q_perp = floorToStep(Q_raw, perp.qtyStep)
Q = min(Q_spot, Q_perp)
```

Then recompute actuals:

```
N_s = Q × S
N_p = Q × P
E_alloc_actual = N_s + N_p / L + β × N_s
```

**Checks:**

- `N_s ≥ spot.minOrderAmt`
- `N_p ≥ perp.minNotionalValue` (if present)
- `Q ≥ max(spot.minOrderQty, perp.minOrderQty)`
- `Q ≤ min(spot.maxOrderQty, perp.maxOrderQty)`
- `E_alloc_actual ≤ E_total × DN_MAX_COIN_EQUITY_PCT`

If any check fails, the allocation is rejected with `minSize` or `precision`, not silently rounded up. Rounding up would breach the cap; rounding down below the minimum would create an unhedgeable position.

### 5.5 Delta-neutrality math

**Base delta:**

```
Δ_base = Q_spot − Q_perp
```

With `Q_spot = Q_perp = Q`, `Δ_base = 0`.

**Notional delta:**

```
Δ_notional = Q × S − Q × P = −Q × S × b
```

where `b = (P − S) / S`. A 1% positive basis leaves a 1% short notional exposure. This is intentional: the position is short the basis. It is not a delta failure. The engine monitors it as **basis exposure**, not as an unhedged directional position.

**Why equal notional is wrong:**

```
If Q_perp = Q × S / P, then Δ_base = Q − Q×S/P = Q × (1 − S/P) = Q × b / (1 + b)
```

At `b = 1%`, `Δ_base ≈ 0.0099 × Q`, i.e. ~1% of the position remains long the base. That is a directional bet the strategy did not intend.

**Tolerance:** the engine targets `|Δ_base| ≤ DN_DELTA_TOLERANCE_QTY` (default one qty step) and `|Δ_notional| / E_total ≤ DN_MAX_UNHEDGED_PCT`. A larger gap triggers a re-hedge.

### 5.6 Capital efficiency

With `N_s ≈ N_p = N` and no buffer:

```
E = N + N/L = N × (1 + 1/L)
```

Funding yield per epoch on equity:

```
y_e = (N × f) / (N × (1 + 1/L)) = f × L / (L + 1)
```

With buffer `β`:

```
y_e = f × L / (L + 1 + βL)
```

| L | β | Equity per $1,000 spot | Funding yield factor |
| --- | --- | --- | --- |
| 1 | 0% | $2,000 | 0.500 × f |
| 2 | 0% | $1,500 | 0.667 × f |
| 3 | 0% | $1,333 | 0.750 × f |
| 3 | 5% | $1,383 | 0.723 × f |
| 5 | 5% | $1,260 | 0.794 × f |

Higher leverage improves funding yield on equity but reduces liquidation distance. The default `L = 3` is a deliberate compromise: 0.75× funding capture, ~33% nominal liquidation distance before maintenance margin, and enough buffer to survive a basis shock.

### 5.7 Margin and liquidation

**Live checks (every 30 seconds):**

- `accountMMRate` from `getWalletBalance` — the fraction of maintenance margin capacity in use.
- `positionIM`, `positionMM`, `liqPrice` from `getPositions`.
- `liq_distance = |liqPrice − markPrice| / markPrice`.
- `adlRankIndicator` — a rising ADL rank is a warning.

**Thresholds:**

| Metric | Warning | Critical | Action |
| --- | --- | --- | --- |
| `accountMMRate` | > 0.50 | > 0.75 | Reduce leverage / add margin / exit |
| `liq_distance` | < 30% | < 15% | Exit or de-risk immediately |
| `unrealisedPnl` on perp | < −5% of `E_alloc` | < −10% | Review hedge and margin |
| `adlRankIndicator` | ≥ 3 | ≥ 4 | Reduce position / alert |

**Short-perp liquidation approximation (isolated, no fees):**

```
P_liq ≈ P_entry × (1 + 1/L − mmr)
```

With `L = 3` and `mmr = 0.5%`, `P_liq ≈ 1.328 × P_entry`, i.e. ~33% above entry. This is a simplification; in UTA cross margin the venue computes a portfolio-level liquidation price. **Always use the exchange's `liqPrice` for live decisions**, and use the approximation only in the backtester.

**What happens if the perp liquidates:** the spot leg remains, so the account is long the base. The engine must detect this via reconciliation and either re-establish the hedge (if the account is healthy) or sell the spot (flatten). It must never assume the position is still hedged.

### 5.8 Rebalancing and compounding

- **No forced resizing on price drift.** The base quantities are fixed; notional drift is the basis, not a delta failure. Resizing would incur fees for no risk reduction.
- **Top-up only on a real delta gap** (partial fill, fee-in-base shortfall, manual intervention) and only if the gap exceeds `DN_DELTA_REHEDGE_THRESHOLD_PCT` (default 0.5% of `Q`).
- **Compounding is off by default.** Realized PnL accumulates in the account; new allocations use `E_total` at the next rebalance. If `DN_COMPOUND=true`, the allocator uses `E_total` including realized PnL, but only at scheduled rebalances — never intra-position.
- **Rebalance cadence:** on new entries/exits and once per day at 00:00 UTC. No intraday churn.

### 5.9 Portfolio drawdown guard

```
peak_equity = max(equity_t)
drawdown = (peak_equity − equity_t) / peak_equity
```

| Drawdown | Action |
| --- | --- |
| < 5% | Normal |
| 5–10% | Halve new allocation sizes; keep exits |
| 10–15% | Stop new entries; keep exits; alert |
| > 15% | Flatten all positions; kill switch; manual review |

The drawdown is measured on **total equity**, including floating PnL on both legs and accrued funding. It is not measured on realized PnL alone; a floating basis loss is real risk.

Reset requires: drawdown < 5%, reconciliation clean, no open incidents, and a manual `/dn_resume`.

---

## 6. Execution Engine & Legging Risk

### 6.1 Preflight checklist

Every entry must pass **all** checks. Any failure is terminal for that proposal; it is not retried on the next tick without a fresh screen.

| # | Check | Detail | Failure bucket |
| --- | --- | --- | --- |
| 1 | Kill switch | `DN_KILL_SWITCH=false`, engine not paused | `killSwitch` |
| 2 | Account | UTA, one-way, margin mode as configured | `accountMode` |
| 3 | Instruments | Both fresh (<1h), status `Trading` | `instrument` |
| 4 | Fees | Both categories fresh (<24h) | `feeStale` |
| 5 | Balance | `N_s + N_p/L + buffer ≤ E_available` | `insufficientBalance` |
| 6 | Basis | Within `[−maxNeg, max]` at the live tick | `basisOutOfBand` |
| 7 | Funding freshness | History fetched <1 interval ago; MA unchanged | `staleSignal` |
| 8 | Spread | ≤ `DN_MAX_SPREAD_BPS` on both legs | `wideSpread` |
| 9 | Depth | Top 10 levels ≥ 3× intended notional | `thinBook` |
| 10 | Existing position | No open DN position for symbol | `alreadyOpen` |
| 11 | Cooldown | Not in cooldown | `cooldown` |
| 12 | Size | Qty/notional above minimums, below maximums | `minSize` |
| 13 | Precision | Prices/qty formatted to tick/step | `precision` |
| 14 | Leverage | Perp leverage set to configured value | `leverage` |
| 15 | Idempotency | `orderLinkId` unused | `duplicate` |
| 16 | Funding window | Not within 60s before `nextFundingTime` (default) | `fundingWindow` |
| 17 | Maintenance | Exchange not in maintenance | `maintenance` |

**Depth check:** `getOrderbook({ category, symbol, limit: 50 })`; sum the quote value of the top 10 levels on the side being crossed. If the sum is below `3 × N`, the order is too large for the book. The factor is configurable (`DN_DEPTH_MULTIPLIER`).

### 6.2 Order policy matrix

| Leg | Default order | Price | Fallback | Notes |
| --- | --- | --- | --- | --- |
| Spot buy | Limit IOC | `ask + slippageCap` | Market IOC | Fee in base; hedge received qty |
| Perp short | Limit IOC | `bid − slippageCap` | Market IOC | `positionIdx: 0` |
| Perp close | Limit IOC, `reduceOnly` | `ask + slippageCap` | Market IOC, `reduceOnly` | Close perp first |
| Spot sell | Limit IOC | `bid − slippageCap` | Market IOC | After perp is flat |
| Rollback spot sell | Market IOC | — | Retry with wider cap | Must not leave unhedged long |
| Rollback perp close | Market IOC, `reduceOnly` | — | Retry | Must not leave unhedged short |

`slippageCap = DN_ENTRY_SLIPPAGE_BPS / 10_000` applied to the mid or the touch. Default 10 bps for liquid pairs; 20 bps for thinner books. The cap is a **limit price**, not a guarantee; the fill can be better.

**Maker-first mode (optional, off by default):**

- Spot post-only at the bid; if unfilled after `DN_MAKER_TIMEOUT_MS`, cancel and cross.
- Perp post-only at the ask (short); if unfilled, cancel and cross.
- Maker-first reduces fees but increases the time to hedge. It is only allowed when the unhedged window is bounded and the book is deep.
- **Never** leave a maker order resting while the other leg is filled and unhedged past `DN_MAX_UNHEDGED_MS`.

### 6.3 Why spot-first

| Scenario | Unhedged exposure | Worst-case loss | Verdict |
| --- | --- | --- | --- |
| Spot filled, perp not yet | Long base | `N_s` (price → 0) | Bounded; can sell spot |
| Perp filled, spot not yet | Short base | Unbounded (price → ∞) | Unacceptable |

**Rule:** the first leg is always the spot buy. The second leg is always the perp short. The exit reverses the order: perp buy-back first, spot sell second.

This asymmetry is the core execution safety property. It is not a performance optimization; it is a capital-preservation rule.

### 6.4 Legging state machine

```
IDLE
  │ SCAN_TICK / ALLOCATION_APPROVED
  ▼
PREFLIGHT ──fail──► IDLE (record bucket)
  │ pass
  ▼
SPOT_ENTRY_PENDING
  │ fill/partial                │ no fill / reject
  ▼                             ▼
HEDGE_PENDING                 IDLE
  │ both legs matched           │ hedge failed / timeout
  ▼                             ▼
HEDGED                        ROLLBACK_PENDING
  │                             │ spot sold
  ▼                             ▼
MONITORING                    ROLLED_BACK
  │ exit signal / kill switch
  ▼
EXIT_PENDING (perp close)
  │ perp flat                   │ perp close failed
  ▼                             ▼
SPOT_EXIT_PENDING             ORPHAN_PERP
  │ spot flat                   │ spot sell failed
  ▼                             ▼
CLOSED                        ORPHAN_SPOT
```

**State table:**

| State | Meaning | Allowed next states |
| --- | --- | --- |
| `IDLE` | No position, no pending intent | `PREFLIGHT` |
| `PREFLIGHT` | Validating an allocation | `SPOT_ENTRY_PENDING`, `IDLE` |
| `SPOT_ENTRY_PENDING` | Spot order live | `HEDGE_PENDING`, `IDLE` |
| `HEDGE_PENDING` | Perp hedge live/partial | `HEDGED`, `ROLLBACK_PENDING` |
| `HEDGED` | Both legs matched | `MONITORING` |
| `MONITORING` | Position open, managed | `EXIT_PENDING`, `ORPHAN_*` |
| `EXIT_PENDING` | Perp close in progress | `SPOT_EXIT_PENDING`, `ORPHAN_PERP` |
| `SPOT_EXIT_PENDING` | Spot sell in progress | `CLOSED`, `ORPHAN_SPOT` |
| `ROLLBACK_PENDING` | Spot sell after failed hedge | `ROLLED_BACK`, `ORPHAN_SPOT` |
| `CLOSED` | Terminal, flat, accounted | — |
| `ROLLED_BACK` | Terminal, flat, hedge failed | — |
| `ORPHAN_SPOT` | Long spot without hedge | Manual/auto resolution |
| `ORPHAN_PERP` | Short perp without spot | Manual/auto resolution |
| `HALTED` | Kill switch | Manual resume |

**Watchdogs:**

- `DN_MAX_UNHEDGED_MS` (default 3,000): if the second leg is not confirmed within this window, escalate to market and then rollback.
- `DN_MAX_LEGGING_RETRIES` (default 3): perp hedge attempts before rollback.
- `DN_ROLLBACK_RETRIES` (default 5): spot sell attempts before `ORPHAN_SPOT`.
- The watchdog runs every 250 ms while a position is in `SPOT_ENTRY_PENDING` or `HEDGE_PENDING`.

### 6.5 Partial fills

Partial fills are normal on thin books. The engine must hedge **what actually filled**, not what was ordered.

**Spot partial, perp not yet sent:**

1. Send the perp hedge for the filled spot quantity immediately.
2. Cancel the remaining spot order (or let it rest only if the policy allows).
3. If the remainder fills later, send an incremental hedge for the delta.
4. If the remainder is canceled, no further hedge is needed.

**Perp partial:**

1. Retry the remainder with a wider slippage cap.
2. If the retry fails and the filled perp quantity is less than the spot quantity, rollback the **residual spot** (sell the unhedged portion) or hedge it again.
3. Never leave a short perp larger than the spot quantity.

**Fee-in-base shortfall:**

A spot buy charged in base delivers `Q_received = Q_ordered × (1 − spot_fee)` (if the fee is taken in base). The perp hedge must be `Q_received`, not `Q_ordered`. If the engine hedges the ordered quantity, it is slightly short the base — a small but real directional exposure. Reconcile the actual received quantity from `getExecutions` and adjust.

### 6.6 Rollback procedures

**Case A — Spot filled, perp failed after retries:**

1. Cancel any resting perp order.
2. Sell the filled spot quantity with a market/IOC order.
3. If the sell fills: state `ROLLED_BACK`, record the loss (fees + slippage), release the allocation, alert INFO.
4. If the sell fails: state `ORPHAN_SPOT`, alert CRITICAL, retry with exponential backoff, keep the position visible to reconciliation. Never transition to `IDLE`.

**Case B — Perp filled, spot failed (only possible during re-hedge or manual repair):**

1. Buy the missing spot quantity with a market/IOC order.
2. If the buy fills: state `HEDGED`, continue.
3. If the buy fails: close the perp with a `reduceOnly` market order.
4. If both fail: state `ORPHAN_PERP`, alert CRITICAL. This is the most dangerous state; escalate immediately.

**Case C — Both legs filled but quantities mismatch:**

1. Compute `Δ = Q_spot − Q_perp`.
2. If `Δ > 0` (long residual), sell `Δ` spot or buy `Δ` perp (prefer selling spot; it reduces exposure).
3. If `Δ < 0` (short residual), buy `|Δ|` spot or close `|Δ|` perp (prefer buying spot; it removes the unbounded short).
4. Re-run the delta check. If still mismatched beyond tolerance, `ORPHAN_*`.

**Rollback is not a failure of the strategy; it is a controlled loss.** The incident is recorded with the exact fees, slippage and reason. A high rollback rate is a signal to tighten the preflight (depth, spread, timing), not to loosen the safety rules.

### 6.7 Idempotency

`orderLinkId` is the source of truth for ambiguous submissions.

```
orderLinkId = "dn" + positionId.slice(0, 8) + legCode + attempt
```

- Max 36 characters, alphanumeric.
- `legCode`: `SB` (spot buy), `PS` (perp short), `PC` (perp close), `SS` (spot sell), `RB` (rollback).
- Before retrying an ambiguous submission, query `getActiveOrders` and `getExecutions` by `orderLinkId`. If a fill exists, adopt it; do not resubmit.
- If the exchange rejects a duplicate `orderLinkId`, treat it as "already submitted" and reconcile.

**Never** retry a `submitOrder` blindly after a timeout. The SMC `executeWithRetry` pattern retries the HTTP call; for order placement, the idempotency key makes that safe, but the DN engine must still verify the fill state before sending a second order.

### 6.8 Precision and rounding

- Prices: `formatPrice(value, instrument.tickSize)`.
- Quantities: `formatQuantity(value, instrument.qtyStep)`.
- Never `toFixed()`, never `Math.round()` on money.
- Use `Decimal` for every intermediate value; convert to string only at the API boundary.
- Spot and perp have different `qtyStep` values. Choose `Q = min(floorToStep(...))` so both legs are equal and valid.
- Spot `minOrderAmt` is quote-denominated; perp `minNotionalValue` may be absent. Check both.

### 6.9 Fee-currency handling

| Fill | Fee currency | Effect | Hedge adjustment |
| --- | --- | --- | --- |
| Spot buy | Base asset (typical) | Received base = ordered × (1 − fee) | Hedge received base |
| Spot buy | Quote asset (some promos) | Fee reduces USDT, base unchanged | Hedge ordered base |
| Spot sell | Quote asset (typical) | Proceeds = qty × price × (1 − fee) | No hedge adjustment |
| Perp short/open/close | USDT (settle coin) | Fee reduces USDT | No qty adjustment |

**Rule:** read the actual `execFee` and `feeCurrency` from `getExecutions`; do not assume. The preflight estimate may use the standard model, but the post-fill bookkeeping must use the exchange's actual values.

### 6.10 Post-fill bookkeeping and orphan guard

Immediately after both legs are confirmed:

1. Transition to `HEDGED` **before** the DB write. This mirrors `AGENTS.md` Invariant 47: a WS close event during bookkeeping must see `IN_TRADE`/`HEDGED`, not `IDLE`.
2. Wait 500 ms for the venue to finalize.
3. Fetch `getPositions` and the spot balance; read actual `avgPrice`, `size`, fees.
4. Persist the position and legs in `dn_positions` / `dn_legs`.
5. If the DB write fails: **do not** reset to `IDLE`. Run `panicCloseOrphan`:
   - cancel any resting orders;
   - close the perp with `reduceOnly`;
   - sell the spot;
   - verify flat with 3 × 500 ms polls;
   - only then transition to `ROLLED_BACK` / `CLOSED`.
   If flatness cannot be verified, remain `ORPHAN_*` and alert CRITICAL. This mirrors Invariant 49.

### 6.11 Worked entry example

```
E_total          = $10,000
per-coin cap     = 10% → $1,000
L                = 3
β                = 5%
S                = $100.00
P                = $101.00 (1% basis)
spot_taker       = 0.10%
perp_taker       = 0.055%
spot_qtyStep     = 0.001
perp_qtyStep     = 0.01
```

Equity to notional:

```
N_s = 1000 / (1 + (101/100)/3 + 0.05)
    = 1000 / (1 + 0.33667 + 0.05)
    = 1000 / 1.38667
    = $721.15
Q_raw = 7.2115
Q = min(floor(7.2115, 0.001), floor(7.2115, 0.01)) = 7.21
N_s = 7.21 × 100 = $721.00
N_p = 7.21 × 101 = $728.21
E_alloc_actual = 721.00 + 728.21/3 + 0.05×721.00
               = 721.00 + 242.74 + 36.05
               = $999.79
```

Spot buy fee in base:

```
fee_base = 7.21 × 0.001 = 0.00721
Q_received = 7.21 − 0.00721 = 7.20279
```

The perp hedge should be `7.20` (rounded to 0.01 step) to match the received quantity within tolerance. If the engine hedges `7.21`, it is short `0.00721` base — a tiny directional exposure that reconciliation will flag.

Fees:

```
spot buy:  7.21 × 100 × 0.001 = $0.721
perp short: 7.21 × 101 × 0.00055 = $0.400
```

At exit, assume the same prices and fees:

```
spot sell:  7.20279 × 100 × 0.001 = $0.720
perp close: 7.20 × 101 × 0.00055 = $0.400
total fees ≈ $2.241
```

This is the number that must be amortized by funding.

---
## 7. Position Lifecycle: Time-Lock & Exit

### 7.1 Economic time-lock

The time-lock exists to prevent fee churn. A position that exits after one epoch almost always loses money, even if the funding rate was positive, because the four fills and slippage exceed one epoch of carry.

**Minimum holding epochs:**

```
k_min = ceil( (fee_round_trip + slippage_round_trip + profit_buffer) / f_ma )
```

Where:

- `fee_round_trip = 2 × (spot_fee + perp_fee)` as a fraction of notional.
- `slippage_round_trip = 2 × (σ_spot + σ_perp)` as a fraction of notional.
- `profit_buffer = DN_MIN_PROFIT_BUFFER_PCT` (default 0.10%).
- `f_ma` is the entry-time funding MA, not the live rate.

Clamp:

```
k_min = max(DN_MIN_HOLDING_EPOCHS, min(k_min, DN_MAX_HOLDING_EPOCHS))
```

Also enforce a wall-clock minimum:

```
min_hold_until = opened_at + DN_MIN_HOLDING_HOURS × 3600_000
```

Defaults: `DN_MIN_HOLDING_EPOCHS=3`, `DN_MIN_HOLDING_HOURS=24`, `DN_MAX_HOLDING_EPOCHS=90`.

**Worked example:** fees 0.31%, slippage 0.04%, profit buffer 0.10%, `f_ma=0.02%` → `(0.0031+0.0004+0.0010)/0.0002 = 22.5` → 23 epochs → 7.67 days at 8h. With `f_ma=0.05%`, it is 9 epochs → 3 days.

**The time-lock is economic, not a suicide pact.** Risk overrides (§7.4) can exit earlier. The lock only prevents **voluntary** early exits for impatience or minor rate noise.

### 7.2 Exit conditions

Evaluate every 5 minutes and at every funding boundary. Any **one** condition triggers an exit proposal; risk overrides execute immediately, economic exits wait for the next tick.

| # | Condition | Rule | Priority |
| --- | --- | --- | --- |
| 1 | Funding MA decay | `f_ma < DN_EXIT_FUNDING_RATE` for `DN_EXIT_CONSECUTIVE_EPOCHS` consecutive polls | Economic |
| 2 | Negative streak | Last `DN_NEGATIVE_STREAK_EPOCHS` realized epochs all < 0 | Economic |
| 3 | Net loss | `unrealized_net + expected_remaining_funding < −DN_MAX_LOSS_PCT × E_alloc` | Risk |
| 4 | Basis blowout | `basis > DN_MAX_BASIS_EXIT_PCT` | Risk |
| 5 | Margin | `accountMMRate > DN_MAX_MARGIN_RATIO` or `liq_distance < DN_MIN_LIQ_DISTANCE_PCT` | Risk (immediate) |
| 6 | Max holding | `holding_days > DN_MAX_HOLDING_DAYS` | Economic |
| 7 | Delisting | Instrument status not `Trading` | Risk (immediate) |
| 8 | Interval change | Funding interval changed and the thesis no longer holds | Economic |
| 9 | Manual | `/dn_close` or `/dn_flatten_all` | Immediate |
| 10 | Rotation | A better candidate clears the fee hurdle by `DN_ROTATION_MARGIN_APR` | Optional |

**Condition 1 detail:** `f_ma` is recomputed from realized history only. The exit threshold is deliberately lower than the entry threshold (hysteresis). If `DN_EXIT_CONSECUTIVE_EPOCHS=2`, two consecutive evaluations below the threshold are required; a single noisy print does not exit.

**Condition 2 detail:** a negative streak is more urgent than a low positive MA. If the last 3 epochs were negative, the position is paying to hold. Exit even if the long-run MA is still positive, unless the risk override says the basis loss from exiting is larger than the expected funding recovery. That comparison is explicit:

```
exit_cost = fees + slippage + realized_basis_loss_if_any
hold_expected = max(0, f_ma_next × k_remaining)
if exit_cost > hold_expected + DN_EXIT_LOSS_TOLERANCE: exit
```

**Condition 3 detail:** `unrealized_net` includes both legs' mark-to-market and accrued funding. `expected_remaining_funding` uses the current MA for the remaining planned epochs. If the sum is below the loss cap, exit. This prevents "waiting for the funding to come back" while the basis bleeds.

**Condition 4 detail:** a basis blowout means the perp premium widened dramatically. The short perp is losing mark-to-market faster than funding can compensate. Exit and re-enter later at a better basis. The threshold is a risk parameter, not a prediction.

**Condition 5 detail:** margin and liquidation are the only conditions that bypass the time-lock **and** the normal exit queue. Execute immediately, perp first.

### 7.3 Hysteresis

| Parameter | Entry | Exit |
| --- | --- | --- |
| Funding MA | `≥ DN_MIN_FUNDING_RATE` (e.g. 0.010%) | `≤ DN_EXIT_FUNDING_RATE` (e.g. 0.002%) |
| Basis | `≤ DN_MAX_BASIS` (e.g. 0.50%) | `≥ DN_MAX_BASIS_EXIT_PCT` (e.g. 1.00%) |
| Positive ratio | `≥ 0.80` | `< 0.50` for 2 consecutive polls |

The gap between entry and exit thresholds prevents a position from oscillating in and out around a single threshold, paying fees each time.

### 7.4 Risk overrides

The time-lock is suspended when any of the following is true:

- Margin ratio or liquidation distance breach.
- Instrument delisted / trading halted.
- Manual kill switch or `/dn_close`.
- Basis blowout beyond the exit threshold.
- Negative funding streak that makes holding cash-negative.
- Exchange maintenance that prevents orderly management (exit as soon as trading resumes).

In these cases, the engine exits **even at a loss**. A controlled loss is better than an uncontrolled liquidation or an unhedged leg.

### 7.5 Unwind order

**Always close the perpetual first, then sell spot.**

| Step | Action | Why |
| --- | --- | --- |
| 1 | Buy back perp `reduceOnly` | Removes the unbounded short exposure |
| 2 | Verify perp size = 0 | No residual short |
| 3 | Sell spot | Removes the bounded long exposure |
| 4 | Verify spot balance = 0 (or below dust) | No residual long |
| 5 | Mark `CLOSED`, compute PnL | Accounting |

If step 1 fails, **do not sell spot**. Selling spot while the perp short remains would create a naked short. Keep retrying the perp close; if it cannot be closed, state `ORPHAN_PERP` and alert CRITICAL.

If step 3 fails after the perp is flat, the account is long spot only. This is bounded and can be retried; state `ORPHAN_SPOT` until resolved.

### 7.6 Cooldown and re-entry

After a close, the symbol enters a cooldown:

```
cooldown_until = closed_at + DN_COOLDOWN_EPOCHS × fundingIntervalHours × 3600_000
```

Default `DN_COOLDOWN_EPOCHS=3`. This prevents re-entering the same symbol immediately after a fee-heavy exit and gives the funding regime time to stabilize.

Re-entry requires a fresh screen, a fresh preflight, and a new `positionId`. The old position's `orderLinkId` namespace is never reused.

### 7.7 Funding settlement handling

At each expected funding timestamp:

1. Poll `getTransactionLog({ type: 'SETTLEMENT', startTime, endTime })` for the symbol.
2. Match records by `symbol` and `transactionTime` within the settlement window.
3. Extract `funding`, `fee`, `cashFlow`, `currency`.
4. Insert into `dn_funding_accruals` with a deterministic idempotency key.
5. Update the position's `realized_funding`, `epochs_held`, and `last_funding_at`.
6. If the exchange record is missing after `DN_FUNDING_SYNC_GRACE_MS` (default 15 min), compute an **estimated** accrual from `Q × mark × rate` and mark it `SIMULATED`; reconcile later when the exchange record arrives.

**Do not double-count.** The unique key `(position_id, funding_time)` prevents duplicate accruals. If an exchange record arrives after a simulated one, update the row (replace, not add) and adjust `realized_funding` by the difference.

**Funding sign:** for the short perp, `payment = Q × mark × rate`. Positive rate → positive payment. Negative rate → negative payment. Store the signed value; never store `abs()`.

### 7.8 Exception cases

| Case | Detection | Action |
| --- | --- | --- |
| Funding interval changed | `fundingIntervalHour` differs from the cached value | Recompute annualized yield; re-evaluate exit |
| Funding cap hit | `fundingRate` at `fundingCap` | Warn; reduce score; do not add |
| Negative funding flip | MA < exit threshold | Exit per §7.2 |
| Perp delisted | Instrument status | Exit immediately; perp first |
| Spot delisted | Instrument status | Exit immediately; perp first, then spot |
| Exchange maintenance | API error / system status | Pause entries; keep monitoring; exit when trading resumes |
| Partial close | Perp close fills partially | Continue closing remainder; do not sell spot until perp flat |
| Duplicate funding record | Same key | Idempotent upsert |
| Missing funding record | No exchange row after grace | Simulated accrual + reconciliation |
| Clock drift | `syncServerTime` offset > 500ms | Re-sync; pause entries if unresolved |

---

## 8. Accounting & Yield Mathematics

### 8.1 PnL decomposition

For a position with base quantity `Q` (spot and perp equal):

| Component | Formula | Sign convention |
| --- | --- | --- |
| Spot PnL | `Q × (S_exit − S_entry)` | Long spot: positive when price rises |
| Perp PnL | `Q × (P_entry − P_exit)` | Short perp: positive when price falls |
| Basis PnL | `Q × [(P_entry − S_entry) − (P_exit − S_exit)]` | Positive when the premium converges |
| Funding PnL | `Σ Q × mark_k × f_k` | Positive when the short receives |
| Fees | `Σ (qty × price × fee_rate)` per fill | Always negative |
| Slippage | `Σ (expected_price − fill_price) × qty` in the adverse direction | Always negative (conservative) |
| **Net PnL** | Spot + Perp + Funding − Fees − Slippage | Signed |

Note that `Spot PnL + Perp PnL = Basis PnL` when quantities are equal. The decomposition is an accounting identity, not an approximation:

```
Q(S1 − S0) + Q(P0 − P1)
= Q[(P0 − S0) − (P1 − S1)]
= Q[S0 b0 − S1 b1]
= Q S0 [b0 − b1 (S1/S0)]
```

### 8.2 Funding accrual

For epoch `k` with funding rate `f_k` and mark price `mark_k`:

```
payment_k = Q_perp × mark_k × f_k
```

This is the **short's** PnL. If `f_k > 0`, the short receives; if `f_k < 0`, the short pays. No extra sign flip.

As a fraction of the entry spot notional `N0 = Q × S0`:

```
r_funding,k = f_k × (mark_k / S0)
```

If mark ≈ S0, `r_funding,k ≈ f_k`. Over `k` epochs:

```
r_funding = Σ f_k × (mark_k / S0)
```

**Why use mark, not last:** funding is calculated on the mark price. Using the last traded price introduces a small error, especially during volatility. In backtests, if mark price is unavailable, use the perp close at the funding timestamp and document the approximation.

### 8.3 Basis PnL

Define:

```
b0 = (P_entry − S_entry) / S_entry
b1 = (P_exit − S_exit) / S_exit
```

Basis PnL as a fraction of `N0`:

```
r_basis = b0 − b1 × (S_exit / S_entry)
```

If `S_exit ≈ S_entry`:

```
r_basis ≈ b0 − b1
```

**Interpretation:**

- Enter when `b0 > 0` (perp premium) and exit when `b1 ≈ 0`: positive basis PnL.
- Enter when `b0 > 0` and exit when `b1 > b0`: negative basis PnL (premium widened).
- Enter when `b0 < 0` (perp discount): the short is positioned at a discount and loses on convergence; this is why the screener has a negative-basis floor.

### 8.4 Fee model

Let:

- `s_in`, `s_out` = spot fee rates on entry/exit fills.
- `p_in`, `p_out` = perp fee rates on entry/exit fills.
- `S0`, `S1`, `P0`, `P1` = prices.

Fee cost in USDT:

```
fees = Q S0 s_in + Q P0 p_in + Q S1 s_out + Q P1 p_out
```

As a fraction of `N0 = Q S0`:

```
r_fees = s_in + p_in (P0/S0) + s_out (S1/S0) + p_out (P1/S0)
```

If `S1 ≈ P1 ≈ S0` and entry/exit rates are symmetric:

```
r_fees ≈ 2(s + p)
```

**Spot fee currency adjustment:** if the spot buy fee is charged in base, the hedged quantity is `Q(1 − s_in)`, not `Q`. The exact fee cost in USDT is still `Q S0 s_in`, but the perp notional is slightly smaller. The accounting must use the actual filled quantities, not the ordered quantity.

### 8.5 Slippage

Slippage is the difference between the decision price and the fill price, in the adverse direction:

```
slip_spot_buy  = (fill_spot − decision_spot) × Q
slip_perp_sell = (decision_perp − fill_perp) × Q
slip_perp_close= (fill_perp_close − decision_perp) × Q
slip_spot_sell = (decision_spot − fill_spot_sell) × Q
```

Total slippage is the sum. In live trading, it is measured from actual fills. In backtesting, it is modeled:

```
slip_bps = DN_SLIPPAGE_BASE_BPS + DN_SLIPPAGE_IMPACT_BPS × sqrt(notional / ADV)
```

where `ADV` is the 24h quote turnover. Clamp to `DN_SLIPPAGE_MAX_BPS`. The impact term captures size; the base term captures spread crossing.

### 8.6 Net yield formula

**On notional:**

```
r_net_notional = r_basis + r_funding − r_fees − r_slip
```

**On allocated equity:**

```
r_net_equity = r_net_notional × (N0 / E_alloc)
             = r_net_notional / (1 + (P0/S0)/L + β)
```

If `P0 ≈ S0`:

```
r_net_equity ≈ r_net_notional / (1 + 1/L + β)
```

**Annualized:**

```
APR = r_net_equity × (365 / holding_days)
APY = (1 + r_net_equity)^(365 / holding_days) − 1
```

Use APR for comparison across positions with different holding periods. Use APY only when explicitly modeling compounding; the engine does not compound intra-position.

### 8.7 Break-even epochs

Ignoring basis and slippage:

```
k_be = ceil( (2(s + p)) / f_ma )
```

With slippage and expected basis convergence:

```
k_be = ceil( (2(s + p) + 2(σ_s + σ_p) − (b0 − b1_assumed)) / f_ma )
```

If the result is ≤ 0, the basis convergence alone covers the costs; the setup is fee-positive even with zero funding. That is rare and should be treated as a basis trade, not a funding trade.

**Break-even days:**

```
days_be = k_be × fundingIntervalHour / 24
```

### 8.8 Worked end-to-end example

**Inputs:**

```
E_alloc        = $1,000
S0             = $100.00
P0             = $101.00  (b0 = 1.00%)
Q              = 7.21
N0             = $721.00
L              = 3
β              = 5%
spot_taker     = 0.10%
perp_taker     = 0.055%
f_ma           = 0.02% per 8h
holding        = 30 days = 90 epochs
exit basis b1  = 0.00%
slippage       = 0.02% per leg (0.04% round trip)
```

**Funding:**

```
r_funding = 90 × 0.0002 × (mark/S0 ≈ 1.005)
          ≈ 0.01809 = 1.809%
```

**Basis:**

```
r_basis = b0 − b1 = 1.00% − 0.00% = 1.00%
```

**Fees:**

```
r_fees ≈ 2 × (0.0010 + 0.00055) = 0.31%
```

**Slippage:**

```
r_slip ≈ 0.04%
```

**Net on notional:**

```
r_net_notional = 1.809% + 1.00% − 0.31% − 0.04% = 2.459%
```

**Net on allocated equity:**

```
r_net_equity = 2.459% / (1 + 1.005/3 + 0.05)
             = 2.459% / 1.385
             = 1.775%
```

**Annualized:**

```
APR = 1.775% × (365/30) = 21.60%
APY = (1.01775)^(12.167) − 1 ≈ 23.86%
```

**If the basis does not converge (exit b1 = 1.00%):**

```
r_net_notional = 1.809% + 0% − 0.31% − 0.04% = 1.459%
r_net_equity = 1.459% / 1.385 = 1.053%
APR = 12.81%
```

The basis assumption is the largest source of dispersion. The backtester must report both "converge" and "stay" scenarios, not just one.

### 8.9 Sensitivity tables

**Assumptions:** `L=3`, `β=0`, no basis/slippage, fees `0.31%` round trip. Values are net APR on allocated equity.

| f per 8h | 30 days | 90 days | 180 days |
| --- | --- | --- | --- |
| 0.005% | 1.28% | 3.16% | 3.55% |
| 0.010% | 5.38% | 7.27% | 7.69% |
| 0.020% | 13.60% | 15.48% | 15.93% |
| 0.030% | 21.81% | 23.70% | 24.16% |
| 0.050% | 38.23% | 40.12% | 40.60% |

**With 0.24% fees (maker perp legs):**

| f per 8h | 30 days | 90 days | 180 days |
| --- | --- | --- | --- |
| 0.005% | 2.19% | 3.64% | 3.90% |
| 0.010% | 6.29% | 7.75% | 8.01% |
| 0.020% | 14.51% | 15.96% | 16.23% |
| 0.030% | 22.72% | 24.18% | 24.45% |
| 0.050% | 39.14% | 40.60% | 40.87% |

**Break-even days:**

| f per 8h | 0.31% fees | 0.24% fees | 0.15% fees |
| --- | --- | --- | --- |
| 0.005% | 20.7 | 16.0 | 10.0 |
| 0.010% | 10.3 | 8.0 | 5.0 |
| 0.020% | 5.2 | 4.0 | 2.5 |
| 0.030% | 3.4 | 2.7 | 1.7 |
| 0.050% | 2.1 | 1.6 | 1.0 |

These tables are illustrative, not forecasts. They exist to show why the fee tier and the holding horizon dominate the strategy's viability.

### 8.10 What `0.15%` really means

At `0.15%` round-trip and `f_ma=0.01%`, break-even is 15 epochs (5 days). At `0.31%`, it is 31 epochs (10.3 days). The difference is **5.3 days of extra funding risk** for the same trade. If the rate flips negative during that window, the "cheaper" assumption turns a small profit into a loss.

**Rule:** never hardcode `0.15%`. Read `getFeeRate` for both categories, add the measured slippage, and compute `k_be` per symbol. If the actual cost is worse than the config's `DN_ASSUMED_ROUND_TRIP_FEE` by more than `DN_FEE_DRIFT_TOLERANCE`, pause new entries and alert.

### 8.11 Precision and rounding rules

- Every money value is `Decimal` in memory and a string in the DB (`NUMERIC(24,8)`).
- Convert to `number` only at the Chart.js/report boundary, never in accounting.
- Round prices with `formatPrice(value, tickSize)`.
- Round quantities with `formatQuantity(value, qtyStep)`.
- Fees and funding are stored at 8 decimals; the exchange may report more, so round only at persistence.
- PnL is computed from **actual fills**, not from planned prices. If an actual fill is missing, the position is `ORPHAN_*`, not approximated.
- Negative zero is normalized to zero before persistence.

---
## 9. Backtester Specification

### 9.1 Objectives

The backtester must answer five questions, in this order:

1. **Viability:** Does the strategy clear round-trip fees and slippage over the chosen window, at the account's actual fee tier?
2. **Selection quality:** Does the screener's funding MA and eligibility funnel separate profitable from unprofitable symbols, or is it selecting noise?
3. **Capital efficiency:** How does portfolio-level allocation (caps, reserve, concurrency) affect returns and drawdown versus per-symbol isolation?
4. **Robustness:** How much does the result degrade under funding haircuts, fee increases, basis widening, slippage doubling and hedge delays?
5. **Parity:** Would the live engine have made the same decisions with the same data? The same pure functions and rejection buckets must be used.

The backtester is a **research and validation tool**, not a profit projector. It must be conservative by default: taker fees, positive slippage, no perfect fills, no lookahead.

### 9.2 Data sources and caching

| Dataset | API | Use | Cache |
| --- | --- | --- | --- |
| Funding history | `getFundingRateHistory({ category: 'linear', symbol, startTime, endTime, limit: 200 })` | Realized funding per epoch; the core signal and accrual | `data/dn/funding/<SYMBOL>.json` |
| Spot klines | `getKlines({ category: 'spot', symbol, interval, start, end, limit })` | Spot entry/exit, basis, slippage | `data/dn/klines/<SYMBOL>_spot_<interval>.json` |
| Perp klines | `getKlines({ category: 'linear', symbol, interval, start, end, limit })` | Perp entry/exit, basis, liquidation | `data/dn/klines/<SYMBOL>_linear_<interval>.json` |
| Mark price klines | `getMarkPriceKline({ category: 'linear', symbol, interval, start, end, limit })` | Accurate funding accrual at settlement | `data/dn/klines/<SYMBOL>_mark_<interval>.json` |
| Instrument info | `getInstrumentsInfo({ category, symbol })` | Qty steps, min notional, funding interval | `data/dn/instruments/<SYMBOL>.json` |
| Fee rates | `getFeeRate({ category, symbol })` | Current fee tier | `data/dn/fees.json` |
| Transaction log (optional) | `getTransactionLog({ type: 'SETTLEMENT', ... })` | Validate live-period funding against the exchange | Not cached |

**Pagination and retry:** reuse the SMC `historyLoader` semantics — 8 attempts per chunk, 3s pause, log `[WARN] Fetch chunk failed, retrying...`, and on permanent failure break pagination rather than crashing. An empty result must not overwrite a non-empty cache file.

**Funding history pagination:** `limit` max 200. Iterate backwards with `endTime` until the requested window is covered. Deduplicate by `fundingRateTimestamp`. Sort ascending. If a gap exceeds 2× the expected interval, mark the symbol `dataGap` for that window.

**OHLC interval:** default `60` (1h) for full mode. `240` (4h) is acceptable for long windows; `15` is allowed but slower. Never use 1m for multi-month portfolios — the memory and API cost are unnecessary for a funding strategy.

**Universe survivorship:** the backtest uses the **current** symbol list. Delisted symbols are excluded, which biases results upward. Mitigation: maintain an optional `DN_BACKTEST_UNIVERSE_EXTRA` list of known delisted symbols and include them if history exists; report the bias explicitly.

### 9.3 Two simulation modes

| Mode | Inputs | Fidelity | Speed | Use |
| --- | --- | --- | --- | --- |
| `FUNDING_ONLY` | Funding history, daily closes, fixed/estimated basis | Medium | Fast (50 symbols × 1 year in seconds) | Universe screening, long-window viability, parameter sweeps |
| `FULL_OHLC` | Funding history, spot/perp 1h OHLC, mark price | High | Slower (minutes) | Final validation, stress, drawdown, liquidation |

**`FUNDING_ONLY` model:**

- Entry/exit at the daily close (or next daily open) with a configurable basis assumption (`DN_BACKTEST_BASIS_PCT`, default 0.10%).
- Fees and slippage applied per leg.
- Funding accrued at each historical funding timestamp.
- No intrabar liquidation; a margin check at each daily close flags `MARGIN_WARNING`.
- Portfolio allocation and time-lock simulated exactly as live.

**`FULL_OHLC` model:**

- Signals evaluated at bar close `t`.
- Entry executed at bar open `t+1` (causal).
- Spot and perp legs filled at their respective `t+1` opens plus slippage.
- Basis computed from the actual prices.
- Funding accrued at the settlement timestamp using the mark-price close (or perp close if mark unavailable).
- Exit executed at `t+1` open after the exit signal.
- Intrabar liquidation check: if the perp high (for a short) reaches the liquidation price, force close.
- Optional legging delay: execute the perp leg `N` seconds after the spot leg with a price shock drawn from the bar's high-low range. This models the unhedged window.

### 9.4 Event model and causality

The simulator is an **event loop over a merged timeline**:

```
events = merge(funding_events, price_bars, rebalance_ticks) sorted by timestamp
for event in events:
  if event.type == 'funding': accrue if position open and entry_time < event.time <= exit_time
  if event.type == 'bar':     update marks; evaluate signals at close; schedule execution at next open
  if event.type == 'rebalance': allocate capital for new signals; expire stale proposals
```

**Causality rules (hard):**

1. A signal at bar `t` may use only data with `timestamp <= t`.
2. Execution occurs at `t+1` open, never at `t` close.
3. The funding MA at time `t` uses only funding events with `timestamp < t`.
4. A funding event at time `t` is credited only if the position was opened **before** `t` and is still open at `t` (strict).
5. The universe at time `t` includes only symbols with a valid listing and data at `t`.
6. Fee rates and instrument filters are the ones known at `t`; if historical fee changes are unavailable, use the current snapshot and disclose the limitation.
7. No future-aware selection: a symbol cannot be chosen at `t` because it performed well later.

**Lookahead tests are mandatory** (see §14.5). A backtest that violates any of these rules is invalid, even if the PnL looks plausible.

### 9.5 `FundingExecutionSimulator`

**Responsibilities:**

- Maintain per-symbol position state: `FLAT`, `SIGNAL`, `SPOT_FILLED`, `HEDGED`, `EXITING`, `CLOSED`.
- Compute entry quantity from allocated equity and prices.
- Apply fees, slippage, and fee-currency adjustments.
- Accrue funding at settlement timestamps.
- Evaluate time-lock and exit conditions.
- Record every leg, funding accrual, and PnL component.
- Emit events for the portfolio simulator (capital released, drawdown updated).

**Interface (conceptual):**

```ts
interface FundingSimulatorInput {
  symbol: string;
  funding: FundingEvent[];
  spotBars: OhlcBar[];
  perpBars: OhlcBar[];
  markBars?: OhlcBar[];
  instrument: InstrumentPair;
  fees: FeeSnapshot;
  config: DnConfig;
}

interface FundingSimulatorOutput {
  legs: SimLeg[];
  accruals: SimAccrual[];
  positions: SimPosition[];
  metrics: SymbolMetrics;
  rejections: Record<string, number>;
}

function runFundingSimulation(input: FundingSimulatorInput): FundingSimulatorOutput;
```

**Entry algorithm (FULL_OHLC):**

1. At bar `t` close, evaluate `evaluateCandidate` with the funding history up to `t`.
2. If eligible and the portfolio allocates capital, create a pending entry for `t+1`.
3. At `t+1` open:
   - `S_exec = spot_open × (1 + slip_spot)`
   - `P_exec = perp_open × (1 − slip_perp)` (short sells lower)
   - Compute `Q` from `E_alloc`, `S_exec`, `P_exec`, `L`, `β`.
   - Apply spot buy fee in base: `Q_received = Q × (1 − s_in)`.
   - Set perp qty to `Q_received` (rounded to perp step).
   - Record fees and slippage.
4. Set `entry_time = t+1 timestamp`, `entry_basis = (P_exec − S_exec) / S_exec`.
5. State `HEDGED`.

**Funding accrual:**

```
for each funding event f with entry_time < f.time <= exit_time:
  mark = markBars.closeAt(f.time) ?? perpBars.closeAt(f.time)
  payment = Q_perp × mark × f.rate
  accruals.push({ time: f.time, rate: f.rate, mark, payment })
```

**Exit algorithm:**

1. At bar `t` close, evaluate exit conditions using the funding MA up to `t`, the current basis, the margin state, and the time-lock.
2. If exit, schedule for `t+1` open.
3. At `t+1` open:
   - Close perp at `P_exit = perp_open × (1 + slip_perp_close)` (buy back higher).
   - Sell spot at `S_exit = spot_open × (1 − slip_spot_sell)`.
   - Apply fees.
   - Compute basis PnL, funding PnL, fees, slippage, net PnL, ROE.
4. State `CLOSED`, release capital after the cooldown.

**Risk override:** if the bar's high (short) crosses the liquidation price, close the perp at the liquidation price with a penalty, then sell spot at the next open. Record `LIQUIDATED` and a negative PnL. This is a conservative stress outcome, not a forecast.

### 9.6 Portfolio simulation

The portfolio simulator sits above the per-symbol simulators:

- **Shared equity** `E_total`, initialized from config (`DN_BACKTEST_INITIAL_EQUITY`, default $10,000).
- **Allocation cadence:** daily at 00:00 UTC (or on a new signal, depending on `DN_BACKTEST_REBALANCE`).
- **Ranking:** all eligible symbols at that timestamp, sorted by score.
- **Caps:** per-coin, deployment, sector, max positions, reserve — identical to live.
- **Concurrency:** a symbol can have at most one open position. Signals for an already-open symbol are rejected with `alreadyOpen`.
- **Capital release:** on close, `E_alloc` returns to `E_free` after the cooldown; realized PnL is added to `E_total` if compounding is enabled, otherwise kept as cash.
- **Drawdown guard:** the same 5%/10%/15% thresholds; the backtest must show whether the guard improves or hurts the result.
- **No intraday rebalancing** unless configured; daily is enough for a funding strategy and avoids fee churn.

**Portfolio equity:**

```
equity_t = cash + Σ (spot_qty × S_t) + Σ perp_unrealized_t + accrued_funding_t
```

`cash` includes realized PnL and fees. `accrued_funding_t` is the sum of funding payments up to `t` (including simulated estimates). Fees are realized at fill; funding at settlement.

### 9.7 Execution and fee model

| Component | Model | Default |
| --- | --- | --- |
| Spot buy fee | Base asset: `Q_received = Q × (1 − s)` | 0.10% |
| Spot sell fee | Quote asset: `proceeds = Q × S × (1 − s)` | 0.10% |
| Perp fee | USDT: `Q × P × p` | 0.055% taker |
| Maker mix | `DN_BACKTEST_MAKER_FILL_RATIO` ∈ [0,1]; 0 = all taker | 0 |
| Slippage | `base_bps + impact_bps × sqrt(notional / ADV)` | 2 bps + 5 bps |
| Slippage cap | `DN_SLIPPAGE_MAX_BPS` | 50 bps |
| Legging delay | `DN_BACKTEST_LEGGING_DELAY_MS` | 0 (base), 5,000 (stress) |
| Funding | `Q × mark × rate` | Mark close |

**Fee scenario multipliers:**

- `base`: actual `getFeeRate` values.
- `maker`: perp maker rate on both perp legs, spot taker.
- `stress`: base × 1.5.
- `vip`: configurable override (e.g., 0.06% spot, 0.03% perp).

**No perfect fills:** a limit order that would have filled at the exact low/high is not assumed to fill unless the bar traded through the price by at least one tick. Market orders fill at the open plus slippage.

**No zero-slippage:** every leg pays at least `DN_SLIPPAGE_BASE_BPS`, even in the base scenario. This is deliberately pessimistic.

### 9.8 Liquidation and stress

**Liquidation model (short perp, isolated approximation):**

```
P_liq ≈ P_entry × (1 + 1/L − mmr)
```

For each bar while `HEDGED`:

```
if bar.high >= P_liq:
  close perp at P_liq × (1 + DN_LIQUIDATION_PENALTY_PCT)
  close spot at next open
  record LIQUIDATED
```

`mmr` is the maintenance margin rate from the instrument's risk limit tier; if unavailable, use `DN_BACKTEST_MMR` (default 0.5%). The model is conservative: UTA cross margin may delay liquidation, but the backtest must not assume that benefit.

**Stress matrix:**

| Scenario | Perturbation | Purpose |
| --- | --- | --- |
| `BASE` | Actual fees, base slippage | Reference |
| `FUNDING_HAIRCUT_50` | All funding × 0.5 | Rate compression |
| `FUNDING_NEGATIVE_30D` | Flip sign for a 30-day window | Regime reversal |
| `FEE_50` | All fees × 1.5 | Fee-tier risk |
| `BASIS_WIDEN_50` | Add +50 bps to entry basis; exit at +50 bps | Premium blowout |
| `BASIS_CONVERGE` | Exit basis = 0 | Best-case basis |
| `SLIPPAGE_2X` | Slippage × 2 | Liquidity stress |
| `HEDGE_DELAY_5S` | Perp leg 5s later with adverse move | Legging risk |
| `LIQUIDITY_CRUNCH` | Slippage × 5 for 1% of days | Tail liquidity |
| `EXCHANGE_OUTAGE_24H` | No exits for 24h | Operational risk |
| `ALL_WORST` | Funding −50%, fees +50%, slippage ×2, basis +50 bps | Combined stress |

The report must show **all** scenarios, not just the base. A strategy that only works in `BASE` is not viable.

### 9.9 Metrics

**Per symbol:**

| Metric | Formula / definition |
| --- | --- |
| Net PnL | Sum of closed-position net PnL |
| Gross funding | Sum of positive and negative funding payments |
| Basis PnL | Sum of `Q × (b_entry − b_exit)` |
| Fees | Sum of all fills |
| Slippage | Sum of adverse fill differences |
| ROE | `net_pnl / Σ E_alloc` (time-weighted optional) |
| APR | `ROE × 365 / holding_days` |
| Epochs held | Count of funding settlements while open |
| Break-even progress | `gross_funding / round_trip_fees` |
| Win rate | Winning positions / closed positions |
| Profit factor | Gross profit / gross loss |
| Average win/loss | Mean PnL of wins and losses |
| Max drawdown | Peak-to-trough on the symbol's equity |
| Liquidations | Count |

**Portfolio:**

| Metric | Definition |
| --- | --- |
| Net PnL | Sum across symbols |
| Portfolio ROE | `net_pnl / average_deployed_equity` |
| Portfolio APR | Annualized from the run window |
| Max drawdown | Peak-to-trough on portfolio equity, including floating PnL |
| Calmar | APR / max drawdown |
| Sharpe | Mean per-epoch return / stdev × sqrt(epochs_per_year) |
| Sortino | Mean / downside deviation |
| Utilization | `average_deployed / E_total` |
| Turnover | Number of entries/exits per year |
| Funding/fee ratio | Gross funding / fees |
| Rejection funnel | Counts by bucket |
| Open-position count | Average and max |

**Report caveats:** Sharpe on a low-frequency strategy with 20–100 positions is noisy. Report it with the number of observations and do not over-interpret. The primary decision metrics are net APR after stress, max drawdown, and funding/fee ratio.

### 9.10 Rejection funnel

The backtest funnel uses the **same bucket names** as live:

```
noSpotPair, notTrading, insufficientHistory, dataGap,
lowLiquidity, wideSpread, fundingBelowFloor, fundingUnstable,
fundingAtCap, basisOutOfBand, feeHurdle, belowHurdle,
cooldown, allocationCap, minSize, alreadyOpen, killSwitch
```

For each rebalance, count every symbol once at its deepest rejection. Report:

- absolute counts,
- share of evaluated symbol-days,
- trend over time (weekly buckets),
- comparison between profitable and unprofitable periods.

A funnel that rejects 95% of symbols is not necessarily bad — funding carry is selective. A funnel that rejects 5% but produces negative net PnL is a selection failure.

### 9.11 Artifacts

| Artifact | Content |
| --- | --- |
| `data/dn/DN_Report_<runId>.txt` | Summary, per-symbol table, portfolio metrics, funnel, stress matrix, caveats |
| `data/dn/DN_Equity_<runId>.html` | Equity curve, drawdown, deployed capital, position count (Chart.js, self-contained) |
| `data/dn/DN_Positions_<runId>.csv` | One row per position: symbol, entry/exit, qty, prices, basis, funding, fees, net PnL, ROE, epochs, exit reason |
| `data/dn/DN_Funding_<runId>.csv` | One row per accrual: position, time, rate, mark, payment |
| `data/dn/DN_Stress_<runId>.csv` | Scenario × metric matrix |
| `data/dn/DN_Manifest_<runId>.json` | Git commit, config hash, window, symbols, fee scenario, data hashes |

Artifact writing is non-fatal: a disk error logs a warning and never aborts the run. This mirrors the SMC reporter.

### 9.12 CLI and configuration

```bash
# Funding-only sweep over the current universe
npm run dn:backtest -- --mode funding --days 180 --fee-scenario base

# Full OHLC validation for a shortlist
npm run dn:backtest -- --mode full --symbols NEARUSDT,APTUSDT,LINKUSDT --days 90 --fee-scenario maker

# Stress matrix
npm run dn:backtest -- --mode full --days 90 --stress all

# Offline (cache only, zero network)
npm run dn:backtest -- --mode full --days 90 --offline
```

| Flag | Default | Meaning |
| --- | --- | --- |
| `--mode` | `funding` | `funding` or `full` |
| `--days` | `DN_BACKTEST_DAYS` (180) | Window length |
| `--start` / `--end` | derived | Explicit UTC window |
| `--symbols` | all eligible | Comma-separated shortlist |
| `--fee-scenario` | `base` | `base`, `maker`, `stress`, `vip` |
| `--stress` | `base` | `base`, `all`, or a named scenario |
| `--offline` | `false` | Cache only; fail if missing |
| `--seed` | `42` | Deterministic slippage/legging draws |
| `--initial-equity` | `10000` | Portfolio starting equity |
| `--json` | `false` | Machine-readable output |

### 9.13 Golden tests and reproducibility

- **Golden dataset:** 3 symbols, 30 days, fixed funding and OHLC fixtures. Assert net PnL, funding, basis, fees and ROE to 8 decimals.
- **Causality test:** inject a funding spike at `t`; assert the signal at `t−1` does not see it and the entry occurs at `t+1` open.
- **Fee-currency test:** spot buy fee in base reduces the hedged qty; assert the perp qty matches the received qty, not the ordered qty.
- **Break-even test:** a position exits before `k_min` only if a risk override fires.
- **Liquidation test:** a bar that crosses the liquidation price produces `LIQUIDATED` and a negative PnL.
- **Reproducibility:** the manifest includes the git commit, config hash, data file hashes and seed. Two runs with the same manifest must produce identical output.
- **Offline test:** `--offline` with a complete cache produces the same result as the online run.

### 9.14 Limitations

| Limitation | Effect | Mitigation |
| --- | --- | --- |
| Survivorship bias | Current universe excludes delisted symbols; upward bias | Optional extra list; disclose |
| Historical fee tiers unavailable | Current fees applied to history; may over/understate | Stress fee scenarios; disclose |
| Mark price gaps | Funding accrual uses close if mark missing | Prefer mark klines; document error |
| Simplified liquidation | Isolated approximation, not UTA portfolio margin | Conservative; stress `ALL_WORST` |
| No historical order-book depth | Slippage model is an approximation | Base + impact model; stress ×2/×5 |
| No exchange outage history | Outage scenarios are synthetic | Explicit stress scenario |
| Daily allocation cadence | Intraday opportunities missed | Full OHLC mode with rebalance option |
| Funding regime change | History may not repeat | Negative-funding stress; live exit rules |

---
## 10. Reconciliation & Recovery

### 10.1 Reconciliation loop

Runs every `DN_RECONCILE_INTERVAL_MS` (default 10 minutes). It is the **only** authority that can declare a position healthy or orphaned. It never trusts the in-memory state alone.

**Step 1 — Fetch exchange truth.**

- `getWalletBalance({ accountType: 'UNIFIED' })` → `totalEquity`, `totalAvailableBalance`, `accountMMRate`, coin balances.
- `getPositions({ category: 'linear' })` → every perp position, including `size`, `avgPrice`, `liqPrice`, `positionIM`, `positionMM`, `unrealisedPnl`.
- Spot balances from the wallet response → base-asset quantity per symbol.
- `getActiveOrders({ category: 'spot' | 'linear' })` → resting orders.

**Step 2 — Load DB truth.**

- `dn_positions` where `status = 'OPEN'`.
- `dn_legs` for each position.
- `dn_funding_accruals` since the last cursor.

**Step 3 — Compare per position.**

| Check | Tolerance | Action |
| --- | --- | --- |
| Spot qty vs DB | `max(1 qtyStep, 0.1% of Q)` | Re-hedge or flag |
| Perp qty vs DB | `max(1 qtyStep, 0.1% of Q)` | Re-hedge or flag |
| `abs(Q_spot − Q_perp)` | `DN_DELTA_TOLERANCE_PCT × Q` | Re-hedge |
| Perp side | Must be `Sell` | If `Buy` or `None`, investigate |
| Position status | `OPEN` in DB and on exchange | Orphan handling |
| Resting orders | None for a `HEDGED` position | Cancel stale orders |
| `liqPrice` distance | `≥ DN_MIN_LIQ_DISTANCE_PCT` | Alert / de-risk |
| `accountMMRate` | `≤ DN_MAX_MARGIN_RATIO` | Alert / de-risk |

**Step 4 — Orphan handling.** See §10.3.

**Step 5 — Funding and fee sync.**

- `getTransactionLog({ type: 'SETTLEMENT', startTime: lastCursor, endTime: now })`.
- For each `funding` record, match to an open position by symbol and time window.
- Upsert into `dn_funding_accruals` with a deterministic key.
- For each `fee` record, match to a leg by `orderId`/`tradeId`; if the leg's fee differs, update it and log a drift incident.
- Advance the cursor only after a successful commit.

**Step 6 — Drift detection.**

```
db_net = Σ realized_funding + Σ realized_basis + Σ spot_pnl + Σ perp_pnl − Σ fees
exchange_net = totalEquity − initialEquity − deposits + withdrawals
drift = |db_net − exchange_net| / initialEquity
```

If `drift > DN_DRIFT_TOLERANCE_PCT` (default 0.1%), log `RECON_DRIFT`, alert, and freeze new entries until resolved. Do not silently adjust the DB to match; investigate first.

**Step 7 — Persist health.**

Write `last_reconcile_at`, `last_funding_sync_at`, `open_positions`, `deployed_equity`, `drift`, and `incident_count` to `dn_engine_state`. The healthcheck reads this.

### 10.2 Startup recovery

On process start, before any screen or order:

1. Load `dn_engine_state`. If `kill_switch = true`, enter `HALTED` and do not trade.
2. Load `dn_positions` where `status = 'OPEN'`.
3. Fetch exchange positions and spot balances.
4. For each DB position, verify both legs and quantities.
5. If a position is healthy → state `MONITORING`, resume.
6. If a position is orphaned → `ORPHAN_*`, alert, and attempt resolution per §10.3.
7. If the exchange has a position that the DB does not know about:
   - If it matches a known symbol and looks like a DN hedge, create an `ADOPTED` position after verifying the spot leg.
   - If not, **do not touch it**; alert CRITICAL. It may belong to another system (which should be impossible with a dedicated sub-account, but never assume).
8. If the DB has a position that the exchange does not → mark `CLOSED` with the last known data, alert, and investigate.
9. Only after reconciliation is clean may the screener start.

**Rule:** never place a new order before startup reconciliation completes. A restart during a legging window is the most dangerous moment; the startup audit is the safety net.

### 10.3 Orphan leg decision table

| Spot | Perp | Interpretation | Action | Priority |
| --- | --- | --- | --- | --- |
| Present | Missing | Long spot only (bounded) | Re-hedge with perp short; if fails, sell spot | High |
| Missing | Present (short) | Naked short (unbounded) | Buy spot immediately; if fails, close perp reduceOnly | **Critical** |
| Present | Present, qty mismatch | Delta drift | Adjust the smaller leg; prefer selling excess spot over adding short | High |
| Present | Present, wrong side | Data/position error | Freeze, alert, manual review | **Critical** |
| Missing | Missing | Already flat | Mark closed, reconcile PnL | Normal |
| Spot > perp | — | Long residual | Sell `Δ` spot | High |
| Perp > spot | — | Short residual | Buy `abs(Δ)` spot; if fails, close `abs(Δ)` perp | **Critical** |

**Never** resolve a naked short by selling more spot. **Never** resolve a long residual by opening more short than the spot quantity.

### 10.4 Funding sync details

`TransactionLogV5` has no `id`. Use:

```
key = sha256(`${symbol}|${transactionTime}|${funding}|${fee}|${cashFlow}|${currency}`)
```

Store it as `external_key` with a unique index. On conflict, update the row only if the values differ (and log a drift incident). This makes the sync idempotent across restarts and overlapping windows.

**Settlement window:** `[fundingTime − 5 min, fundingTime + 15 min]`. Bybit may post the record slightly after the timestamp. If no record appears within `DN_FUNDING_SYNC_GRACE_MS`, create a `SIMULATED` accrual and reconcile later.

**Fee sync:** match by `orderId` or `orderLinkId`; if neither is present, match by `tradeId` and symbol. A missing fee on a filled leg is a data bug; alert and use the exchange's `fee` field when it arrives.

### 10.5 Drift detection

| Drift source | Symptom | Action |
| --- | --- | --- |
| Funding mismatch | DB funding ≠ exchange funding | Re-sync, replace simulated rows |
| Fee mismatch | DB fee ≠ exchange fee | Update leg, log incident |
| Missing fill | DB leg qty < exchange qty | Adopt fill, re-hedge |
| Extra fill | DB leg qty > exchange qty | Investigate, do not delete |
| Price mismatch | DB avg price ≠ exchange avg price | Update to exchange truth |
| Equity mismatch | `db_net` ≠ `exchange_net` | Freeze entries, investigate |
| Clock drift | Funding timestamps off | Sync, re-evaluate |

**Tolerance:** `DN_DRIFT_TOLERANCE_PCT = 0.001` (0.1% of equity). A drift of 0.1% on a $10,000 account is $10; that is already material for a strategy earning a few percent per month.

### 10.6 Incident taxonomy

| Code | Severity | Meaning | Runbook |
| --- | --- | --- | --- |
| `DN_ORPHAN_SPOT` | High | Long spot without hedge | §10.3, re-hedge or sell |
| `DN_ORPHAN_PERP` | Critical | Naked short | §10.3, buy spot or close perp |
| `DN_ROLLBACK_FAILED` | Critical | Cannot flatten after failed hedge | Manual intervention, exchange support |
| `DN_PARTIAL_HEDGE` | High | Quantities mismatch | Re-hedge, verify |
| `DN_MARGIN_WARNING` | High | `accountMMRate` or liq distance breach | De-risk, add margin, exit |
| `DN_LIQUIDATION_RISK` | Critical | Perp near liquidation | Immediate exit |
| `DN_BASIS_BLOWOUT` | High | Basis beyond exit threshold | Exit |
| `DN_FUNDING_NEGATIVE` | Medium | Negative streak | Exit per §7.2 |
| `DN_RECON_DRIFT` | High | DB vs exchange mismatch | Freeze, investigate |
| `DN_API_DEGRADED` | Medium | Retry exhaustion / circuit breaker | Pause entries, monitor |
| `DN_WS_DEGRADED` | Medium | Watchdog reconnect | Resync |
| `DN_DATA_GAP` | Medium | Missing funding/OHLC | Exclude symbol |
| `DN_FEE_DRIFT` | Medium | Actual fee > assumed | Recompute break-even, pause |
| `DN_CLOCK_DRIFT` | Low | Offset > 500ms | Re-sync |
| `DN_CONFIG_INVALID` | Critical | Startup validation failure | Fix config, restart |

### 10.7 Runbooks

**`DN_ORPHAN_PERP`:**

1. Do not sell spot. Do not open new positions.
2. Fetch the perp position and spot balance.
3. Buy the missing spot quantity with a market/IOC order.
4. If the buy succeeds, verify delta and resume.
5. If the buy fails, close the perp with `reduceOnly` market.
6. If both fail, halt the engine, alert CRITICAL, and escalate manually.

**`DN_ORPHAN_SPOT`:**

1. Attempt to hedge with a perp short for the spot quantity.
2. If the hedge fails after retries, sell the spot with a market/IOC order.
3. If the sell fails, halt, alert, and escalate.

**`DN_RECON_DRIFT`:**

1. Freeze new entries.
2. Pull the last 24h of transaction log, executions and positions.
3. Recompute PnL from exchange truth.
4. If the drift is a missing funding/fee record, upsert it.
5. If the drift is unexplained, halt and escalate. Do not "fix" the DB by writing a plug.

**`DN_MARGIN_WARNING`:**

1. Check `liqPrice` and `accountMMRate`.
2. If distance < 15%, exit immediately (perp first).
3. If 15–30%, reduce perp size or add margin.
4. Do not increase leverage to "buy time".

---

## 11. Configuration

### 11.1 Naming and validation

All variables use the `DN_` prefix. They are parsed and validated at startup; an invalid config fails fast with a clear message and never starts the engine.

**Rules:**

- Money values are strings or decimals; never `number` in runtime calculations.
- Percentages are fractions (`0.10` = 10%), not `10`.
- Bps are integers (`10` = 10 bps = 0.10%).
- Durations are milliseconds unless the name ends in `_HOURS` or `_DAYS`.
- Symbols are uppercase and must end in `USDT` in v1.
- `DN_SYMBOLS` empty means "all eligible"; a non-empty list is a whitelist.
- Secrets (`DN_TELEGRAM_BOT_TOKEN`, `DN_TELEGRAM_CHAT_ID`, `BYBIT_API_KEY`, `BYBIT_API_SECRET`, `DN_DATABASE_URL`) are injected by the platform and never committed.

### 11.2 Full reference

#### Core

| Variable | Default | Description |
| --- | --- | --- |
| `DN_ENABLED` | `false` | Feature flag; the process exits if false |
| `DN_SYMBOLS` | empty | Optional whitelist |
| `DN_AUTO_TRADING` | `false` | `false` = manual Telegram approval |
| `DN_DRY_RUN` | `true` | Simulate orders, no exchange writes |
| `DN_KILL_SWITCH` | `false` | Stop new entries; exits still run |
| `DN_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `DN_DATA_DIR` | `data/dn` | Cache and artifacts |

#### Screener

| Variable | Default | Description |
| --- | --- | --- |
| `DN_UNIVERSE_TOP_N` | `50` | Max symbols after Stage A |
| `DN_HISTORY_CANDIDATES` | `20` | Symbols whose funding history is fetched |
| `DN_SCREENER_INTERVAL_MS` | `300000` | 5 minutes |
| `DN_FUNDING_MA_EPOCHS` | `5` | 3–5 recommended; 2–10 allowed |
| `DN_MIN_HISTORY_EPOCHS` | `10` | Minimum realized events |
| `DN_MIN_LISTING_DAYS` | `30` | Minimum listing age |
| `DN_MIN_FUNDING_RATE` | `0.0001` | 0.01% per epoch entry floor |
| `DN_MAX_FUNDING_RATE` | `0.005` | 0.5% per epoch sanity cap |
| `DN_MIN_POSITIVE_RATIO` | `0.8` | Share of positive epochs |
| `DN_MAX_FUNDING_STDEV` | `0.0001` | 0.01% dispersion cap |
| `DN_CAP_WARN_RATIO` | `0.8` | Warn when rate ≥ 80% of cap |
| `DN_MIN_TURNOVER_24H_USDT` | `5000000` | Liquidity floor per leg |
| `DN_MAX_SPREAD_BPS` | `10` | 0.10% spread cap |
| `DN_MAX_BASIS` | `0.005` | 0.50% positive basis cap |
| `DN_MAX_NEGATIVE_BASIS` | `0.001` | 0.10% negative basis floor |
| `DN_BASIS_EXIT_ASSUMPTION_PCT` | `0` | Assumed exit basis for scoring |
| `DN_MIN_NET_APR` | `0.10` | 10% net APR hurdle |
| `DN_MAX_CANDIDATES` | `10` | Ranking handoff limit |
| `DN_COOLDOWN_EPOCHS` | `3` | Post-exit cooldown |

#### Portfolio

| Variable | Default | Description |
| --- | --- | --- |
| `DN_DEPLOYMENT_TARGET_PCT` | `0.80` | Max deployed equity |
| `DN_MAX_COIN_EQUITY_PCT` | `0.10` | Per-coin cap |
| `DN_MAX_SECTOR_EQUITY_PCT` | `0.30` | Per-sector cap |
| `DN_MIN_RESERVE_PCT` | `0.20` | Cash buffer |
| `DN_MAX_POSITIONS` | `8` | Concurrency cap |
| `DN_PERP_LEVERAGE` | `3` | Perp leverage |
| `DN_PERP_LEVERAGE_MAX` | `5` | Hard ceiling for any per-symbol leverage override |
| `DN_MAX_EFFECTIVE_LEVERAGE` | `3` | Portfolio-level cap |
| `DN_MARGIN_BUFFER_PCT` | `0.05` | Buffer in `E_alloc` |
| `DN_MIN_POSITION_USDT` | `100` | Minimum allocated equity |
| `DN_MAX_UNHEDGED_PCT` | `0.005` | Max unhedged notional / equity |
| `DN_DELTA_TOLERANCE_PCT` | `0.001` | Base delta tolerance |
| `DN_DELTA_REHEDGE_THRESHOLD_PCT` | `0.005` | Re-hedge trigger |
| `DN_ALLOCATION_MODE` | `score` | `score` or `equal` |
| `DN_COMPOUND` | `false` | Compound realized PnL |
| `DN_MAX_DRAWDOWN_PCT` | `0.10` | Stop new entries |
| `DN_FLATTEN_DRAWDOWN_PCT` | `0.15` | Flatten all |

#### Execution

| Variable | Default | Description |
| --- | --- | --- |
| `DN_ENTRY_SLIPPAGE_BPS` | `10` | Limit price cap on entries |
| `DN_EXIT_SLIPPAGE_BPS` | `10` | Limit price cap on exits |
| `DN_ROLLBACK_SLIPPAGE_BPS` | `50` | Rollback market cap |
| `DN_MAX_UNHEDGED_MS` | `3000` | Max time between legs |
| `DN_MAX_LEGGING_RETRIES` | `3` | Hedge attempts |
| `DN_ROLLBACK_RETRIES` | `5` | Flatten attempts |
| `DN_MAKER_FIRST` | `false` | Post-only entry mode |
| `DN_MAKER_TIMEOUT_MS` | `5000` | Maker wait before crossing |
| `DN_FUNDING_WINDOW_MS` | `60000` | No-entry window before funding |
| `DN_DEPTH_MULTIPLIER` | `3` | Book depth vs intended notional |
| `DN_PREFLIGHT_BUFFER_PCT` | `0.001` | Extra balance buffer |

#### Lifecycle

| Variable | Default | Description |
| --- | --- | --- |
| `DN_MIN_HOLDING_EPOCHS` | `3` | Economic floor |
| `DN_MIN_HOLDING_HOURS` | `24` | Wall-clock floor |
| `DN_MAX_HOLDING_EPOCHS` | `90` | Clamp for `k_min` |
| `DN_MAX_HOLDING_DAYS` | `30` | Hard maximum |
| `DN_MIN_PROFIT_BUFFER_PCT` | `0.001` | Extra profit buffer in `k_min` |
| `DN_EXIT_FUNDING_RATE` | `0.00002` | Exit when MA below this |
| `DN_EXIT_CONSECUTIVE_EPOCHS` | `2` | Confirmation polls |
| `DN_NEGATIVE_STREAK_EPOCHS` | `3` | Negative streak exit |
| `DN_MAX_LOSS_PCT` | `0.02` | Net loss exit threshold |
| `DN_MAX_BASIS_EXIT_PCT` | `0.01` | Basis blowout exit |
| `DN_MAX_MARGIN_RATIO` | `0.75` | Margin warning |
| `DN_MIN_LIQ_DISTANCE_PCT` | `0.30` | Liquidation distance warning |
| `DN_ROTATION_MARGIN_APR` | `0.05` | Optional rotation advantage |

#### Reconciliation and operations

| Variable | Default | Description |
| --- | --- | --- |
| `DN_RECONCILE_INTERVAL_MS` | `600000` | 10 minutes |
| `DN_POSITION_POLL_MS` | `30000` | 30 seconds |
| `DN_FUNDING_SYNC_INTERVAL_MS` | `600000` | 10 minutes |
| `DN_FUNDING_SYNC_GRACE_MS` | `900000` | 15 minutes |
| `DN_DRIFT_TOLERANCE_PCT` | `0.001` | 0.1% equity |
| `DN_CLOCK_SYNC_INTERVAL_MS` | `3600000` | 1 hour |
| `DN_FEE_REFRESH_MS` | `86400000` | 24 hours |
| `DN_HEALTHCHECK_PORT` | `3001` | Separate from SMC |
| `DN_ENABLE_TRADE_NOTIFICATIONS` | `true` | Routine trade alerts |
| `DN_DAILY_REPORT_UTC` | `00:10` | Daily report time, 10 min after the 00:00 settlement |

#### Fee fallbacks and backtest

| Variable | Default | Description |
| --- | --- | --- |
| `DN_SPOT_TAKER_FEE` | `0.001` | Fallback if `getFeeRate` fails |
| `DN_PERP_TAKER_FEE` | `0.00055` | Fallback |
| `DN_PERP_MAKER_FEE` | `0.0002` | Fallback |
| `DN_ASSUMED_ROUND_TRIP_FEE` | `0.0031` | Sanity check baseline |
| `DN_FEE_DRIFT_TOLERANCE` | `0.0005` | Pause if actual exceeds by 0.05% |
| `DN_BACKTEST_DAYS` | `180` | Default window |
| `DN_BACKTEST_INITIAL_EQUITY` | `10000` | Starting equity |
| `DN_BACKTEST_MODE` | `funding` | `funding` or `full` |
| `DN_BACKTEST_INTERVAL` | `60` | OHLC interval |
| `DN_BACKTEST_FEE_SCENARIO` | `base` | Fee scenario |
| `DN_BACKTEST_BASIS_PCT` | `0.001` | Funding-only basis assumption |
| `DN_BACKTEST_MMR` | `0.005` | Maintenance margin rate |
| `DN_BACKTEST_LIQUIDATION_PENALTY_PCT` | `0.005` | Liquidation slippage |
| `DN_BACKTEST_LEGGING_DELAY_MS` | `0` | Stress legging delay |
| `DN_BACKTEST_MAKER_FILL_RATIO` | `0` | 0 = all taker |
| `DN_SLIPPAGE_BASE_BPS` | `2` | Base slippage |
| `DN_SLIPPAGE_IMPACT_BPS` | `5` | Impact coefficient |
| `DN_SLIPPAGE_MAX_BPS` | `50` | Cap |

### 11.3 Validation rules

The config parser must reject:

- `DN_FUNDING_MA_EPOCHS` outside `[2, 10]`.
- `DN_MIN_FUNDING_RATE <= 0` or `>= DN_MAX_FUNDING_RATE`.
- `DN_MIN_POSITIVE_RATIO` outside `[0, 1]`.
- `DN_MAX_FUNDING_STDEV < 0`.
- `DN_MAX_BASIS <= 0` or `DN_MAX_NEGATIVE_BASIS < 0`.
- `DN_DEPLOYMENT_TARGET_PCT + DN_MIN_RESERVE_PCT > 1`.
- `DN_MAX_COIN_EQUITY_PCT > DN_DEPLOYMENT_TARGET_PCT`.
- `DN_MAX_SECTOR_EQUITY_PCT < DN_MAX_COIN_EQUITY_PCT`.
- `DN_PERP_LEVERAGE < 1` or `> 10`.
- `DN_MAX_EFFECTIVE_LEVERAGE < DN_PERP_LEVERAGE` (warning, not fatal if intentional).
- `DN_MIN_HOLDING_EPOCHS > DN_MAX_HOLDING_EPOCHS`.
- `DN_MIN_HOLDING_HOURS < 0` or `DN_MAX_HOLDING_DAYS <= 0`.
- `DN_EXIT_FUNDING_RATE >= DN_MIN_FUNDING_RATE` (breaks hysteresis).
- `DN_MAX_LOSS_PCT` outside `(0, 1)`.
- `DN_MAX_MARGIN_RATIO` outside `(0, 1)`.
- `DN_MIN_LIQ_DISTANCE_PCT` outside `(0, 1)`.
- Any fee negative or > 0.01.
- Any interval `<= 0`.
- `DN_SYMBOLS` containing a non-USDT or malformed symbol.
- `DN_BACKTEST_DAYS <= 0`.

### 11.4 Deployment profiles

**`.env.dn.paper`:**

```
DN_ENABLED=true
DN_DRY_RUN=true
DN_AUTO_TRADING=false
DN_KILL_SWITCH=false
DN_SYMBOLS=
DN_DEPLOYMENT_TARGET_PCT=0.80
DN_MAX_COIN_EQUITY_PCT=0.10
DN_PERP_LEVERAGE=3
DN_MIN_NET_APR=0.10
DN_FUNDING_MA_EPOCHS=5
DN_BACKTEST_MODE=full
```

**`.env.dn.demo`:**

```
DN_ENABLED=true
DN_DRY_RUN=false
DN_AUTO_TRADING=false
DN_SYMBOLS=NEARUSDT,APTUSDT
DN_DEPLOYMENT_TARGET_PCT=0.10
DN_MAX_COIN_EQUITY_PCT=0.05
DN_PERP_LEVERAGE=3
DN_MIN_NET_APR=0.15
DN_MAX_POSITIONS=2
```

**`.env.dn.prod`:**

```
DN_ENABLED=true
DN_DRY_RUN=false
DN_AUTO_TRADING=true
DN_SYMBOLS=
DN_DEPLOYMENT_TARGET_PCT=0.80
DN_MAX_COIN_EQUITY_PCT=0.10
DN_PERP_LEVERAGE=3
DN_MIN_NET_APR=0.10
DN_MAX_POSITIONS=8
DN_KILL_SWITCH=false
```

**Secrets are never in these files.** They are injected by Render/Docker/systemd: `BYBIT_API_KEY`, `BYBIT_API_SECRET`, `DN_DATABASE_URL`, `DN_TELEGRAM_BOT_TOKEN`, `DN_TELEGRAM_CHAT_ID`.

### 11.5 Per-symbol overrides

Follow the SMC `resolveSymbolConfig` pattern. Supported twins:

```
DN_MIN_FUNDING_RATE_<SYMBOL>
DN_EXIT_FUNDING_RATE_<SYMBOL>
DN_MAX_BASIS_<SYMBOL>
DN_MIN_NET_APR_<SYMBOL>
DN_MAX_COIN_EQUITY_PCT_<SYMBOL>
DN_PERP_LEVERAGE_<SYMBOL>
DN_MIN_HOLDING_EPOCHS_<SYMBOL>
DN_COOLDOWN_EPOCHS_<SYMBOL>
```

An override for a symbol not in `DN_SYMBOLS` is silently dropped (matching the SMC convention). Each override is validated against the global bounds; e.g., a per-symbol leverage cannot exceed `DN_PERP_LEVERAGE_MAX`.

---

## 12. Database Schema

### 12.1 Design rules

- Every money column is `NUMERIC(24,8)`; the driver returns strings.
- Every timestamp is `BIGINT` UTC milliseconds.
- Every table has a `created_at` / `updated_at` where mutable.
- `JSONB` is used only for raw exchange payloads and flexible management state; never for values that need arithmetic.
- All queries use `const client = await pool.connect(); try { ... } finally { client.release(); }`.
- The schema is additive: `dn_*` tables only. No `ALTER` of `trades` or `symbol_state`.
- A separate database or schema (`delta_neutral`) is recommended. If a shared database is unavoidable, the `dn_` prefix and a dedicated role prevent accidental cross-reads.

### 12.2 Tables

```sql
CREATE TABLE IF NOT EXISTS dn_positions (
  id                    VARCHAR(64) PRIMARY KEY,
  symbol                VARCHAR(20) NOT NULL,
  status                VARCHAR(20) NOT NULL
                        CHECK (status IN ('OPEN','CLOSED','ROLLED_BACK','ORPHANED')),
  state                 VARCHAR(32) NOT NULL,
  spot_qty              NUMERIC(24,8) NOT NULL,
  perp_qty              NUMERIC(24,8) NOT NULL,
  spot_entry_price      NUMERIC(24,8) NOT NULL,
  perp_entry_price      NUMERIC(24,8) NOT NULL,
  spot_exit_price       NUMERIC(24,8),
  perp_exit_price       NUMERIC(24,8),
  entry_basis           NUMERIC(24,8) NOT NULL,
  exit_basis            NUMERIC(24,8),
  spot_notional         NUMERIC(24,8) NOT NULL,
  perp_notional         NUMERIC(24,8) NOT NULL,
  allocated_equity      NUMERIC(24,8) NOT NULL,
  perp_leverage         NUMERIC(10,4) NOT NULL,
  funding_ma_at_entry   NUMERIC(24,8) NOT NULL,
  funding_interval_h    INTEGER NOT NULL,
  min_holding_epochs    INTEGER NOT NULL,
  epochs_held           INTEGER NOT NULL DEFAULT 0,
  realized_funding      NUMERIC(24,8) NOT NULL DEFAULT 0,
  realized_basis        NUMERIC(24,8) NOT NULL DEFAULT 0,
  spot_pnl              NUMERIC(24,8) NOT NULL DEFAULT 0,
  perp_pnl              NUMERIC(24,8) NOT NULL DEFAULT 0,
  fees_paid             NUMERIC(24,8) NOT NULL DEFAULT 0,
  slippage_paid         NUMERIC(24,8) NOT NULL DEFAULT 0,
  net_pnl               NUMERIC(24,8),
  net_roe               NUMERIC(24,8),
  opened_at             BIGINT NOT NULL,
  closed_at             BIGINT,
  exit_reason           VARCHAR(64),
  management_state      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at            BIGINT NOT NULL,
  updated_at            BIGINT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_dn_positions_open_symbol
  ON dn_positions (symbol)
  WHERE status = 'OPEN';

CREATE INDEX IF NOT EXISTS idx_dn_positions_status_opened
  ON dn_positions (status, opened_at DESC);

CREATE INDEX IF NOT EXISTS idx_dn_positions_closed
  ON dn_positions (closed_at DESC)
  WHERE closed_at IS NOT NULL;
```

```sql
CREATE TABLE IF NOT EXISTS dn_legs (
  id                VARCHAR(64) PRIMARY KEY,
  position_id       VARCHAR(64) NOT NULL
                    REFERENCES dn_positions(id) ON DELETE CASCADE,
  leg               VARCHAR(24) NOT NULL
                    CHECK (leg IN ('SPOT_BUY','PERP_SHORT','PERP_CLOSE','SPOT_SELL',
                                   'ROLLBACK_SPOT_SELL','ROLLBACK_PERP_CLOSE')),
  category          VARCHAR(8) NOT NULL CHECK (category IN ('spot','linear')),
  order_id          VARCHAR(128),
  order_link_id     VARCHAR(64),
  side              VARCHAR(8) NOT NULL CHECK (side IN ('Buy','Sell')),
  qty               NUMERIC(24,8) NOT NULL,
  filled_qty        NUMERIC(24,8) NOT NULL DEFAULT 0,
  price             NUMERIC(24,8),
  avg_fill_price    NUMERIC(24,8),
  fee               NUMERIC(24,8) NOT NULL DEFAULT 0,
  fee_currency      VARCHAR(16),
  slippage          NUMERIC(24,8) NOT NULL DEFAULT 0,
  status            VARCHAR(20) NOT NULL,
  created_at        BIGINT NOT NULL,
  filled_at         BIGINT,
  raw               JSONB
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_dn_legs_order_link
  ON dn_legs (order_link_id)
  WHERE order_link_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_dn_legs_position
  ON dn_legs (position_id, created_at);
```

```sql
CREATE TABLE IF NOT EXISTS dn_funding_accruals (
  id             VARCHAR(64) PRIMARY KEY,
  position_id    VARCHAR(64) NOT NULL
                 REFERENCES dn_positions(id) ON DELETE CASCADE,
  symbol         VARCHAR(20) NOT NULL,
  funding_time   BIGINT NOT NULL,
  funding_rate   NUMERIC(24,8) NOT NULL,
  mark_price     NUMERIC(24,8) NOT NULL,
  qty            NUMERIC(24,8) NOT NULL,
  payment        NUMERIC(24,8) NOT NULL,
  external_key   VARCHAR(128),
  source         VARCHAR(16) NOT NULL CHECK (source IN ('EXCHANGE','SIMULATED')),
  created_at     BIGINT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_dn_funding_position_time
  ON dn_funding_accruals (position_id, funding_time);

CREATE UNIQUE INDEX IF NOT EXISTS uq_dn_funding_external
  ON dn_funding_accruals (external_key)
  WHERE external_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_dn_funding_symbol_time
  ON dn_funding_accruals (symbol, funding_time DESC);
```

```sql
CREATE TABLE IF NOT EXISTS dn_screener_snapshots (
  id                      BIGSERIAL PRIMARY KEY,
  snapshot_at             BIGINT NOT NULL,
  symbol                  VARCHAR(20) NOT NULL,
  funding_rate            NUMERIC(24,8),
  predicted_funding_rate  NUMERIC(24,8),
  funding_ma              NUMERIC(24,8),
  funding_positive_ratio  NUMERIC(10,6),
  funding_stdev           NUMERIC(24,8),
  funding_interval_h      INTEGER,
  basis                   NUMERIC(24,8),
  spot_turnover_24h       NUMERIC(24,8),
  perp_turnover_24h       NUMERIC(24,8),
  spot_spread_bps         NUMERIC(10,4),
  perp_spread_bps         NUMERIC(10,4),
  score                   NUMERIC(24,8),
  eligible                BOOLEAN NOT NULL,
  reject_reason           VARCHAR(64)
);

CREATE INDEX IF NOT EXISTS idx_dn_screener_time
  ON dn_screener_snapshots (snapshot_at DESC);

CREATE INDEX IF NOT EXISTS idx_dn_screener_symbol_time
  ON dn_screener_snapshots (symbol, snapshot_at DESC);
```

```sql
CREATE TABLE IF NOT EXISTS dn_fee_snapshots (
  id           BIGSERIAL PRIMARY KEY,
  captured_at  BIGINT NOT NULL,
  symbol       VARCHAR(20) NOT NULL,
  category     VARCHAR(8) NOT NULL CHECK (category IN ('spot','linear')),
  maker_rate   NUMERIC(24,8) NOT NULL,
  taker_rate   NUMERIC(24,8) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dn_fees_symbol_time
  ON dn_fee_snapshots (symbol, category, captured_at DESC);
```

```sql
CREATE TABLE IF NOT EXISTS dn_incidents (
  id           VARCHAR(64) PRIMARY KEY,
  position_id  VARCHAR(64),
  symbol       VARCHAR(20),
  severity     VARCHAR(16) NOT NULL
               CHECK (severity IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  code         VARCHAR(64) NOT NULL,
  message      TEXT NOT NULL,
  context      JSONB NOT NULL DEFAULT '{}'::jsonb,
  resolved     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   BIGINT NOT NULL,
  resolved_at  BIGINT
);

CREATE INDEX IF NOT EXISTS idx_dn_incidents_open
  ON dn_incidents (resolved, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_dn_incidents_symbol
  ON dn_incidents (symbol, created_at DESC);
```

```sql
CREATE TABLE IF NOT EXISTS dn_engine_state (
  key         VARCHAR(64) PRIMARY KEY,
  value       JSONB NOT NULL,
  updated_at  BIGINT NOT NULL
);
```

### 12.3 State keys

| Key | Value |
| --- | --- |
| `kill_switch` | `{ enabled: boolean, reason: string, at: number }` |
| `last_screen_at` | number |
| `last_reconcile_at` | number |
| `last_funding_sync_at` | number |
| `funding_cursor` | number |
| `equity_snapshot` | `{ total, available, deployed, reserve, at }` |
| `allocation_proposal` | `{ id, createdAt, expiresAt, allocations[] }` |
| `cooldowns` | `{ [symbol]: number }` |
| `peak_equity` | number |
| `drawdown` | number |
| `version` | string |

### 12.4 Migration and startup

- `CREATE TABLE IF NOT EXISTS` runs at startup, idempotent.
- Indexes are created with `IF NOT EXISTS`.
- No destructive migration. A schema change adds a column with a default or a new table.
- If the DB is unreachable, the engine fails fast; it never trades without persistence.
- If the schema version is newer than the code expects, fail closed.

### 12.5 Retention and backup

| Data | Retention | Backup |
| --- | --- | --- |
| `dn_positions` | Forever | Daily `pg_dump` |
| `dn_legs` | 2 years | Daily |
| `dn_funding_accruals` | 2 years | Daily |
| `dn_screener_snapshots` | 90 days | Weekly |
| `dn_fee_snapshots` | 1 year | Weekly |
| `dn_incidents` | 2 years | Daily |
| `dn_engine_state` | Latest only | Daily |

Backups are encrypted (AES-256-CBC), stored off-instance, and tested quarterly. The DN backup is separate from the SMC backup; a single corrupted database must not take down both engines' recovery.

---

## 13. Observability & Telegram

### 13.1 What must be observable

A carry strategy fails quietly. The position is hedged, the price barely moves, and the only symptom of a broken thesis is a funding line that stopped being positive three days ago. Observability therefore has to answer four questions continuously, not on demand:

| Question | Signal | Cadence |
| --- | --- | --- |
| Is the hedge still neutral? | Base-quantity delta per position | Every tick + 10 min audit |
| Is the position still earning? | Realized funding vs expected funding | Per epoch |
| Is the account still solvent? | Margin ratio, liquidation distance | Every 60 s |
| Is the engine still alive and honest? | Heartbeat + DB/exchange drift | 60 s / 10 min |

If any of these cannot be answered from stored data, the engine is not observable regardless of how many log lines it emits.

### 13.2 Log schema

Every structured log line carries the same envelope so that a single `jq` query can reconstruct any position:

```json
{
  "ts": "2026-10-27T09:14:03.221Z",
  "level": "info",
  "engine": "dn",
  "module": "position.manager",
  "symbol": "NEARUSDT",
  "positionId": "dnpos_01J9...",
  "state": "MONITORING",
  "event": "funding.accrued",
  "data": { "epoch": 7, "rate": "0.00021", "mark": "4.812", "payment": "1.0137" },
  "traceId": "dnrun_01J9..."
}
```

**Rules:**

1. `symbol` and `positionId` are present on every line that concerns a position. A log line about money without an owner is not debuggable.
2. Money fields are **strings**, matching the `Decimal`-only invariant. Never `1.0137` as a float in JSON — a downstream parser that reads it as `number` has already lost precision.
3. `event` is a dotted, stable identifier (`legging.hedge.timeout`, `exit.triggered`). Grep targets events, not prose.
4. `level=error` lines are shipped to Telegram by the logger hook (§13.5). All other levels stay in stdout.
5. No secrets, no API keys, no full request bodies. `orderLinkId` is safe; signatures are not.
6. English only, consistent with `AGENTS.md` §4.6.

### 13.3 Metric catalog

Metrics are computed from DB rows, never from in-memory counters, so a restart does not reset the picture.

| Metric | Definition | Unit | Warning | Critical |
| --- | --- | --- | --- | --- |
| `dn_equity_total` | Wallet `totalEquity` (UNIFIED) | USDT | — | — |
| `dn_equity_deployed` | Σ spot notional at entry of open positions | USDT | > 85% | > 95% |
| `dn_equity_reserve` | `total − deployed` | USDT | < 15% | < 5% |
| `dn_positions_open` | Count of `OPEN` rows | count | ≥ 80% of `DN_MAX_POSITIONS` | > `DN_MAX_POSITIONS` |
| `dn_delta_gap_max` | max over positions of `abs(Q_s − Q_p) / Q` | fraction | > 0.1% | > 0.5% |
| `dn_basis_entry_avg` | Notional-weighted entry basis | fraction | > 0.4% | > 0.5% |
| `dn_basis_now_max` | max current basis | fraction | > 0.8% | > 1.0% |
| `dn_funding_ma_min` | min `f_ma` across open positions | fraction/epoch | < 0.005% | < 0.002% |
| `dn_funding_realized_7d` | Σ realized funding, trailing 7d | USDT | < 0 | < −0.2% equity |
| `dn_funding_realization_ratio` | realized / expected funding | ratio | < 0.9 | < 0.7 |
| `dn_fee_drag_30d` | Σ fees, trailing 30d | USDT | > 40% of gross funding | > 60% |
| `dn_net_apr_30d` | Trailing net APR | fraction | < 8% | < 0 |
| `dn_margin_ratio` | `accountMMRate` | fraction | > 0.60 | > 0.75 |
| `dn_liq_distance_min` | min distance to `liqPrice` | fraction | < 40% | < 30% |
| `dn_unhedged_age_max` | longest current unhedged window | ms | > 2,000 | > `DN_MAX_UNHEDGED_MS` |
| `dn_recon_drift` | `abs(db_net − exchange_net) / equity` | fraction | > 0.05% | > 0.1% |
| `dn_api_error_rate_5m` | Failed REST calls / total | ratio | > 5% | > 20% |
| `dn_ws_silence_ms` | Time since last WS message | ms | > 60,000 | > 180,000 |
| `dn_clock_offset_ms` | Server time − local time | ms | > 200 | > 500 |
| `dn_screen_reject_ratio` | Rejected / evaluated | ratio | > 0.98 for 7d | — |

Two of these deserve emphasis because they are the early-warning pair that matters most:

- **`dn_funding_realization_ratio`** — if the exchange credits less funding than the model expects, either the epoch count, the mark price, or the position size is wrong. Any of those invalidates every downstream yield number. This ratio degrades **before** PnL does.
- **`dn_fee_drag_30d`** — carry strategies die by fee churn, not by a single bad trade. A fee drag above 60% of gross funding means the strategy is working for the exchange.

### 13.4 Telegram command surface

The DN bot is a **separate bot token and chat** (`DN_TELEGRAM_BOT_TOKEN`, `DN_TELEGRAM_CHAT_ID`). It shares no state with the SMC notifier. The same silent-ignore security middleware applies: any chat id other than the configured one receives nothing, including errors.

Read-only commands:

| Command | Response |
| --- | --- |
| `/dn_status` | Equity, deployed, reserve, open positions, margin ratio, mode (`DRY_RUN`/`LIVE`), kill-switch state |
| `/dn_positions` | One block per open position: symbol, qty, entry spot/perp, current basis, funding MA, epochs held, unrealized net, time-lock remaining |
| `/dn_position <SYMBOL>` | Full detail: legs, fills, accrued funding history, exit conditions status, next evaluation |
| `/dn_screen` | Last screener run: top 10 candidates with score, `f_ma`, basis, fee hurdle, and the rejection funnel |
| `/dn_yield` | Realized vs expected funding, net APR trailing 7/30/90d, fee drag, per-symbol contribution |
| `/dn_health` | Heartbeat age, WS silence, clock offset, API error rate, reconciliation drift |
| `/dn_report [days]` | On-demand PnL report (text) for the window |
| `/dn_incidents [n]` | Last `n` incidents with code, severity, resolution state |

Mutating commands (all require an explicit confirmation tap):

| Command | Effect | Guard |
| --- | --- | --- |
| `/dn_pause` | Stop new entries; management continues | Always allowed |
| `/dn_resume` | Re-enable entries | Refused while an incident is open |
| `/dn_close <SYMBOL>` | Market-unwind one position (perp first) | Confirmation + state must be `MONITORING` |
| `/dn_flatten_all` | Unwind every position, then pause | Confirmation with typed symbol count |
| `/dn_kill` | Set `kill_switch`, block all new risk | Immediate, no confirmation (safety asymmetry) |
| `/dn_approve <id>` | Approve a staged allocation proposal | Only in manual mode, only while unexpired |
| `/dn_reject <id>` | Reject a staged allocation | Only in manual mode |
| `/dn_reconcile` | Force a reconciliation pass now | Read-only repair; never writes a plug |

**Design rules:**

1. Commands never block the trading loop. They read from the DB and enqueue work; they do not execute orders inline.
2. Every mutating command is idempotent. A double-tap on `/dn_close` must not send two market orders — the second call finds the position already `EXITING` and returns "already in progress".
3. `/dn_kill` is the only asymmetric command: it succeeds without confirmation because the cost of a delayed halt exceeds the cost of an accidental one.
4. No command exposes raw API responses. The operator gets a decision, not a payload.

### 13.5 Notification taxonomy

| Class | Examples | Delivery | Throttle |
| --- | --- | --- | --- |
| **Critical** | `DN_ORPHAN_PERP`, `DN_ROLLBACK_FAILED`, `DN_LIQUIDATION_RISK`, fatal crash, kill switch tripped | Immediate, always | Never throttled; deduped by incident id |
| **High** | `DN_MARGIN_WARNING`, `DN_RECON_DRIFT`, `DN_BASIS_BLOWOUT`, rollback executed | Immediate | 1 per incident per 30 min |
| **Trade** | Position opened, position closed, partial rollback | Immediate | Gated by `DN_ENABLE_TRADE_NOTIFICATIONS` |
| **Routine** | Screener summary, allocation proposal, daily digest | Batched | 1 per cycle / per day |
| **Debug** | Per-tick decisions, per-epoch accrual detail | Never to Telegram | Log only |

**Critical never mutes.** `DN_ENABLE_TRADE_NOTIFICATIONS=false` suppresses only the Trade class. This mirrors `AGENTS.md` Invariant 44: muting routine traffic must never mute the alarm.

**Dedupe key:** `incident_code + symbol + floor(timestamp / window)`. A flapping WS reconnect produces one message per window, not one per reconnect. The dedupe state lives in `dn_engine_state`, so a restart does not re-send a storm.

**Message shape.** Every notification answers three questions in order: *what happened*, *what it costs*, *what the bot did next*.

```
🔴 DN_ORPHAN_PERP

📊 NEARUSDT — short perp is naked (spot leg missing)
💵 Exposure: 1,240.50 USDT | Est. risk: unbounded upside
🛠 Action: buying 257.4 NEAR spot (attempt 1/5)
⏱ 09:14:03 UTC | position dnpos_01J9...
```

A message that only says "error" forces the operator to open a terminal, which defeats the purpose of the alert.

### 13.6 Heartbeat and dead-man switch

The engine writes a heartbeat row every 60 seconds:

```json
{ "at": 1793000000000, "state": "MONITORING", "positions": 3, "version": "1.0.0", "pid": 1 }
```

An **external** monitor (the Render health check, a cron job, or a second process) treats a heartbeat older than `3 × interval` as a dead engine and alerts. The engine cannot be trusted to report its own death; a crashed process sends nothing.

Failure semantics:

| Condition | Meaning | Response |
| --- | --- | --- |
| Heartbeat stale < 5 min | Event loop blocked or process restarting | Alert; check logs |
| Heartbeat stale > 15 min | Process dead | Alert CRITICAL; **positions remain open on the exchange** |
| Heartbeat alive, no funding sync for 2 epochs | Sync loop broken | Alert; force `/dn_reconcile` |

The third case is the dangerous one: the process looks healthy while the accounting silently stops. That is why `dn_engine_state.last_funding_sync_at` is monitored independently of the heartbeat.

### 13.7 Daily and weekly reports

**Daily digest (fixed UTC time, `DN_DAILY_REPORT_UTC`, default `00:10`):**

- Equity open/close, net PnL, realized funding, fees paid.
- Open positions with epochs held and time-lock remaining.
- Exits during the day with reason and net PnL.
- Rejection funnel top 5 buckets.
- Any unresolved incident.

**Weekly review:**

- Net APR trailing 7/30/90d against the `DN_MIN_NET_APR` hurdle.
- Per-symbol contribution, sorted; the worst three are named explicitly.
- Fee drag as a share of gross funding.
- Funding realization ratio and its trend.
- Slippage vs model (realized bps against the modeled bps).
- Recommendation block: *continue*, *tighten gate X*, or *stop and re-review*. The report is allowed to recommend stopping.

Reports are generated from SQL, not from a running counter, so they can be regenerated for any historical window.

### 13.8 Health endpoint

`GET /health` on `DN_HEALTHCHECK_PORT` (default `3001`, deliberately different from the SMC port `3000` so a port collision cannot silently route the wrong probe):

```json
{
  "status": "healthy",
  "engine": "dn",
  "uptimeSec": 184230,
  "lastHeartbeat": 1793000000000,
  "lastReconcile": 1792999800000,
  "lastFundingSync": 1792998000000,
  "openPositions": 3,
  "killSwitch": false,
  "version": "1.0.0"
}
```

`status` is `healthy`, `degraded` or `unhealthy`:

| Status | Condition | HTTP |
| --- | --- | --- |
| `healthy` | Heartbeat fresh, reconcile fresh, no critical incident | 200 |
| `degraded` | Reconcile stale, WS degraded, or API error rate high | 200 (do not trigger a restart loop) |
| `unhealthy` | Kill switch on, critical incident open, or DB unreachable | 503 |

`degraded` deliberately returns 200. A platform that restarts the container on any non-200 turns a transient REST outage into repeated process death — which is strictly worse than a degraded but running engine that can still manage exits.

### 13.9 Audit trail

Every state transition, order, fill, fee, funding credit, and config change appends to an immutable record:

| Record | Table | Immutability |
| --- | --- | --- |
| State transitions | `dn_positions.state_history` (JSONB array) | Append-only |
| Orders | `dn_legs` | Rows are updated only for fill fields; identity never changes |
| Funding | `dn_funding_accruals` | Unique idempotency key; never updated, only inserted |
| Config | `dn_engine_state.config_history` | Append on change with hash |
| Incidents | `dn_incidents` | Append; resolution sets `resolved`, never deletes |

The audit trail exists so that a disputed PnL can be reconstructed from exchange data alone. If the DB cannot be reconciled to the exchange, the exchange wins — always.

---

## 14. Testing Strategy

### 14.1 Test pyramid

| Layer | Count target | Runtime | What it proves |
| --- | --- | --- | --- |
| Unit (pure functions) | ~250 | < 5 s | Screening, allocation, sizing, yield, fee and break-even math |
| Property-based | ~15 properties | < 30 s | Invariants hold for arbitrary inputs |
| Integration (fake exchange) | ~60 | < 2 min | Legging, rollback, reconciliation, idempotency |
| Replay / golden dataset | ~10 | < 5 min | Determinism and historical parity |
| Fault injection | ~25 | < 5 min | Every failure path reaches a defined terminal state |
| Demo/testnet burn-in | manual | 14 days | The system survives real latency, real partial fills |

The pyramid is inverted on purpose in one place: fault injection is unusually large because the strategy's dangerous failures are operational, not mathematical. A carry engine that computes yield perfectly and orphans a leg is worthless.

### 14.2 Unit test matrix

**Screener (`screener/fundingMa.ts`, `eligibility.ts`, `scorer.ts`)**

| Test | Assertion |
| --- | --- |
| Causal MA | A rate injected at epoch `t` changes `f_ma` only from `t` onward |
| Window length | `f_ma` uses exactly `DN_FUNDING_MA_EPOCHS`, no off-by-one |
| Insufficient history | Fewer than `DN_MIN_HISTORY_EPOCHS` → `insufficientHistory` |
| Positive ratio | Mixed sign history yields the exact ratio; zeros count as non-positive |
| Stdev | Sample vs population choice is fixed and documented |
| Cap detection | A rate at `fundingCap` → `fundingAtCap` |
| Basis band | `basis > DN_MAX_BASIS` → `basisOutOfBand`; negative beyond `DN_MAX_NEGATIVE_BASIS` → same bucket |
| Fee hurdle | A structurally positive but fee-negative setup → `feeHurdle` |
| Score monotonicity | Increasing `f_ma` with all else fixed never lowers the score |
| Score non-negativity | `score = max(0, score_apr) × …` never returns negative |
| Determinism | Same inputs → identical output, no time or RNG reads |

**Allocator (`portfolio/allocator.ts`, `sizing.ts`)**

| Test | Assertion |
| --- | --- |
| Per-coin cap | No allocation exceeds `DN_MAX_COIN_EQUITY_PCT × equity` |
| Deployment cap | Σ allocations ≤ `DN_DEPLOYMENT_TARGET_PCT × equity` |
| Reserve floor | Reserve never drops below `DN_MIN_RESERVE_PCT × equity` |
| Water-filling | When caps bind, remaining capital flows to the next-best eligible candidate |
| Determinism | Equal scores break ties by the documented key order, never by array order |
| Min size | A candidate below `DN_MIN_POSITION_USDT` is dropped, not rounded up |
| Precision | Quantity is floored to `qtyStep`; notional is re-checked after flooring |
| Empty universe | Zero candidates → zero allocations, no throw |
| Single candidate | One candidate receives the full deployment allowance subject to its cap |

**Yield and fees (`accounting/pnl.ts`, `fees.ts`)**

| Test | Assertion |
| --- | --- |
| Fee currency | Base-charged spot fee reduces hedged qty to `Q(1 − s)` |
| Round-trip fee | `2(s + p)` at equal prices, 8-decimal precision |
| Funding sign | Positive rate credits the short; negative debits |
| Mark vs last | Accrual uses mark when available, close otherwise, and flags the substitution |
| Basis identity | `spot + perp = basis` to 1e-8 over 10,000 random cases |
| Break-even | `k_be = ceil(2(s+p)/f_ma)` including a zero-`f_ma` guard |
| Time-lock | `k_min` clamps to `[DN_MIN_HOLDING_EPOCHS, DN_MAX_HOLDING_EPOCHS]` |
| APR/APY | APR is linear, APY compounds; both match closed-form on fixtures |
| Equity denominator | `1 + 1/L + β` matches the notional-to-equity conversion |
| Zero/negative inputs | Zero price or zero qty throws, never divides |

### 14.3 Property-based tests

Using a seeded generator (no wall clock, no network):

| Property | Statement |
| --- | --- |
| P1 | For any valid inputs, `r_net_notional = r_basis + r_funding − r_fees − r_slip` holds to 1e-8 |
| P2 | For any two positions with identical parameters except `f_ma`, the higher `f_ma` yields the higher `score` |
| P3 | Total allocation never exceeds `min(equity × deployment, Σ per-coin caps)` |
| P4 | For any sequence of funding rates, `realized_funding` equals the sum of per-epoch payments |
| P5 | `side` is always `Buy` for spot and `Sell` for perp, for every generated symbol |
| P6 | Quantity sent to the perp never exceeds the spot quantity actually received |
| P7 | For any rollback path, the terminal state is one of `ROLLED_BACK`, `ORPHAN_SPOT` — never `HEDGED` |
| P8 | For any exit path, the perp is flat before the spot sell is attempted |
| P9 | Re-running the allocator on identical inputs is byte-identical |
| P10 | `k_min ≥ k_be` whenever `DN_MIN_PROFIT_BUFFER_PCT ≥ 0` |
| P11 | A position that exits before `k_min` carries a non-economic exit reason |
| P12 | Time-lock expiry is monotonic in `opened_at` |
| P13 | No path returns a `number` where `Decimal` is required (type-level plus runtime guard) |
| P14 | For any config, `DN_MIN_RESERVE_PCT + DN_DEPLOYMENT_TARGET_PCT ≤ 1` or startup fails |
| P15 | Liquidation price is always strictly on the adverse side of entry for the short |

Properties P7 and P8 are the ones that protect capital. They encode the two rules that, if violated, turn a hedged position into a directional bet.

### 14.4 Integration tests with a fake exchange

A deterministic `FakeBybit` implements the subset of the V5 API the engine uses: tickers, instruments, wallet, positions, orders, executions, transaction log, funding history. It supports programmable failures per call and per symbol.

| Scenario | Programmed behavior | Expected outcome |
| --- | --- | --- |
| Clean entry | Both legs fill fully | `HEDGED`, delta = 0, two `dn_legs` rows |
| Spot partial | Spot fills 60% | Perp hedges 60%, residual intent cancelled |
| Perp partial | Perp fills 80% of target | Remainder retried; if unfilled, rollback to flat |
| Hedge timeout | Perp rejects for `DN_MAX_UNHEDGED_MS` | Escalate to market, then rollback |
| Hedge reject ×3 | Perp rejects 3× | `ROLLED_BACK`, spot sold, incident logged |
| Rollback fail | Spot sell rejects 5× | `ORPHAN_SPOT`, CRITICAL alert, no retry storm |
| Exit perp fail | Perp close rejects | `ORPHAN_PERP`, spot **not** sold |
| Duplicate submit | Same `orderLinkId` retried | One order on the exchange, one row in DB |
| Funding sync | Two settlement records for one epoch | One accrual row (idempotent) |
| Recon adoption | Position on exchange, no DB row | Adopted or flattened per §10.3, never ignored |
| Recon phantom | DB row, no exchange position | Closed with `RECONCILIATION` reason and non-null PnL |
| Kill switch | Set mid-cycle | No new entries; open positions still managed |
| Restart mid-legging | Process killed in `HEDGE_PENDING` | Startup recovery resolves per §10.2 |

### 14.5 Replay and golden dataset

| Fixture | Content | Asserted |
| --- | --- | --- |
| `golden_3sym_30d` | 3 symbols, 30 days, real funding and OHLC | Net PnL, funding, basis, fees, ROE to 8 decimals |
| `causality_spike` | Funding spike at `t` | No decision before `t`; entry at `t+1` open |
| `fee_base_currency` | Spot fee in base | Perp qty equals received qty |
| `negative_regime` | 30 days of negative funding | No entries, or entries exited by the negative-streak rule |
| `liq_cascade` | Basis gap through the liquidation price | `LIQUIDATED` with penalty, negative PnL |
| `interval_change` | Funding interval 8h → 4h mid-window | Epoch accounting follows the change, no double count |
| `delisting` | Instrument stops trading | Immediate exit attempt, `DELISTING` reason |

Replay tests compare against committed expected files. A diff requires an explicit rationale in the commit message — silently regenerating goldens is forbidden, because that is how a regression becomes the new baseline.

### 14.6 Fault-injection matrix

Each row is a test, not a hope:

| Injected fault | Expected terminal state | Must not happen |
| --- | --- | --- |
| REST 429 for 5 min | Entries paused, positions managed | Retry storm |
| REST 503 for 30 min | Entries paused; exits retried with backoff | Silent position abandonment |
| WS silence 5 min | Watchdog reconnect, resync | Stale state treated as truth |
| Clock drift +2 s | `recvWindow` widened, sync forced | Order rejection loop |
| DB write failure at entry | `panicCloseOrphan` → flat → `ROLLED_BACK` | `IDLE` with a live position |
| DB write failure at exit | Position stays open, retried | `CLOSED` without exchange flatness |
| Partial fill + disconnect | Recon adopts actual quantities | DB/insurance mismatch |
| Funding record missing | Symbol flagged `DN_DATA_GAP` | Zero-funding assumption |
| Fee change mid-hold | Break-even recomputed, alert | Silent yield overstatement |
| Instrument precision change | Order rejected → symbol paused | Repeated invalid orders |
| Negative funding for 3 epochs | Exit per §7.2 condition 2 | Holding a cash-negative position |
| Exchange maintenance during exit | Retry after resume | Selling spot while perp is open |

### 14.7 Demo and testnet burn-in

Minimum 14 consecutive days on Bybit demo (or testnet) before mainnet capital, with:

- At least **10 complete position lifecycles**, including at least 2 exits.
- At least **1 forced partial fill** (submit a size large enough relative to visible depth, or simulate via the fake exchange in a parallel run).
- At least **1 process restart** during an open position, verifying startup recovery.
- At least **1 reconciliation drift** injected and resolved.
- Zero unresolved `CRITICAL` incidents at the end of the window.
- Realized funding within 5% of modeled funding over the window.

The burn-in is not a formality. It is the only place where real latency, real partial fills and real settlement timing appear together.

### 14.8 CI gates

| Gate | Requirement |
| --- | --- |
| Typecheck | `tsc --noEmit` clean, `strict` on |
| Unit + property | 100% pass |
| Integration | 100% pass |
| Coverage (pure modules) | ≥ 90% lines, ≥ 85% branches |
| Coverage (execution, reconciliation) | ≥ 80% lines |
| Golden replay | Byte-identical artifacts |
| Lint | No `number` for money (custom rule or grep gate), no `Math.abs` in directional math |
| Build | Docker image builds; `/health` responds in a smoke test |

The "no `number` for money" gate is mechanical on purpose. A code review that relies on vigilance will eventually miss one, and one is enough to corrupt a PnL ledger.

### 14.9 Definition of done

A feature is done when:

1. It has unit tests for the happy path **and** each rejection bucket.
2. It has at least one fault-injection test if it touches orders, funds, or state.
3. Its log lines carry `symbol` and `positionId` where applicable.
4. Its config is in §11 with a default and a validation rule.
5. Its failure mode is documented as a terminal state, not "handled".
6. It is reflected in the metric catalog if it can degrade silently.

Point 6 is the one most often skipped, and it is the one that determines whether an operator learns about a problem in minutes or in a monthly statement.

---

## 15. Phased Rollout

### 15.1 Phase overview

| Phase | Mode | Capital | Duration (min) | Exit criterion |
| --- | --- | --- | --- | --- |
| 0 | Design | — | — | This document approved |
| 1 | Read-only screener | 0 | 7 days | Funnel and scores match manual spot checks |
| 2 | Paper trading | 0 | 14 days | Simulated PnL reconciles to funding history |
| 3 | Demo orders | Demo | 14 days | 10 lifecycles, 0 unresolved criticals |
| 4 | Mainnet pilot | 5% of target | 30 days | Net positive after fees, drift < 0.1% |
| 5 | Scale-up | 100% of target | ongoing | Hurdle and drawdown maintained |

Each phase runs in its own process and, from Phase 3 onward, its own sub-account. Phase 4 and Phase 5 share the same sub-account; only the allocated capital changes via `DN_DEPLOYMENT_TARGET_PCT`.

### 15.2 Phase 0 — Design

This document, the invariants (§18), and the rejection-bucket dictionary (Appendix F). Nothing runs. The deliverable is a specification that an independent engineer could implement without asking a question about intent.

### 15.3 Phase 1 — Read-only screener

**What runs:** universe building, funding history, screening, scoring, ranking, rejection funnel. No orders, no positions, no capital.

**What it proves:**

- The symbol mapping between spot and linear perp is correct for the live universe.
- Funding history pagination and caching work against the real API.
- The funnel is not rejecting everything (a 100% rejection rate usually means a units bug, not a barren market).
- Scores are stable across runs, not jumping with every tick.

**Daily check:** manually verify three candidate scores against raw API values. If the manual number and the engine number disagree, stop and fix the units before continuing.

**Exit criterion:** 7 consecutive days with ≥ 3 eligible candidates per day on average and zero unexplained rejections of manually verified symbols.

### 15.4 Phase 2 — Paper trading

**What runs:** full decision pipeline against live data, with a simulated portfolio. Orders are generated and recorded but never sent.

**What it proves:**

- Allocation, sizing, precision formatting produce exchange-valid quantities.
- The time-lock and exit rules trigger on realistic data.
- Simulated funding accrual matches the exchange's published settlement records within tolerance.
- The strategy's thesis is not already dead (if paper net APR is negative for 14 days, do not proceed).

**Exit criterion:** simulated net APR after fees > 0 over the window, funding realization ratio ≥ 0.95, and zero state-machine violations in the transition log.

### 15.5 Phase 3 — Demo orders

**What runs:** real orders on Bybit demo, real fills, real partial fills, real latency. `DN_DRY_RUN=false`, `DN_AUTO_TRADING` may be `true` or `false`.

**What it proves:**

- The legging watchdog behaves under real latency.
- Rollback works when a hedge genuinely fails.
- The reconciliation loop matches real exchange state.
- Restart recovery survives a real process kill.

**Minimum coverage:** 10 lifecycles, ≥ 2 exits, ≥ 1 restart, ≥ 1 partial fill, ≥ 1 injected fault.

**Exit criterion:** zero unresolved `CRITICAL` incidents, 100% of positions reconciled to exchange truth at close, realized funding within 5% of modeled.

### 15.6 Phase 4 — Mainnet pilot

**Capital:** 5% of the intended deployment, hard-capped. `DN_MAX_POSITIONS=2`, `DN_MAX_COIN_EQUITY_PCT=0.05`.

**What it proves:** real fees, real slippage, real funding credits, real operational friction. Demo accounts are forgiving in ways mainnet is not — spreads are wider, fills are worse, and funding is the only number that does not lie.

**Monitoring:** daily review for 30 days. Any of these stops the phase immediately:

- Net PnL negative after fees at day 30.
- Reconciliation drift > 0.1% of equity unresolved for 24 h.
- Any `CRITICAL` incident.
- Realized funding ratio < 0.9.
- A legging rollback that failed and required manual flattening.

**Exit criterion:** 30 days, net positive after all fees, max drawdown within `DN_MAX_DRAWDOWN_PCT`, and an incident log with no unresolved items.

### 15.7 Phase 5 — Scale-up

Capital increases in steps, never in one jump:

| Step | Deployment | Hold period before next step |
| --- | --- | --- |
| 1 | 25% of target | 14 days |
| 2 | 50% of target | 14 days |
| 3 | 75% of target | 30 days |
| 4 | 100% of target | — |

A step is not taken if the trailing 14-day net APR is below `DN_MIN_NET_APR` or if drawdown exceeds half of `DN_MAX_DRAWDOWN_PCT`. Scaling into a degrading strategy multiplies the loss, not the edge.

### 15.8 Gate criteria summary

| Gate | Phase 1 | Phase 2 | Phase 3 | Phase 4 | Phase 5 |
| --- | --- | --- | --- | --- | --- |
| Typecheck + tests green | ✅ | ✅ | ✅ | ✅ | ✅ |
| Rejection funnel reviewed | ✅ | ✅ | ✅ | ✅ | ✅ |
| No unresolved criticals | — | ✅ | ✅ | ✅ | ✅ |
| Funding realization ≥ 0.95 | — | ✅ | ✅ | ✅ | ✅ |
| ≥ 10 lifecycles | — | — | ✅ | ✅ | ✅ |
| Restart recovery proven | — | — | ✅ | ✅ | ✅ |
| Net positive after fees | — | ✅ | ✅ | ✅ | ✅ |
| Drift < 0.1% sustained | — | — | — | ✅ | ✅ |
| Manual approval sign-off | ✅ | ✅ | ✅ | ✅ | — |

### 15.9 Rollback playbook

Rollback means **reduce risk**, not "revert the deploy". In order of preference:

1. `/dn_pause` — stop new entries, keep managing exits. Always the first action.
2. `/dn_kill` — block all new risk, keep exits running. Use when the problem is in the entry pipeline.
3. `/dn_close <SYMBOL>` — unwind one position, perp first.
4. `/dn_flatten_all` — unwind everything, then pause.
5. Stop the process — **last resort**, because a stopped process manages nothing. Positions remain open on the exchange.

Never stop the process to "see what happens". A stopped engine with open positions is the worst of both worlds: exposure without management.

### 15.10 Operational readiness checklist

Before Phase 4, every item must be true:

- [ ] Separate sub-account funded and API keys scoped to it.
- [ ] Separate database provisioned, migrations applied, backup verified by restore.
- [ ] Separate Telegram bot and chat; `/dn_status` responds; unauthorized chat is silently ignored.
- [ ] Kill switch tested end-to-end: `/dn_kill` blocks entries within one cycle.
- [ ] Manual unwind tested on demo: `/dn_close` unwinds perp-first.
- [ ] Alert delivery tested by forcing a `CRITICAL` incident.
- [ ] Heartbeat monitor configured with an external dead-man check.
- [ ] Runbooks (§10.7) printed or pinned; operator has exchange credentials to intervene manually.
- [ ] Time sync verified: clock offset < 200 ms.
- [ ] Fee snapshot matches the exchange's actual fee tier for the account.
- [ ] Funding interval confirmed per symbol; no assumption of 8h.
- [ ] `DN_MAX_POSITIONS`, caps and reserve reviewed against the funded amount.

The fee-tier item is quietly decisive. A strategy calibrated on 0.055% perp taker fees while the account actually pays 0.075% has a break-even horizon 36% longer than modeled, and every yield number in the reports is optimistic by that margin.

---

## 16. Risks & Mitigations

### 16.1 Risk register

Likelihood and impact are qualitative (Low / Medium / High) and deliberately conservative.

| ID | Risk | Category | Likelihood | Impact | Mitigation | Detection |
| --- | --- | --- | --- | --- | --- | --- |
| R1 | Funding flips negative and stays negative | Market | High | Medium | Negative-streak exit, time-lock override, `DN_MIN_POSITIVE_RATIO` | `dn_funding_ma_min`, `DN_FUNDING_NEGATIVE` |
| R2 | Basis blows out, short perp loses faster than funding pays | Market | Medium | High | `DN_MAX_BASIS`, `DN_MAX_BASIS_EXIT_PCT`, immediate exit on breach | `dn_basis_now_max`, `DN_BASIS_BLOWOUT` |
| R3 | Legging failure leaves a naked leg | Operational | Medium | High | Spot-first entry, perp-first unwind, watchdog, rollback, orphan runbooks | `dn_unhedged_age_max`, `DN_ORPHAN_*` |
| R4 | Liquidation of the perp on a violent rally | Market | Low | Critical | 3× leverage, 5% buffer, liq-distance gate, margin alerts | `dn_liq_distance_min`, `DN_LIQUIDATION_RISK` |
| R5 | Exchange outage during entry or exit | Infrastructure | Medium | High | Retry with backoff, state persisted, resume-and-reconcile | Heartbeat, `DN_API_DEGRADED` |
| R6 | Fees higher than modeled | Cost | Medium | Medium | Actual fee snapshots, `DN_FEE_DRIFT`, fee-aware hurdle | `dn_fee_drag_30d`, `DN_FEE_DRIFT` |
| R7 | Slippage worse than modeled | Cost | Medium | Medium | Depth caps, spread gate, size limits, stress ×2/×5 | Realized vs modeled slippage |
| R8 | Partial fill leaves an unhedged remainder | Operational | High | Medium | Hedge actual received qty, never ordered qty; residual cancel | `dn_delta_gap_max` |
| R9 | Accounting drift between DB and exchange | Integrity | Medium | High | 10-min reconciliation, exchange-wins rule, freeze on drift | `dn_recon_drift`, `DN_RECON_DRIFT` |
| R10 | Funding history unavailable or gappy | Data | Medium | Medium | Multi-source cache, `DN_DATA_GAP`, exclude symbol | Funnel `dataGap` |
| R11 | Symbol delisted or trading suspended | Venue | Low | High | Instrument status gate, immediate exit, no new entries | Status poll |
| R12 | Stablecoin depeg (USDT) | Systemic | Low | High | Out of scope for v1; disclosed, not hedged | Manual monitoring |
| R13 | Concentration in one sector | Portfolio | Medium | Medium | `DN_MAX_SECTOR_EQUITY_PCT`, per-coin cap | Allocation report |
| R14 | Correlated basis shock across all positions | Portfolio | Low | High | Position cap, deployment cap, drawdown flatten | `dn_basis_now_max` aggregate |
| R15 | Operator error (wrong command, wrong config) | Human | Medium | High | Confirmations, kill switch asymmetry, config validation, dry-run default | Audit trail |
| R16 | API key compromise | Security | Low | Critical | Scoped keys, no withdrawal permission, IP allowlist, separate sub-account | Exchange audit log |
| R17 | Funding interval change invalidates the thesis | Venue | Low | Medium | Interval-change exit condition, re-screen | Exchange announcement, `intervalChanged` |
| R18 | Model overfits a high-funding regime | Model | High | Medium | Multi-regime backtest, negative-funding stress, live hurdle | Backtest vs live divergence |
| R19 | Clock drift causes `recvWindow` rejections | Infrastructure | Low | Medium | Hourly sync, offset metric, widened window | `dn_clock_offset_ms` |
| R20 | Process crash with open positions | Infrastructure | Medium | High | State in DB, startup recovery, external heartbeat | Heartbeat staleness |
| R21 | Liquidity evaporates exactly when exiting | Market | Medium | High | Depth gate at entry, staged exit, accept worse fills over no fills | Spread and depth metrics |
| R22 | Funding cap reached, upside truncated | Venue | Medium | Low | `fundingAtCap` bucket, score haircut | Screener bucket |
| R23 | Reserve exhausted, margin call on adverse move | Treasury | Low | High | `DN_MIN_RESERVE_PCT`, margin alerts, no leverage increase | `dn_equity_reserve` |
| R24 | Simultaneous exits exceed available liquidity | Operational | Low | Medium | Exit queue with per-cycle limit, stagger | Exit queue metrics |

### 16.2 Narrative for the five risks that actually bite

**R2 — Basis blowout.** This is the failure that looks like success until it doesn't. A position entered at 0.3% premium can see the premium widen to 2% in a squeeze. The short perp loses 1.7% of notional mark-to-market while funding pays 0.02% per epoch. Eight hours of carry does not cover it. The mitigation is not a better forecast; it is a hard `DN_MAX_BASIS_EXIT_PCT` that exits at a known loss rather than an unknown one. The engine is explicitly allowed to be wrong about direction — it is not allowed to be undecided about the exit.

**R3 — Legging failure.** The order of operations encodes the risk asymmetry. Entering spot first means a failed hedge leaves a **bounded** long position (the asset can go to zero, but not below). Entering perp first would leave an **unbounded** naked short. On exit, closing perp first removes the unbounded leg before the bounded one. This ordering is invariant DN-6 and it is not negotiable for convenience — a "faster" perp-first entry converts a bounded failure into a catastrophic one.

**R4 — Liquidation.** At 3× leverage, liquidation requires roughly a 30% adverse move before the margin buffer is consumed, which is rare on a major pair over days but not impossible over weeks. The actual protection is not the leverage number; it is the **liq-distance gate combined with the reserve**. A position that consumes 95% of available margin has no room to survive a wick, and the engine must exit while it still can rather than hope.

**R9 — Accounting drift.** Drift is insidious because every downstream number inherits it. A missing funding record understates income; a missing fee overstates it; a stale `avgPrice` corrupts R-multiples. The rule is absolute: **the exchange wins**. The DB is repaired to match the exchange, never the reverse, and an unexplained drift halts new entries rather than being papered over with an adjustment row.

**R18 — Regime overfit.** Funding rates in a bull market can be persistently high for months, and a backtest over that window will look spectacular. The strategy's edge is not "funding is always positive"; it is "positive funding is common enough, and exits are fast enough, that the negative periods are survivable". Stress scenarios `FUNDING_NEGATIVE_30D` and `FUNDING_HAIRCUT_50` exist specifically to break the fantasy, and the live `DN_MIN_NET_APR` hurdle is measured on realized data, not modeled data.

### 16.3 Residual risk statement

After all mitigations, the following risks remain **accepted and unhedged** in v1:

| Accepted risk | Why accepted | Bound |
| --- | --- | --- |
| USDT depeg | Hedging it requires a second stablecoin leg and doubles operational complexity | Disclosed; manual monitoring |
| Exchange insolvency / withdrawal freeze | Cannot be hedged on-venue | Position size limited to working capital |
| Regulatory restriction on perp shorts | Jurisdiction-dependent; no technical mitigation | Manual shutdown |
| Funding regime permanently compressing to near zero | Strategy becomes unprofitable, not unsafe | Exit and idle; capital preserved |
| Smart-contract / token-specific failure of the spot asset | Not modeled | Per-coin cap, major-pair bias |

The strategy is designed to lose money gracefully, not to be immune to loss. A carry engine that claims no residual risk is either lying or has not enumerated its assumptions.

### 16.4 Concentration and correlation

Three constraints prevent a false sense of diversification:

1. **Per-coin cap** — `DN_MAX_COIN_EQUITY_PCT` (10%) bounds single-name exposure.
2. **Sector cap** — `DN_MAX_SECTOR_EQUITY_PCT` (30%) bounds L1/L2/DeFi clustering. Funding rates across L1s correlate strongly; eight L1 positions are closer to one position than to eight.
3. **Deployment cap** — `DN_DEPLOYMENT_TARGET_PCT` (80%) with a 20% reserve bounds total exposure.

Correlation is measured, not assumed: the weekly report includes the pairwise correlation of position returns over the holding window. If the effective number of independent positions (participation ratio of the correlation matrix) falls below 2 while more than 4 positions are open, that is reported as a concentration warning even though every individual cap is satisfied.

### 16.5 Capital at risk

A candid framing for the operator:

| Scenario | Approximate loss |
| --- | --- |
| Normal exit, funding turned mildly negative | 0.2–0.5% of allocated capital (fees + small basis) |
| Basis blowout exit | 1–3% of allocated capital |
| Failed hedge with rollback | 0.1–0.4% (slippage on both legs) |
| Failed hedge without rollback (orphan) | Unbounded until resolved; typically resolved within minutes |
| Perp liquidation | 5–15% of allocated capital on that position |
| Exchange failure with open positions | Up to 100% of deployed capital |

The last row is the honest one. Delta-neutral means price-neutral, not counterparty-neutral. The capital is on the exchange, and no amount of hedging changes that.

---

## 17. Architecture Decision Records

Each ADR records the decision, the alternatives considered, and the consequence that is now binding. ADRs are append-only: superseding one means adding a new ADR, never editing history.

### ADR-001 — Separate process, account, database and Telegram bot

**Decision:** The `DeltaNeutralEngine` runs as its own process against its own sub-account, its own database, and its own Telegram bot.

**Alternatives:** (a) same process with a mode flag; (b) same account, separate tables; (c) separate process, shared database.

**Rationale:** The SMC engine treats every exchange position on a configured symbol as its own. A delta-neutral position in the same account would be adopted by the SMC reconciliation loop, force-reset, or worse, partially closed. Invariant DN-15 and `AGENTS.md` §1.3 make the separation mandatory.

**Consequence:** Two deploys from potentially the same image, two sets of credentials, two backups. Higher operational cost, unambiguous ownership. That trade is accepted.

### ADR-002 — Spot long plus linear perp short, not two perps

**Decision:** The hedge is spot long / linear perp short.

**Alternatives:** (a) perp long on one venue and perp short on another (cross-exchange); (b) quarterly futures vs perp; (c) spot long vs inverse perp short.

**Rationale:** A single-venue spot/perp pair has one margin account, one settlement currency, no cross-exchange transfer latency, and no counterparty split. Cross-exchange carry can earn more but introduces transfer risk and two failure domains — unacceptable for v1.

**Consequence:** Yield is bounded by one venue's funding rate. The engine cannot arbitrage venue-to-venue funding spreads. That is a deliberate scope limit, recorded in §20.

### ADR-003 — Equal base quantity, not equal notional

**Decision:** `Q_spot = Q_perp` in base units.

**Alternatives:** equal notional (`Q_s × S = Q_p × P`).

**Rationale:** Delta is `∂V/∂S`. With equal base quantity, spot delta `+Q` and perp delta `−Q` cancel exactly, and the residual is pure basis. Equal notional leaves a residual delta of `Q(1 − P/S)` — small, but it means the position is not delta-neutral, it is *approximately* delta-neutral, and the approximation degrades exactly when basis is wide (i.e., when the position is most stressed).

**Consequence:** The perp notional is slightly larger than the spot notional when the perp trades at a premium, consuming marginally more margin. Correctness wins over a rounding-level capital efficiency gain.

### ADR-004 — `Decimal` only, strings on the wire and in the database

**Decision:** No `number` for price, quantity, notional, fee, funding, or PnL, anywhere.

**Rationale:** `0.1 + 0.2 !== 0.3`. Funding accrual sums hundreds of small values; a float error of 1e-12 per epoch compounds into a visible ledger discrepancy over a year, and the reconciliation loop then flags a drift that does not exist. `NUMERIC(24,8)` plus `Decimal` eliminates the class.

**Consequence:** Slightly more verbose code, mandatory formatting helpers, and a CI gate that greps for numeric literals in money paths. Accepted.

### ADR-005 — Causal moving average over 3–5 funding epochs

**Decision:** Eligibility uses `f_ma` over `DN_FUNDING_MA_EPOCHS` (default 5) realized epochs, strictly backward-looking.

**Alternatives:** (a) instantaneous rate; (b) exponential smoothing; (c) longer window (20+).

**Rationale:** The instantaneous rate is noisy and mean-reverts within one epoch; entering on a single print is entering on noise. A 5-epoch window at 8h is ~40 hours — long enough to distinguish a regime from a spike, short enough to react within a week. EMA was rejected because it makes the effective window implicit and hard to explain in a report.

**Consequence:** The engine is late to genuinely new high-funding regimes by up to 5 epochs. That latency is the price of not entering on a one-epoch spike that reverses immediately.

### ADR-006 — Spot-first entry, perp-first exit

**Decision:** Entry buys spot, then shorts perp. Exit buys back perp, then sells spot.

**Alternatives:** perp-first entry; simultaneous submission.

**Rationale:** Failure asymmetry. A failed entry hedge leaves a bounded long; a failed perp-first entry leaves an unbounded naked short. On exit, closing the perp first removes the unbounded leg before touching the bounded one. Simultaneous submission produces the same naked-short window with less control.

**Consequence:** Entry pays spot slippage before knowing whether the hedge is available. In a fast market the hedge can cost more than planned. That cost is bounded and known; the alternative's cost is unbounded. This is invariant DN-6.

### ADR-007 — Manual approval by default

**Decision:** `DN_AUTO_TRADING=false` and `DN_DRY_RUN=true` by default.

**Rationale:** The failure modes that lose money in carry are operational, not analytical. A human seeing the first ten real allocations catches a units bug or a mis-mapped symbol that tests did not. Automation is enabled after the burn-in, deliberately, not by default.

**Consequence:** The strategy cannot capture a fast-moving funding spike that appears and disappears between approvals. Accepted for v1; the approval timeout is configurable.

### ADR-008 — Additive `dn_*` schema, never touch SMC tables

**Decision:** All new tables are prefixed `dn_`; no SMC table is altered, and the DN engine never reads SMC tables.

**Rationale:** Two engines, two lifecycles, one migration hazard. Additive-only migration means a DN deploy cannot break an SMC process even if they share a PostgreSQL instance (they should not, but defense in depth).

**Consequence:** Some duplication (equity snapshots, incidents) across engines. Accepted.

### ADR-009 — Pure functions shared by live and backtest

**Decision:** `evaluateCandidate`, `allocate`, `sizePosition`, `computeBreakEvenEpochs`, `computeYield` are pure and imported by both the live engine and the simulator.

**Alternatives:** reimplement the logic in the backtester (faster to write, drifts immediately).

**Rationale:** A backtest that uses different math than live is a different strategy. The only defensible parity guarantee is a shared implementation. This mirrors the SMC codebase's `BaseScenario.calculateLevels()` single-source-of-truth rule.

**Consequence:** The pure functions cannot perform I/O, cannot read the clock, and cannot log. Callers pass `now` explicitly. That constraint is enforced by their signatures.

### ADR-010 — 3× perp leverage with a 5% margin buffer

**Decision:** `DN_PERP_LEVERAGE=3`, `DN_MARGIN_BUFFER_PCT=0.05`.

**Rationale:** At 3×, the perp margin is ~33% of notional and liquidation requires a ~30% adverse move before buffer consumption. Higher leverage improves capital efficiency (more notional per unit of equity) but shortens the liquidation distance superlinearly, and a carry position is held for days or weeks — exactly the horizon over which a 20–30% move is plausible.

**Consequence:** Capital efficiency is lower than a 5× or 10× configuration. The strategy earns less per unit of equity in exchange for surviving the tail. This is a deliberate, documented trade.

### ADR-011 — Reject rather than clamp

**Decision:** When a setup fails a gate, it is rejected. Thresholds are never widened, targets never trimmed, quantities never rounded up to pass a minimum.

**Rationale:** Clamping turns a failed gate into a silent, undocumented position with different economics than the model assumed. A rejected setup costs nothing; a clamped one costs the difference between the thesis and the compromise.

**Consequence:** Lower trade frequency and a funnel that rejects most symbol-days. That is the correct behavior for a selective carry strategy.

### ADR-012 — `predictedFundingRate` is optional

**Decision:** The screener uses realized `fundingRate` and the causal MA. `predictedFundingRate` is consumed only if present, and never gates eligibility alone.

**Rationale:** The installed SDK's `TickerLinearInverseV5` does not type `predictedFundingRate`, and the field's availability varies by endpoint and category. Building a hard gate on an untyped optional field produces `undefined` comparisons that silently pass or silently reject.

**Consequence:** The engine reacts to realized funding, not predictions. Slightly later entries; no dependency on an unguaranteed field.

### ADR-013 — Two backtest modes: funding-only and full OHLC

**Decision:** `--mode funding` iterates funding epochs only; `--mode full` iterates OHLC bars with basis, slippage and liquidation.

**Rationale:** A funding-only sweep over 180 days and 100 symbols is fast enough to run on every config change. A full OHLC simulation is ~100× slower but is the only way to model basis, wicks and liquidation. Using only one mode either makes iteration impossible or makes results untrustworthy.

**Consequence:** Two code paths that must agree on the accounting core. They share `computeYield` and the fee model, and a golden test asserts that funding-only results equal full-mode results when basis and slippage are set to zero.

### ADR-014 — Economic time-lock with risk overrides

**Decision:** A minimum holding period derived from the fee hurdle, bypassable only by risk conditions.

**Rationale:** Without a lock, the engine churns: enter, exit on a one-epoch dip, pay 0.31% round trip, repeat. With an absolute lock, it holds through a genuine blowout. The lock must be economic (derived from actual fees and the entry MA) and overridable (because a lock that holds through liquidation is not discipline, it is negligence).

**Consequence:** Some exits that would have been profitable are delayed past the optimal point. Accepted; the alternative is fee-driven death by a thousand cuts.

### ADR-015 — Persistent kill switch in the database

**Decision:** `dn_engine_state.kill_switch` persists across restarts and blocks all new risk until explicitly cleared.

**Rationale:** An in-memory flag resets on deploy. The moment an operator most needs the halt to survive is the moment a restart happens. Persistence makes `/dn_kill` a real circuit breaker rather than a suggestion.

**Consequence:** A forgotten kill switch silently blocks the strategy. The daily digest reports kill-switch state explicitly so "why is nothing trading" is answered in one line.

### ADR-016 — Exchange-wins reconciliation

**Decision:** Any disagreement between DB and exchange is resolved in favor of the exchange; the DB is repaired, never the reverse.

**Rationale:** The exchange holds the money. A DB that disagrees is wrong by definition — there is no scenario where writing a plug into the ledger makes the position real. Unexplained drift halts new entries rather than being smoothed.

**Consequence:** A bug that under-writes the DB will be corrected on the next reconciliation, which may make historical reports shift. Report regeneration must therefore be expected and is supported.

---

## 18. Delta-Neutral Invariants

These are the normative constraints for the new engine. They are numbered as a stable API: source comments, tests and runbooks cite them, so numbers are never reused or reordered. New invariants are appended.

### 18.1 Money, precision and truth

**DN-1 — No `number` for money.** Prices, quantities, notionals, fees, funding, basis and PnL are `Decimal` in memory and strings in the DB and on the wire. `NUMERIC(24,8)` is the storage type. Formatting uses `formatPrice` / `formatQuantity` from instrument metadata, never `toFixed`.

**DN-2 — Exchange truth over local intent.** `avgPrice`, filled quantity, funding credits and fees are read from the exchange. The planned price is never persisted as a fill price. If the exchange and the DB disagree, the exchange wins (ADR-016).

**DN-3 — Equal base quantity.** `Q_spot = Q_perp` in base units after fee-currency adjustment. Equal notional is forbidden (ADR-003).

**DN-4 — Fee currency correctness.** When the spot fee is charged in the base asset, the hedged quantity is the quantity **received**, not the quantity ordered. The perp leg is sized from the received amount.

### 18.2 Execution physics

**DN-5 — No order without preflight.** Every entry passes kill switch, state, instrument status, funding interval, basis band, fee hurdle, balance, precision and minimum-notional checks before the first order is sent. Any failure aborts before submission.

**DN-6 — Leg ordering asymmetry.** Entry is spot-then-perp; exit is perp-then-spot. Inverting either order is forbidden because it converts a bounded failure into an unbounded one.

**DN-7 — Hedge the received quantity.** The perp hedge is sized from the actual spot fill (or balance delta), never from the requested quantity.

**DN-8 — Unhedged watchdog.** While a position is `SPOT_ENTRY_PENDING` or `HEDGE_PENDING`, a watchdog runs every 250 ms. Exceeding `DN_MAX_UNHEDGED_MS` escalates to a market hedge, then to rollback.

**DN-9 — Rollback is mandatory.** A failed hedge must attempt rollback. Leaving a spot position unhedged because rollback is inconvenient is forbidden; if rollback fails, the state is `ORPHAN_SPOT` with a CRITICAL alert, never `IDLE`.

**DN-10 — Partial fills are first-class.** A partial spot fill hedges the filled portion and cancels the remainder. A partial perp fill is topped up; if it cannot be topped up, the surplus spot is sold. No path assumes a full fill.

**DN-11 — Idempotent submissions.** Every order carries an `orderLinkId` derived from `positionId + leg + attempt`. A retry with the same link id must never create a second order. An ambiguous failure with an issued link id is resolved by polling, never by resubmitting blindly.

**DN-12 — No spot sell while the perp is open.** During exit, the spot leg is sold only after the perp position is verified flat. Violating this creates a naked short.

**DN-13 — Flatness before terminal state.** `CLOSED` and `ROLLED_BACK` are reachable only when both legs are verified flat (or below the dust threshold). An unverified position keeps the engine in an `ORPHAN_*` state.

### 18.3 State machine and concurrency

**DN-14 — State persisted around every exchange action.** The intended state is written before an order is sent and the confirmed state after. A crash between the two must be recoverable from the persisted intent.

**DN-15 — Hard separation from the SMC engine.** Separate process, sub-account, database, Telegram bot and deployment profile. No shared tables, no shared account, no shared state. See ADR-001.

**DN-16 — Additive schema only.** New tables are `dn_*`. SMC tables are never read or written. Migration is `CREATE TABLE IF NOT EXISTS` / additive columns with defaults; no destructive migration.

**DN-17 — One writer per position.** A per-position mutex serializes all state transitions. Concurrent handlers (WS, reconciler, command, watchdog) must acquire it or skip. A skipped action is retried on the next tick, never forced.

**DN-18 — State precedes bookkeeping.** On a confirmed fill, the in-memory/DB state transitions to `HEDGED` (entry) or `EXITING` (exit) **before** the detailed bookkeeping writes. A WS event arriving during bookkeeping must see a state that owns the position. A close event that finds no matching position row must **not** reset the state machine — bookkeeping may be in flight; reconciliation adopts it.

**DN-19 — Every path has a terminal state.** No branch ends in "logged an error and continued". Each failure maps to `IDLE`, `ROLLED_BACK`, `CLOSED`, `ORPHAN_SPOT`, `ORPHAN_PERP` or `HALTED`, and the mapping is tested by fault injection.

**DN-20 — Kill switch blocks entries, never exits.** `kill_switch=true` prevents all new risk and leaves management and exits fully operational.

### 18.4 Economics

**DN-21 — Economic time-lock.** Minimum holding epochs are derived from the fee hurdle and the entry-time funding MA, clamped to the configured bounds. A voluntary exit before the lock requires a risk override.

**DN-22 — Exit hysteresis.** Exit thresholds are strictly looser than entry thresholds for funding MA, basis and positive ratio. A single threshold for both directions produces oscillation and fee churn.

**DN-23 — Risk overrides bypass the lock.** Margin breach, liquidation proximity, delisting, manual command and basis blowout exit immediately, at a loss if necessary. The lock never traps a position in a dangerous state.

**DN-24 — Funding comes from the exchange.** Realized funding is ingested from the transaction log (`type: 'SETTLEMENT'`), matched by symbol and timestamp window, with an idempotency key. Modeled funding is used only for expectations, never for realized PnL.

**DN-25 — No compounding within a position.** Position size is fixed at entry. Profits are not reinvested into an open position; the equity conversion factor `1 + 1/L + β` is computed once.

**DN-26 — Reject, don't clamp.** Failed gates reject the setup. Thresholds, sizes and targets are never adjusted to pass (ADR-011).

### 18.5 Portfolio

**DN-27 — Caps are hard.** `DN_MAX_COIN_EQUITY_PCT`, `DN_MAX_SECTOR_EQUITY_PCT`, `DN_MAX_POSITIONS`, `DN_DEPLOYMENT_TARGET_PCT` and `DN_MIN_RESERVE_PCT` are ceilings/floors, not targets. No allocation may exceed a cap even if the score is exceptional.

**DN-28 — Deterministic allocation.** Given identical inputs, the allocator returns an identical allocation. Tie-breaks use a documented key order (score, positive ratio, stdev, turnover, spread, symbol), never array order or insertion time.

**DN-29 — Reserve is inviolable.** The reserve is never deployed to avoid missing a trade, to top up margin, or to average a position. It exists to survive an adverse move and to fund exits.

**DN-30 — No leverage increase to avoid an exit.** Adding margin by raising leverage extends the liquidation distance on paper while increasing the loss on a real move. The engine reduces size or exits; it never raises leverage.

**DN-31 — One position per symbol.** A symbol with an open or exiting position cannot receive a second allocation. Re-entry requires a closed position, cooldown expiry, and a fresh screen.

### 18.6 Risk and reconciliation

**DN-32 — Margin and liquidation gates are continuous.** `accountMMRate` and liquidation distance are evaluated every 60 s and on every position update, not only at entry.

**DN-33 — Reconciliation is authoritative.** The 10-minute loop compares spot qty, perp qty, side, prices, funding and equity against the exchange. Discrepancies are repaired toward exchange truth (ADR-016).

**DN-34 — Drift freezes entries.** A drift above `DN_DRIFT_TOLERANCE_PCT` blocks new entries until resolved. Trading on top of a corrupted ledger compounds the error.

**DN-35 — No plugs.** An unexplained discrepancy is never resolved by inserting a balancing row. It is either explained by a missing exchange record (which is upserted) or escalated as an incident.

**DN-36 — Orphans have runbooks.** `ORPHAN_SPOT`, `ORPHAN_PERP` and `DN_ROLLBACK_FAILED` each have a documented, ordered recovery procedure (§10.7), and the engine attempts it before escalating.

### 18.7 Backtester fidelity

**DN-37 — Shared pure functions.** Screening, allocation, sizing, break-even and yield math are imported by both live and backtest (ADR-009). Reimplementation is forbidden.

**DN-38 — No lookahead.** Every decision at time `t` uses data with timestamp `< t`. The funding MA at `t` excludes `t`. A signal observed at `t` is executable no earlier than `t+1`.

**DN-39 — Costs are always modeled.** Fees and slippage are never zero in a reported backtest. A "gross" run may exist for diagnostics but is labeled and never used to justify deployment.

**DN-40 — Deterministic and reproducible.** Given the same data, config and seed, the simulator produces byte-identical output. The manifest records commit, config hash, data hashes and seed.

**DN-41 — Rejection funnel parity.** Live and backtest use the same bucket names and the same deepest-gate attribution rule.

**DN-42 — Limitations are disclosed.** Survivorship bias, fee-tier drift, mark-price substitution and simplified liquidation are reported with every run, not buried in a README.

### 18.8 Operations

**DN-43 — Critical alerts never mute.** `DN_ENABLE_TRADE_NOTIFICATIONS` gates routine trade messages only. Critical, high and error-level alerts are always delivered.

**DN-44 — Config fails fast.** Invalid config aborts startup with a precise message. A silently defaulted risk parameter is a bug, not a convenience.

**DN-45 — Dry run is the default.** `DN_DRY_RUN=true` and `DN_AUTO_TRADING=false` unless explicitly overridden.

**DN-46 — Degraded is not dead.** The health endpoint reports `degraded` with HTTP 200 so an orchestrator does not restart a running engine during a transient exchange outage.

**DN-47 — Every money log line is attributable.** Position-related log lines carry `symbol` and `positionId`; money values are strings.

**DN-48 — Persistent kill switch.** `dn_engine_state.kill_switch` survives restarts and is only cleared explicitly (ADR-015).

---

## 19. What Not To Do

Each entry records a failure mode that is easy to write, plausible in review, and expensive in production. Format: **anti-pattern → why it fails → rule**.

### 19.1 Execution

**19.1.1 Short the perp first because it's faster.**
The perp short is the unbounded leg. If the spot buy then fails, the account carries a naked short with no upper bound. Spot-first caps the failure at "long an asset that fell". *Rule:* entry order is spot then perp, always (DN-6).

**19.1.2 Sell spot and perp simultaneously on exit.**
Simultaneous submission means neither leg is confirmed before the other is committed. If the perp close fails, the spot sale has already removed the hedge and created a naked short. *Rule:* perp flat first, verified, then spot (DN-12).

**19.1.3 Size the hedge from the order, not the fill.**
A 60% spot fill hedged with a 100% perp order leaves a 40% naked short. *Rule:* hedge the received quantity, read from the balance delta or fill (DN-7).

**19.1.4 Retry a timed-out order with a new `orderLinkId`.**
The original order may still be live. A new link id creates a second position and the account ends up double-hedged or double-long. *Rule:* an ambiguous submission is resolved by polling the original link id; never resubmit under a new one (DN-11).

**19.1.5 Round the quantity up to reach the minimum notional.**
Rounding up increases risk beyond the sized amount and silently breaks the per-coin cap. *Rule:* drop the candidate; minimum size is a filter, not a target.

**19.1.6 Treat "no position found" as "position closed".**
During bookkeeping, a position can exist on the exchange before the DB row lands, or the API can lag. Resetting state on absence of evidence orphans a live position. *Rule:* absence of a DB row is not evidence of flatness; verify against the exchange (DN-18).

**19.1.7 Use market orders everywhere "for simplicity".**
Market orders on both legs of every entry and exit convert a 0.31% modeled round trip into something materially worse during volatile periods. *Rule:* market orders are for urgency and safety exits; normal entries use limit/IOC with a slippage cap.

**19.1.8 Keep a maker order resting while the other leg is unhedged.**
The unhedged window is unbounded while the maker order waits. *Rule:* the unhedged watchdog starts at the first fill and does not pause for a resting order (DN-8).

### 19.2 Economics

**19.2.1 Enter on the instantaneous funding rate.**
One print is noise. A 0.08% print that mean-reverts to 0.005% next epoch produces a position that cannot cover its round trip. *Rule:* eligibility uses the causal MA over ≥ 3 epochs (ADR-005).

**19.2.2 Compare funding rate to fee rate directly.**
`f_ma = 0.02%` vs `fee = 0.31%` is not a comparison of like units. Funding accrues per epoch; fees are one-time. *Rule:* always compare annualized or per-holding-period quantities (Appendix A.5).

**19.2.3 Assume 0.15% round trip because a VIP schedule says so.**
Retail all-taker spot + perp is ~0.31%. A 0.15% assumption halves the break-even horizon and doubles the apparent yield. *Rule:* fees come from the account's actual fee snapshot; the backtest labels its fee scenario.

**19.2.4 Ignore the fee currency.**
A spot fee charged in base reduces the received quantity; hedging the ordered quantity over-hedges by the fee amount. Small, systematic, and invisible in aggregate PnL until reconciliation. *Rule:* hedge received quantity (DN-4).

**19.2.5 Exit the moment funding dips below the entry threshold.**
That is a fee pump. The position pays the round trip and re-enters a week later. *Rule:* exit hysteresis (DN-22).

**19.2.6 Hold through a negative-funding streak to "wait for the MA to recover".**
The MA is backward-looking; a negative streak means the position is paying now. Waiting is a directional bet funded by carry losses. *Rule:* negative-streak exit, subject to the explicit exit-cost vs expected-recovery comparison (§7.2).

**19.2.7 Compute APR from the entry rate and never update it.**
Reported yield then describes a past market. *Rule:* reports use realized funding and realized fees; modeled APR is labeled as modeled.

### 19.3 Portfolio

**19.3.1 Deploy 100% because the reserve "costs yield".**
The reserve is what pays for exits, margin top-ups and adverse moves. Deploying it converts a manageable drawdown into a forced liquidation. *Rule:* reserve floor is inviolable (DN-29).

**19.3.2 Let one high-score symbol take 40% because the score is exceptional.**
A score is a ranking heuristic built on historical funding. It is not a risk measure. *Rule:* hard per-coin cap regardless of score (DN-27).

**19.3.3 Treat eight L1 positions as diversification.**
Their funding and basis correlate. Eight correlated positions are one position with eight fee schedules. *Rule:* sector cap plus correlation reporting (§16.4).

**19.3.4 Raise leverage to avoid an exit.**
It extends the paper liquidation distance while increasing the loss on any real move through it. *Rule:* never (DN-30).

**19.3.5 Re-enter immediately after a fee-heavy exit.**
The regime has not changed and the fees are paid twice. *Rule:* cooldown of `DN_COOLDOWN_EPOCHS`.

### 19.4 Data and accounting

**19.4.1 Assume an 8-hour funding interval.**
Many instruments use 4h or 1h. Assuming 8h halves the expected funding for a 4h instrument and doubles the break-even horizon. *Rule:* interval from `getInstrumentsInfo`, per symbol, refreshed daily (DN-24, Appendix B).

**19.4.2 Model funding instead of ingesting it.**
Modeled funding drifts from the exchange because of mark-price differences, size changes and settlement timing. It is fine for expectations and unacceptable for realized PnL. *Rule:* realized funding comes from the transaction log (DN-24).

**19.4.3 "Fix" a discrepancy with a balancing row.**
A plug hides the bug that created the discrepancy and makes future reconciliation unable to detect it. *Rule:* explain and upsert, or halt (DN-35).

**19.4.4 Store money as `number` "just for the report".**
The report then disagrees with the ledger, and someone reconciles the report instead of the ledger. *Rule:* `Decimal` to the render boundary, strings in JSON (DN-1).

**19.4.5 Aggregate PnL without position attribution.**
An unexplained daily PnL becomes unattributable the moment two positions close in the same hour. *Rule:* every money log carries `symbol` and `positionId` (DN-47).

### 19.5 Backtesting

**19.5.1 Backtest without fees because "it's a yield strategy".**
Carry is a fee-sensitive strategy; a fee-free backtest is a different strategy with a different edge. *Rule:* costs always modeled (DN-39).

**19.5.2 Use the current universe over five years.**
Delisted symbols are absent, so the survivors are exactly the ones whose funding stayed viable. *Rule:* disclose survivorship; optionally include a manual delisted list (DN-42).

**19.5.3 Optimize thresholds on the same window used to report.**
That is fitting the report, not the strategy. *Rule:* walk-forward or out-of-sample validation for any threshold change.

**19.5.4 Assume every limit order fills.**
Fill rates on pullbacks are well below 100%, and the unfilled ones are systematically the ones where price ran away. *Rule:* fill simulation with a touch requirement and an expiration (Appendix A.7).

**19.5.5 Reimplement the live math in the simulator "for speed".**
The two diverge on the first bug fix, and the backtest then validates a strategy that no longer exists. *Rule:* shared pure functions (DN-37).

**19.5.6 Report only the base scenario.**
Every strategy looks good in its base case. The stress matrix is the actual deliverable. *Rule:* report base + at least the negative-funding and 2× slippage scenarios.

### 19.6 Operations

**19.6.1 Restart the container when `/health` returns non-200.**
During an exchange outage, that turns one degraded engine into a restart loop with open positions and no manager. *Rule:* `degraded` returns 200; only `unhealthy` is fatal (DN-46).

**19.6.2 Run both engines in one process to "save a server".**
Shared `IN_TRADE` state, shared reconciliation, shared account. The saving is a few dollars; the failure mode is double exposure. *Rule:* DN-15.

**19.6.3 Store the kill switch in memory.**
A deploy clears it. *Rule:* persistent kill switch (DN-48).

**19.6.4 Silence Telegram because the alerts are noisy.**
The noisy alert is usually a real repeated condition. Muting the class mutes the next real one. *Rule:* fix the dedupe, never mute critical (DN-43).

**19.6.5 Intervene manually without recording it.**
The next reconciliation sees an unexplained difference and halts, or worse, adopts the manual action as strategy behavior. *Rule:* every manual action is logged as an incident with a reason.

**19.6.6 Change config on a running process without a restart record.**
`config_history` exists so a PnL change can be attributed to a parameter change. Without it, a regression and a config edit are indistinguishable. *Rule:* config changes are versioned and hashed (§13.9).

---

## 20. Future Work

The following are explicitly **out of scope for v1** and recorded so they are not quietly added mid-implementation.

### 20.1 Near-term (v1.1)

| Item | Value | Blocker |
| --- | --- | --- |
| Cross-venue funding arbitrage | Higher yield when venues diverge | Requires transfer risk model and two-venue reconciliation |
| Multi-account allocation | Diversifies exchange counterparty risk | Doubles operational surface; needs per-account reconciler |
| Maker-first entry with timeout | Cuts round-trip fees ~50% | Fill-rate modeling and a reliable cancel-replace loop |
| Funding-prediction overlay | Earlier entries on regime shifts | `predictedFundingRate` availability is not guaranteed (ADR-012) |
| Auto-compounding | Higher effective APY | Changes position sizing semantics; needs explicit approval |

### 20.2 Medium-term (v2)

- **Portfolio margin optimization.** Bybit's UTA already nets margin across positions; explicit optimization could raise capital efficiency beyond the fixed 3× per position. Requires modeling portfolio margin effects that the current liquidation approximation ignores.
- **Basis trading as a separate strategy.** Enter when basis is wide, exit on convergence, independent of funding. Shares the execution layer but not the screener.
- **Options overlay for tail protection.** Buying cheap downside protection on the spot leg converts an unbounded exchange-risk position into a bounded one, at a carry cost.
- **Dynamic leverage per symbol.** Volatility-scaled leverage instead of a flat 3×. Needs a liquidation model calibrated per symbol.
- **Reinforcement-learned exit timing.** Tempting and probably overrated; the current rule set is explainable and the sample size per regime is small.

### 20.3 Explicitly rejected

| Idea | Why rejected |
| --- | --- |
| Market-making the basis | Requires inventory risk management that contradicts delta-neutrality |
| Leverage above 5× | Liquidation distance becomes comparable to normal weekly volatility |
| Holding through a known delisting | No edge compensates for a forced exit at an unknown price |
| Negative-funding carry (reverse the legs) | Doubles the strategy surface; the short-perp leg is the safe direction |
| Social/copy-trading integration | Not a strategy feature; adds custody and disclosure risk |

### 20.4 Research questions

1. Does funding persistence differ enough between majors and alts to justify a different MA window per tier?
2. Is the basis at entry a better predictor of net PnL than the funding MA? If so, the score weights are wrong.
3. What is the realized fill rate for the limit entries, and does it justify maker-first?
4. How much of the drawdown is basis (recoverable) vs funding (permanent)?
5. Does the cooldown period actually improve post-exit re-entry, or does it just delay a good trade?

Each question is answerable from data the engine already stores. That is deliberate: the observability schema is designed so future research does not require new instrumentation.

---

## Appendix A — Formula Sheet

All values are `Decimal`; `S` = spot price, `P` = perp price, `Q` = base quantity, `f` = funding rate per epoch, `L` = perp leverage, `β` = margin buffer fraction of spot notional.

### A.1 Position geometry

| Quantity | Formula | Notes |
| --- | --- | --- |
| Spot notional | `N_s = Q_s × S` | Long leg |
| Perp notional | `N_p = Q_p × P` | Short leg |
| Delta neutrality | `Q_s = Q_p = Q` | Equal base qty (DN-3) |
| Margin posted | `M_p = N_p / L` | Isolated perp margin |
| Buffer | `M_b = β × N_s` | Extra equity reserve for the position |
| Allocated equity | `E_alloc = M_p + N_s + M_b` | Denominator for ROE |
| Deployment ratio | `N_s / E_alloc = 1 / (1 + 1/L + β)` | With `P ≈ S` |
| Margin posted per equity | `M_p / E_alloc = 1 / (L(1 + 1/L + β))` | Perp margin as a share of allocated equity |

The `1 + 1/L + β` denominator is the single most important number in the model: it converts notional yield into equity yield. At `L=3, β=0.05` it is `1.3833`, so a 20% notional carry is a ~14.5% equity carry.

### A.2 Basis

```
b_t = (P_t − S_t) / S_t
```

| Quantity | Formula |
| --- | --- |
| Entry basis | `b0 = (P0 − S0) / S0` |
| Exit basis | `b1 = (P1 − S1) / S1` |
| Basis PnL (USDT) | `Q × [(P0 − S0) − (P1 − S1)]` |
| Basis PnL fraction of `N0` | `b0 − b1 × (S1/S0)` |
| Approximate (small moves) | `b0 − b1` |

### A.3 Funding

```
payment_k = Q × mark_k × f_k          (short's PnL)
```

| Quantity | Formula |
| --- | --- |
| Fraction of entry notional | `r_f,k = f_k × (mark_k / S0)` |
| Cumulative fraction | `r_f = Σ_k f_k × (mark_k / S0)` |
| Annualized (notional) | `APR_f = r_f × (365 / holding_days)` |
| Epochs per year | `(24 / fundingIntervalHours) × 365` |
| Annualized from MA | `f_ma × (24/h) × 365 × (P/S)` |

At `h=8`, `f_ma=0.02%`: `0.0002 × 3 × 365 = 21.9%` notional, `≈15.9%` equity at 3× with a 5% buffer.

### A.4 Fees

| Quantity | Formula |
| --- | --- |
| Spot entry fee (quote) | `Q S0 s_in` |
| Spot entry fee (base) | `Q s_in` → received `Q(1 − s_in)` |
| Perp entry fee | `Q P0 p_in` |
| Spot exit fee | `Q S1 s_out` |
| Perp exit fee | `Q P1 p_out` |
| Total (USDT) | `Q[S0 s_in + P0 p_in + S1 s_out + P1 p_out]` |
| Fraction of `N0` | `s_in + p_in(P0/S0) + s_out(S1/S0) + p_out(P1/S0)` |
| Symmetric approximation | `2(s + p)` |

**Reference values:** spot taker `0.10%`, perp taker `0.055%` → `2(0.0010 + 0.00055) = 0.31%`. With maker fills on both legs (`0.10%` spot maker, `0.02%` perp maker) the round trip drops to `0.24%`; with VIP/rebate pricing it can reach `~0.15%`. **`0.15%` is not a retail default** — using it without evidence understates the break-even horizon by half.

### A.5 Break-even and time-lock

```
k_be = ceil( (fee_round_trip) / f_ma )

k_min = ceil( (fee_round_trip + slip_round_trip + profit_buffer) / f_ma )
k_min = clamp(k_min, DN_MIN_HOLDING_EPOCHS, DN_MAX_HOLDING_EPOCHS)
min_hold_until = opened_at + DN_MIN_HOLDING_HOURS × 3_600_000
```

With `fee=0.31%`, `slip=0.04%`, `buffer=0.10%`, `f_ma=0.02%`:

```
k_min = ceil((0.0031 + 0.0004 + 0.0010) / 0.0002) = ceil(22.5) = 23 epochs
      = 23 × 8h = 184h = 7.67 days
```

The same fees at `f_ma=0.05%` give `k_min = 9 epochs = 3 days`. Break-even is entirely a function of the fee-to-funding ratio; this is why fee snapshots are a first-class input, not a constant.

### A.6 Net yield

```
r_net_notional = r_basis + r_funding − r_fees − r_slip
r_net_equity   = r_net_notional / (1 + 1/L + β)
APR            = r_net_equity × (365 / holding_days)
APY            = (1 + r_net_equity)^(365 / holding_days) − 1
```

### A.7 Score

```
expected_funding_apr = f_ma × (24/h × 365) × (P/S) × L/(L + 1 + βL)
expected_fee_drag_apr = 2(s+p) × (365 / expected_hold_days)
expected_basis_apr = (b_entry − b_exit_assumed) × (365 / expected_hold_days)

score_apr = expected_funding_apr − expected_fee_drag_apr + expected_basis_apr
stability = f_ma / (f_ma + σ_f)
liquidity = min(1, min(turnover_spot, turnover_perp) / (2 × DN_MIN_TURNOVER_24H_USDT))
score = max(0, score_apr) × stability × liquidity
```

### A.8 Slippage model

```
slip_bps = DN_SLIPPAGE_BASE_BPS + DN_SLIPPAGE_IMPACT_BPS × sqrt(notional / ADV)
slip_bps = min(slip_bps, DN_SLIPPAGE_MAX_BPS)
```

`ADV` is 24h quote turnover. The impact term makes size expensive, which is the intent: a strategy that ignores its own market impact backtests beautifully and executes poorly.

### A.9 Liquidation (approximation)

For an isolated short with entry `P0`, leverage `L`, and maintenance margin rate `mmr`:

```
liq_price ≈ P0 × (1 + 1/L − mmr)
```

At `L=3`, `mmr=0.005`: `liq ≈ P0 × 1.3283`, i.e. a ~32.8% adverse move. This is an approximation: UTA portfolio margin nets across positions, and the real liquidation price is computed by the exchange. The formula is used for gating and stress, not for accounting.

The `β` buffer does not move an isolated position's liquidation price — it adds account-level equity that delays a margin call and funds an orderly exit. Conflating the two (assuming the buffer widens `liqPrice`) overstates the safety margin.

### A.10 Drawdown and Sharpe

```
drawdown_t = (peak_equity − equity_t) / peak_equity

sharpe = (mean(r_d) / stdev(r_d)) × sqrt(365)     # daily returns, rf = 0
sortino = (mean(r_d) / downside_deviation(r_d)) × sqrt(365)
```

Report Sharpe and Sortino alongside net APR, never instead of it. A carry strategy can post a high Sharpe and still lose money if the loss arrives in one basis event.

---

## Appendix B — Bybit V5 API Reference Used

Only endpoints the engine actually calls are listed. All calls go through `dnBybitClient` with retry, per-symbol circuit breaker and the global 429 breaker.

### B.1 Market data

| Purpose | Endpoint | Key fields | Notes |
| --- | --- | --- | --- |
| Linear tickers | `GET /v5/market/tickers?category=linear` | `symbol`, `lastPrice`, `markPrice`, `indexPrice`, `fundingRate`, `nextFundingTime`, `fundingIntervalHour`, `fundingCap`, `basisRate`, `turnover24h`, `bid1Price`, `ask1Price` | Batch, one request for the universe |
| Spot tickers | `GET /v5/market/tickers?category=spot` | `symbol`, `lastPrice`, `turnover24h`, `bid1Price`, `ask1Price` | Used for the spot leg and basis |
| Instruments (perp) | `GET /v5/market/instruments-info?category=linear` | `qtyStep`, `minOrderQty`, `maxOrderQty`, `minNotionalValue`, `tickSize`, `fundingInterval`, `upperFundingRate`, `lowerFundingRate`, `status` | `fundingInterval` in minutes |
| Instruments (spot) | `GET /v5/market/instruments-info?category=spot` | `qtyStep`, `minOrderQty`, `minNotionalValue`, `tickSize`, `status` | Spot and perp steps usually differ |
| Order book | `GET /v5/market/orderbook?category=...&symbol=...&limit=50` | `b`, `a` | Depth check for `DN_DEPTH_MULTIPLIER` |
| Klines (perp/spot) | `GET /v5/market/kline?category=...` | `ts`, `open`, `close`, `high`, `low`, `volume`, `turnover` | Backtest OHLC and mark approximation |
| Mark price klines | `GET /v5/market/mark-price-kline?category=linear` | `ts`, `open`, `close`, `high`, `low` | Preferred for funding accrual in backtest |
| Funding history | `GET /v5/market/funding/history?category=linear&symbol=...&startTime=&endTime=&limit=200` | `symbol`, `fundingRate`, `fundingRateTimestamp` | Paginated; 200 max per page |
| Server time | `GET /v5/market/time` | `timeSecond`, `timeNano` | Clock offset |

**`predictedFundingRate` is not used as a gate.** The installed SDK's linear ticker type does not include it; if the raw response carries it, it is stored as an optional diagnostic. A gate on an optional field fails open or closed unpredictably (ADR-012).

### B.2 Account and positions

| Purpose | Endpoint | Key fields | Notes |
| --- | --- | --- | --- |
| Wallet | `GET /v5/account/wallet-balance?accountType=UNIFIED` | `totalEquity`, `totalAvailableBalance`, `totalMarginBalance`, `accountMMRate`, `coin[]` | `accountType` must be `UNIFIED`; `CONTRACT` is rejected on UTA accounts |
| Fee rates | `GET /v5/account/fee-rate?category=spot` and `?category=linear` | `takerFeeRate`, `makerFeeRate` | Snapshot daily into `dn_fee_snapshots` |
| Positions | `GET /v5/position/list?category=linear&symbol=...` | `side`, `size`, `avgPrice`, `liqPrice`, `positionIM`, `positionMM`, `unrealisedPnl`, `positionIdx` | `positionIdx: 0` for one-way |
| Set leverage | `POST /v5/position/set-leverage` | `buyLeverage`, `sellLeverage` | Once at symbol onboarding |
| Set margin mode | `POST /v5/position/switch-isolated` | `tradeMode` | Isolated per position |
| Trading stop | `POST /v5/position/trading-stop` | `stopLoss`, `takeProfit`, `positionIdx` | Optional protective stop on the perp |
| Closed PnL | `GET /v5/position/closed-pnl` | `closedPnl`, `avgExitPrice`, `createdTime` | Cross-check on close |

### B.3 Orders and executions

| Purpose | Endpoint | Key fields | Notes |
| --- | --- | --- | --- |
| Place order | `POST /v5/order/create` | `category`, `symbol`, `side`, `orderType`, `qty`, `price`, `timeInForce`, `orderLinkId`, `positionIdx`, `reduceOnly` | Spot market buy needs `qty` in quote or base depending on `marketUnit` |
| Cancel | `POST /v5/order/cancel` | `category`, `symbol`, `orderId` or `orderLinkId` | Idempotent enough to retry |
| Open orders | `GET /v5/order/realtime?category=...` | `orderId`, `orderLinkId`, `orderStatus`, `cumExecQty`, `avgPrice` | Used by reconciliation and watchdogs |
| Order history | `GET /v5/order/history?category=...` | same + `cancelType` | Debugging ambiguous submissions |
| Executions | `GET /v5/execution/list?category=...` | `execId`, `execPrice`, `execQty`, `execFee`, `feeRate`, `execTime`, `isMaker` | Fee truth per fill |
| Transaction log | `GET /v5/account/transaction-log?accountType=UNIFIED&type=SETTLEMENT` | `symbol`, `funding`, `fee`, `cashFlow`, `currency`, `transactionTime` | **No `id` field** — build an idempotency key from symbol + time + amounts |

### B.4 WebSocket topics

| Topic | Purpose | Handling |
| --- | --- | --- |
| `execution` | Real-time fills and fees | Primary fill source; reconcile with REST on reconnect |
| `position` | Perp position changes | Detect size `0` / `side: "None"` closes with `Decimal.isZero()` |
| `wallet` | Balance changes | Equity refresh; not authoritative for accounting |
| `order` | Order state transitions | Watchdog input; not a substitute for fills |

**Watchdog:** any silence > 180 s forces a reconnect and resync, mirroring `AGENTS.md` §3.1. Funding and PnL are never derived from WS alone — REST is the ledger.

### B.5 Rate limits and error codes

| Code | Meaning | Handling |
| --- | --- | --- |
| `10001` | Parameter error (price, qty, `positionIdx`, TP/SL geometry) | Classify by message; a precision error pauses the symbol, a transient geometry error aborts the attempt |
| `10002` | Invalid timestamp / `recvWindow` | Re-sync clock, retry once |
| `10003` | Invalid API key | Fatal; alert |
| `10004` | Signature error | Fatal; alert |
| `10006` | Rate limit | Backoff 1s/2s/4s; count toward breaker |
| `10016` | Server error | Retry with backoff |
| `110001` | Order does not exist | Treat as ambiguous; poll order history |
| `1100xx` order-validation family | Quantity/price/min-notional/`positionIdx` rejection | Never retry unchanged: refresh instrument info, re-format, or abort the setup |
| Duplicate `orderLinkId` (message-level) | Same link id already used | Expected on retry; fetch the original order instead of resubmitting |

The retry policy mirrors the SMC client: max 3 attempts, exponential backoff, per-symbol breaker after 3 failures in 60 s, global pause after 3 consecutive 429s.

---

## Appendix C — Configuration Cheat Sheet

The full reference is §11. This appendix is what an operator needs in front of them at 3 a.m.

### C.1 Minimal viable config

```bash
# Engine
DN_ENABLED=true
DN_DRY_RUN=true
DN_AUTO_TRADING=false
DN_KILL_SWITCH=false

# Universe (empty = all eligible USDT pairs)
DN_SYMBOLS=

# Capital
DN_DEPLOYMENT_TARGET_PCT=0.80
DN_MAX_COIN_EQUITY_PCT=0.10
DN_MIN_RESERVE_PCT=0.20
DN_MAX_POSITIONS=8
DN_PERP_LEVERAGE=3
DN_MARGIN_BUFFER_PCT=0.05

# Screening
DN_FUNDING_MA_EPOCHS=5
DN_MIN_FUNDING_RATE=0.0001
DN_MIN_POSITIVE_RATIO=0.80
DN_MIN_NET_APR=0.10
DN_MAX_BASIS=0.005

# Lifecycle
DN_MIN_HOLDING_EPOCHS=3
DN_MIN_HOLDING_HOURS=24
DN_EXIT_FUNDING_RATE=0.00002

# Execution safety
DN_MAX_UNHEDGED_MS=3000
DN_MAX_LEGGING_RETRIES=3
DN_ROLLBACK_RETRIES=5

# Operations
DN_HEALTHCHECK_PORT=3001
DN_DAILY_REPORT_UTC=00:10
DN_LOG_LEVEL=info
```

Secrets (`BYBIT_API_KEY`, `BYBIT_API_SECRET`, `DN_DATABASE_URL`, `DN_TELEGRAM_BOT_TOKEN`, `DN_TELEGRAM_CHAT_ID`) are **never** in this file.

### C.2 Knob → symptom map

When something looks wrong, this table points at the parameter most likely responsible.

| Symptom | Likely knob | Direction |
| --- | --- | --- |
| No candidates for days | `DN_MIN_FUNDING_RATE`, `DN_MIN_NET_APR`, `DN_MAX_BASIS` | Loosen one at a time, never all three |
| Too many marginal entries | `DN_MIN_NET_APR`, `DN_MIN_POSITIVE_RATIO` | Tighten |
| Positions exit almost immediately | `DN_MIN_HOLDING_EPOCHS`, `DN_EXIT_FUNDING_RATE` | Raise the lock, lower the exit floor |
| Positions held too long through decay | `DN_EXIT_FUNDING_RATE`, `DN_NEGATIVE_STREAK_EPOCHS` | Raise the floor, shorten the streak |
| Fee drag > 50% of gross funding | `DN_MIN_HOLDING_EPOCHS`, `DN_MIN_NET_APR` | Raise both |
| Frequent legging rollbacks | `DN_MAX_UNHEDGED_MS`, `DN_ENTRY_SLIPPAGE_BPS`, `DN_DEPTH_MULTIPLIER` | Widen time slightly, loosen slippage cap, require more depth |
| Rollbacks succeed but cost a lot | `DN_ROLLBACK_SLIPPAGE_BPS` | Accept; safety exits should not be tight |
| Margin warnings | `DN_PERP_LEVERAGE`, `DN_MAX_POSITIONS`, `DN_MIN_RESERVE_PCT` | Reduce leverage or positions, raise reserve |
| Basis blowout exits | `DN_MAX_BASIS`, `DN_MAX_BASIS_EXIT_PCT` | Tighten entry: entering at a wide premium invites convergence loss |
| Funding realization ratio < 0.9 | Data issue, not a knob | Check interval, settlement sync, mark price |
| Reconciliation drift | Data issue, not a knob | Check fee currency, partial fills, missing settlements |
| Alerts flooding | Dedupe window | Fix dedupe; never mute critical |
| Nothing trades after a deploy | `DN_KILL_SWITCH`, `DN_ENABLED`, `DN_DRY_RUN` | Check `/dn_status` first |

### C.3 Pre-flight config review

Before any live start, verify:

1. `DN_DEPLOYMENT_TARGET_PCT + DN_MIN_RESERVE_PCT ≤ 1`.
2. `DN_MAX_COIN_EQUITY_PCT ≤ DN_DEPLOYMENT_TARGET_PCT`.
3. `DN_EXIT_FUNDING_RATE < DN_MIN_FUNDING_RATE` (hysteresis intact).
4. `DN_PERP_LEVERAGE ≤ DN_PERP_LEVERAGE_MAX`.
5. `DN_MIN_HOLDING_EPOCHS ≤ DN_MAX_HOLDING_EPOCHS`.
6. Fee snapshot matches the account's real tier.
7. `DN_MAX_POSITIONS × DN_MAX_COIN_EQUITY_PCT` is compatible with the deployment target (eight positions at 10% needs 80% deployment; a 50% deployment target makes the eighth position unreachable).
8. The funding interval for every whitelisted symbol is confirmed, not assumed.

Item 7 is a common misconfiguration: the caps look fine individually but cannot all bind simultaneously, so the allocator silently under-deploys and the operator concludes the screener is broken.

---

## Appendix D — Glossary

| Term | Definition |
| --- | --- |
| **ADV** | Average daily volume; used in the slippage impact model |
| **APR** | Annualized simple return; used for comparison across holding periods |
| **APY** | Annualized compounded return; used only when compounding is explicitly modeled |
| **Basis** | `(P_perp − S_spot) / S_spot`; the perp premium or discount |
| **Basis blowout** | A rapid widening of the premium against the short perp |
| **Break-even epochs** | Minimum epochs of funding needed to cover round-trip costs |
| **Carry** | Return earned from holding a position, here funding plus basis |
| **Cooldown** | Mandatory wait after an exit before the same symbol can re-enter |
| **Delta** | Sensitivity of position value to the underlying price; here, net base quantity |
| **Delta-neutral** | Net delta ≈ 0; long spot offset by an equal short perp |
| **Epoch** | One funding interval (commonly 8h, sometimes 4h or 1h) |
| **Funding rate** | Periodic payment between longs and shorts, expressed per epoch |
| **Funding MA** | Causal moving average of realized funding rates over N epochs |
| **Hedge** | The offsetting leg; here the short perp |
| **Hysteresis** | Different entry and exit thresholds to prevent oscillation |
| **Leg** | One side of the position (spot or perp) |
| **Legging risk** | Risk that only one leg fills, leaving unhedged exposure |
| **Liquidation distance** | Percentage move to the perp liquidation price |
| **Maker / taker** | Resting order / crossing order; different fee schedules |
| **MMR** | Maintenance margin rate |
| **Negative basis** | Perp trading below spot; the short is positioned at a discount |
| **Notional** | `quantity × price`, in quote currency |
| **Orphan leg** | A leg without its hedge, e.g. long spot with no perp short |
| **Perp** | Perpetual futures contract with periodic funding |
| **Positive ratio** | Share of epochs in the MA window with positive funding |
| **Rollback** | Closing the filled leg after the hedge fails |
| **Round trip** | Entry plus exit, i.e. four fills for a two-leg position |
| **Slippage** | Difference between decision price and fill price |
| **Spread** | `ask − bid`, as a fraction of mid |
| **Stability** | `f_ma / (f_ma + σ_f)`; penalizes volatile funding |
| **Time-lock** | Minimum holding period derived from the fee hurdle |
| **UTA** | Unified Trading Account; Bybit's portfolio-margin account type |
| **Water-filling** | Allocation that fills the best candidates to their caps, then flows down |

---

## Appendix E — Implementation File Map & Build Order

### E.1 Module responsibilities

| Path | Responsibility | Pure? |
| --- | --- | --- |
| `src/delta/config.ts` | Parse and validate `DN_*`, fail fast | ✅ |
| `src/delta/types.ts` | Domain types, string money, `Decimal` in memory | ✅ |
| `src/delta/constants.ts` | Timeouts, bucket names, defaults | ✅ |
| `src/delta/api/dnBybitClient.ts` | REST wrapper, retry, breaker, time sync | ❌ |
| `src/delta/api/dnWsClient.ts` | Execution/position/wallet streams, watchdog | ❌ |
| `src/delta/api/dnRateLimiter.ts` | Token bucket per category | ❌ |
| `src/delta/screener/universe.ts` | Symbol mapping, status, liquidity filters | ❌ (I/O) |
| `src/delta/screener/fundingMa.ts` | Causal MA, positive ratio, stdev | ✅ |
| `src/delta/screener/eligibility.ts` | Gate function, rejection bucket | ✅ |
| `src/delta/screener/scorer.ts` | Net-APR score, stability, liquidity factor | ✅ |
| `src/delta/portfolio/equity.ts` | Wallet equity, deployed, reserve | ❌ |
| `src/delta/portfolio/allocator.ts` | Caps, water-filling, tie-breaks | ✅ |
| `src/delta/portfolio/sizing.ts` | Equity → qty → precision → min notional | ✅ |
| `src/delta/execution/preflight.ts` | All checks before the first order | ❌ |
| `src/delta/execution/orderPolicy.ts` | Market/limit, slippage caps, fee currency | ✅ |
| `src/delta/execution/legging.ts` | Two-leg state machine, watchdog, rollback | ❌ |
| `src/delta/execution/panic.ts` | Orphan close, flatness verification | ❌ |
| `src/delta/execution/idempotency.ts` | `orderLinkId` generation and lookup | ✅ |
| `src/delta/position/manager.ts` | Lifecycle orchestration | ❌ |
| `src/delta/position/funding.ts` | Epoch tracking, accrual, settlement sync | ❌ |
| `src/delta/position/exits.ts` | Time-lock, hysteresis, risk overrides | ✅ |
| `src/delta/position/margin.ts` | Margin ratio, liq distance, ADL | ✅ |
| `src/delta/accounting/pnl.ts` | Spot/perp/funding/fee decomposition | ✅ |
| `src/delta/accounting/fees.ts` | Fee snapshots and currency model | ❌ |
| `src/delta/accounting/reports.ts` | Daily/weekly report builders | ✅ |
| `src/delta/reconciliation/loop.ts` | 10-min audit | ❌ |
| `src/delta/reconciliation/legs.ts` | Spot vs perp comparison | ✅ |
| `src/delta/reconciliation/transactions.ts` | Funding/fee ingestion, idempotency | ❌ |
| `src/delta/db/schema.ts` | Additive DDL | ❌ |
| `src/delta/db/repository.ts` | Pool-safe CRUD | ❌ |
| `src/delta/telegram/notifier.ts` | Separate bot, security middleware | ❌ |
| `src/delta/telegram/commands.ts` | `/dn_*` surface | ❌ |
| `src/delta/backtest/run.ts` | CLI entry | ❌ |
| `src/delta/backtest/historyLoader.ts` | Funding + OHLC pagination/cache | ❌ |
| `src/delta/backtest/fundingExecutionSimulator.ts` | Epoch-level simulation | ❌ |
| `src/delta/backtest/portfolioSimulator.ts` | Shared equity across symbols | ❌ |
| `src/delta/backtest/metrics.ts` | PnL, ROE, APR, PF, drawdown, Sharpe | ✅ |
| `src/delta/backtest/reporter.ts` | Text/HTML/CSV artifacts | ❌ |
| `src/delta/index.ts` | Bootstrap, DI, healthcheck, shutdown | ❌ |

The "pure" column is a review gate, not documentation: a pure module that imports the client or reads `Date.now()` is a defect, because it breaks ADR-009 parity.

### E.2 Build order

Dependencies dictate the sequence. Each stage is independently testable and independently mergeable.

| Stage | Deliverable | Depends on | Test gate |
| --- | --- | --- | --- |
| 1 | `types.ts`, `constants.ts`, `config.ts` | — | Config validation suite |
| 2 | `accounting/*` (pure) | 1 | Fee, PnL, yield, break-even unit tests |
| 3 | `screener/fundingMa.ts`, `eligibility.ts`, `scorer.ts` (pure) | 1, 2 | Screener unit + property tests |
| 4 | `portfolio/allocator.ts`, `sizing.ts` (pure) | 1, 2 | Cap and water-filling tests |
| 5 | `db/schema.ts`, `repository.ts` | 1 | Migration idempotency, CRUD round-trip |
| 6 | `api/dnBybitClient.ts`, `dnRateLimiter.ts` | 1 | Fake-exchange integration |
| 7 | `backtest/historyLoader.ts` | 6 | Pagination, cache, offline mode |
| 8 | `backtest/fundingExecutionSimulator.ts` | 2, 3, 4, 7 | Golden dataset, causality |
| 9 | `backtest/portfolioSimulator.ts`, `metrics.ts`, `reporter.ts` | 8 | Reproducibility, artifacts |
| 10 | `api/dnWsClient.ts` | 6 | Watchdog, reconnect, resync |
| 11 | `execution/*` | 5, 6, 10 | Fault injection: legging, rollback, panic |
| 12 | `position/*` | 2, 11 | Lifecycle, funding sync, exits |
| 13 | `reconciliation/*` | 5, 6, 12 | Drift, adoption, orphan runbooks |
| 14 | `telegram/*`, `index.ts` | all | Command surface, health, shutdown |

Stages 2–4 are pure and can be built in parallel. Stage 8 before stage 11 is deliberate: the simulator is the cheapest place to discover that the allocator or the fee model is wrong, and discovering it there costs no money.

### E.3 Integration points with the existing repo

| Existing module | Reuse | Do not reuse |
| --- | --- | --- |
| `src/utils/logger.ts` | Winston setup pattern, Telegram hook pattern | The SMC hook instance; DN installs its own |
| `src/utils/precision.ts` | `formatPrice`, `formatQuantity` | — |
| `src/config/fees.ts` | Reference values for perp taker/maker | Spot fees are not there; DN keeps its own |
| `src/db/database.ts` | Pool pattern, `NUMERIC(24,8)`, leak-proof acquire/release | The `trades` schema and pool instance |
| `src/backtest/historyLoader.ts` | Pagination, retry, cache-key conventions | Cache filenames (DN uses `DN_` prefix and funding-specific keys) |
| `src/backtest/reporter.ts` | Artifact-writing pattern, HTML chart conventions | Report layout and metric names |
| `src/telegram/notifier.ts` | Security middleware pattern, command handler shape | Bot token, chat id, command names |
| `src/bootstrap/reconciliation.ts` | Loop cadence, clock-sync pattern | Position ownership logic |
| `src/index.ts` | Graceful shutdown, global error guards | The process itself |

The rule is: **copy patterns, never import process-global state.** A shared singleton logger or DB pool would couple the two engines' lifecycles and reintroduce exactly the coupling DN-15 forbids.

---

## Appendix F — Rejection Bucket Dictionary

Stable identifiers used by the live funnel and the backtest funnel (DN-41). Order is the evaluation order; a symbol is counted at its **deepest** reached bucket.

**Relationship to other lists.** §4.4 enumerates the screener's internal gates (`noSpotPair` … `belowHurdle`); §9.10 lists the bucket names shared with the backtester. This appendix is the **authoritative union**: it adds the engine-level pre-checks (`killSwitch`, `alreadyOpen`) and the portfolio-level `cooldown` / `minSize`, and it fixes the attribution order. When §4.4 and this table disagree on order, this table wins.

| # | Bucket | Gate | Typical cause |
| --- | --- | --- | --- |
| 1 | `killSwitch` | Engine halted | Operator action or drawdown flatten |
| 2 | `alreadyOpen` | Position exists for symbol | Duplicate intent |
| 3 | `cooldown` | Post-exit cooldown active | Recent exit |
| 4 | `noSpotPair` | Spot instrument missing | Perp-only listing |
| 5 | `notTrading` | Instrument status ≠ `Trading` | Delisting, maintenance |
| 6 | `insufficientHistory` | < `DN_MIN_HISTORY_EPOCHS` or < `DN_MIN_LISTING_DAYS` | New listing |
| 7 | `dataGap` | Missing funding or OHLC in the window | API gap, cache miss |
| 8 | `lowLiquidity` | Turnover < `DN_MIN_TURNOVER_24H_USDT` | Thin alt |
| 9 | `wideSpread` | Spread > `DN_MAX_SPREAD_BPS` | Illiquid moment |
| 10 | `fundingBelowFloor` | `f_ma < DN_MIN_FUNDING_RATE` | Carry too small |
| 11 | `fundingUnstable` | `σ_f > DN_MAX_FUNDING_STDEV` or `positive_ratio < DN_MIN_POSITIVE_RATIO` | Erratic regime |
| 12 | `fundingAtCap` | Rate at/near `fundingCap` | Capped upside |
| 13 | `basisOutOfBand` | `basis > DN_MAX_BASIS` or `basis < −DN_MAX_NEGATIVE_BASIS` | Premium too rich / discount too deep |
| 14 | `feeHurdle` | Gross carry < round-trip fees over the expected hold | Fee-dominated geometry |
| 15 | `belowHurdle` | `score_apr < DN_MIN_NET_APR` | Viable but not attractive enough |
| 16 | `allocationCap` | Candidate eligible but caps are exhausted | Capital fully deployed |
| 17 | `minSize` | Allocation < `DN_MIN_POSITION_USDT` | Equity too small or cap too tight |

**Reading the funnel:**

- A heavy `insufficientHistory` / `dataGap` tail is a **data** problem, not a market problem.
- A heavy `fundingBelowFloor` tail in a calm market is expected; carry is regime-dependent.
- A heavy `feeHurdle` tail means the fee snapshot is too high for the strategy's holding horizon — either negotiate fees or extend the hold.
- A heavy `allocationCap` tail means the strategy is capital-constrained, which is a good problem and should not be "fixed" by raising caps without re-running the backtest.
- A near-zero rejection rate with negative net PnL is a **selection** failure: the gates are too loose somewhere upstream.

---

## Appendix G — Document Control

| Field | Value |
| --- | --- |
| Document | Delta-neutral funding-rate architecture & backtester specification |
| Version | 1.0 |
| Status | Design complete; implementation not started |
| Scope | New `src/delta/` engine; no changes to existing SMC code |
| Normative sections | §18 (invariants), §11 (config), §12 (schema), §6 (state machine) |
| Related | `AGENTS.md` (SMC architecture), `README.md` (operator overview) |
| Change policy | Append-only ADRs; invariants numbered stably, never renumbered |

### G.1 Consistency checklist

Verified before sign-off:

- [x] State machine states in §6 match the transition table and the orphan taxonomy in §10.
- [x] Exit conditions in §7 match the risk overrides and the time-lock formula in Appendix A.5.
- [x] Fee constants in §8 match `src/config/fees.ts` for perps and document the separate spot rate.
- [x] Config names in §11 are used verbatim in §13, §14, §15 and the appendices.
- [x] Rejection buckets in §4.4 and §9.10 are consistent with Appendix F, which is the authoritative union and fixes attribution order.
- [x] The backtester's shared pure functions (§9) are the same modules listed in Appendix E.
- [x] Invariants §18 are cited by number where the design depends on them.
- [x] No existing file outside `docs/` was modified.

### G.2 Open questions for implementation

These do not block the design but must be answered before the execution layer is implemented (Stage 11 in Appendix E).

1. Does the account's fee tier change the `DN_ASSUMED_ROUND_TRIP_FEE` sanity baseline? If actual is 0.24%, the baseline should reflect it, not the retail 0.31%.
2. Is `marketUnit` required for spot market buys on this account, or does `qty` in base work? This affects the entry path and must be verified once, on demo.
3. Does the sub-account inherit the master's fee tier, or does it start at the base tier? A newly created sub-account often starts at the lowest tier.
4. Are funding settlements reported per symbol per epoch, or aggregated? The idempotency key depends on the answer.
5. What is the actual partial-fill behavior on the chosen spot pairs at the intended size? This calibrates `DN_DEPTH_MULTIPLIER`.

Each question is answerable with one demo-account session. Answering them before writing the execution layer is significantly cheaper than discovering them during the Phase 3 burn-in.

---

_End of document._
