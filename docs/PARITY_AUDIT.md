# LIVE vs BACKTEST — PARITY AUDIT & VERIFICATION MATRIX

> **Revision**: 2026-10-21 (post-correction).
> **Scope**: `src/engine` + `src/risk` + `src/execution` (live) vs `src/backtest` (simulation), head-to-head on every input, decision and output path.
> **Method**: read-only static audit of the full decision graph, followed by a targeted correction pass on `src/backtest/run.ts` (see §3).
> **Verification**: `npm run typecheck` clean, `npx jest` → **31 suites / 329 tests green** (§5).

---

## 0. VERDICT

The backtester is **structurally faithful**: it runs the same `ScenarioRouter`, the same scenarios, the same `BaseScenario.calculateLevels()`, the same `RiskManager` sizing math, the same `evaluateTradeManagement()` (Adaptive Fractioning) and the same Hybrid Smart Entry decision as the live engine. It is **not** a second implementation of the strategy — it is the same code driven by replayed candles.

Before this pass it was **optimistic and partially non-causal** on three axes:

1. **Pattern window size** (HTF 50 vs 200) — scenarios 1/5/9 saw different 4H structure.
2. **Lookahead** — the still-forming 4H candle (up to 4h of future data) and, in Sniper Mode, the still-forming 15m candle were fed into `buildPatternData()`.
3. **Warmup** — with a proper 200-candle HTF window, the first ~33 days of a 60-day run would have been evaluated against a truncated window.

All three are corrected in §3. Remaining divergences are **execution-realism gaps** (funding, slippage, news, manual approval) and are listed with impact estimates in §4 — none of them change the *decision logic*, only the *fills and filters* around it.

---

## 1. PARITY VERIFICATION MATRIX

### Vector 1 — Signal input (candles → PatternData → Router)

| Input | Live (`StrategyEngine` / `CandleFeed`) | Backtest — before | Backtest — now | Status |
|---|---|---|---|---|
| LTF pattern window | `CandleFeed(ltf, historyCandles)` → **200 closed** candles max | `slice(index15m - 200 + 1, index15m + 1)` → 200 **+ forming** candle in Sniper Mode | `slice(end - historyCandles, end)`, forming candle excluded | ✅ FIXED |
| HTF pattern window | `CandleFeed(htf, historyCandles)` → **200 closed** candles max | **50** candles, `ts <= lastClosed15m.timestamp` (forming 4H candle included) | `historyCandles`, `ts + 4h <= evaluation instant` | ✅ FIXED |
| 1m window (Sniper) | `feed1m` capacity **300** (5h), closed only | 200 candles | `SNIPER_1M_WINDOW = 300` | ✅ FIXED |
| Evaluation timestamp | Timestamp of the candle that just closed (1m in Sniper, 15m in Classic) | `lastClosed15m.timestamp` even in Sniper → killzone/session mis-gated for the first 15 min of every hour | `candleTime` in Sniper, `lastClosed15m.timestamp` in Classic | ✅ FIXED |
| Minimum-history gate | `candlesLtf.length < 20 \|\| candlesHtf.length < 20` → skip | `currentHtfCandles.length >= 50` | `>= MIN_PATTERN_CANDLES (20)` per timeframe | ✅ FIXED |
| Warmup at run start | Full `historyCandles` preloaded at boot | Window grew from 1 candle; the first 200 4H candles (~33 days of a 60-day run) truncated | LTF **and** HTF warmup preloaded before `fromMs` (context only, never traded) | ✅ FIXED |
| Macro context (PDH/PDL/PWH/PWL/ATH/ATL) | REST 1W/1D at boot + daily 00:00 UTC refresh | Dynamic, causal, sliding windows of closed candles | Same (Invariant 13) | ✅ PARITY |
| News embargo (±30 min high-impact USD) | `newsService.isNewsEmbargo(candleTimestamp)` before router | **absent** | **absent** | ⚠️ RESIDUAL (§4.1) |
| Day-of-week filter | Router top, UTC weekday of eval timestamp | Router top — identical code | Identical | ✅ PARITY |
| Killzone gate | `patternData.currentKillzone` / `isInKillzone()` (12 scenarios) | Same code paths | Same | ✅ PARITY |
| Mitigated zones | Engine memory, 100-entry cap, filtered by type/timeframe/direction/top/bottom | `state.mitigatedZones` | Same semantics | ✅ PARITY |
| Mitigated structures | Engine memory, 100-entry cap, **timestamp-only** matching | `state.mitigatedStructures` | Same semantics | ✅ PARITY |
| Pattern cache mutation | Fresh `buildPatternData` per `evaluate()` | Copy-on-write `evaluationData` (Invariant 50) | Same | ✅ PARITY |

