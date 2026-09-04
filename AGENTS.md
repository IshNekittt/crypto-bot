# AGENTS.md — Эталонный свод законов проекта crypto-bot-ox

> Этот файл является единственным источником правды для архитектуры, правил и конвенций проекта. Любые изменения кода должны соответствовать этим правилам.

---

## АРХИТЕКТУРА (Stateless Web Service)

| Компонент | Технология | Детали |
|-----------|------------|--------|
| **Платформа** | Render.com | Stateless Web Service, HTTP health-check на `process.env.PORT` (`GET /` → `200 OK`) |
| **База данных** | PostgreSQL (Supabase) | Direct connection через `pg` (pool), `DATABASE_URL` из env |
| **WebSocket** | Bybit V5 WS | `bybit-api` lib, приватные топики требуют `isPrivateTopic=true` |
| **Telegram** | Telegraf | Long-Polling, inline-кнопки Approve/Reject |
| **Health-check** | Express/HTTP | Обязателен для Render |

### Ключевые модули
- `src/index.ts` — точка входа: DB init → health server → BybitClient preflight → RiskManager/ExecutionEngine → per-symbol StrategyEngine → WS subscriptions → ReconciliationLoop
- `PatternRecognizer` — чистая математика (нет Bybit зависимостей): killzones, displacement, BOS/CHoCH/SMS/IDM, FVG/OB/Breaker/Mitigation, EQH/EQL, PDH/PDL/PWH/PWL/DO/WO, macro 1W/1D, Fib 0.5, Premium/Discount
- `ScenarioRouter` — 11 сценариев, first-match wins, first-match → `ENTRY_STAGED`
- `StrategyEngine` — per-symbol стейт-машина: `SCANNING → WAITING → CONFIRMATION → ENTRY_STAGED → IN_TRADE`
- `PendingTradeManager` — ручной апрув: кэш в памяти + timeout + TG inline кнопки
- `RiskManager` — общий на баланс, TP = Entry + (Entry - SL) × 3 (строго 1:3), qty вниз до `qtyStep`
- `ExecutionEngine` — Market IOC, `tpslMode: Full`, circuit breaker 60с при rate limit

---

## 11 SMC СЦЕНАРИЕВ (в порядке приоритета роутера)

### Группа А: Продолжение тренда (Trend Continuation)
1. **HTF Continuation** — 4H тренд, касание 4H OB → 15m CHoCH (Displacement) → вход от 15m FVG
2. **FVG Fill** — большой HTF FVG → касание 0.5 (Equilibrium) → 15m CHoCH → вход
3. **Inducement (IDM)** — локальный минимум (IDM) → свип тенью → тест настоящего OB → вход по рынку на закрытии SFP
4. **Mitigation Chain** — тренд без откатов → новый OB → возврат ровно к 0.5 OB (в касание) → вход

### Группа Б: Развороты тренда (Reversals)
5. **HTF Liquidity Sweep** — PDH/PDL/PWH/PWL/BSL/SSL в киллзоне → SFP → агрессивный 15m CHoCH → вход от 15m FVG
6. **Failure Swing (SMS)** — неудача обновить экстремум → агрессивный CHoCH в обратную сторону → вход от OB, сформировавшего SMS
7. **AMD** — Asian Range (00-06 NY) → Лондонский открытие свип Asian Low → SFP/CHoCH вверх → вход в лонг, цель — Asian High

### Группа В: Работа в боковике (Ranges)
8. **Range Deviation & Reclaim** — Trading Range → девиация выше RH → реклейм внутрь → медвежий CHoCH → вход от 15m FVG (SHORT), цели: 0.5 Range / Range Low
9. **Turtle Soup (Range SFP)** — EQH/EQL на границах → SFP (прокол тенью, возврат внутрь) → мгновенный MARKET вход на закрытии свечи, SL за кончик тени, TP противоположная граница

### Группа Г: Продвинутые зоны (Advanced POI)
10. **Breaker Block Entry** — сильный OB пробит импульсной свечой телом → OB становится Breaker → зеркальный возврат → вход от 0.5 Breaker (FVG обязателен)
11. **Mitigation Block** — как Брейкер, но перед пробоем был SMS (не обновил экстремум) → вход на зеркальном ретесте MB

---

## ТРИ ЗОЛОТЫХ ПРАВИЛА SMC (НЕНАРУШИМЫЕ)

1. **Killzones** — сделки ТОЛЬКО в активные сессии (NY time, DST-aware через `luxon`):
   - Asian Range: 20:00–00:00 NY
   - London Killzone: 02:00–05:00 NY
   - NY Killzone: 07:00–10:00 NY
   > Свипы вне киллзон игнорируются.

