# Architectural Implementation Plan
## S13 Deprecation · S12 Frequency Expansion · S1/S5 Revival · Mixed-Mode Readiness

**Status:** PLAN ONLY — no source file has been modified.
**Date:** 2026-10-23
**Scope:** `src/engine/scenarios/Scenario12_SniperTouch.ts`, `Scenario1_HTFContinuation.ts`, `Scenario5_HTFLiquiditySweep.ts`, scenario lifecycle (`scenarioRouter`, `strategyEngine`, `config/env`), reconciliation, backtester, tests, docs.
**Reference:** `smc_full_guide.md` §2 (HTF Continuation), SFP/sweep reversal, AGENTS.md invariants 1–57.

---

## 0. Executive Verdict

| Question | Answer |
| --- | --- |
| Is S13 removed cleanly? | Yes — 1 scenario file + 2 brain modules + 1 test suite + 2 brain tests + 3 wiring points. `tpResolver.ts` survives. |
| Does S12 keep its verified edge? | Yes — the 1m CHoCH + displacement + OB-midpoint proximity + structural TP path is untouched. Only the **sweep source list** and the **sweep→CHoCH pairing rule** change, and both new sources are opt-in. |
| Can S1 be restored without breaking existing tests? | Yes — current S1 tests only exercise `calculateLevels()` geometry; behaviour tests must be added. |
| Can S5 be restored without breaking existing tests? | Functionally yes, but **two fixtures must change** (CHoCH timestamp and missing `timeframe`) because the current fixtures encode the causality bug. |
| Is the execution pipeline 100% ready for S12 + S1/S5 in one process today? | **No.** The primitives (Hybrid Smart Entry, RiskManager, tpResolver, BybitClient) are ready. Six process-level cadence/timing couplings are not. All are fixed in Step 5. |

### The six mixed-mode blockers

| # | Blocker | Current code | Effect in mixed mode |
| --- | --- | --- | --- |
| B1 | Limit expiry is mode-global | `resolveLimitExpirationCandles(config)` keys on `enableSniperMode` | A 15m S1/S5 limit expires after `15 × 1m = 15 min` instead of `6 × 15m = 90 min` |
| B2 | Cooldown is mode-global | `enableSniperMode ? 1 : Number(ltfTimeframe)` (3 call sites) | A 15m stop-loss gets a 16-minute cooldown instead of 4 hours |
| B3 | Router evaluates every scenario on every 1m close | `process('1')` passes the full scenario list | S1/S5 rescan 15× per bar on stale 15m data and can trigger on a 1m tick |
| B4 | One dedupe marker for both cadences | `lastProcessedCandleTimestamp` | At every 15m boundary both feeds confirm a candle; the second pass is dropped (`|Δ| < 60 000`) |
| B5 | Execution-feed fallback is mode-global | `enableSniperMode ? feed1m : feedLtf` | A 15m trade falls back to a 1m feed (harmless but inconsistent); a null scenario id cannot be resolved per trade |
| B6 | Reconciliation/no scenario id on `reconcileWithTrade` | expiry resolved mode-globally; `reconcileWithTrade` param has no `scenarioId` | Post-crash recovery mis-times limit expiry and cooldown for the wrong cadence |

---

## 1. S13 Deprecation (do this first)

### 1.1 Delete files

```text
DELETE src/engine/scenarios/Scenario13_TopDownOrderFlow.ts
DELETE src/engine/brain/htfRoadmap.ts
DELETE src/engine/brain/volumeExhaustion.ts
DELETE tests/scenarios/scenario13_top_down.test.ts
DELETE tests/engine/brain/htfRoadmap.test.ts
DELETE tests/engine/brain/volumeExhaustion.test.ts
```

`src/engine/tpResolver.ts` **stays**. It is a standalone, pure module used by S12 and now by S1/S5. `tests/engine/tpResolver.test.ts` stays.

### 1.2 `src/engine/scenarioRouter.ts`

```diff
@@ imports
-import { Scenario13_TopDownOrderFlow } from './scenarios/Scenario13_TopDownOrderFlow';
@@ constructor
     const allScenarios: IScenario[] = [
-      // Priority 1: Top-Down orchestrator — 4H roadmap + 15m volume + 1m trigger.
-      // Checked before every single-timeframe scenario: when the full matrix agrees,
-      // its confluence strictly dominates any partial setup.
-      new Scenario13_TopDownOrderFlow(this.config),     // 13: Top-Down Order Flow
       // Priority 1: Complex, high-precision scenarios (checked first)
       new Scenario5_HTFLiquiditySweep(this.config),    // 5: HTF Liquidity Sweep
```

### 1.3 `src/backtest/reporter.ts`

```diff
@@ imports
-import { Scenario13_TopDownOrderFlow } from '../engine/scenarios/Scenario13_TopDownOrderFlow';
@@ resetScenarioRejectionStats()
   Scenario12_SniperTouch.resetStats();
-  Scenario13_TopDownOrderFlow.resetStats();
 }
@@ generateReport() — delete the whole S13 block, keep the trailing blank line
-  // Scenario 13 is an AND of three timeframes, so the funnel is the only readable
-  // presentation: a bullish 4H roadmap with no 15m volume event is not a partial
-  // setup, it is nothing. Buckets always sum to Total - Triggered.
-  const scenario13Stats = Scenario13_TopDownOrderFlow.getRejectionStats();
-  lines.push('   Scenario 13 (Top-Down Order Flow):');
-  lines.push(`     Total: ${scenario13Stats.totalEvals} | Triggered: ${scenario13Stats.triggered} | Disabled: ${scenario13Stats.disabled} (strict Sniper Mode requirement)`);
-  lines.push(`     Macro gates: NoHtfRoadmap: ${scenario13Stats.noHtfRoadmap} (${sharePct(...)}) | HtfNeutral: ...`);
-  lines.push(`     Flow gates: NoPullbackOrigin: ...`);
-  lines.push(`     POI gates: PoiViolated: ...`);
-  lines.push(`     Target gates: InsufficientAsymmetry: ... | TpInvalid: ...`);
   lines.push('');
```

### 1.4 `src/config/env.ts` — scenario bounds 13 → 12

```diff
@@ parseActiveScenarios()
-    .filter((n) => Number.isInteger(n) && n >= 1 && n <= 13);
+    .filter((n) => Number.isInteger(n) && n >= 1 && n <= 12);
   if (ids.length === 0) {
     throw new Error(
-      "ACTIVE_SCENARIOS must contain valid scenario IDs (1-13), e.g. ACTIVE_SCENARIOS=3,4,5,7,8,9,12,13",
+      "ACTIVE_SCENARIOS must contain valid scenario IDs (1-12), e.g. ACTIVE_SCENARIOS=3,4,5,7,8,9,12",
     );
@@ parseSymbolScenarios()
-        .filter((n) => Number.isInteger(n) && n >= 1 && n <= 13);
+        .filter((n) => Number.isInteger(n) && n >= 1 && n <= 12);
```

### 1.5 Tests to remove/adjust for S13

| File | Action |
| --- | --- |
| `tests/scenarioRouter.test.ts` L120–133 | Delete `'registers Scenario 13 …'`. The 11-scenario priority test stays valid (`activeScenarios` there is `[1..11]`). |
| `tests/config/env.test.ts` L160–176 | Replace the "accepts Scenario 13" block with `'rejects scenario 13 after deprecation'` and change the message regex to `/\(1-12\)/`. |

### 1.6 Operator config (must happen before deploy)

```diff
@@ .env (untracked, line 58)
-ACTIVE_SCENARIOS=13
+ACTIVE_SCENARIOS=12

@@ .env.example (line 21)
-ACTIVE_SCENARIOS=1,2,3,4,5,6,7,8,9,10,11,12,13
+ACTIVE_SCENARIOS=1,2,3,4,5,6,7,8,9,10,11,12

@@ .env.example (line 66)
-# Sniper Mode (1m entry within 15m zones) — required by Scenario 12 and Scenario 13
+# Sniper Mode (1m entry within 15m zones) — required by Scenario 12

@@ .env.example (line 74)
-# Scenario 13 always resolves TP dynamically; these bounds still apply.
+# These bounds apply to structural TP resolution in S12/S1/S5.
```

> **Deploy guard:** narrowing the bounds to `1-12` makes `loadConfig()` throw if any environment still contains `13`. This is intentional: S13 cannot be silently active after its implementation is deleted. Update all four env files (`.env`, `.env.example`, `.env.emilia`, `.env.subaru` — the last two are already clean).

### 1.7 Docs

- `README.md`: lines 36, 38, 406, 421, 587–626, 939, 953, 1194–1195, 1713 (`S1–S13`).
- `AGENTS.md`: §1.2 table (S13 rows), §1.3 (`.env.topdown` block), §7.4 note, §8 table, delete §8.6, §11 env block, Invariant 57 reference, §16 references, header "13 scenarios" → "12 scenarios".
- Keep the historical S13 experiment notes only if explicitly marked as removed; otherwise delete to avoid contradicting the live code.

---

## 2. Scenario 12 — Frequency Expansion

### 2.1 Design

Current S12 (lines 112–250) has three structural limitations:

1. It only considers `PDH/PDL/PWH/PWL`.
2. It keeps a single **global latest sweep** (`sweptAt = max over all levels`) and then requires `choch.timestamp > sweptAt`.
3. Consequence: if price sweeps PDL → prints a bullish CHoCH → then sweeps PDH 3 minutes later, the global anchor moves to the PDH sweep and the previously valid bullish CHoCH is discarded until a *new* CHoCH prints. In a two-sided market this destroys most S12 opportunities.