### Vector 2 — Entry execution physics

| Stage | Live | Backtest | Status |
|---|---|---|---|
| Signal → decision | `process()` on confirmed candle, `SCANNING` only, `isProcessing` mutex | Loop on closed candles, same router, same mutex semantics | ✅ PARITY |
| Hybrid Smart Entry | `isDiscount \|\| priceDiffPct <= smartEntryThresholdPct` at the live tick | Identical formula on `candle.close` | ✅ PARITY |
| Discount Trap guard | Discount ⇒ always Market (never Limit) | Identical | ✅ PARITY |
| Pre-flight SL breach | `livePrice` vs SL ± `PREFLIGHT_BUFFER_PCT` | `candle.close` vs SL ± `preflightBufferPct` | ✅ PARITY |
| Pre-flight TP reached | `livePrice` vs TP | `candle.close` vs TP | ✅ PARITY |
| Slippage Guard (0.2% directional) | Market orders only; rejects if price moved >0.2% toward TP while awaiting approval | Not implemented | ✅ NON-DIVERGENT for auto path — see §4.5 (unreachable by construction at decision time) |
| Order submission | Bybit `submitOrder` with `positionIdx: 0`, TP/SL attached, `orderLinkId` idempotency | Simulated state transition | ➖ N/A (no exchange) |
| Fill price (Market) | Exchange `avgPrice` (actual fill, Invariant 34) | Signal candle `close` | ⚠️ RESIDUAL (§4.2) |
| Fill price (Limit) | Fills when the book trades through the limit, possibly partially (Invariant 53) | Fills full qty when `low <= limit` (Buy) / `high >= limit` (Sell) at the exact limit price | ⚠️ RESIDUAL (§4.2) |
| Limit expiry | Age based: `LIMIT_EXPIRATION_CANDLES × LTF` minutes, checked by the 10-min ReconciliationLoop | `candlesWaited > limitExpirationCandles` (candle-exact) | ✅ PARITY (granularity diff ≤ 10 min) |
| Failure handling | `burnSetup()` + `SCANNING`; post-fill `panicCloseOrphan()` (Invariant 49) | `burnBacktestSetup()` + `state` reset; no orphan path exists | ✅ PARITY of the reachable paths |
| Fee model | Exchange actual taker/maker + funding, from `closedPnl` | `TAKER_FEE_RATE = 0.00055`, `MAKER_FEE_RATE = 0.00020`, entry+exit settled **once** at closure | ⚠️ RESIDUAL on funding only (§4.3) |

### Vector 3 — Position management (Adaptive Fractioning)

| Aspect | Live | Backtest | Status |
|---|---|---|---|
| Core evaluator | `evaluateTradeManagement()` (`src/risk/tradeManager.ts`) | **same function** | ✅ PARITY |
| Profit-direction guard | `isProfitable` required before progress math (Invariant 41) | Same function | ✅ PARITY |
| Milestones (Classic < 4R: 66% → SL→entry; Sniper ≥ 4R: 33% → 25% + SL→entry, 66% → 25% + trail) | Same thresholds | Same function | ✅ PARITY |
| `TotalR` initialization | `initializeTradeManagement(entry, sl, tp, qty)` before open | Same call before open (no hardcoded `0`) | ✅ PARITY |
| Evaluation cadence | **Every WS tick** (`checkAndManagePosition` before the `confirmed` guard) | Once per candle, using the favorable extreme (`high` for longs / `low` for shorts) | ⚠️ RESIDUAL (§4.4) |
| Partial-close qty | `formatQuantity(qty, qtyStep)` + `minOrderQty` guard | Same helpers | ✅ PARITY |
| Partial-close fill price | Market (reduce-only) at the live price | `max(triggerPrice, open)` (long) — the first price the market offered | ⚠️ RESIDUAL (§4.2) |
| SL update | `setTradingStop` on the position (Invariant: never `amendOrder`) | State mutation (`slPrice`) | ✅ PARITY of intent |
| Milestone persistence | DB write **only after** `ok: true` (no silent desync) | Applied when the signal fires in-candle | ✅ PARITY |
| Same-candle safety | n/a (tick-based) | `hitSL`/`hitTP` evaluated against the **pre-management** stop → a same-candle SL→BE move can never manufacture a false breakeven | ✅ CONSERVATIVE BY DESIGN |
| Stop consumed on inactivity | Breakeven logic replaced by Adaptive Fractioning (no `BREAKEVEN_RR_TRIGGER`) | Same | ✅ PARITY |