2. **Displacement > 1.5×ATR(10)** — пробой структуры (BOS/CHoCH) только если тело свечи > 1.5×ATR(10). Вялый пробой = отмена.

3. **0.5 Equilibrium Entry** — вход строго от 0.5 (Equilibrium) FVG/OB/Breaker/MB. Premium/Discount: лонги < 0.5 (Discount), шорты > 0.5 (Premium).

---

## ЖЕСТКИЕ ПРАВИЛА РАЗРАБОТКИ

### Математика и точность
- **ЗАПРЕЩЕНО** использовать `number` для цен/объемов/PnL — только `decimal.js`
- PostgreSQL: `NUMERIC(24,8)` для всех цен/PnL. `pg` возвращает строки — хранить как строки
- Риск-менеджмент: TP считается автоматически = Entry + (Entry - SL) × 3 (строго 1:3). Коллеры не передают takeProfit
- Точность: qty **вниз** до `qtyStep`, цены/SL/TP до `tickSize`; отмена если qty < `minOrderQty`

### TypeScript и код
- Strict TS, **нет `any`**
- Нет хардкода символов/сумм/задержек — всё из `.env` / Bybit API
- Обязательные библиотеки: `bybit-api`, `winston`, `pg`, `telegraf`, `luxon`, `decimal.js`, Jest

### Env переменные (обязательные)
```
BYBIT_API_KEY, BYBIT_API_SECRET, TESTNET, SYMBOLS, RISK_PERCENT,
TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, DATABASE_URL,
AUTO_TRADING (default false), TRADE_APPROVAL_TIMEOUT_MINUTES (5),
LEVERAGE (10), REDUCED_RISK_PERCENT (1),
HISTORY_CANDLES (200, max 1000), MACRO_CANDLES (1000, max 1000),
LTF_TIMEFRAME (15), HTF_TIMEFRAME (240), LOG_LEVEL, DATA_DIR,
DEMO_TRADING (default false)
```

---

## РЕЖИМЫ РАБОТЫ

| Режим | `AUTO_TRADING` | Поведение |
|-------|----------------|-----------|
| **Авто** | `true` | Мгновенный MARKET ордер через ExecutionEngine → запись в БД → `IN_TRADE` |
| **Полуавто** | `false` | `PendingTradeManager.queueTrade()` → TG inline [✅ Войти] [❌ Отменить] + таймер `TRADE_APPROVAL_TIMEOUT_MINUTES` → `engine.handleTradeApproval()` исполняет или отменяет |

### Режим Demo Trading (`DEMO_TRADING=true`)
- Реальная ликвидность Bybit, но фейковые USDT (как Testnet)
- `testnet` принудительно ставится в `false` (Bybit API не позволяет одновременно)
- Используется для тестирования SMC-логики на реальной ликвидности без риска

| Режим | `TESTNET` | `DEMO_TRADING` | Где торгует |
|-------|-----------|----------------|-------------|
| Testnet | `true` | `false` | testnet.bybit.com (фейковые USDT, нет ликвидности) |
| Demo Trading | `false` | `true` | bybit.com/demo (реальная ликвидность, демо USDT) |
| Mainnet | `false` | `false` | bybit.com (РЕАЛЬНЫЕ ДЕНЬГИ) |

> **Важно**: `DEMO_TRADING=true` принудительно ставит `testnet=false`. Нельзя использовать одновременно.

---

## ЦИКЛ ЖИЗНИ СДЕЛКИ

1. **SCANNING** — поиск сетапов на закрытии 15m свечи
2. **ENTRY_STAGED** — роутер нашел сетап, посчитал уровни
3. **AUTO_TRADING=true** → мгновенный ордер → **IN_TRADE**
4. **AUTO_TRADING=false** → TG алерт с кнопками → Approve → ордер → **IN_TRADE** / Reject/Timeout → **SCANNING**
5. **IN_TRADE** — позиция открыта, закрытие ТОЛЬКО по приватным WS событиям (`execution`, `position`), никогда локально
6. **ReconciliationLoop** (каждые 10 мин) — сверка БД с биржей, автозакрытие "потерянных" сделок через REST историю исполнений

---

## КОМАНДЫ

```bash
npm test          # Jest (ts-jest) — suites в tests/ (math, smc, patternRecognizer, candleFeed, api + 11 scenario tests + router + pendingTradeManager)
npm run typecheck # tsc --noEmit (strict TS только src/)
npm run build     # tsc → dist/
npm start         # build → bootstrap (требует .env, TESTNET=true по умолчанию)
```

---

## ТЕСТИРОВАНИЕ