The new model:

1. **Source-tagged levels.** `macro` (always), `session` (Asian H/L, opt-in), `eqh_eql` (15m EQH/EQL, opt-in).
2. **Per-level latest sweep.** Each level contributes at most one hit (newest sweep inside the 50-minute lookback). This is what makes later opposite-side sweeps harmless.
3. **Per-CHoCH pairing.** For every unmitigated 1m CHoCH in the last 30 candles, take the newest sweep of *any* source strictly before it. The directions must agree. Choose the freshest matched CHoCH.
4. **Per-source proximity.** Macro keeps the full `1.0 × ATR(15m)` band; intraday sources use `0.5 × ATR(15m)`; both keep the `0.3%` price floor.
5. **Untouched edge.** Displacement (`≥ 1.5 ATR`), body-close validation, HTF bias, premium/discount, OB-midpoint entry, `tpResolver`, and the “structureDetails only” mitigation contract are unchanged.

**Why the pairing rule is causal:** a CHoCH is a reaction to the liquidity event that immediately preceded it. Sweeps *after* the CHoCH belong to the next reaction and must not retroactively invalidate it. Requiring the prior sweep to be the newest sweep of any direction preserves the “one reaction, one cause” semantics without the false negative described above.

### 2.2 Config flags (A/B rollback)

`BotConfig` gains two **optional** booleans (optional keeps the 18 existing test literals compiling; `loadConfig` always populates them):

```diff
@@ src/config/env.ts — interface BotConfig, after enableSniperMode
   readonly enableSniperMode: boolean;
+  /**
+   * Scenario 12 sweep-source expansion (A/B gates).
+   * Default `false` preserves the verified PDH/PDL/PWH/PWL baseline exactly.
+   * `undefined` is treated as `false` so old config literals keep compiling.
+   */
+  readonly s12SessionSweeps?: boolean;
+  readonly s12EqhEqlSweeps?: boolean;
```

```diff
@@ src/config/env.ts — loadConfig(), near enableSniperMode (line ~507)
   const enableSniperMode =
     (optionalEnv(env, "ENABLE_SNIPER_MODE") ?? "false").toLowerCase() === "true";
+
+  // Scenario 12 sweep-source A/B gates. OFF by default: the macro-only path
+  // produced the verified NEAR baseline and must remain reproducible.
+  const s12SessionSweeps =
+    (optionalEnv(env, "S12_SESSION_SWEEPS") ?? "false").toLowerCase() === "true";
+  const s12EqhEqlSweeps =
+    (optionalEnv(env, "S12_EQH_EQL_SWEEPS") ?? "false").toLowerCase() === "true";
```

```diff
@@ return object (line ~621)
     enableSniperMode,
+    s12SessionSweeps,
+    s12EqhEqlSweeps,
     sniperDisplacementMultiplier,
```

`.env.example`:

```bash
# Scenario 12 sweep-source expansion (A/B gates)
# false = verified macro-only baseline (PDH/PDL/PWH/PWL)
S12_SESSION_SWEEPS=false
S12_EQH_EQL_SWEEPS=false
```

### 2.3 `Scenario12_SniperTouch.ts` — constants and types

```diff
@@ top of file, after DEFAULT_SNIPER_DISPLACEMENT
 const DEFAULT_SNIPER_DISPLACEMENT = '1.5';
+
+/** 1m candles scanned for a sweep (50 minutes). */
+const SWEEP_LOOKBACK_CANDLES = 50;
+/** Macro levels keep the full 1 ATR(15m) proximity band (Invariant 51). */
+const MACRO_PROXIMITY_ATR_MULT = new Decimal(1);
+/** Session / EQH-EQL levels sit closer to price and use half the band. */
+const INTRADAY_PROXIMITY_ATR_MULT = new Decimal('0.5');
+
+/** Sweep sources. Macro is mandatory; the other two are config-gated. */
+type SweepSource = 'macro' | 'session' | 'eqh_eql';
+
+interface SweepLevel {
+  readonly price: Decimal;
+  readonly name: string;
+  readonly direction: 'BULLISH' | 'BEARISH';
+  readonly source: SweepSource;
+}
+
+interface SweepHit extends SweepLevel {
+  readonly sweptAt: number;
+}
+
+/** Price-dedupe priority: macro always wins over an intraday level at the same price. */
+const SWEEP_SOURCE_PRIORITY: Record<SweepSource, number> = {
+  macro: 0,
+  session: 1,
+  eqh_eql: 2,
+};
```

### 2.4 `Scenario12_SniperTouch.ts` — rejection stats

```diff
@@ EMPTY_REJECTION_STATS
   // --- informational (not part of the exclusive partition) ---
   levelTouched: 0,
   sweepFound: 0,
+  /** Setups whose paired sweep came from an Asian session extreme. */
+  sessionSweepPaired: 0,
+  /** Setups whose paired sweep came from a 15m EQH/EQL pool. */
+  eqhEqlSweepPaired: 0,
 };
@@ S12RejectionKey
 type S12RejectionKey = Exclude<
   keyof typeof EMPTY_REJECTION_STATS,
-  'totalEvals' | 'triggered' | 'levelTouched' | 'sweepFound'
+  | 'totalEvals'
+  | 'triggered'
+  | 'levelTouched'
+  | 'sweepFound'
+  | 'sessionSweepPaired'
+  | 'eqhEqlSweepPaired'
 >;
```

### 2.5 `Scenario12_SniperTouch.ts` — replace the whole sweep block

**Replace lines 110–199** (from `// Get macro levels from patternData` through `const direction = sweptLevel.direction;`) with:

```ts
    // Get macro levels from patternData
    const macro = patternData.macroContext as MacroContext & { dailyLevels: any; weeklyLevels: any };
    const macroLevels: SweepLevel[] = [
      { price: macro.dailyLevels.pdh, name: 'PDH', direction: 'BEARISH', source: 'macro' },
      { price: macro.dailyLevels.pdl, name: 'PDL', direction: 'BULLISH', source: 'macro' },
      { price: macro.weeklyLevels.pwh, name: 'PWH', direction: 'BEARISH', source: 'macro' },
      { price: macro.weeklyLevels.pwl, name: 'PWL', direction: 'BULLISH', source: 'macro' },
    ].filter(l => l.price.gt(0));

    // Macro anchors are mandatory: session/EQH-EQL expansion is additive, never
    // a replacement for the daily/weekly liquidity premise.
    if (macroLevels.length === 0) {
      return this.reject('noMacroLevels', 'No valid macro levels');
    }

    const sweepLevels = this.buildSweepLevels(macroLevels, patternData);

    // === FILTER 2: SWEEP VALIDATION (SFP - Swing Failure Pattern) ===
    // Check recent 1m candles (last 50 min) for a sweep of ANY enabled level.
    // Sweep = wick pierces level, body closes back inside.
    const lookbackCandles = candles1m.slice(-SWEEP_LOOKBACK_CANDLES);
    const hits: SweepHit[] = [];
    const weakSweeps: string[] = [];

    for (const level of sweepLevels) {
      const levelPrice = level.price;

      // Scan newest -> oldest: the first hit is the most recent sweep of THIS level.
      for (let i = lookbackCandles.length - 1; i >= 0; i--) {
        const candle = lookbackCandles[i];
        const high = new Decimal(candle.high);
        const low = new Decimal(candle.low);
        const open = new Decimal(candle.open);
        const close = new Decimal(candle.close);

        const isSweep = level.direction === 'BEARISH'
          ? high.gt(levelPrice) && close.lt(levelPrice)
          : low.lt(levelPrice) && close.gt(levelPrice);

        if (!isSweep) continue;

        Scenario12_SniperTouch.rejectionStats.levelTouched += 1;

        // REJECTION QUALITY (SFP): the wick that pierced the level must carry at
        // least `smcSweepMinWickRatio` of the candle's total range (default 25%).
        // A one-tick poke followed by a full-body close back inside is liquidity
        // consumption, not absorption — there is no evidence the sweep was defended.
        const minWickRatio = this.config.smcSweepMinWickRatio;
        const range = high.minus(low);
        const wick = level.direction === 'BEARISH'
          ? high.minus(Decimal.max(open, close))
          : Decimal.min(open, close).minus(low);
        const wickRatio = range.gt(0) ? wick.div(range) : new Decimal(0);

        if (wickRatio.lt(minWickRatio)) {
          weakSweeps.push(
            `${level.name} wick ${wickRatio.mul(100).toFixed(1)}% < ${minWickRatio.mul(100).toString()}%`
          );
          // The most recent touch of this level is not a valid SFP. Older
          // touches are history — this level provides no setup.
          break;
        }

        hits.push({ ...level, sweptAt: candle.timestamp });
        break;
      }
    }

    if (hits.length === 0) {
      return weakSweeps.length > 0
        ? this.reject(
            'weakWick',
            `Sweep rejected: insufficient rejection wick (${weakSweeps.join('; ')})`
          )
        : this.reject('noSweep', 'No valid sweep of any enabled level in last 50 min');
    }

    Scenario12_SniperTouch.rejectionStats.sweepFound += 1;

    // === FILTER 2.1: SWEEP → CHoCH PAIRING (CAUSALITY) ===
    // A CHoCH is the reaction to the liquidity event that PRECEDED it. Pairing is
    // therefore per-CHoCH: the newest sweep of ANY direction before the CHoCH must
    // agree with its direction. Sweeps that happen AFTER a valid CHoCH belong to
    // the next reaction and must not invalidate this one.
    const atr1m = this.calculateATR(candles1m, 14);
    if (atr1m.lte(0)) {
      return this.reject('invalidAtr', 'Invalid ATR');
    }

    const structures = this.detectStructureBreaks(candles1m, atr1m);

    const mitigatedStructures = (patternData as any).mitigatedStructures || [];
    const isMitigated = (s: Structure) =>
      mitigatedStructures.some((ms: any) => ms.timestamp === s.timestamp);

    const recentChochs = structures.filter(
      (s) =>
        s.type === 'CHOCH' &&
        s.timestamp >= (candles1m[candles1m.length - 30]?.timestamp ?? 0) &&
        !isMitigated(s),
    );

    const hitsDesc = [...hits].sort((a, b) => b.sweptAt - a.sweptAt);
    const pairs = recentChochs
      .map((choch) => {
        const priorSweep = hitsDesc.find((h) => h.sweptAt < choch.timestamp);
        if (!priorSweep || priorSweep.direction !== choch.direction) return null;
        return { choch, sweep: priorSweep };
      })
      .filter((p): p is { choch: Structure; sweep: SweepHit } => p !== null)
      .sort((a, b) => a.choch.timestamp - b.choch.timestamp);

    if (pairs.length === 0) {
      // Reason wording preserved for operators/log greps: the reference is the
      // newest sweep, which is precisely the event the CHoCH failed to follow.
      const reference = hitsDesc[0];
      return this.reject(
        'noChoch',
        `No ${reference.direction} CHoCH after latest ${reference.name} sweep`,
      );
    }

    // Freshest matched CHoCH wins.
    const { choch, sweep: sweptLevel } = pairs[pairs.length - 1];
    const direction = choch.direction;
```