### Vector 4 — Risk & sizing

| Guard | Live | Backtest | Status |
|---|---|---|---|
| Position sizing | `qty = (workingBalance × risk%) / SL distance`, rounded to `qtyStep` | Same formula and rounding (`formatQuantity`) | ✅ PARITY |
| Min / max order qty | Abort if `< minOrderQty` or `> maxOrderQty` | Same | ✅ PARITY |
| Micro-stop guard | SL distance > 0.1% | Same (`MIN_SL_DISTANCE_PCT`) | ✅ PARITY |
| Leverage cap | `maxAllowedQty = marginBuffer × leverage / entry` | Same | ✅ PARITY |
| Margin buffer | 98% of working balance | Same | ✅ PARITY |
| Capacity cap | `MAX_WORKING_CAPITAL` applied to sizing **and** drawdown guard | Same | ✅ PARITY (Invariant 55) |
| **Drawdown Guard source** | Global DB query: last 3 **CLOSED** trades across **all symbols** (`getRecentClosedTrades(3)` — includes `CANCELLED` rows with `pnl = 0`) | Per-symbol `consecutiveLosses` counter | ⚠️ RESIDUAL (§4.6) |
| Balance | Live exchange USDT (unified) | Fixed **1000 USDT per symbol**, no cross-symbol compounding | ⚠️ RESIDUAL (§4.7) |
| TP source | Scenario `calculateLevels()` — never recalculated in the RiskManager | Same | ✅ PARITY |
| Entry/SL precision | `formatPrice(value, tickSize)` — no double rounding | Same | ✅ PARITY |

### Vector 5 — Exits, PnL truth & state recovery

| Aspect | Live | Backtest | Status |
|---|---|---|---|
| Exit detection | WS `Position` **and** `Execution` topics (Invariant 35) | `hitSL`/`hitTP` on candle wicks | ➖ N/A (no exchange) |
| Exit price | Real fills (`getClosedPnl` sum after 2.5 s; WS `execPrice` fallback) | Exact SL/TP price | ⚠️ RESIDUAL (§4.2) |
| Same-candle SL+TP | Exchange-order dependent, unknowable | **SL first; `BOTH` ⇒ LOSS at SL** (conservative, Invariant 16) | ✅ CONSERVATIVE BY DESIGN |
| Same-candle re-entry after Limit fill | Possible (SL/TP can be hit intra-candle) | Deferred to the next candle (`candle.timestamp <= entryTime` guard) | ⚠️ RESIDUAL (§4.8) |
| Partial-close PnL aggregation | `.filter().reduce()` over `closedPnl` matching `createdTime >= openedAt` (Invariant 26) | `realizedGrossPnl` ledger summed into the lifecycle PnL | ✅ PARITY of totals |
| Funding fees | Included in `closedPnl` | **Not modeled** | ⚠️ RESIDUAL (§4.3) |
| Cooldown after loss | `cooldownCandles × LTF` from **wall clock**, armed when realized PnL < 0 (WS **or** reconciliation) | Same duration from `candle.timestamp`, armed on `netPnl < 0` | ✅ PARITY |
| Reconciliation | 10-min loop: position/limit audit, force-reset, CANCELLED closes | Not needed (state is fully owned in-memory) | ➖ N/A |
| Orphan/panic-close | `panicCloseOrphan()` + strict `IN_TRADE` retention (Invariant 49) | Impossible (no DB failure mode in-loop) | ➖ N/A |
| Cooldown/re-entry protection | `mitigatedZones` + `mitigatedStructures` burned on entry and on close/abort | Zone burned **at order placement**; structure burned at open; both kept on close | ✅ PARITY (zone timing slightly stricter — §4.9) |

### Vector 6 — Infrastructure (live-only by construction)

| Component | Live | Backtest |
|---|---|---|
| WebSocket watchdog (3 min) | Active | ➖ N/A |
| REST circuit breakers (per-symbol + global 429) | Active | ➖ N/A (uses the same `BybitClient` for history only) |
| Chunk retry guard on history fetch | n/a | 8 attempts / 3 s pause, partial history kept, cache never poisoned (Invariant 46) |
| Clock sync, reconciliation, backups, funding monitor | Active | ➖ N/A |
| Timezone handling | `tzdata` + luxon `America/New_York` | Same killzone code, UTC-driven |