- **178 тестов** (core: math, smc, patternRecognizer, candleFeed, api + 11 scenario tests + router + pendingTradeManager)
- Мокать `PatternRecognizer` через фабрики `createMockPatternData` с правильными структурами `PatternData`
- Использовать `jest.useFakeTimers()` для таймаутов в `PendingTradeManager`
- Запускать `npm test` после изменений; `npm run typecheck` должен проходить первым

---

## ГЛАВНЫЕ ФАЙЛЫ МАНИФЕСТОВ

- `smc_full_guide.md` — бизнес-логика всех 11 сценариев (детальные правила входа/выхода)
- `Крипто-бот SMC эволюция.md` — V3 инфраструктура, БД, роутинг, деплой
- Старый `Крипто-бот SMC.md` — в `.gitignore`, не используется

---

## СИСТЕМНЫЕ ФОНОВЫЕ ЗАДАЧИ

- **Ежедневный бэкап БД** — `BackupService` (setInterval 24h):
  - `SELECT * FROM trades` → CSV → `zlib.gzipSync` → Telegram `sendDocument` как `.csv.gz`
  - Вся обработка в RAM (никаких файлов на диск)
  - Запускается сразу при старте + каждые 24ч
  - Ошибки бэкапа → критичный алерт в Telegram
  - Graceful shutdown: `backupService.stop()` перед выходом

---

## КРИТИЧЕСКИЕ ИСПРАВЛЕНИЯ PERFORMANCE (2026-09-03)

### Macro Context — ультра-быстрая инициализация (~5-10ms)
- **Убрано ВСЁ тяжелое** на макро-свечах (1W/1D): `detectStructureBreaks`, `detectOrderBlocks`, `findSwingPoints`, `detectEqualLevels`, ликвидные пулы BSL/SSL/EQH/EQL
- **Оставлено ТОЛЬКО необходимое** (линейные проходы O(N)):
  - **ATH/ATL** — один проход по массиву (max high / min low)
  - **PWH/PWL** — `weeklyCandles[length-2]` (предпоследняя неделя)
  - **PDH/PDL** — `dailyCandles[length-2]` (предпоследний день)
  - **DO/WO** — `open` последней свечи 1D/1W
  - **FVG** — только на последних **20** дневных свечах (не 1000!)
  - **Нет** Order Blocks, Breakers, Mitigation на макро
- **Логи**: `[SYMBOL] Macro context loaded in Xms: ATH=xxx, ATL=yyy`

### detectStructureBreaks — оптимизация O(N²) → O(N)
- Свинг-поинты вычисляются **один раз** перед циклом (O(N))
- Два указателя (`highSwingIdx`, `lowSwingIdx`) вместо O(N²) поиска на каждой итерации
- **НИКАКИХ `while` циклов** — только `for` с `break`

### Macro Context — инициализация ТОЛЬКО при старте (Bootstrap)
- При старте создаётся **один** `PatternRecognizer` на все движки
- При старте бота (Bootstrap) макроконтекст загружается **ОДИН РАЗ** для всех символов
- В `buildPatternData` убраны вызовы `initializeMacroContext` — используется только кэш
- В WebSocket-хендлере (`ws.onKline`) **НЕТ** REST-запросов

### detectOrderBlocks — СТРОГО по индексам массива
- **НИКОГДА** не итерировать по `br.timestamp` (триллионы миллисекунд!)
- Находим `breakIdx = candles.findIndex(c => c.timestamp === br.timestamp)`
- Идём НАЗАД по индексам: `for (let i = breakIdx - 1; i >= 0; i--)`
- Никаких циклов по timestamp!

### Исправление дублей логов и дедупликации свечей (2026-09-04)
- **Убрано задвоение лога "PatternData built"**: удален дублирующий `logger.debug` в `scenarioRouter.ts`, оставлен только в `patternRecognizer.ts`
- **Исправлена дедупликация свечей**: вместо строгого сравнения timestamp (`===`) используется окно в 60 секунд (`timeDiff < 60000`), что блокирует повторную обработку при двойном `confirm: true` от Bybit
- **Убран дубль лога "PatternData built" в `scenarioRouter.ts`** — оставлен только в `patternRecognizer.ts`
- **Убраны неиспользуемые переменные** `t0`, `ms` в `scenarioRouter.ts`
- **Формат логов**: строго 3 строки на закрытие свечи (candle close, PatternData built, Scan complete)

### Telegram UX improvements (2026-09-04)
- **Inline-кнопки**: после нажатия Approve/Reject клавиатура убирается (`editMessageReplyMarkup`), в конец сообщения добавляется статус `[ ✅ APPROVED ]` / `[ ❌ REJECTED ]`
- **Dry-run тест**: команда `/test_signal` создает фейковую сделку с флагом `isTest: true`, при аппруве логируется `✅ Test trade approved (DRY RUN)` без реального ордера
- **Dependency Injection**: `setPendingTradeManager()` в `TelegramNotifier` для внедрения `PendingTradeManager`