### 2.6 `Scenario12_SniperTouch.ts` — remove the duplicated ATR/structure block

The old lines 215–250 (ATR, structure detection, mitigated filter, old CHoCH gate) now live in the block above. Delete them. Keep everything from `const chochPrice = choch.price;` onward.

```diff
-    // === FILTER 3: VALID CHoCH + ORDER BLOCK ENTRY ===
-    // Calculate ATR for 1m candles
-    const atr1m = this.calculateATR(candles1m, 14);
-    if (atr1m.lte(0)) {
-      return this.reject('invalidAtr', 'Invalid ATR');
-    }
-
-    // Detect structure breaks on 1m candles
-    const structures = this.detectStructureBreaks(candles1m, atr1m);
-
-    // Filter out already mitigated structures (ghost signal prevention)
-    const mitigatedStructures = (patternData as any).mitigatedStructures || [];
-    const isMitigated = (s: Structure) =>
-      mitigatedStructures.some((ms: any) =>
-        ms.timestamp === s.timestamp
-      );
-
-    // Fresh CHoCH in the expected direction, STRICTLY AFTER the latest sweep.
-    // Look at last 30 1m candles, and exclude already mitigated structures.
-    const recentStructures = structures.filter(s =>
-      s.type === 'CHOCH' &&
-      s.direction === direction &&
-      s.timestamp > sweptAt &&
-      s.timestamp >= (candles1m[candles1m.length - 30]?.timestamp ?? 0) &&
-      !isMitigated(s)
-    );
-
-    if (recentStructures.length === 0) {
-      return this.reject(
-        'noChoch',
-        `No ${direction} CHoCH after latest ${sweptLevel.name} sweep`
-      );
-    }
-
-    // Take the most recent CHoCH
-    const choch = recentStructures[recentStructures.length - 1];
     const chochPrice = choch.price;
```

### 2.7 Proximity — per-source tolerance

```diff
@@ FILTER 3.1
-    const atr15m = this.resolveAtr15m(patternData);
-    const proximityTolerance = Decimal.max(atr15m, sweptLevel.price.mul(MIN_PROXIMITY_PCT));
+    const atr15m = this.resolveAtr15m(patternData);
+    // Macro liquidity justifies a full 1 ATR(15m) band. Session extremes and
+    // EQH/EQL are internal liquidity: they sit closer to price by construction,
+    // so a full-ATR band would approve entries disconnected from the swept level.
+    const proximityAtrMultiplier = sweptLevel.source === 'macro'
+      ? MACRO_PROXIMITY_ATR_MULT
+      : INTRADAY_PROXIMITY_ATR_MULT;
+    const proximityTolerance = Decimal.max(
+      atr15m.mul(proximityAtrMultiplier),
+      sweptLevel.price.mul(MIN_PROXIMITY_PCT),
+    );
     const chochDistance = chochPrice.minus(sweptLevel.price).abs();
     const obMidpoint = entryOB.top.plus(entryOB.bottom).div(2);
     const obDistance = obMidpoint.minus(sweptLevel.price).abs();
 
     if (obDistance.gt(proximityTolerance)) {
       return this.reject(
         'proximity',
-        `Entry too far from swept ${sweptLevel.name} (${sweptLevel.price.toFixed(4)}): ` +
+        `Entry too far from swept ${sweptLevel.name} (${sweptLevel.price.toFixed(4)}, ${sweptLevel.source}): ` +
         `CHoCH=${chochDistance.toFixed(4)}, OB_MID=${obDistance.toFixed(4)}, ` +
-        `tolerance=${proximityTolerance.toFixed(4)} (1xATR15m / 0.3%)`
+        `tolerance=${proximityTolerance.toFixed(4)} (${proximityAtrMultiplier}xATR15m / 0.3%)`
       );
     }
```

### 2.8 Reason, attribution and helper

```diff
@@ setReason
-    this.setReason(`Sniper: ${direction} CHoCH at ${chochPrice.toFixed(4)} after ${sweptLevel.name} sweep, entry from 1m OB midpoint`);
+    this.setReason(`Sniper: ${direction} CHoCH at ${chochPrice.toFixed(4)} after ${sweptLevel.name} (${sweptLevel.source}) sweep, entry from 1m OB midpoint`);
@@ before triggered += 1
+    if (sweptLevel.source === 'session') {
+      Scenario12_SniperTouch.rejectionStats.sessionSweepPaired += 1;
+    } else if (sweptLevel.source === 'eqh_eql') {
+      Scenario12_SniperTouch.rejectionStats.eqhEqlSweepPaired += 1;
+    }
     Scenario12_SniperTouch.rejectionStats.triggered += 1;
```

Insert the helper **after `reject()` (line 87)**:

```ts
  /**
   * Build the full sweep-source list for this evaluation.
   *
   * Macro levels are mandatory and always present. Session extremes and 15m
   * EQH/EQL pools are ADDITIVE and opt-in (`S12_SESSION_SWEEPS`,
   * `S12_EQH_EQL_SWEEPS`) so the verified macro-only baseline stays reproducible.
   *
   * Levels are deduped by exact price with macro priority: an Asian high that
   * coincides with PDH is one level, not two, and must be logged as PDH.
   */
  private buildSweepLevels(macroLevels: SweepLevel[], patternData: PatternData): SweepLevel[] {
    const levels: SweepLevel[] = [...macroLevels];

    if (this.config.s12SessionSweeps === true) {
      for (const range of patternData.sessionRanges ?? []) {
        if (range.high.gt(0)) {
          levels.push({
            price: range.high,
            name: `${range.name}_H`,
            direction: 'BEARISH',
            source: 'session',
          });
        }
        if (range.low.gt(0)) {
          levels.push({
            price: range.low,
            name: `${range.name}_L`,
            direction: 'BULLISH',
            source: 'session',
          });
        }
      }
    }

    if (this.config.s12EqhEqlSweeps === true) {
      for (const pool of patternData.liquidityPools ?? []) {
        if (pool.type !== 'EQH' && pool.type !== 'EQL') continue;
        if (pool.isTaken) continue;
        if (!pool.priceLevel.gt(0)) continue;
        levels.push({
          price: pool.priceLevel,
          name: pool.type,
          direction: pool.type === 'EQH' ? 'BEARISH' : 'BULLISH',
          source: 'eqh_eql',
        });
      }
    }

    const byPrice = new Map<string, SweepLevel>();
    for (const level of levels) {
      const key = level.price.toFixed(8);
      const existing = byPrice.get(key);
      if (
        !existing ||
        SWEEP_SOURCE_PRIORITY[level.source] < SWEEP_SOURCE_PRIORITY[existing.source]
      ) {
        byPrice.set(key, level);
      }
    }
    return [...byPrice.values()];
  }
```

### 2.9 Frequency analysis (hypothesis, not a result)

| Source | Typical count | Distance to price | Expected contribution |
| --- | --- | --- | --- |
| PDH/PDL/PWH/PWL | 4 | Often 1–5 ATR(15m) away; only swept on trend days | Baseline (verified) |
| Asian H/L (2 days of ranges, `detectSessionRanges` keeps ~2 days) | ~4 (today + yesterday, H + L) | Usually 0.2–1.5 ATR(15m) during London/NY; price usually leaves the Asian range at London open | Largest frequency gain; highest overlap with macro levels (deduped) |
| 15m EQH/EQL | 0–6; only created near trading-range extremes | By construction at the range boundary, usually < 1 ATR(15m) | Adds range-bound setups; weakest individual edge, densest source |

The multiplication is **not** a simple `N levels × M sweeps` because:
- each level contributes at most one hit per evaluation,
- price-dedupe removes coincident levels,
- the 0.3% floor and the 0.5 ATR band still reject disconnected OBs,
- the 1m CHoCH + displacement gate remains the true bottleneck (a sweep without a subsequent displacement CHoCH still produces nothing).

