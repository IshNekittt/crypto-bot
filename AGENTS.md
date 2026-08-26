# AGENTS.md

## Repo status

- `Крипто-бот SMC.md` (Cyrillic filename, easy to miss) is the authoritative architecture manifest for a TypeScript Bybit V5 Smart-Money-Concepts trading bot; its numbered blocks (Блок 1–9) define required behavior.
- Implemented: all manifest blocks. Блок 1 (`src/bootstrap/preflight.ts`), Блок 2 (`src/smc/smc.ts` pure math + `src/types.ts`), Блок 3 (`BybitClient` in `src/api/bybitClient.ts`, `BybitWebsocket` in `src/api/wsClient.ts`, per-symbol/TF candle buffers in `src/feed/candleFeed.ts` with confirmed-candle merge + shift), Блок 4 (`StrategyEngine` per-symbol state machine in `src/engine/strategyEngine.ts`, wired in `src/index.ts`; liquidity sweep via `hasRecentLiquiditySweep`), Блок 5 (`RiskManager` + `src/utils/precision.ts`), Блок 6 (`ExecutionEngine` + circuit breaker in `src/execution/executionEngine.ts`, `TelegramNotifier` in `src/telegram/notifier.ts`), Блок 7 (`src/db/database.ts` incl. `order_id` migration; `ReconciliationLoop` in `src/bootstrap/reconciliation.ts`), Блок 9 (`Dockerfile` multi-stage non-root, `docker-compose.yml` with named volume + `restart: unless-stopped`, `README.md` VPS/key-security guide).
- WS reconnects are handled by bybit-api internally; our `onResync` callback re-syncs server time and reloads kline histories. Private topics must use `isPrivateTopic=true`.
- Candle buffers are index-ordered: `CandleFeed.loadHistory` trusts the source's ascending order (REST parser already returns ascending); never re-sort by timestamp or synthetic test candles with post-assigned indexes will break.
- RiskManager derives TP itself from rounded entry/SL (strict 1:3) — callers must not pass takeProfit; SL comes raw from `calculateStopLoss(ob, direction)`.

## Commands

- `npm test` — Jest (ts-jest); suites live in `tests/`, not covered by `tsc --noEmit`.
- `npm run typecheck` — strict TS check of `src/` only.
- `npm start` — builds then runs bootstrap (requires `.env`; see `.env.example`). `TESTNET` defaults to true unless set to `false`.

## Non-negotiable constraints from the manifest

- Strict TypeScript, **no `any`**.
- All money/qty math through `decimal.js`, never plain floats.
- Mandated libraries: `bybit-api`, `winston` (logs), `better-sqlite3` (state), `telegraf` or native fetch (Telegram), Jest for tests (`math.test.ts`, `smc.test.ts`, `api.test.ts` minimum).
- Zero hardcoded symbols, amounts, or delays — everything comes from `.env` / Bybit API. Env vars per Блок 9: `BYBIT_API_KEY`, `BYBIT_API_SECRET`, `TESTNET`, `SYMBOLS`, `RISK_PERCENT`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`; extras: `LEVERAGE` (default 10), `REDUCED_RISK_PERCENT` (default 1), `HISTORY_CANDLES` (default 200, max 1000), `DATA_DIR`, `LOG_LEVEL`.
- SQLite must initialize with `PRAGMA journal_mode = WAL;` — per-symbol workers write concurrently and will hit `SQLITE_BUSY` otherwise.
- SL/TP are set on the order itself (Market IOC, `tpslMode: Full`) and delegated to the exchange; never implement manual position closing. Position close events come from the private WS (`execution`, `position`), not local calculations.
- Precision formatter: round qty **down** to multiples of `qtyStep`, prices/SL/TP to `tickSize`; abort the trade if qty < `minOrderQty`.
- Hard SMC rules that are correctness-critical: BOS/ChoCh counts only when the 15m candle **body** closes beyond the swing (a wick never counts); impulse body must be ≥ 2× average body of the last 10 candles; TP is always exactly 1:3 RR (`TP = Entry + (Entry - SL) * 3`).

## Shape to build toward

- Worker/Actor pattern: one shared Risk Manager over total balance + an independent Strategy Engine state machine per symbol (`SCANNING → WAITING → CONFIRMATION → ENTRY_STAGED → IN_TRADE`), driven by `.env` `SYMBOLS`.
- SMC math module must be pure: it takes candle arrays and knows nothing about Bybit.
- Layout: `src/` (`types.ts`, `config/`, `api/`, `bootstrap/`, `db/`, `engine/`, `feed/`, `risk/`, `execution/`, `smc/`, `telegram/`, `utils/`), `tests/`, `data/` (SQLite DB, gitignored). Deploy: `Dockerfile` + `docker-compose.yml` (named volume `bot-data:/app/data`, `restart: unless-stopped`, non-root user); VPS/key-security guide lives in `README.md`.
- Telegram alerts follow the exact cases/formats in Блок 6; user-facing strings are in Russian.