### detectOrderBlocks — СТРОГО по индексам массива
- **НИКОГДА** не итерировать по `br.timestamp` (триллионы миллисекунд!)
- Находим `breakIdx = candles.findIndex(c => c.timestamp === br.timestamp)`
- Идём НАЗАД по индексам: `for (let i = breakIdx - 1; i >= 0; i--)`
- Никаких циклов по timestamp!

---

## СХЕМА БАЗЫ ДАННЫХ (PostgreSQL / Supabase)

### Таблица `trades`
```sql
CREATE TABLE trades (
  id BIGSERIAL PRIMARY KEY,
  symbol VARCHAR(20) NOT NULL,
  scenario_id INTEGER,
  entry_price NUMERIC(24, 8) NOT NULL,
  sl_price NUMERIC(24, 8) NOT NULL,
  tp_price NUMERIC(24, 8) NOT NULL,
  qty NUMERIC(24, 8) NOT NULL,
  pnl NUMERIC(24, 8),
  exit_price NUMERIC(24, 8),
  status VARCHAR(20) NOT NULL CHECK (status IN ('OPEN', 'CLOSED')),
  reason TEXT,
  opened_at BIGINT NOT NULL,
  closed_at BIGINT,
  order_id VARCHAR(255),
  side VARCHAR(10) CHECK (side IN ('Buy', 'Sell'))
);
```

### Таблица `symbol_state`
```sql
CREATE TABLE symbol_state (
  symbol VARCHAR(20) PRIMARY KEY,
  state VARCHAR(20) NOT NULL CHECK (state IN ('SCANNING', 'WAITING', 'CONFIRMATION', 'ENTRY_STAGED', 'IN_TRADE')),
  updated_at BIGINT NOT NULL
);
```

### Индексы
```sql
CREATE INDEX IF NOT EXISTS idx_trades_symbol_status ON trades (symbol, status, opened_at);
CREATE INDEX IF NOT EXISTS idx_trades_closed ON trades (closed_at DESC);
```

---

## ВАЖНЫЕ ТЕХНИЧЕСКИЕ ДЕТАЛИ

- **Candle buffers** — index-ordered (ascending), **никогда не ресортить**. `CandleFeed.loadHistory` доверяет порядку REST.
- **WS reconnect** — `bybit-api` делает сам, `onResync` колбэк: `syncServerTime()` + `reloadHistory()` по всем символам.
- **Macro context** — при старте загрузка 1000 свечей 1W и 1D → ATH/ATL, PWH/PWL, PDH/PDL, DO/WO, последние 20 дневных FVG. Время ~5-10ms.
- **Private WS** — топики `execution`, `position` требуют `isPrivateTopic=true` (в `wsClient.ts`).
- **Graceful shutdown** — `SIGINT`/`SIGTERM` → stop reconciliation → cancel pending → close WS → close DB pool → `process.exit(0)`.

### PostgreSQL Pool (Supabase) — предотвращение разрывов
- **max: 5** — для одного бота достаточно, меньше нагрузка на Supabase
- **idleTimeoutMillis: 10000** (10 сек) — пул сам закрывает простаивающие клиенты до того, как их оборвет Supabase
- **keepAlive: true** + **keepAliveInitialDelayMillis: 10000** — TCP keep-alive пакеты каждые 10 сек, предотвращают разрыв `ETIMEDOUT` от Supabase
- **allowExitOnIdle: false** — пул не завершает работу при отсутствии активных клиентов
- **connectionTimeoutMillis: 5000** — таймаут установки соединения

---

## ЛОГИРОВАНИЕ (Production-ready)

- **Telegram test message** при старте: `🟢 SMC Бот запущен | mode=Demo Trading`
- **15m candle close**: `[SYMBOL] 15m candle closed at PRICE. Scanning 11 scenarios...`
- **PatternData built**: `[DEBUG] [SYMBOL] PatternData built in Xms` (только в `patternRecognizer.ts`, убрано дублирование в `scenarioRouter.ts`)
- **Scan complete**: `[INFO] [SYMBOL] Scan complete: no setups triggered.`
- **Scenario evaluation**: `[DEBUG] [SYMBOL] ScenarioName evaluated in Xms. Result: true/false`

### Формат логов на закрытие каждой 15m свечи (строго 3 строки)
```
[INFO] [SYMBOL] 15m candle closed at PRICE. Scanning 11 scenarios...
[DEBUG] [SYMBOL] PatternData built in Xms
[INFO] [SYMBOL] Scan complete: no setups triggered.
```

---

*Последнее обновление: 2026-09-04. Все 178 тестов зелёные, build проходит.*