Acceptance protocol (decide the numeric guardrails **before** the run, then A/B in this order):

1. Baseline: both flags `false` (must reproduce the macro-only result).
2. `S12_SESSION_SWEEPS=true` only.
3. `S12_EQH_EQL_SWEEPS=true` only.
4. Both `true`.

For each leg record: trades, win rate, PF, net, max DD, fee drag, and the new `sessionSweepPaired` / `eqhEqlSweepPaired` counters. Do not deploy a leg that increases trade count without a proportional increase in gross profit.

### 2.10 Reporter line

```diff
@@ reporter.ts, after the S12 entry-gates line
   lines.push(`     Entry gates (base ${scenario12Stats.sweepFound}): ...`);
+  lines.push(`     Source mix (paired): Session: ${scenario12Stats.sessionSweepPaired} | EQH/EQL: ${scenario12Stats.eqhEqlSweepPaired} | Macro: ${scenario12Stats.triggered - scenario12Stats.sessionSweepPaired - scenario12Stats.eqhEqlSweepPaired}`);
```

---

## 3. Scenario 1 — HTF Continuation Restoration

### 3.1 Defects in the current file

| Line | Defect |
| --- | --- |
| 11 | `isInKillzone()` accepts ASIAN (it only rejects `NONE`); S1 is a London/NY trend play |
| 19 | `z.timeframe === '240'` strict string; 4H zones are `'240'` today, but the surrounding code uses `String(z.timeframe)` for robustness |
| 25–31 | Picks the **newest unmitigated 4H OB regardless of direction** → a long can be built from 4H supply |
| 32–45 | Touch is tested only on the **last** 15m candle |
| 48–55 | Any BULLISH 15m CHoCH from the entire cached history is accepted — no causality relative to the touch |
| 57–61 | Displacement checked, but the CHoCH may predate the zone test |
| 78–87 | Long-only; fixed `3R` TP |
| 106–111 | `structureDetails.direction` hardcoded BULLISH |

### 3.2 Full replacement of `src/engine/scenarios/Scenario1_HTFContinuation.ts`

```ts
import { BaseScenario } from '../baseScenario';
import { Decimal } from 'decimal.js';
import { BotConfig } from '../../config/env';
import { resolveTakeProfit } from '../tpResolver';

/** 15m candles in a 4H window: OB-touch → CHoCH/FVG causality budget. */
const CAUSALITY_LOOKBACK_CANDLES = 16;
const CAUSALITY_WINDOW_MS = 4 * 60 * 60 * 1000;

type Direction = 'BULLISH' | 'BEARISH';

interface DirectionalSetup {
  readonly direction: Direction;
  readonly ob: any;
  readonly touchCandle: any;
}

/**
 * Scenario 1 — HTF Continuation.
 *
 * Handbook §2: a 4H break establishes the trend, the 15m order block is
 * retested, and a 15m CHoCH with displacement confirms continuation. The entry
 * POI is the 15m FVG equilibrium.
 *
 * Restoration notes:
 *  - Bidirectional: the direction is derived from the 4H OB that was tested, and
 *    the OB direction MUST match the trade direction (demand for longs, supply
 *    for shorts). The old long-only path could buy into 4H supply.
 *  - Causality: the CHoCH must form at/after the OB touch, and the FVG at/after
 *    the CHoCH, both inside one 4H window.
 *  - Target: `resolveTakeProfit()` replaces the blind 3R multiple.
 */
export class Scenario1_HTFContinuation extends BaseScenario {
  constructor(config: BotConfig) {
    super(1, 'HTF Continuation', config);
  }

  protected override evaluateInternal(patternData: any): boolean {
    // London/NY only. `isInKillzone()` intentionally accepts ASIAN for other
    // scenarios, so the session gate is explicit here (still bypassable globally
    // via ENFORCE_KILLZONES=false for backtesting).
    if (this.config.enforceKillzones !== false) {
      const killzone = patternData.currentKillzone;
      if (killzone !== 'LONDON' && killzone !== 'NY') {
        this.logRejection('HTF Continuation requires London or NY killzone');
        return false;
      }
    }

    const candles15m = patternData.candles15m ?? [];
    if (candles15m.length === 0) {
      this.logRejection('No 15m candle available');
      return false;
    }

    const zones = patternData.zones ?? [];
    const htfObs = zones.filter(
      (z: any) =>
        z.type === 'OB' && String(z.timeframe) === '240' && !z.mitigated,
    );
    if (htfObs.length === 0) {
      this.logRejection('No valid 4H Order Block found');
      return false;
    }

    const setups = this.collectDirectionalSetups(htfObs, candles15m);
    if (setups.length === 0) {
      this.logRejection('Price has not touched 4H OB zone');
      return false;
    }

    // Freshest zone interaction first: a newer supply test must not be shadowed
    // by a stale demand touch (or vice versa).
    setups.sort((a, b) => b.touchCandle.timestamp - a.touchCandle.timestamp);

    for (const setup of setups) {
      if (this.tryDirection(setup, patternData)) return true;
    }

    this.logRejection('No 15m CHoCH/FVG with displacement after the 4H OB touch');
    return false;
  }

  /** Evaluate one direction end-to-end; returns true only when a trade is armed. */
  private tryDirection(setup: DirectionalSetup, patternData: any): boolean {
    const { direction, touchCandle } = setup;
    const structures = patternData.structures ?? [];
    const zones = patternData.zones ?? [];

    // Causality: CHoCH at/after the OB touch, within one 4H window.
    const chochs = structures.filter(
      (s: any) =>
        s.type === 'CHOCH' &&
        s.direction === direction &&
        String(s.timeframe) === '15' &&
        s.timestamp >= touchCandle.timestamp &&
        s.timestamp <= touchCandle.timestamp + CAUSALITY_WINDOW_MS,
    );
    const choch = chochs[chochs.length - 1];
    if (!choch) return false;

    // Displacement is a hard gate (AGENTS.md §7.2).
    if (!this.isValidDisplacement(choch, 1.5)) return false;

    // FVG is the entry POI and must be fresh relative to the trigger.
    const fvgs = zones.filter(
      (z: any) =>
        z.type === 'FVG' &&
        z.direction === direction &&
        String(z.timeframe) === '15' &&
        z.timestamp >= choch.timestamp &&
        z.timestamp <= choch.timestamp + CAUSALITY_WINDOW_MS,
    );
    const fvg = fvgs[fvgs.length - 1];
    if (!fvg) return false;

    // Entry at 0.5 (equilibrium) of the FVG.
    const entry = fvg.top.plus(fvg.bottom).dividedBy(2);
    const fvgZone = { top: fvg.top, bottom: fvg.bottom, direction };
    const atr15m =
      patternData.atr15m instanceof Decimal && patternData.atr15m.gt(0)
        ? patternData.atr15m
        : new Decimal('0.01');

    // Stop geometry stays in `calculateLevels` (rr = 1 is a placeholder here).
    const base = this.calculateLevels(
      entry,
      fvgZone,
      direction,
      atr15m,
      new Decimal(1),
    );

    // Structural target. `skipMinorObstacles: false` keeps the legacy 15m
    // semantics: the NEAREST obstacle is the honest target, and if it is closer
    // than DYNAMIC_TP_MIN_RR the setup is rejected rather than clamped.
    const resolution = resolveTakeProfit({
      direction,
      entry: base.entry,
      stopLoss: base.stopLoss,
      zones,
      liquidityPools: patternData.liquidityPools ?? [],
      tradingRange: patternData.tradingRange ?? null,
      macroContext: patternData.macroContext ?? null,
      sessionRanges: patternData.sessionRanges ?? [],
      minRr: this.config.dynamicTpMinRr,
      maxRr: this.config.dynamicTpMaxRr,
      fixedRr: this.config.fixedTpRr,
      enableDynamicTp: this.config.enableDynamicTp,
      requireTarget: this.config.dynamicTpRequireTarget,
      skipMinorObstacles: false,
    });

    if (!resolution.ok) {
      this.logRejection(`Take-profit rejected: ${resolution.reason}`);
      return false;
    }

    const levels = this.calculateLevelsWithTarget(
      entry,
      fvgZone,
      direction,
      atr15m,
      resolution.takeProfit,
    );

    this.setLevels({
      entry: levels.entry,
      stopLoss: levels.stopLoss,
      takeProfit: levels.takeProfit,
    });

    // FVG is the entry zone; CHoCH is the trigger structure. Both are required
    // for ghost-signal mitigation (Invariant 39).
    this.setZoneDetails({
      type: 'FVG',
      top: fvg.top,
      bottom: fvg.bottom,
      timeframe: '15',
      direction,
      timestamp: fvg.timestamp,
    });

    this.setStructureDetails({
      type: 'CHoCH',
      timestamp: choch.timestamp,
      price: choch.price,
      direction,
    });

    this.setReason(
      `HTF Continuation: 4H ${direction} OB touch + 15m ${direction} CHoCH + 15m FVG entry`,
    );
    return true;
  }

  /**
   * One candidate per direction: the newest unmitigated 4H OB of that direction
   * that price touched inside the 4H window, plus the newest touch candle.
   *
   * The OB direction defines the trade direction — this is the guard that
   * prevents buying into 4H supply.
   */
  private collectDirectionalSetups(
    htfObs: any[],
    candles15m: any[],
  ): DirectionalSetup[] {
    const window = candles15m.slice(-CAUSALITY_LOOKBACK_CANDLES);
    const byDirection = new Map<Direction, DirectionalSetup>();

    for (const ob of htfObs) {
      const direction = ob.direction as Direction;
      if (direction !== 'BULLISH' && direction !== 'BEARISH') continue;

      // Zone top/bottom ordering is not guaranteed (Invariant 11).
      const top = Decimal.max(ob.top, ob.bottom);
      const bottom = Decimal.min(ob.top, ob.bottom);

      let touchCandle: any = null;
      for (let i = window.length - 1; i >= 0; i--) {
        const candle = window[i];
        if (
          new Decimal(candle.high).gte(bottom) &&
          new Decimal(candle.low).lte(top)
        ) {
          touchCandle = candle;
          break;
        }
      }
      if (!touchCandle) continue;

      const existing = byDirection.get(direction);
      if (!existing || ob.timestamp > existing.ob.timestamp) {
        byDirection.set(direction, { direction, ob, touchCandle });
      }
    }

    return [...byDirection.values()];
  }
}
```