---

## 2. DIVERGENCE REGISTER (ranked by severity, pre-pass)

| # | Severity | Divergence | Impact | Status |
|---|---|---|---|---|
| 1 | **CRITICAL** | HTF window 50 vs 200 (`run.ts`) | Scenarios 1/5/9 (4H trend, sweeps, turtle soup) evaluated against a different 4H structure — different trades | ✅ FIXED |
| 2 | **CRITICAL** | Forming 4H candle included (`ts <= lastClosed15m.timestamp`) | Up to **4 hours of future price action** leaked into every pattern build | ✅ FIXED |
| 3 | **CRITICAL** | Forming 15m candle included in Sniper Mode | Up to **15 minutes of future price action** in each 1m evaluation | ✅ FIXED |
| 4 | **HIGH** | No pattern warmup | With the (correct) 200-candle HTF window, ~33 of 60 days would run on a truncated window; LTF ~2 days | ✅ FIXED |
| 5 | **HIGH** | Sniper evaluation timestamp anchored to the 15m candle | `currentKillzone`/session derived from the wrong hour → mis-gated entries in the first 15 min of every hour | ✅ FIXED |
| 6 | **HIGH** | Minimum-history gate 50 vs live's 20 | Setups the live engine would take were suppressed (or, with the fixed window, trades would be suppressed for 33 days) | ✅ FIXED |
| 7 | **MEDIUM** | Sniper 1m window 200 vs live 300 | Marginal context difference for Scenario 12 (its active lookback is 50 min) | ✅ FIXED |
| 8 | **MEDIUM** | No News Embargo filter | Trades during ±30 min high-impact USD windows that live would skip | ⚠️ RESIDUAL §4.1 |
| 9 | **MEDIUM** | Drawdown Guard source (global DB vs per-symbol counter) | Risk % may differ after mixed-symbol loss streaks | ⚠️ RESIDUAL §4.6 |
| 10 | **MEDIUM** | Funding fees unmodeled | Perpetual funding (paid/received every 8 h on held positions) is absent from simulated PnL | ⚠️ RESIDUAL §4.3 |
| 11 | **LOW** | No slippage/spread; exact SL/TP exits; full-fill limits | Simulated PnL is optimistic per trade (see §4.2) | ⚠️ RESIDUAL §4.2 |
| 12 | **LOW** | Fixed 1000 USDT per symbol, no compounding | Report aggregation ≠ account equity curve | ⚠️ RESIDUAL §4.7 |
| 13 | **LOW** | 1m window warmup at run start | First ~50 minutes of a Sniper run have a thinner 1m lookback than live | ⚠️ RESIDUAL §4.10 |
| 14 | **LOW** | Manual approval path not simulated | No timeout/slippage-guard/latency analogue | ⚠️ RESIDUAL §4.5 |

---

## 3. CORRECTIONS APPLIED (2026-10-21 pass)

All changes are confined to **`src/backtest/run.ts`** — the live engine was not modified. No shared code (`ScenarioRouter`, `RiskManager`, `tradeManager`, `executionSimulator` parity helpers) was touched.

### 3.1 Pattern window sizes → live `CandleFeed` capacities (tasks 2 & 3)

```ts
// Live CandleFeed capacities — the backtester MUST feed buildPatternData()
// the identical lookback window.
const SNIPER_1M_WINDOW = 300;   // StrategyEngine feed1m capacity (5h)
const MIN_PATTERN_CANDLES = 20; // StrategyEngine.process() guard
```

```ts
// Inside runBacktestForSymbol():
const historyWindow = config.historyCandles ?? 200;
const ltfStart = Math.max(0, ltfEndExclusive - historyWindow);   // was: - 200
const htfStartIdx = Math.max(0, htfEndIdx - historyWindow + 1);  // was: - 50
```

**Before → after**: LTF `200` hardcoded → `config.historyCandles` (200 by default, single source of truth, Invariant 42); HTF `50` hardcoded → `config.historyCandles`.

### 3.2 Closed-candle causality (lookahead elimination)

```ts
// Evaluation instant = the moment the trigger candle closed.
const evalCloseTimeMs = useSniperMode ? candleTime + 60 * 1000
                                      : candleTime + ltfMs;

// HTF window: only 4H candles fully closed by that instant.
const validHtfTimestamps = htfTimestamps.filter(
  (ts) => ts + htfMs <= evalCloseTimeMs,       // was: ts <= lastClosed15m.timestamp
);

// LTF window: drop the 15m candle still forming at that instant.
let ltfEndExclusive = index15m + 1;
const lastLtf = candlesLtf[ltfEndExclusive - 1];
if (lastLtf && lastLtf.timestamp + ltfMs > evalCloseTimeMs) ltfEndExclusive -= 1;
```

