# Crypto Payment Service (Sepolia testnet)

Backend-сервис платежей. Другие сервисы вызывают его по REST API.
Принимает крипту (ETH на тестовой сети Sepolia), хранит баланс клиента, делает повторные списания и возвраты.

## Как это работает

| Что нужно по заданию | Как сделано |
|---|---|
| Принять запрос от другого сервиса | REST API + заголовок `x-api-key` |
| Взять деньги у клиента | Для каждого платежа выдаётся **уникальный адрес** (HD-кошелёк). Клиент отправляет на него ETH |
| Запросить данные клиента | `POST /clients`, `GET /clients`, `GET /clients/:id` |
| Повторный платёж из кошелька | Клиент **пополняет баланс** (`/topups`). Потом `POST /payments` с `method: "BALANCE"` списывает с баланса |
| Возврат | `POST /payments/:id/refund` |
| Вернуть ответ | JSON-ответ + webhook (подпись HMAC) при смене статуса |

Почему не "снять деньги с чужого кошелька": в блокчейне так нельзя. Клиент всегда сам отправляет деньги. Поэтому повторные платежи сделаны через внутренний баланс.

## Структура (Hexagonal + SOLID)

```
src/
  domain/types.ts            статусы платежа и разрешённые переходы (State-диаграмма)
  domain/ports.ts            интерфейсы: AddressGenerator, BalanceReader, FundsSender, Notifier, Stores
  services/                  бизнес-логика: PaymentService, RefundService, ClientService
  workers/BlockchainWatcher  следит за блокчейном, меняет статусы
  infra/                     PostgreSQL, Ethereum (ethers.js), Webhook
  http/server.ts             REST API + API для сайта (/web)
  http/session.ts            сессии и cookie для входа на сайт
public/index.html            сайт (интерфейс для демо)
  index.ts                   сборка всех частей (composition root)
sql/schema.sql               таблицы
```


## Сайт

После запуска открой **http://localhost:3000** и войди с паролем
Дальше проходи сценарий кнопками: пополнение, оплата с баланса, оплата криптой, возврат.

**API-ключ в браузер не попадает.** Как это устроено:
- Сайт ходит на `/web/...`. Доступ по паролю, сессия хранится в httpOnly cookie (JavaScript её не видит).
- Другие сервисы ходят на обычные пути (`/payments` и т.д.) с заголовком `x-api-key`.
- Оба набора путей используют одну и ту же бизнес-логику.
- Пароль можно перебирать не чаще 10 раз за 15 минут с одного IP.
- На сервере с HTTPS поставь `COOKIE_SECURE=true`.

Файл сайта: `public/index.html` (без библиотек, чистый HTML/CSS/JS).

## Проверка сценария (curl)

```bash
KEY=your-api-key
H='content-type: application/json'

# 1. Создать клиента
curl -X POST localhost:3000/clients -H "x-api-key: $KEY" -H "$H" \
  -d '{"email":"a@example.com","name":"Aiganysh"}'
# -> запомни id клиента

# 2. Пополнение баланса: получим адрес
curl -X POST localhost:3000/clients/CLIENT_ID/topups -H "x-api-key: $KEY" -H "$H" \
  -d '{"amount":"0.01","idempotency_key":"topup-1"}'
# -> в ответе "address"

# 3. Отправь 0.01 тестового ETH на этот адрес (из MetaMask, сеть Sepolia).
#    Тестовые ETH бесплатно: Google Cloud Web3 faucet или Alchemy Sepolia faucet.

# 4. Следи за статусом: PENDING -> CONFIRMING -> COMPLETED (баланс начислен)
curl localhost:3000/payments/PAYMENT_ID -H "x-api-key: $KEY"
curl localhost:3000/clients/CLIENT_ID   -H "x-api-key: $KEY"

# 5. Повторный платёж с баланса (мгновенно)
curl -X POST localhost:3000/payments -H "x-api-key: $KEY" -H "$H" \
  -d '{"client_id":"CLIENT_ID","amount":"0.002","method":"BALANCE","idempotency_key":"order-1"}'

# 6. Возврат на баланс
curl -X POST localhost:3000/payments/PAYMENT_ID/refund -H "x-api-key: $KEY" -H "$H" -d '{}'

# 7. Прямая оплата криптой и возврат в блокчейн
curl -X POST localhost:3000/payments -H "x-api-key: $KEY" -H "$H" \
  -d '{"client_id":"CLIENT_ID","amount":"0.005","method":"CRYPTO","idempotency_key":"order-2"}'
# после COMPLETED:
curl -X POST localhost:3000/payments/PAYMENT_ID/refund -H "x-api-key: $KEY" -H "$H" \
  -d '{"refund_address":"0xYourWallet"}'
```

## API

| Метод | Путь | Что делает |
|---|---|---|
| POST | /clients | создать клиента |
| GET | /clients | список клиентов |
| GET | /clients/:id | данные клиента и баланс |
| POST | /clients/:id/topups | пополнение баланса (выдаёт адрес) |
| POST | /payments | `method`: `CRYPTO` или `BALANCE` |
| GET | /payments/:id | статус платежа |
| POST | /payments/:id/refund | возврат |
| GET | /health | проверка (без ключа) |

Суммы передаются строкой в ETH: `"0.01"`. Поле `idempotency_key` обязательно: повторный запрос с тем же ключом вернёт тот же платёж, деньги не спишутся дважды.

## Статусы

```
PENDING -> CONFIRMING -> COMPLETED -> REFUND_PENDING -> REFUNDED
   |            |
 EXPIRED      FAILED
```
Отличия от прежней диаграммы: нет статуса CREATED (платёж сразу PENDING). Если отправка возврата не удалась, статус возвращается в COMPLETED. Для оплаты с баланса переход COMPLETED -> REFUNDED прямой.
Обнови State-диаграмму под это.

## Ограничения (честно)

- Только ETH на Sepolia. Другие сети и токены (USDT) = новый класс-адаптер.
- Деньги остаются на адресах платежей. Автоматического вывода на общий кошелёк (sweep) нет. Возврат работает именно потому, что деньги ещё на адресе.
- Возврат = весь баланс адреса минус комиссия сети. Частичных возвратов нет. Пополнения (TOPUP) вернуть нельзя.
- Мнемоника в `.env` подходит для учебного проекта. В production: KMS/Vault, а лучше HSM.
- Webhook: ретраи в памяти. В production: outbox-таблица + очередь.
- Не проверяется, что `callback_url` безопасен (защита от SSRF). Для production добавь белый список доменов.
- Кошелёк после EXPIRED всё равно может получить деньги: такие случаи нужно разбирать вручную.

## Что сделать для production

1. Ключи в AWS KMS / HashiCorp Vault
2. Свой ключ на каждого мерчанта и rate limit
3. Очередь (SQS/RabbitMQ) для webhook и возвратов
4. Мониторинг (CloudWatch/Grafana) и алерты
5. Тесты (Jest) и CI
6. Аудит безопасности перед реальными деньгами