### 3.3 Behavioural consequences

- A 4H supply OB now produces a **short** setup, never a long.
- A CHoCH printed before the zone test no longer qualifies.
- Entry is delayed until a fresh 15m FVG exists after the CHoCH, but the entry price remains the FVG midpoint; if price is away from it, Hybrid Smart Entry places a Limit and lets it expire per the per-scenario lifetime (Step 5).
- TP is now structural. With `ENABLE_DYNAMIC_TP=false`, `resolveTakeProfit` falls back to `fixedTpRr` (default 3), which preserves legacy behaviour.

---

## 4. Scenario 5 — HTF Liquidity Sweep Restoration

### 4.1 Defects

| Line | Defect |
| --- | --- |
| 54 | `lastCandle` only — a sweep can occur on any of the previous 16 candles |
| 79–102 | First matching pool wins in raw array order (non-deterministic priority); `strong*` conditions duplicate the base condition |
| 112–116 | Causality is inverted: it accepts any CHoCH in `[lastCandle - 4h, ∞)` — including CHoCHs **before** the sweep — and has no `timeframe === '15'` filter |
| 154–164 | Fixed `3R` TP |
| stats | no `tpInvalid` bucket |

### 4.2 Constants and stats

```diff
@@ imports
 import { BotConfig } from '../../config/env';
+import { resolveTakeProfit } from '../tpResolver';
+
+/** 4H of 15m candles. */
+const SWEEP_LOOKBACK_CANDLES = 16;
+const CAUSALITY_WINDOW_MS = 4 * 60 * 60 * 1000;
+/** Deterministic pool priority on a timestamp tie. */
+const POOL_RANK: Record<string, number> = {
+  PDH: 0, PDL: 1, PWH: 2, PWL: 3, BSL: 4, SSL: 5,
+};
@@ rejection stats (both declaration and reset)
     noFvg: 0,
+    tpInvalid: 0,
     totalEvals: 0
```

### 4.3 Replace lines 54–164

```ts
    // === SWEEP SCAN (last 4H of 15m candles) ===
    // A sweep is not a "last candle" event: price can take a pool and only close
    // back inside a few bars later. Scanning the whole 4H window is what makes
    // the causality gate below meaningful.
    const sweepWindow = candles15m.slice(-SWEEP_LOOKBACK_CANDLES);
    if (sweepWindow.length === 0) return false;

    // Deterministic pool ranking: on a timestamp tie the higher-ranked pool is
    // the dominant liquidity event (PDH > PDL > PWH > PWL > BSL > SSL).
    const rankedPools = [...htfPools].sort(
      (a: any, b: any) => (POOL_RANK[a.type] ?? 99) - (POOL_RANK[b.type] ?? 99),
    );

    let sweptPool: any = null;
    let sweptAt = 0;
    let sweepDirection: 'BULLISH' | 'BEARISH' = 'BULLISH';

    for (const pool of rankedPools) {
      const level = new Decimal(pool.priceLevel);

      // Newest -> oldest: the first hit is this pool's most recent sweep.
      for (let i = sweepWindow.length - 1; i >= 0; i--) {
        const candle = sweepWindow[i];
        const high = new Decimal(candle.high);
        const low = new Decimal(candle.low);
        const close = new Decimal(candle.close);

        const bearishSweep = high.gt(level) && close.lt(level);
        const bullishSweep = low.lt(level) && close.gt(level);
        if (!bearishSweep && !bullishSweep) continue;

        // Latest sweep across ALL pools wins. Strict `>` keeps the higher-ranked
        // pool on a timestamp tie (pools are iterated in rank order).
        if (candle.timestamp > sweptAt) {
          sweptAt = candle.timestamp;
          sweptPool = pool;
          sweepDirection = bearishSweep ? 'BEARISH' : 'BULLISH';
        }
        break;
      }
    }

    if (!sweptPool) {
      this.logRejection('No HTF liquidity sweep detected in last 4H');
      Scenario5_HTFLiquiditySweep.rejectionStats.noSweep++;
      return false;
    }

    // === CAUSALITY: the CHoCH must FOLLOW the sweep ===
    // The replaced code measured a lower bound from the LAST candle, so a CHoCH
    // printed BEFORE the sweep passed. Causality now runs from `sweptAt`; the
    // same candle is allowed because sweep and break can print together.
    const recentStructures = structures?.filter((s: any) =>
      s.direction === sweepDirection &&
      s.type === 'CHOCH' &&
      String(s.timeframe) === '15' &&
      s.timestamp >= sweptAt &&
      s.timestamp <= sweptAt + CAUSALITY_WINDOW_MS
    ) || [];

    const choch = recentStructures[recentStructures.length - 1];
    if (!choch) {
      this.logRejection(`No aggressive 15m CHoCH ${sweepDirection} after ${sweptPool.type} sweep`);
      Scenario5_HTFLiquiditySweep.rejectionStats.noChoch++;
      return false;
    }

    // Displacement: body >= 1.5 ATR (AGENTS.md §7.2).
    if (!this.isValidDisplacement(choch, 1.5)) {
      this.logRejection('15m CHoCH displacement < 1.5 ATR after sweep');
      Scenario5_HTFLiquiditySweep.rejectionStats.displacement++;
      return false;
    }

    // FVG after the CHoCH, inside the same reaction window.
    const fvgsAfterChoch = zones?.filter((z: any) =>
      z.type === 'FVG' &&
      z.direction === sweepDirection &&
      String(z.timeframe) === '15' &&
      z.timestamp >= choch.timestamp &&
      z.timestamp <= choch.timestamp + CAUSALITY_WINDOW_MS
    ) || [];

    const fvg = fvgsAfterChoch[fvgsAfterChoch.length - 1];
    if (!fvg) {
      this.logRejection('No 15m FVG found after CHoCH following sweep');
      Scenario5_HTFLiquiditySweep.rejectionStats.noFvg++;
      return false;
    }

    // Entry at 0.5 (equilibrium) of the FVG.
    const entry = fvg.top.plus(fvg.bottom).dividedBy(2);
    const fvgZone = { top: fvg.top, bottom: fvg.bottom, direction: sweepDirection };
    const atr15m =
      patternData.atr15m instanceof Decimal && patternData.atr15m.gt(0)
        ? patternData.atr15m
        : new Decimal('0.01');

    // Stop from the single source of truth; target from market structure.
    const base = this.calculateLevels(
      entry,
      fvgZone,
      sweepDirection,
      atr15m,
      new Decimal(1),
    );

    const resolution = resolveTakeProfit({
      direction: sweepDirection,
      entry: base.entry,
      stopLoss: base.stopLoss,
      zones: zones ?? [],
      liquidityPools,
      tradingRange: patternData.tradingRange ?? null,
      macroContext: patternData.macroContext ?? null,
      sessionRanges: patternData.sessionRanges ?? [],
      minRr: this.config.dynamicTpMinRr,
      maxRr: this.config.dynamicTpMaxRr,
      fixedRr: this.config.fixedTpRr,
      enableDynamicTp: this.config.enableDynamicTp,
      requireTarget: this.config.dynamicTpRequireTarget,
      skipMinorObstacles: false,
    });

    if (!resolution.ok) {
      this.logRejection(`Take-profit rejected: ${resolution.reason}`);
      Scenario5_HTFLiquiditySweep.rejectionStats.tpInvalid++;
      return false;
    }

    const levels = this.calculateLevelsWithTarget(
      entry,
      fvgZone,
      sweepDirection,
      atr15m,
      resolution.takeProfit,
    );
```

The rest of the file (setLevels / setZoneDetails / setStructureDetails / setReason / `return true`) stays unchanged. Update the final reason to include the sweep timestamp for auditability:

```diff
-    this.setReason(`HTF Liquidity Sweep: ${sweptPool.type} swept in killzone + 15m CHoCH + FVG 0.5 entry`);
+    this.setReason(`HTF Liquidity Sweep: ${sweptPool.type} swept at ${sweptAt} in killzone + 15m CHoCH + FVG 0.5 entry`);
```

### 4.4 Determinism notes

- Pools are ranked, not array-ordered. Two different `liquidityPools` orderings now produce identical output.
- When two pools are swept on the same 15m candle, the higher-ranked pool is reported. This matters only for logging and `zoneDetails`; the entry geometry is the same FVG.
- The 4H window starts at `sweptAt`, not at `lastCandle - 4h`, so a stale CHoCH can no longer validate a fresh sweep.

---

## 5. Mixed-Mode Readiness Patch (S12 @ 1m + S1/S5 @ 15m)

