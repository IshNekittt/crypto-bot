# SMC Trading Bot (Bybit V5)

Автономный торговый бот для Bybit Derivatives (Linear Perpetual), торгующий по концепции Smart Money Concepts:

- **4H**: поиск Order Block после слома структуры (BOS/ChoCh — только закрытие **телом** свечи, импульс ≥ 2× среднего тела последних 10 свечей).
- Ожидание касания зоны 4H OB (анти-стик: 30 свечей без касания → пересканирование).
- **15m**: подтверждение Liquidity Sweep + ChoCh, поиск свежего FVG и 15m OB.
- Вход Market-ордером на откате в 15m FVG. SL ставится на 0.1% за экстремум 15m OB, TP строго **1:3 RR**. Стопы делегированы бирже (`tpslMode: Full`), ручных закрытий нет.
- Риск на сделку — процент от баланса USDT (`RISK_PERCENT`); после 3 убыточных сделок подряд риск автоматически режется.
- Circuit breaker: 3 ошибки Rate Limit / Insufficient Margin подряд → пара останавливается на 1 час + алерт в Telegram.

> ⚠️ **Дисклеймер**: торговля криптодеривативами с плечом сопряжена с высоким риском. Бот предоставляется «как есть». Запускайте сначала на testnet (`TESTNET=true`) и используйте только средства, потерю которых можете себе позволить.

---

## Требования

- VPS (Ubuntu 22.04+) со **статичным IP**
- Docker Engine 24+ и Docker Compose v2
- Для разработки без Docker: Node.js ≥ 20

## Быстрый старт на VPS

```bash
git clone <repo-url> smc-bot && cd smc-bot
cp .env.example .env
nano .env            # заполните ключи и параметры (см. ниже)
docker compose up -d --build
docker logs -f smc-bot   # смотреть логи
```

Бот при старте выполняет pre-flight: синхронизацию времени с сервером Bybit, загрузку фильтров инструментов (tickSize / qtyStep / minOrderQty), установку isolated margin и плеча, загрузку истории свечей и подписку на WebSocket.

### Обновление

```bash
git pull
docker compose up -d --build
```

Состояние (SQLite в WAL-режиме) хранится в Docker-volume `bot-data` и переживает пересборку контейнера.

### Бэкап и осмотр данных

```bash
docker cp smc-bot:/app/data/bot-state.db ./backup-$(date +%F).db
```

### Остановка

```bash
docker compose down          # остановить (состояние сохраняется)
docker compose down -v       # остановить И УДАЛИТЬ базу данных
```

---

## Настройка API ключей Bybit (важно!)

1. Создайте ключ: **Bybit → Account → API Management → Create New Key** (тип *System-generated*).
2. Разрешения ключа — **минимально необходимые**:
   - ✅ `Contract` — **Orders**, **Positions**
   - ✅ `Account` — **Read** (нужно для чтения баланса USDT)
   - ❌ `Withdraw` — галочка должна быть **снята** (обязательно!)
   - ❌ Spot / Earn / Transfer — выключены
3. **IP binding**: привяжите ключ строго к статичному IP вашего VPS. Ключ без IP-ограничения — главный вектор взлома.
4. Никогда не храните ключи в git. `.env` уже добавлен в `.gitignore`.

Если бот стартует с ошибкой доступа к балансу/позициям — проверьте права ключа и то, что IP VPS совпадает с указанным в ограничении.

---

## Конфигурация (.env)

| Переменная | Обязательная | По умолчанию | Описание |
|---|---|---|---|
| `BYBIT_API_KEY` | да | — | API ключ |
| `BYBIT_API_SECRET` | да | — | API секрет |
| `TESTNET` | нет | `true` | `false` — только для реальной торговли |
| `SYMBOLS` | да | — | Пары через запятую: `SOLUSDT,BTCUSDT,ETHUSDT` |
| `RISK_PERCENT` | да | — | Риск на сделку, % от баланса (например `2`) |
| `REDUCED_RISK_PERCENT` | нет | `1` | Риск при 3 убытках подряд |
| `LEVERAGE` | нет | `10` | Плечо (влияет только на обеспечение; риск управляется лотностью) |
| `HISTORY_CANDLES` | нет | `200` | Глубина истории по каждому TF (макс. 1000) |
| `DATA_DIR` | нет | `data` | Каталог SQLite-базы внутри контейнера |
| `TELEGRAM_BOT_TOKEN` | нет | — | Токен бота для уведомлений (@BotFather) |
| `TELEGRAM_CHAT_ID` | нет | — | ID чата для уведомлений |
| `LOG_LEVEL` | нет | `info` | `debug` / `info` / `warn` / `error` |

Telegram уведомления: найден сетап 👀, открыт ордер 🚀, закрытие позиции ✅/❌ с PnL, критические ошибки ⚠️.

---

## Разработка

```bash
npm ci                 # установка зависимостей
npm test               # Jest: SMC-математика, precision formatter, risk, execution, API-моки
npm run typecheck      # строгий TS (без any)
npm start              # сборка + запуск (читает .env из текущей папки)
```

Тесты не требуют сети: Bybit API мокается, Telegram — подменой fetch.

### Структура

```
src/
├── api/         # BybitClient (REST) + BybitWebsocket (public/private WS)
├── bootstrap/   # Pre-flight checks + Reconciliation Loop
├── config/      # Загрузка и валидация .env
├── db/          # better-sqlite3 (WAL): состояния стейт-машин и сделки
├── engine/      # StrategyEngine — стейт-машина на символ
├── execution/   # ExecutionEngine + circuit breaker
├── feed/        # CandleFeed: буферы 15m/4h, merge confirmed-свечей
├── risk/        # RiskManager: лотность от риска и SL-дистанции
├── smc/         # Чистая SMC-математика (decimal.js): свинги, BOS/ChoCh, FVG, OB
├── telegram/    # Уведомления (native fetch)
└── utils/       # Precision formatter, winston-логгер
tests/           # Jest-сюиты (в т.ч. обязательные math/smc/api тесты манифеста)
data/            # SQLite (в git игнорируется; в Docker — volume)
```