**Why the guard (not a plain `index15m` shift)**: in Classic mode the current candle has *just closed* (`timestamp + ltfMs === evalCloseTimeMs`) and is legitimately part of the window — the guard keeps it, and also stays correct across LTF data gaps. In Sniper mode the candle containing the current 1m tick is excluded.

### 3.3 Evaluation timestamp parity

```ts
const evalTimestamp = useSniperMode ? candleTime : lastClosed15m?.timestamp ?? candleTime;
```

Passed to both `recognizer.buildPatternData(...)` and `router.evaluate(...)`. `buildPatternData` consumes this only for session/killzone derivation (`patternRecognizer.ts`), which is exactly what live does with the 1m trigger timestamp. Under a 15m anchor, `NY 07:00–10:00` was evaluated as `06:45–09:45` for the first 15 minutes of every hour.

### 3.4 Live-parity minimum-history gate

`currentHtfCandles.length >= 50` (two call sites) → `currentLtfCandles.length >= 20 && currentHtfCandles.length >= 20`, mirroring `StrategyEngine.process()`.

### 3.5 Warmup preload (pattern context only)

```ts
// main(): fetch historyCandles extra LTF/HTF candles BEFORE the report window.
const ltfWarmupMs = historyWindow * Number(config.ltfTimeframe) * 60 * 1000;
const htfWarmupMs = historyWindow * Number(config.htfTimeframe) * 60 * 1000;
// ... loadCachedOrFetch(..., fromMs - warmupMs, toMs, ...)

const ltfWarmupCount = Math.max(0, candlesLtfWithWarmup.findIndex(c => c.timestamp >= fromMs));
const candlesLtf = candlesLtfWithWarmup.slice(ltfWarmupCount);   // report/period series
```

`runBacktestForSymbol()` receives the full array (warmup included) **plus** `ltfWarmupCount`, and starts its loop at that index:

```ts
const loopStart = useSniperMode ? 0 : Math.min(ltfWarmupCount, mainCandles.length);
for (let i = loopStart; i < mainCandles.length; i++) { ... }
```

**Guarantees**:
- Warmup candles are **never traded** — the simulated period still starts at `fromMs`.
- `printReport()` / `writeBacktestArtifacts()` still receive the **period slice**, so the report window, the chart period and `BACKTEST_DAYS` remain identical (Invariant 42).
- Both cache files now carry the warmup range; `loadCachedOrFetch` merges and re-saves, so subsequent runs are cache-hits.

### 3.6 Sniper 1m window 200 → 300

```ts
const sliceStart = Math.max(0, sliceEnd - SNIPER_1M_WINDOW); // was: - 200
```

### 3.7 Cosmetic

- Loop-start-aware progress counter in the completion log (`mainCandles.length - loopStart`).
- Warmup preload is logged once per symbol (`Pattern warmup preloaded: N extra 15m candles`).

---

## 4. RESIDUAL DIVERGENCES (accepted, with impact)

### 4.1 News Embargo is live-only
`NewsService` (FXMacroData ±30 min high-impact USD) is injected into live engines only. The backtester has no embargo window, so it may take setups live would skip.
**Impact**: a handful of 1-hour windows per week; direction of bias is *unknown* (news trades are high-variance, not inherently positive or negative). Fixing requires network access to a third-party calendar during replay.

### 4.2 No slippage, spread or partial fills
Market entries fill at the signal candle close; limits fill the full qty at the exact limit price; SL/TP exits fill at the exact stop/target. Live suffers all three: spread on entry, slippage on Market orders, partial limit fills (Invariant 53), and gap-through-stops.
**Impact**: per-trade optimism, roughly `spread + slippage` on entry plus stop-throughput on exits. On liquid pairs with taker fees already modeled, this is the **largest remaining optimism** in absolute PnL.

### 4.3 Funding fees unmodeled
Live `closedPnl` includes funding (Invariant: PnL truth comes from the exchange). A position held across an 8-hour funding stamp pays/receives that rate; the backtester credits none of it.
**Impact**: bounded by `|rate| × notional × stamps`, typically ~0.01%/8h. Direction depends on the side and the prevailing rate — it can help or hurt.