### 5.1 `src/types.ts` — cadence contract

```diff
@@ before IScenario
+/**
+ * Evaluation cadence of a scenario.
+ *
+ * `1m`  — re-evaluated on every confirmed 1m close (Sniper).
+ * `ltf` — re-evaluated only on confirmed LTF closes (Classic 15m).
+ *
+ * A mixed-mode process (S12 alongside S1/S5) MUST filter by cadence inside the
+ * router; otherwise classic scenarios rescan 15× per bar and 1m timing leaks
+ * into 15m trade lifecycle decisions.
+ */
+export type EvaluationCadence = '1m' | 'ltf';
+
 export interface IScenario {
   readonly id: number;
   readonly name: string;
+  readonly cadence: EvaluationCadence;
   evaluate(patternData: any): boolean;
```

### 5.2 `src/engine/baseScenario.ts`

```diff
-import { IScenario, StructureDetails } from '../types';
-import { ScenarioLevels } from '../types';
-import { ZoneDetails } from '../types';
+import {
+  EvaluationCadence,
+  IScenario,
+  ScenarioLevels,
+  StructureDetails,
+  ZoneDetails,
+} from '../types';
@@ class fields
   readonly id: number;
   readonly name: string;
+  readonly cadence: EvaluationCadence;
@@ constructor
-  constructor(id: number, name: string, config: BotConfig) {
+  constructor(
+    id: number,
+    name: string,
+    config: BotConfig,
+    cadence: EvaluationCadence = 'ltf',
+  ) {
     this.id = id;
     this.name = name;
     this.config = config;
+    this.cadence = cadence;
   }
```

`Scenario12_SniperTouch`:

```diff
-    super(12, 'Sniper Touch (1m Macro)', config);
+    super(12, 'Sniper Touch (1m Macro)', config, '1m');
```

Every other scenario inherits `'ltf'`.

### 5.3 `src/engine/scenarioRouter.ts` — cadence filter

```diff
@@ import
-import { IScenario, StructureDetails, MitigatedZone, MitigatedStructure } from '../types';
+import {
+  EvaluationCadence,
+  IScenario,
+  StructureDetails,
+  MitigatedZone,
+  MitigatedStructure,
+} from '../types';
@@ evaluate signature
     candles1m: any[] = [], // 1m candles for Sniper Mode (Scenario 12)
-    patternData?: PatternData // Pre-computed PatternData for performance
+    patternData?: PatternData, // Pre-computed PatternData for performance
+    cadences?: readonly EvaluationCadence[], // Cadence isolation for mixed mode
   ): Promise<RouterResult> {
@@ after the `this.scenarios.length` guard
+    const cadenceFilter =
+      cadences && cadences.length > 0 ? new Set(cadences) : null;
+    const activeScenarios = cadenceFilter
+      ? this.scenarios.filter((s) => cadenceFilter.has(s.cadence))
+      : this.scenarios;
+
+    if (!activeScenarios.length) {
+      return { triggered: false, scenario: null, levels: null, reason: 'No scenarios for cadence', zoneDetails: null, structureDetails: null };
+    }
@@ loop
-      for (const scenario of this.scenarios) {
+      for (const scenario of activeScenarios) {
```

Backward-compatible: every existing caller/test that omits `cadences` keeps the old “all scenarios” behaviour.

### 5.4 `src/config/env.ts` — per-scenario timing helpers

Insert after `resolveLimitExpirationMs` (line 287):

```ts
/**
 * Scenario IDs that execute on the 1m cadence.
 *
 * Single source of truth so live cadence, execution-feed selection, limit
 * expiration and cooldown duration can never disagree about which trades are
 * "Sniper" trades. Extend only when a new scenario is genuinely 1m-driven.
 */
const SNIPER_CADENCE_SCENARIO_IDS = new Set<number>([12]);

export function isSniperCadenceScenario(
  scenarioId: number | null | undefined,
): boolean {
  return scenarioId != null && SNIPER_CADENCE_SCENARIO_IDS.has(scenarioId);
}

/**
 * Effective execution timeframe in minutes for a trade.
 *
 * `null`/`undefined` keeps the legacy mode-global behaviour for callers that do
 * not know the trade's scenario (mocks, legacy paths, pre-trade approvals).
 */
export function resolveExecutionTimeframeMinutes(
  config: { enableSniperMode: boolean; ltfTimeframe: string },
  scenarioId: number | null | undefined,
): number {
  if (scenarioId == null) {
    return config.enableSniperMode ? 1 : Number(config.ltfTimeframe);
  }
  return isSniperCadenceScenario(scenarioId) ? 1 : Number(config.ltfTimeframe);
}

export function resolveLimitExpirationCandlesForScenario(
  config: {
    enableSniperMode: boolean;
    limitExpirationCandles: number;
    sniperLimitExpirationCandles: number;
  },
  scenarioId: number | null | undefined,
): number {
  if (scenarioId == null) return resolveLimitExpirationCandles(config);
  return isSniperCadenceScenario(scenarioId)
    ? config.sniperLimitExpirationCandles
    : config.limitExpirationCandles;
}

export function resolveLimitExpirationMsForScenario(
  config: {
    enableSniperMode: boolean;
    limitExpirationCandles: number;
    sniperLimitExpirationCandles: number;
    ltfTimeframe: string;
  },
  scenarioId: number | null | undefined,
): number {
  return (
    resolveLimitExpirationCandlesForScenario(config, scenarioId) *
    resolveExecutionTimeframeMinutes(config, scenarioId) *
    60 *
    1000
  );
}
```

### 5.5 `src/engine/strategyEngine.ts` — cadence passes and dedupe

```diff
@@ imports
-import { InstrumentInfo, StrategyState, Timeframe, BotConfig, MitigatedZone, MitigatedStructure } from '../types';
+import { BotConfig, EvaluationCadence, InstrumentInfo, MitigatedZone, MitigatedStructure, StrategyState, Timeframe } from '../types';
+import {
+  isSniperCadenceScenario,
+  resolveExecutionTimeframeMinutes,
+} from '../config/env';
@@ fields (line 92)
-  private lastProcessedCandleTimestamp: number = 0;
+  /** Dedupe is per cadence: both feeds confirm a candle at every 15m boundary. */
+  private lastProcessed1mTimestamp: number = 0;
+  private lastProcessedLtfTimestamp: number = 0;
```

Replace the cadence/dedupe block (lines 867–909) with:

```ts
      // Cadence selection: 1m closes drive the Sniper cadence, LTF closes drive
      // every classic scenario. A single shared marker cannot work in mixed mode:
      // both feeds confirm a candle at every 15m boundary, so one cadence would
      // silently swallow the other's candle.
      const ltfInterval = this.deps.config.ltfTimeframe;
      const is1mPass = this.deps.config.enableSniperMode && timeframe === '1';
      if (timeframe !== ltfInterval && !is1mPass) return;

      if (this.state !== StrategyState.SCANNING) return;

      const candlesLtf = this.feedLtf.getCandles() as any[];
      const candlesHtf = this.feedHtf.getCandles() as any[];
      if (candlesLtf.length < 20 || candlesHtf.length < 20) return;

      const cadences: EvaluationCadence[] = is1mPass ? ['1m'] : ['ltf'];

      let lastCandle: any;
      let candleTimestamp: number;
      let candles1m: any[] = [];

      if (is1mPass) {
        candles1m = this.feed1m.getCandles() as any[];
        lastCandle = candles1m[candles1m.length - 1];
        candleTimestamp = lastCandle?.timestamp ?? 0;
        if (!this.isNewCandle(candleTimestamp, this.lastProcessed1mTimestamp)) return;
        this.lastProcessed1mTimestamp = candleTimestamp;
      } else {
        lastCandle = candlesLtf[candlesLtf.length - 1];
        candleTimestamp = lastCandle?.timestamp ?? 0;
        if (!this.isNewCandle(candleTimestamp, this.lastProcessedLtfTimestamp)) return;
        this.lastProcessedLtfTimestamp = candleTimestamp;
      }

      if (!lastCandle) return;
```

Keep the news embargo / cooldown blocks unchanged. Replace the router call:

```diff
-    // Pass 1m candles to router if Sniper Mode is enabled
-    const candles1m = this.deps.config.enableSniperMode ? [...this.feed1m.getCandles()] : [];
-
-    const result = await this.scenarioRouter.evaluate(candlesLtf, candlesHtf, candleTimestamp, this.mitigatedZones, this.mitigatedStructures, candles1m);
+    const result = await this.scenarioRouter.evaluate(
+      candlesLtf,
+      candlesHtf,
+      candleTimestamp,
+      this.mitigatedZones,
+      this.mitigatedStructures,
+      candles1m,
+      undefined,
+      cadences,
+    );
```

Add the helper near `transition()`:

```ts
  /**
   * A candle is new when its timestamp is strictly greater than the last one
   * processed FOR THE SAME CADENCE. Two different candles never share an open
   * timestamp, and a re-delivered confirmed kline repeats it exactly.
   */
  private isNewCandle(timestamp: number, lastProcessed: number): boolean {
    if (timestamp <= 0) return false;
    return lastProcessed <= 0 || timestamp > lastProcessed;
  }
```

> Note: the old `Math.abs(Δ) < 60 000` check also suppressed a genuinely different candle at a 59-second distance. Strict `>` is both correct and simpler.

### 5.6 Execution-feed fallback

```diff
@@ executeStagedEntry (line 1020)
-    const fallbackFeed = this.deps.config.enableSniperMode ? this.feed1m.getCandles() : this.feedLtf.getCandles();
+    const fallbackFeed = this.resolveExecutionFeed(this.plan.scenarioId).getCandles();
```

