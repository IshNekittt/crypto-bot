# crypto-bot-ox — SMC Trading Bot for Bybit V5

> **Smart Money Concepts (SMC) торговый бот** для линейных фьючерсов Bybit V5.
> Реализует **11 профессиональных SMC-сценариев**, автоматически рассчитывает риск/прибыль (строго 1:3), работает в двух режимах (авто / полуавто с Telegram-апрувом) и деплоится как Stateless Web Service на **Render.com** с базой **PostgreSQL (Supabase)**.

---

## 🎯 Что умеет бот

| Возможность | Описание |
|-------------|----------|
| **11 SMC-сценариев** | 4 группы: продолжение тренда, развороты, работа в боковике, продвинутые зоны (Breaker/Mitigation Blocks) |
| **Чистая математика** | `decimal.js` — никаких `number`, все расчёты в `NUMERIC(24,8)` |
| **Killzones (NY time)** | Азиатская (20:00–00:00), Лондонская (02:00–05:00), Нью-Йоркская (07:00–10:00) — DST-aware через `luxon` |
| **Displacement > 1.5×ATR** | Только полнотелые пробои структуры |
| **0.5 Equilibrium Entry** | Вход строго от середины FVG/OB/Breaker/Mitigation Block |
| **Premium/Discount Filter** | Лонги только в Discount (< 0.5), шорты только в Premium (> 0.5) |
| **Риск-менеджмент 1:3** | TP = Entry + (Entry - SL) × 3, qty округляется вниз до `qtyStep` |
| **Telegram UI** | Long-Polling + Inline-кнопки `✅ Войти / ❌ Отменить` с таймером |
| **Reconciliation Loop** | Каждые 10 мин сверка с биржей, автозакрытие «потерянных» сделок |
| **Graceful Shutdown** | SIGTERM → stop reconciliation → close WS → close DB pool → exit(0) |

---

## 📋 Предварительные требования

Перед настройкой убедитесь, что у вас есть:

| Сервис | Что нужно | Ссылка |
|--------|-----------|--------|
| **Bybit** | API Key + Secret (Derivatives/USDT Perpetual, Read-Only + Trade) | [bybit.com](https://www.bybit.com/app/user/api-management) |
| **Supabase** | PostgreSQL проект (Direct connection string) | [supabase.com](https://supabase.com/dashboard) |
| **Render.com** | Аккаунт для деплоя Web Service | [render.com](https://dashboard.render.com) |
| **Telegram BotFather** | Токен бота + ваш Chat ID | [@BotFather](https://t.me/BotFather) |

> ⚠️ **Совет:** Создайте отдельный Sub-account на Bybit только для бота. Включите **IP Whitelist** (добавьте IP Render — они динамические, лучше оставить пустым, но включите 2FA на аккаунте).

---

## ⚙️ Настройка `.env`

Создайте файл `.env` в корне проекта (скопируйте из `.env.example`):

```bash
# ──────────────────────────────────────────────
# BYBIT API (ОБЯЗАТЕЛЬНО)
# ──────────────────────────────────────────────
BYBIT_API_KEY=ваш_api_key
BYBIT_API_SECRET=ваш_api_secret
TESTNET=true                    # true = testnet.bybit.com, false = mainnet (РЕАЛЬНЫЕ ДЕНЬГИ!)
DEMO_TRADING=false              # true = Demo Trading (реальная ликвидность, фейковые USDT)
SYMBOLS=SOLUSDT,BTCUSDT,ETHUSDT # Торговые пары через запятую (Bybit V5 Linear/USDT Perpetual)

# ──────────────────────────────────────────────
# РИСК-МЕНЕДЖМЕНТ
# ──────────────────────────────────────────────
RISK_PERCENT=2                  # % от баланса на сделку (1-5 рекомендуется)
REDUCED_RISK_PERCENT=1          # % после 3 убыточных сделок подряд
LEVERAGE=10                     # Плечо (1-50)

# ──────────────────────────────────────────────
# ТАЙМФРЕЙМЫ (в минутах, как у Bybit)
# ──────────────────────────────────────────────
LTF_TIMEFRAME=15                # Низкий TF для входа (1, 3, 5, 15, 30, 60...)
HTF_TIMEFRAME=240               # Высокий TF для тренда/контекста (60, 120, 240, 360...)
HISTORY_CANDLES=200             # Свечей для LTF/HTF (макс 1000)
MACRO_CANDLES=1000              # Свечей 1D/1W для макро-контекста (макс 1000)

# ──────────────────────────────────────────────
# TELEGRAM (ОБЯЗАТЕЛЬНО для уведомлений/аппрува)
# ──────────────────────────────────────────────
TELEGRAM_BOT_TOKEN=123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11
TELEGRAM_CHAT_ID=123456789      # Ваш личный Chat ID (узнайте у @userinfobot)

# ──────────────────────────────────────────────
# БАЗА ДАННЫХ (Supabase Direct Connection)
# ──────────────────────────────────────────────
# В Supabase: Settings → Database → Connection string → Direct connection (port 5432)
# Замените [PASSWORD] на пароль БД, [HOST] — на db.xxx.supabase.co
DATABASE_URL=postgresql://postgres.[PROJECT_REF]:[PASSWORD]@db.[PROJECT_REF].supabase.co:5432/postgres?sslmode=require

# ──────────────────────────────────────────────
# РЕЖИМЫ РАБОТЫ
# ──────────────────────────────────────────────
AUTO_TRADING=false              # true = бот сам входит в сделку; false = шлет кнопки в TG
TRADE_APPROVAL_TIMEOUT_MINUTES=5 # Таймаут на аппрув в полуавто (мин)
ENABLE_LIVE_TEST_ORDERS=false   # true = включить команду /test_live_order (E2E тест на Demo)

# ──────────────────────────────────────────────
# СИСТЕМНЫЕ
# ──────────────────────────────────────────────
LOG_LEVEL=info                  # debug, info, warn, error
DATA_DIR=./data                 # Папка для временных файлов (логи, кэш)
```

### 🔑 Важные нюансы переменных

| Переменная | Пояснение |
|------------|-----------|
| **TESTNET** | `true` — торгует на `testnet.bybit.com` (фейковые USDT). `false` — **РЕАЛЬНЫЕ ДЕНЬГИ** на `bybit.com`. Всегда начинайте с `true`. |
| **DEMO_TRADING** | `true` — **Demo Trading** (реальная ликвидность Bybit, фейковые USDT). `false` — обычный режим. `DEMO_TRADING=true` принудительно ставит `testnet=false`. Нельзя использовать одновременно с `TESTNET=true`. |
| **AUTO_TRADING** | `true` — бот сам выставляет MARKET-ордер сразу при сигнале. `false` — бот шлёт в Telegram сообщение с кнопками `✅ Войти / ❌ Отменить` и таймером (`TRADE_APPROVAL_TIMEOUT_MINUTES`). |
| **LTF_TIMEFRAME / HTF_TIMEFRAME** | В **минутах** как в API Bybit. `15` = 15m, `240` = 4H. LTF — для входа (15m), HTF — для тренда/контекста (4H). Допустимые: `1,3,5,15,30,60,120,240,360,720,D,W,M`. |
| **DATABASE_URL** | **Direct connection** (port 5432), НЕ PgBouncer (port 6543). В Supabase: Settings → Database → Connection string → **Direct connection**. Формат: `postgresql://postgres.[REF]:[PASS]@db.[REF].supabase.co:5432/postgres?sslmode=require`. |
| **ENABLE_LIVE_TEST_ORDERS** | `true` — включает команду `/test_live_order` для сквозного E2E теста на Demo Trading. `false` (по умолчанию) — команда скрыта и недоступна. **Настоятельно рекомендуется держать `false` на мейннете!** |

---

## ⚙️ Режимы работы бота

| Режим | `TESTNET` | `DEMO_TRADING` | Где торгует | Деньги |
|-------|-----------|----------------|-------------|--------|
| **Testnet** | `true` | `false` | `testnet.bybit.com` | Фейковые USDT, нет ликвидности |
| **Demo Trading** | `false` | `true` | `bybit.com/demo` | **Реальная ликвидность**, демо USDT |
| **Mainnet** | `false` | `false` | `bybit.com` | **РЕАЛЬНЫЕ ДЕНЬГИ** |

> **Важно**: `DEMO_TRADING=true` принудительно ставит `testnet=false`. Нельзя использовать одновременно `TESTNET=true` и `DEMO_TRADING=true`.

> **Совет**: Начинайте с `TESTNET=true` → тестируете 1-2 недели → переходите на `DEMO_TRADING=true` для тестов на реальной ликвидности → только потом `TESTNET=false` + `DEMO_TRADING=false` (Mainnet).

---

## ⚡ Performance Optimizations & Fixes (2026-09-04)

### Исправления и оптимизации (2026-09-04)

### Исправление дублей логов и дедупликация свечей
- **Убрано задвоение лога "PatternData built"**: удален дублирующий `logger.debug` в `scenarioRouter.ts`, оставлен только в `patternRecognizer.ts`
- **Исправлена дедупликация свечей**: вместо строгого сравнения timestamp (`===`) используется окно в **60 секунд** (`timeDiff < 60000`), что блокирует повторную обработку при двойном `confirm: true` от Bybit
- **Убран дубль лога "PatternData built"** в `scenarioRouter.ts` — оставлен только в `patternRecognizer.ts`
- **Убраны неиспользуемые переменные** `t0`, `ms` в `scenarioRouter.ts`

### Telegram UX улучшения
- **Inline-кнопки**: после нажатия Approve/Reject клавиатура убирается (`editMessageReplyMarkup`), в конец сообщения добавляется статус `[ ✅ APPROVED ]` / `[ ❌ REJECTED ]`
- **Dry-run тест**: команда `/test_signal` создает фейковую сделку BTCUSDT (entry: 45000, SL: 44000, TP: 48000, qty: 0.01), кладет в `PendingTradeManager`, шлет в Telegram сообщение с кнопками ✅ Войти (Test) / ❌ Отменить (Test). При нажатии ✅ — бот пишет в консоль `✅ Test trade approved (DRY RUN)` (реальный ордер на Bybit **не** отправляется).
- **Dependency Injection**: добавлен сеттер `setPendingTradeManager()` в `TelegramNotifier` для внедрения `PendingTradeManager`

### Telegram Commands & Security (2026-09-05)
- **Команда `/test_signal`** — создает тестовый сигнал (dry-run) для проверки флоу аппрува. Бот отправляет сообщение с inline-кнопками ✅ Войти (Test) / ❌ Отменить (Test). При нажатии ✅ логируется `✅ Test trade approved (DRY RUN)`, реальный ордер на Bybit **не** отправляется.
- **Команда `/test_live_order`** — сквозной интеграционный тест (E2E) полного цикла исполнения ордера на Bybit Demo. Берет первую пару, получает текущую цену, рассчитывает SL/TP, использует реальный RiskManager для расчёта qty (баланс, tickSize, qtyStep), кладет сделку в PendingTradeManager с флагом `isLiveDemoTest: true`, шлет в Telegram алерт с кнопками ✅ Войти (LIVE DEMO) / ❌ Отменить. При нажатии ✅ сделка проходит через `engine.handleTradeApproval` → `ExecutionEngine` → реальный POST /v5/order/create на Bybit Demo. Полный ответ API (orderId, retCode, retMsg) логируется в консоль. Работает ТОЛЬКО в режиме Demo Trading.
- **Команда `/backup`** — ручной запуск бэкапа БД. Вызывает `BackupService.runManualBackup()`, делает `SELECT * FROM trades`, собирает CSV, сжимает в `.csv.gz` через `zlib.gzipSync`, отправляет как документ в Telegram. Если таблица пуста — отправляется файл только с заголовками колонок. Имя файла в формате `trades_backup_YYYY_MM_DD.csv.gz` (такое же как у авто-бэкапа).
- **Stealth Authorization Middleware** — глобальный middleware в Telegraf, проверяет `ctx.chat?.id.toString()` на строгое совпадение с `TELEGRAM_CHAT_ID` из `.env`. Чужие пользователи получают **глухой игнор** (просто `return`, никаких ответов/ошибок). Меню команд (`setMyCommands`) **не настраивается** — бот невидим для посторонних.
- **Dependency Injection**: добавлен сеттер `setBackupService()` в `TelegramNotifier` для внедрения `BackupService`. Добавлен `setLiveTestDependencies()` для внедрения client, riskManager, executionEngine, pendingTradeManager, engines.

### Backup Service Improvements (2026-09-05)
- **Нет авто-бэкапа при старте** — `BackupService.start()` только ставит `setInterval` на 24 часа. Первый авто-бэкап через 24 часа после запуска.
- **Единая логика имени файла** — `getBackupFilename()` возвращает `trades_backup_YYYY_MM_DD.csv.gz` для авто и ручного бэкапа.
- **Ручной бэкап через основной метод** — `/backup` вызывает `runManualBackup()`, который использует ту же `runBackup()` логику, что и таймер. Никакого дублирования кода.
- **Web Standard sendDocument** — используется нативный `fetch` + `Blob` + `FormData` (Web API), а не Telegraf streams. Это исправляет `socket hang up` в Node.js 26+.

### Database Schema Fix (2026-09-05)
- **id и order_id изменены на VARCHAR(255)** — Были `BIGSERIAL`/`BIGINT`, теперь строковые идентификаторы (например, `BTCUSDT_1788604751264_1` или `TEST_DB_1`). Это позволяет использовать понятные ID сделок вместо автоинкремента.
- Обновлены все интерфейсы (`TradeRecord`, `TradeRow`, `TradeInput`) и методы (`openTrade`, `closeTrade`, `getOpenTrade`, `getRecentClosedTrades`, `getAllOpenTrades`, `reconcileWithTrade`) на `string`.

### Исправление detectOrderBlocks
- **Строгое правило**: перебор свечей **строго по индексам массива** (`breakIdx - 1`), никаких таймстемпов!
- Исправлен критический баг: цикл `for (let i = br.timestamp; i >= 0; i--)` → `for (let i = breakIdx - 1; i >= 0; i--)`

### Performance Optimizations (2026-09-03)

### Macro Context — ультра-быстрая инициализация (~5-10ms)
- **Убрано ВСЁ тяжелое** на макро-свечах (1W/1D): `detectStructureBreaks`, `detectOrderBlocks`, `findSwingPoints`, ликвидные пулы на 1000 свечах
- **Оставлено ТОЛЬКО необходимое** (линейные проходы O(N)):
  - **ATH/ATL** — один проход по массиву (max high / min low)
  - **PWH/PWL** — `weeklyCandles[length-2]` (предпоследняя неделя)
  - **PDH/PDL** — `dailyCandles[length-2]` (предпоследний день)
  - **DO/WO** — `open` последней свечи 1D/1W
  - **FVG** — только на последних **20** дневных свечах (не 1000!)
  - **Нет** Order Blocks, Breakers, Mitigation на макро
- **Логи**: `[SYMBOL] Macro context loaded in 8ms: ATH=245.50, ATL=12.30`

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

---

## 🚀 Локальный запуск и тесты

```bash
# 1. Клонирование и установка
git clone https://github.com/your-repo/crypto-bot-ox.git
cd crypto-bot-ox
npm ci                    # Чистая установка (package-lock.json)

# 2. Настройка окружения
cp .env.example .env
# Отредактируйте .env (nano .env)

# 3. Запуск тестов (обязательно перед запуском!)
npm test                  # 178 тестов: math, smc, patternRecognizer, candleFeed, api, 11 scenarios, router, pendingTradeManager
npm run typecheck         # Строгий TS (no any, strict null checks)

# 4. Локальный запуск (требует .env с TESTNET=true)
npm run build && npm start
# Или для разработки:
npm run dev               # ts-node (если настроено)
```

> ✅ **Все тесты должны быть зелёными** перед деплоем. `npm run typecheck` должен проходить без ошибок.

---

## 🐳 Docker Deploy (2026-09-05)

### Быстрый запуск через Docker Compose
```bash
# 1. Настройте .env
cp .env.example .env
nano .env

# 2. Сборка и запуск
docker compose up -d --build

# 3. Логи
docker compose logs -f

# 4. Остановка
docker compose down
```

### Dockerfile (Multi-stage)
| Стадия | Образ | Действие |
|--------|-------|----------|
| **Builder** | `node:20-alpine` | `npm ci` → `npm run build` |
| **Runner** | `node:20-alpine` | `npm ci --omit=dev` → копирует `dist/` |

- **Итоговый образ**: ~80-100 MB, чистый JS, никаких dev-зависимостей
- **Port**: `EXPOSE 3000` (health-check на `GET /` → `200 OK`)
- **Graceful shutdown**: 30s (`stop_grace_period` в compose)

### docker-compose.yml
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
- **Нет volumes** — бот полностью Stateless
- **Порт 3000** проброшен для health-check
- **Переменные окружения** из `.env` файла

---

## ☁️ Деплой на Render.com

### 1. Подготовка репозитория
```bash
git add .
git commit -m "Deploy: initial setup"
git push origin main
```

### 2. Создание Web Service на Render
1. Зайдите в **Dashboard → New → Web Service**
2. Подключите GitHub-репозиторий
3. Настройки:
   | Поле | Значение |
   |------|----------|
   | **Name** | `crypto-bot-ox` |
   | **Runtime** | `Node` |
   | **Build Command** | `npm ci && npm run build` |
   | **Start Command** | `npm start` |
   | **Instance Type** | `Free` (или `Starter` для production) |
   | **Auto-Deploy** | `Yes` |

### 3. Environment Variables (в Render Dashboard → Environment)
Добавьте **все** переменные из `.env` (кроме `DATA_DIR` — на Render контейнер эфемерный).
- `PORT` — **не задавайте**, Render подставит автоматически (health-check слушает `process.env.PORT`).

### 4. Health Check
- Рендер автоматически пингует `GET /` → ожидает `200 OK`.
- Бот запускает HTTP-сервер на `process.env.PORT` при старте.

### 5. Деплой
Нажмите **Deploy Latest Commit**. Первый деплой займёт 3-5 мин (установка зависимостей + сборка).

---

## 💾 Ежедневные бэкапы базы данных

Бот автоматически создаёт бэкап таблицы `trades` **каждые 24 часа** и присылает его в Telegram:

| Параметр | Значение |
|----------|----------|
| **Расписание** | Каждые 24 часа (первый — через 24 часа после старта) |
| **Источник** | `SELECT * FROM trades` (все сделки за всё время) |
| **Формат** | CSV → GZIP (в памяти, через `zlib.gzipSync`) |
| **Доставка** | Telegram документ `.csv.gz` (файл `trades_backup_YYYY_MM_DD.csv.gz`) |
| **Хранение** | Только в RAM — никаких файлов на диск |

> 💡 Бэкап работает **только если настроен Telegram** (`TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`). При ошибке бэкапа бот пришлёт критичный алерт `⚠️ Ошибка создания бэкапа БД!`.

---

## 🗄️ Управление базой данных (Supabase)

> **Миграции выполняются автоматически** при старте бота (`src/db/database.ts::initialize()`).
> **Ручная настройка таблиц в Supabase НЕ НУЖНА.**

### Схема таблицы `trades`
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

### Схема таблицы `symbol_state`
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

> **Миграции выполняются автоматически** при старте бота (`src/db/database.ts::initialize()`).
> **Ручная настройка таблиц в Supabase НЕ НУЖНА.**

Если нужно сбросить БД — просто удалите таблицы в Supabase Dashboard (SQL Editor: `DROP TABLE trades, symbol_state;`), при следующем старте бот создаст их заново.

---

## ⚙️ Настройка пула подключений PostgreSQL (Supabase)

В `src/db/database.ts` настроен пул подключений для стабильной работы с Supabase:

| Параметр | Значение | Назначение |
|----------|----------|------------|
| `max` | `5` | Достаточно для одного бота, меньше нагрузка на Supabase |
| `idleTimeoutMillis` | `10000` (10 сек) | Пул сам закрывает простаивающие клиенты до разрыва от Supabase |
| `keepAlive` | `true` | TCP keep-alive пакеты предотвращают разрыв `ETIMEDOUT` |
| `keepAliveInitialDelayMillis` | `10000` | Первые keep-alive пакеты через 10 сек |
| `allowExitOnIdle` | `false` | Пул не завершается при отсутствии активных клиентов |
| `connectionTimeoutMillis` | `5000` | Таймаут установки соединения |

> Эти настройки предотвращают ошибки `ETIMEDOUT` и `read ETIMEDOUT` от бездействующих соединений.

---

## ⚠️ Дисклеймер и безопасность

> **ЭТА ПРОГРАММА ТОРГУЕТ РЕАЛЬНЫМИ ДЕНЬГАМИ.**
> - **Всегда начинайте с `TESTNET=true`** и `AUTO_TRADING=false`.
> - Проверяйте логи на `TESTNET` минимум 1-2 недели перед переходом на мейннет.
> - Никогда не коммитьте `.env` в git (он в `.gitignore`).
> - Используйте отдельный Sub-account на Bybit с минимальными правами (Trade + Read).
> - Автор не несёт ответственности за убытки. Торговля фьючерсами сопряжена с высоким риском потери капитала.

---

## 📂 Структура проекта (кратко)

```
crypto-bot-ox/
├── src/
│   ├── index.ts              # Точка входа (bootstrap)
│   ├── api/                  # Bybit REST + WS клиенты
│   ├── bootstrap/            # Health-check, preflight, reconciliation
│   ├── db/                   # PostgreSQL (pg pool, миграции)
│   ├── engine/               # StrategyEngine, ScenarioRouter, 11 сценариев, PendingTradeManager
│   ├── execution/            # ExecutionEngine (Market IOC, circuit breaker)
│   ├── feed/                 # CandleFeed (15m/4H буферы)
│   ├── risk/                 # RiskManager (1:3, qtyStep, drawdown guard)
│   ├── smc/                  # PatternRecognizer (чистая математика SMC)
│   ├── telegram/             # TelegramNotifier (Telegraf Long-Polling)
│   ├── types.ts              # Все интерфейсы (Candle, Zone, Structure, PatternData...)
│   └── utils/                # Logger (winston), precision helpers
├── tests/                    # 178 тестов (Jest + ts-jest)
├── .env.example              # Шаблон конфигурации
├── .gitignore
├── package.json
├── tsconfig.json
└── README.md                 # Этот файл
```

---

## 🤝 Поддержка и развитие

- **Issues** — баги и фич-реквесты в GitHub Issues
- **Логи** — `winston` в консоль (Render Logs) + Telegram уведомления
- **Метрики** — нет встроенных, но можно подключить Prometheus/Grafana через кастомный health-endpoint

---

**Удачной торговли! 📈 Помните: дисциплина важнее стратегии.**