### 4.4 Management cadence (tick vs candle)
Live evaluates Adaptive Fractioning on **every WS tick**; the backtester evaluates once per candle using the favorable extreme.
**Impact**: milestones can be recognized one candle earlier in the backtest than live would in a fast move; the *pre-management stop* rule (§Vector 3) prevents this from manufacturing breakevens.

### 4.5 No manual-approval path
`AUTO_TRADING=false` (user approval, timeout, directional slippage guard, Telegram latency) has no backtest analogue — the simulator always behaves like `AUTO_TRADING=true`.
**Note**: the 0.2% directional guard is **not** a divergence for the auto path: at decision time `movedTowardTp <= 0` by construction (a discount or a within-threshold premium), and in live auto mode the same guard is evaluated milliseconds after the same decision. It only becomes meaningful on the manual path, which is out of scope.

### 4.6 Drawdown Guard source
Live reads the last 3 **closed** trades globally (`WHERE status='CLOSED' ORDER BY closed_at DESC`), so a loss on BTCUSDT can reduce risk on ETHUSDT — and `CANCELLED` rows (`pnl = 0`) participate, breaking a streak. The backtester uses a per-symbol `consecutiveLosses` counter.
**Impact**: risk-percent divergence after mixed-symbol streaks; measurable but second-order versus window/lookahead bugs.

### 4.7 Fixed per-symbol balance
Each symbol is simulated from `initialBalance = 1000 USDT` independently; there is no cross-symbol compounding and no shared margin.
**Impact**: report totals aggregate independent tearsheets; use them for *per-trade* statistics, not for account-equity projection.

### 4.8 Same-candle exit after a Limit fill
`checkAndCloseTrade()` skips any candle with `candle.timestamp <= trade.entryTime`, so a Limit filled on candle C cannot exit on candle C. Live can stop out or take profit intra-candle.
**Impact**: one candle of deferral on limit entries (both favorable and unfavorable depending on direction of travel).

### 4.9 Zone burn timing on Limit placement
The backtester adds the zone to `mitigatedZones` at **placement**; live burns on fill/close/`burnSetup()` (and on unfilled-limit cancellation the zone returns to the pool via the normal scan).
**Impact**: the backtester is *stricter* — it can miss a re-entry live would consider. Conservative direction.

### 4.10 1m warmup at Sniper run start
1m candles are loaded from `fromMs` (they are the trigger series and must not be offset). The first ≤50 minutes of a Sniper run therefore have a thinner 1m lookback than live's 300-candle `feed1m`.
**Impact**: confined to the first ~50 minutes of the run; negligible for a 60-day window.

---

## 5. VERIFICATION

| Check | Result |
|---|---|
| `npm run typecheck` (`tsc --noEmit`) | ✅ clean |
| `npm test` (`jest`) | ✅ **31 suites / 329 tests passed** |
| `tests/backtestSynchronization.test.ts` | covers sizing parity, fee settlement-once, burn-on-entry, milestone initialization |
| Files changed in this pass | `src/backtest/run.ts` only (+ this document) |

### Acceptance criteria traceability

| Task | Requirement | Where |
|---|---|---|
| 1 | Save audit permanently | this file |
| 2 | HTF slice uses `config.historyCandles` (200) instead of 50, same window as live | §3.1 + §3.5 |
| 3 | LTF pattern window uses `config.historyCandles` instead of hardcoded 200 | §3.1 |
| — | (discovered) lookahead, warmup, gate, 1m window, eval timestamp | §3.2 – §3.6 |

### Reproduction

```bash
npm run typecheck
npm test
npm run backtest -- BTCUSDT        # verify the "Pattern warmup preloaded" log line
```

Expected new log lines per symbol:

```
[symbol] Pattern warmup preloaded: 200 extra 15m candles (HTF fetch extended by 200 × 240m).
[symbol] Starting backtest loop over <BACKTEST_DAYS-derived count> candles (Sniper Mode: OFF (15m)).
```

> Warmup changes the **cache contents** on first run (`data/backtest_cache/*.json` is re-saved with the extended range). Subsequent runs are cache-hits and produce identical results.

---

## 6. CHANGE HISTORY

| Date | Change |
|---|---|
| 2026-10-21 | Initial audit (6 vectors). Corrections: HTF/LTF window → `historyCandles`; closed-candle causality (HTF + Sniper LTF); evaluation timestamp parity; `>= 20` gate parity; LTF/HTF warmup preload; Sniper 1m window 300. Residuals documented (§4). |

_Last updated: 2026-10-21._