```ts
  /**
   * Feed used for the live-price fallback when no WS tick exists yet.
   * Sniper-cadence trades fall back to 1m (max 1 minute stale); classic trades
   * use the LTF feed. A null scenario id keeps the historical mode-global rule.
   */
  private resolveExecutionFeed(scenarioId: number | null): CandleFeed {
    if (scenarioId === null) {
      return this.deps.config.enableSniperMode ? this.feed1m : this.feedLtf;
    }
    return isSniperCadenceScenario(scenarioId) ? this.feed1m : this.feedLtf;
  }
```

### 5.7 Cooldowns — three call sites

Site 1 — `processClosedPosition` (line 740). `trade` is the DB row, always present:

```diff
-        const tradeTfMinutes = this.deps.config.enableSniperMode ? 1 : Number(this.deps.config.ltfTimeframe);
+        const tradeTfMinutes = resolveExecutionTimeframeMinutes(
+          this.deps.config,
+          trade.scenario_id,
+        );
         const cooldownMs = this.deps.config.cooldownCandles * tradeTfMinutes * 60 * 1000;
         this.cooldownUntil = Date.now() + cooldownMs;
         const cooldownHours = (cooldownMs / (60 * 60 * 1000)).toFixed(2);
-        const tfLabel = this.deps.config.enableSniperMode ? '1m (Sniper)' : `${tradeTfMinutes}m`;
+        const tfLabel = tradeTfMinutes === 1 ? '1m (Sniper)' : `${tradeTfMinutes}m`;
```

Site 2 — `reconcile` (line 1481). `trade` is the `getOpenTrade` row:

```diff
-        const tradeTfMinutes = this.deps.config.enableSniperMode ? 1 : Number(this.deps.config.ltfTimeframe);
+        const tradeTfMinutes = resolveExecutionTimeframeMinutes(
+          this.deps.config,
+          trade.scenario_id,
+        );
```

Site 3 — `reconcileWithTrade`. Add the field to the parameter type and use it:

```diff
   async reconcileWithTrade(trade: {
     id: string;
     symbol: string;
+    scenarioId: number | null;
     entryPrice: string;
@@ cooldown block
-        const tradeTfMinutes = this.deps.config.enableSniperMode ? 1 : Number(this.deps.config.ltfTimeframe);
+        const tradeTfMinutes = resolveExecutionTimeframeMinutes(
+          this.deps.config,
+          trade.scenarioId,
+        );
```

### 5.8 `src/bootstrap/reconciliation.ts`

```diff
@@ imports
-import { BotConfig, resolveLimitExpirationCandles, resolveLimitExpirationMs } from '../config/env';
+import {
+  BotConfig,
+  resolveLimitExpirationCandlesForScenario,
+  resolveLimitExpirationMsForScenario,
+} from '../config/env';
@@ ReconcilableEngine.reconcileWithTrade param
     symbol: string;
+    scenarioId: number | null;
     entryPrice: string;
@@ Step 1 (line ~97)
-          // Expiration is mode-aware: Sniper Mode counts 1m candles, Classic counts LTF
-          // candles. Resolving through the shared helper keeps live and backtest aligned.
-          const expirationCandles = resolveLimitExpirationCandles(this.config);
-          const expirationMs = resolveLimitExpirationMs(this.config);
+          // Expiration follows the TRADE's execution timeframe, not the
+          // process-wide mode: in mixed mode (S12 + S1/S5) a 15m limit must not
+          // inherit the 1m candle count.
+          const openTrade = await this.db.getOpenTrade(engine.symbol);
+          const scenarioId = openTrade?.scenario_id ?? null;
+          const expirationCandles = resolveLimitExpirationCandlesForScenario(this.config, scenarioId);
+          const expirationMs = resolveLimitExpirationMsForScenario(this.config, scenarioId);
@@ Step 2 (line ~192)
             const changed = await engine.reconcileWithTrade({
               id: trade.id,
               symbol: trade.symbol,
+              scenarioId: trade.scenario_id ?? null,
               entryPrice: trade.entryPrice,
```

> `getOpenTrade` adds one indexed query per engine per 10-minute sweep. Acceptable. If the row is missing (pre-adoption), `scenarioId = null` preserves legacy behaviour.

### 5.9 `src/backtest/executionSimulator.ts`

```diff
@@ checkAndCloseTrade config type
   config: {
     cooldownCandles: number;
     ltfTimeframe: string;
     limitExpirationCandles: number;
     enableSniperMode?: boolean;
+    /**
+     * Per-trade overrides for mixed-cadence runs (S12 on 1m, S1/S5 on LTF).
+     * Absent => the legacy mode-global values above are used.
+     */
+    limitExpirationCandlesForScenario?: (scenarioId: number) => number;
+    executionTfMinutesForScenario?: (scenarioId: number) => number;
   },
@@ pending-limit check
   if (state.pendingLimitOrder) {
+    const pendingScenarioId = state.pendingLimitOrder.scenarioId;
     const limitCheck = checkPendingLimitOrder(
       state,
       candle,
       {
-        limitExpirationCandles: config.limitExpirationCandles,
+        limitExpirationCandles: config.limitExpirationCandlesForScenario
+          ? config.limitExpirationCandlesForScenario(pendingScenarioId)
+          : config.limitExpirationCandles,
         ltfTimeframe: config.ltfTimeframe,
       },
       symbol,
     );
@@ cooldownUntil
     cooldownUntil: isLoss
       ? candle.timestamp +
         config.cooldownCandles *
-          (config.enableSniperMode ? 1 : Number(config.ltfTimeframe)) *
+          (config.executionTfMinutesForScenario
+            ? config.executionTfMinutesForScenario(trade.scenarioId)
+            : config.enableSniperMode
+              ? 1
+              : Number(config.ltfTimeframe)) *
           60 *
           1000
       : 0,
```

### 5.10 `src/backtest/run.ts`

```diff
@@ import
-import { loadConfig, resolveLimitExpirationCandles } from "../config/env";
+import {
+  loadConfig,
+  resolveExecutionTimeframeMinutes,
+  resolveLimitExpirationCandles,
+  resolveLimitExpirationCandlesForScenario,
+} from "../config/env";
+import { EvaluationCadence } from "../types";
@@ checkAndCloseTrade call
             limitExpirationCandles: resolveLimitExpirationCandles(config),
             enableSniperMode: config.enableSniperMode,
+            limitExpirationCandlesForScenario: (scenarioId) =>
+              resolveLimitExpirationCandlesForScenario(config, scenarioId),
+            executionTfMinutesForScenario: (scenarioId) =>
+              resolveExecutionTimeframeMinutes(config, scenarioId),
@@ router gate
-    const shouldEvaluateRouter = useSniperMode ? true : isNew15mClose;
+    const shouldEvaluateRouter = useSniperMode || isNew15mClose;
+
+    // Cadence isolation: classic scenarios run only on a 15m close; S12 runs on
+    // every 1m close. At a 15m boundary both groups are evaluated exactly once.
+    const routerCadences: EvaluationCadence[] = isNew15mClose
+      ? useSniperMode
+        ? ['ltf', '1m']
+        : ['ltf']
+      : ['1m'];
@@ router call
         candles1mForRouter,
         cachedPatternData,
+        routerCadences,
       );
```

### 5.11 Readiness matrix (post-patch)

| Component | Ready | Evidence | Remaining gap |
| --- | --- | --- | --- |
| Hybrid Smart Entry (live, auto) | ✅ | `executeStagedEntry()` re-decides at the live tick; discount-first; Market-only slippage guard | none |
| Hybrid Smart Entry (live, manual) | ✅ | `pendingTradeManager.handleApproval()` mirrors auto semantics directionally | none |
| Hybrid Smart Entry (backtest) | ✅ | `run.ts` L559–585 parses discount/threshold identically | none |
| RiskManager | ✅ | Decimal sizing, `minOrderQty`/`maxOrderQty`, leverage cap, `maxWorkingCapital`, side from geometry | none |
| `tpResolver` | ✅ | pure, no S13 dependency, `skipMinorObstacles` optional | S1/S5 must pass `skipMinorObstacles: false` |
| BybitClient | ✅ | `placeMarketOrderWithTpsl` / `placeLimitOrderWithTpsl` (`positionIdx: 0`), `getOpenOrders` → `getActiveOrders`, `cancelOrder`, `setTradingStop`, `getOpenPositions().avgPrice`, `getClosedPnl` | none |
| Cadence isolation | ✅ after 5.1–5.4 | router filters by `IScenario.cadence` | none |
| Limit expiry | ✅ after 5.4/5.8/5.9 | per-scenario resolver in live + backtest | none |
| Cooldown | ✅ after 5.4/5.7/5.9 | per-trade execution timeframe | none |
| Dedupe | ✅ after 5.5 | separate 1m/LTF markers | none |
| Execution feed fallback | ✅ after 5.6 | per-scenario feed selection | none |
| Reconciliation adoption | ✅ after 5.8 | `scenario_id` threaded through `reconcileWithTrade` | `getOpenTrade` extra read per engine / 10 min |

**Verdict:** the execution primitives were already 100% ready. Mixed-mode operation becomes structurally correct only after Step 5. Without it, running S12 with S1/S5 produces wrong limit lifetimes, wrong cooldowns and a cadence collision at every 15m boundary.

### 5.12 Operational semantics to state explicitly

1. **One position per symbol.** S12, S1 and S5 share the per-symbol `IN_TRADE` slot. A 1m S12 trade blocks a 15m S1/S5 entry on the same symbol until it closes. This is intended; do not expect simultaneous exposure.
2. **Boundary priority.** At a 15m close the router iterates registration order, so S5 is evaluated before S1 and S12. S12 therefore only gets the boundary minute if the classic scenarios reject. Between boundaries it is the only cadence running. If S12 must have priority, that is a deliberate registration-order change, not a silent side effect.
3. **Killzone timestamp.** In mixed mode the backtester evaluates both cadences at `evalTimestamp = candleTime` (the 1m anchor), which is within 60 s of the 15m close. Killzone classification can only differ exactly at a session boundary minute; this is pre-existing Sniper behaviour and is documented rather than changed to avoid regressing S12's per-minute killzone freshness.
4. **News embargo** remains per-evaluation-timestamp; both cadences are blocked inside ±30 min of high-impact USD news.

---

## 6. Tests

### 6.1 New / updated S12 tests

| Test | Assertion |
| --- | --- |
| Asian high sweep + bearish CHoCH, `s12SessionSweeps: true` | triggers; `structureDetails.type === 'CHoCH'`; `getZoneDetails() === null` |
| Same fixture, flag `false` | rejects with `noSweep`/`noChoch`; proves the A/B gate |
| EQH sweep + bearish CHoCH, `s12EqhEqlSweeps: true` | triggers |
| SQL/EQH pool with `isTaken: true` | not used |
| Macro + Asian at the same price | one level; reason reports `PDH` (macro priority) |
| Sweep → CHoCH → later opposite-side sweep | still triggers (the frequency fix) |
| CHoCH before any sweep | rejects, reason regex `No BULLISH CHoCH after latest PDL sweep` preserved |
| Session-source OB 0.6 × ATR away | rejects (0.5 ATR band) |
| Macro-source OB 0.6 × ATR away | triggers (1.0 ATR band) |
| Session-source OB at 0.25% of level | triggers (0.3% floor) |

Existing fixtures keep working because `mockConfig` does not set the new optional flags (`undefined !== true`).

### 6.2 New S1 tests

| Test | Assertion |
| --- | --- |
| Bullish 4H demand + touch + 15m bullish CHoCH + FVG | `side` geometry: `SL < entry < TP` |
| Bearish 4H supply + touch + 15m bearish CHoCH + FVG | short setup, `TP < entry < SL`; proves the BEARISH branch |
| 4H supply with bullish 15m CHoCH | rejects — direction mismatch |
| CHoCH timestamp before the touch | rejects — causality |
| CHoCH without `timeframe: '15'` | rejects |
| Displacement `impulseFactor = 1.0` | rejects |
| `resolveTakeProfit` returns `Insufficient room` | rejects |
| `ENFORCE_KILLZONES=false` + `currentKillzone: 'ASIAN'` | evaluates (bypass works) |
| `ENFORCE_KILLZONES` default + ASIAN | rejects |

### 6.3 S5 fixture and test changes

```diff
@@ tests/scenarios/scenario5_htf_liquidity_sweep.test.ts (bearish fixture)
     const choch = config.hasChochAfterSweep ? {
       type: 'CHOCH', direction: 'BEARISH', price: new Decimal(103),
-      timestamp: now - 2 * 60 * 60 * 1000, // 2 hours ago (within 4H window)
+      timestamp: now, // same 15m candle as the sweep (causality allows it)
+      timeframe: '15',
       isValidated: true, impulseFactor: ...
@@ ... (bullish fixture)
     const choch = config.hasChochAfterSweep ? {
       type: 'CHOCH', direction: 'BULLISH', price: new Decimal(97),
-      timestamp: now - 2 * 60 * 60 * 1000,
+      timestamp: now,
+      timeframe: '15',
```

New S5 tests:

- sweep on an **older** candle inside the 16-candle window still qualifies;
- CHoCH **before** the sweep rejects (the regression this change fixes);
- two pools swept on different candles → newest wins;
- two pools swept on the same candle → higher-ranked pool reported;
- `resolveTakeProfit` rejection increments `tpInvalid`.

### 6.4 New readiness tests

| Test | File |
| --- | --- |
| `resolveExecutionTimeframeMinutes` for 12 → 1, for 1/5 → 15, for `null` → mode |
| `resolveLimitExpirationCandlesForScenario` 12 → sniper knob, 1 → classic knob |
| Router cadence filter: S12 excluded on `['ltf']`, included on `['1m']` |
| Router `evaluate()` without cadence keeps all scenarios (backward compat) |
| `reconcileWithTrade` receives `scenarioId` |
| Simulator pending limit uses the pending trade's scenario expiry |
| Simulator cooldown uses the closed trade's scenario timeframe |

---

## 7. Implementation Order

1. **Step 1** — S13 removal (bounds, router, reporter, files, tests, docs).
2. **Step 2** — S12 expansion (flags, stats, sweep block, helper, proximity, reporter).
3. **Step 3** — S1 rewrite (full file).
4. **Step 4** — S5 restoration (stats, sweep block, TP).
5. **Step 5** — Mixed-mode readiness (types → base → router → env → engine → reconciliation → simulator → run.ts).
6. **Step 6** — Tests (fixtures first, then new suites).
7. **Step 7** — Docs/config, then validation.

Run after each step:

```bash
npm run typecheck
npm test
npm run build
```

Full validation after Step 7:

```bash
npm run typecheck && npm test && npm run build
npm run backtest -- NEARUSDT
npm run backtest -- SOLUSDT
npm run backtest -- BTCUSDT
```

A/B matrix (same 60-day window, same cache):

```bash
ENABLE_SNIPER_MODE=true ACTIVE_SCENARIOS=12 S12_SESSION_SWEEPS=false S12_EQH_EQL_SWEEPS=false npm run backtest -- NEARUSDT
ENABLE_SNIPER_MODE=true ACTIVE_SCENARIOS=12 S12_SESSION_SWEEPS=true  S12_EQH_EQL_SWEEPS=false npm run backtest -- NEARUSDT
ENABLE_SNIPER_MODE=true ACTIVE_SCENARIOS=12 S12_SESSION_SWEEPS=false S12_EQH_EQL_SWEEPS=true  npm run backtest -- NEARUSDT
ENABLE_SNIPER_MODE=true ACTIVE_SCENARIOS=12 S12_SESSION_SWEEPS=true  S12_EQH_EQL_SWEEPS=true  npm run backtest -- NEARUSDT
```

Mixed-mode smoke test (backtest):

```bash
ENABLE_SNIPER_MODE=true ACTIVE_SCENARIOS=1,5,12 npm run backtest -- SOLUSDT
```

---

## 8. Risks and Rollback

| Risk | Mitigation |
| --- | --- |
| S12 frequency explodes into low-quality trades | Both new sources default `false`; per-source attribution counters; per-source tighter ATR band; the 1m CHoCH + displacement gate remains |
| Asian H/L duplicates macro levels | Exact-price dedupe with macro priority |
| EQH/EQL pools are already stale/mitigated | `isTaken` filter; router mitigation filter; 50-minute lookback |
| S1 becomes too permissive after bidirectional support | Direction-matched OB, touch→CHoCH→FVG causality, 4H windows, displacement gate, structural TP floor |
| S5 fixture changes mask a regression | Add the explicit “CHoCH before sweep rejects” test |
| Mixed-mode cadence patch alters classic behaviour | `cadences` is optional; omitting it preserves the old all-scenario path; `scenarioId = null` preserves mode-global timing |
| Startup failure after S13 removal | Intentional; operator must update `ACTIVE_SCENARIOS` before deploying |
| `reconcileWithTrade` signature change | Test uses `objectContaining`; mock engines are untyped jest fns; update the interface in `reconciliation.ts` and the engine in the same commit |

**Rollback:** set `S12_SESSION_SWEEPS=false` and `S12_EQH_EQL_SWEEPS=false` to restore the exact macro-only S12 path. S1/S5 can be excluded per symbol via `SCENARIOS_<SYMBOL>` without touching code.

---

## 9. Files Touched (summary)

| Area | Files |
| --- | --- |
| S13 removal | `src/engine/scenarios/Scenario13_TopDownOrderFlow.ts` (delete), `src/engine/brain/*` (delete), `src/engine/scenarioRouter.ts`, `src/backtest/reporter.ts`, `src/config/env.ts` |
| S12 | `src/engine/scenarios/Scenario12_SniperTouch.ts`, `src/config/env.ts`, `src/backtest/reporter.ts` |
| S1 | `src/engine/scenarios/Scenario1_HTFContinuation.ts` |
| S5 | `src/engine/scenarios/Scenario5_HTFLiquiditySweep.ts` |
| Readiness | `src/types.ts`, `src/engine/baseScenario.ts`, `src/engine/scenarioRouter.ts`, `src/engine/strategyEngine.ts`, `src/config/env.ts`, `src/bootstrap/reconciliation.ts`, `src/backtest/executionSimulator.ts`, `src/backtest/run.ts` |
| Tests | `tests/scenarios/scenario12_sniper_touch.test.ts`, `tests/scenarios/scenario1_htf_continuation.test.ts`, `tests/scenarios/scenario5_htf_liquidity_sweep.test.ts`, `tests/scenarioRouter.test.ts`, `tests/config/env.test.ts`, `tests/reconciliationLoop.test.ts`, new cadence/timing tests |
| Docs/config | `.env`, `.env.example`, `README.md`, `AGENTS.md` |
