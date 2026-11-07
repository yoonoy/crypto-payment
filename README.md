# Crypto Payment Service (Sepolia testnet)

Backend payment service. Other services interact with it through a REST API.
It accepts ETH on the Sepolia test network, tracks client balances, and supports repeat payments and refunds.

## How It Works

| Requirement | Implementation |
|---|---|
| Accept requests from other services | REST API with the `x-api-key` header |
| Collect money from a client | Each payment gets a **unique address** from an HD wallet. The client sends ETH to that address. |
| Retrieve client data | `POST /clients`, `GET /clients`, `GET /clients/:id` |
| Make repeat payments | The client **tops up their balance** (`/topups`). Then `POST /payments` with `method: "BALANCE"` deducts funds from that balance. |
| Issue a refund | `POST /payments/:id/refund` |
| Return payment status updates | JSON responses and an HMAC-signed webhook when a status changes |

Why not "withdraw money from someone else's wallet"? That is not possible on a blockchain. The client always sends the funds. Repeat payments are therefore made using an internal balance.

## Structure (Hexagonal Architecture + SOLID)

```
src/
  domain/types.ts            payment statuses and allowed transitions (state diagram)
  domain/ports.ts            interfaces: AddressGenerator, BalanceReader, FundsSender, Notifier, Stores
  services/                  business logic: PaymentService, RefundService, ClientService
  workers/BlockchainWatcher  watches the blockchain and updates payment statuses
  infra/                     PostgreSQL, Ethereum (ethers.js), webhooks
  http/server.ts             REST API and website API (/web)
  http/session.ts            website login sessions and cookies
public/index.html            demo website
  index.ts                   assembles all components (composition root)
sql/schema.sql               database tables
```


## Website

After starting the service, open **http://localhost:3000** and sign in with the site password.
Use the buttons to try the workflow: top up, pay from the balance, pay with crypto, and issue a refund.

**The API key is never sent to the browser.** Here is how it works:
- The website calls `/web/...`. Access requires a password, and the session is stored in an HttpOnly cookie that JavaScript cannot read.
- Other services call the regular endpoints (`/payments`, etc.) with the `x-api-key` header.
- Both sets of endpoints use the same business logic.
- Login attempts are limited to 10 per 15 minutes per IP address.
- Set `COOKIE_SECURE=true` when hosting the site over HTTPS.

Website files: `public/index.html`, `public/styles.css`, and `public/app.js` (plain HTML, CSS, and JavaScript; no libraries).

## Test the Workflow (curl)

```bash
KEY=your-api-key
H='content-type: application/json'

# 1. Create a client
curl -X POST localhost:3000/clients -H "x-api-key: $KEY" -H "$H" \
  -d '{"email":"a@example.com","name":"Aiganysh"}'
# -> note the client ID

# 2. Top up the balance: get a deposit address
curl -X POST localhost:3000/clients/CLIENT_ID/topups -H "x-api-key: $KEY" -H "$H" \
  -d '{"amount":"0.01","idempotency_key":"topup-1"}'
# -> the response contains "address"

# 3. Send 0.01 test ETH to this address from MetaMask on the Sepolia network.
#    Get test ETH for free from the Google Cloud Web3 faucet or Alchemy Sepolia faucet.

# 4. Check the status: PENDING -> CONFIRMING -> COMPLETED (balance credited)
curl localhost:3000/payments/PAYMENT_ID -H "x-api-key: $KEY"
curl localhost:3000/clients/CLIENT_ID   -H "x-api-key: $KEY"

# 5. Make a repeat payment from the balance (immediate)
curl -X POST localhost:3000/payments -H "x-api-key: $KEY" -H "$H" \
  -d '{"client_id":"CLIENT_ID","amount":"0.002","method":"BALANCE","idempotency_key":"order-1"}'

# 6. Refund to the balance
curl -X POST localhost:3000/payments/PAYMENT_ID/refund -H "x-api-key: $KEY" -H "$H" -d '{}'

# 7. Pay directly with crypto and issue a blockchain refund
curl -X POST localhost:3000/payments -H "x-api-key: $KEY" -H "$H" \
  -d '{"client_id":"CLIENT_ID","amount":"0.005","method":"CRYPTO","idempotency_key":"order-2"}'
# after the status becomes COMPLETED:
curl -X POST localhost:3000/payments/PAYMENT_ID/refund -H "x-api-key: $KEY" -H "$H" \
  -d '{"refund_address":"0xYourWallet"}'
```

## API

| Method | Path | Description |
|---|---|---|
| POST | /clients | Create a client |
| GET | /clients | List clients |
| GET | /clients/:id | Get client details and balance |
| POST | /clients/:id/topups | Top up the balance (returns a deposit address) |
| POST | /payments | Create a payment; `method` is `CRYPTO` or `BALANCE` |
| GET | /payments/:id | Get payment status |
| POST | /payments/:id/refund | Refund a payment |
| GET | /health | Health check (no key required) |

Amounts are passed as strings in ETH, for example `"0.01"`. The `idempotency_key` field is required: repeating a request with the same key returns the same payment and prevents duplicate charges.

## Statuses

```
PENDING -> CONFIRMING -> COMPLETED -> REFUND_PENDING -> REFUNDED
   |            |
 EXPIRED      FAILED
```
There is no `CREATED` status; a payment starts as `PENDING`. If sending a refund fails, the status returns to `COMPLETED`. For balance payments, the transition from `COMPLETED` to `REFUNDED` is direct.

## Limitations

- Only ETH on Sepolia is supported. Other networks and tokens (such as USDT) require a new adapter.
- Funds remain at the payment addresses. There is no automatic sweep to a central wallet. Refunds work because the funds are still at the address.
- A refund sends the full address balance minus the network fee. Partial refunds are not supported. Top-ups (`TOPUP`) cannot be refunded.
- Storing a mnemonic in `.env` is suitable only for a learning project. For production, use KMS or Vault—preferably an HSM.
- Webhook retries are held in memory. For production, use an outbox table and a queue.
- The service does not check whether `callback_url` is safe (SSRF protection). For production, add a domain allowlist.
- A wallet can still receive funds after a payment expires (`EXPIRED`); these cases must be handled manually.

## Production Recommendations

1. Store keys in AWS KMS or HashiCorp Vault.
2. Use a separate key for each merchant and add rate limiting.
3. Use a queue (SQS/RabbitMQ) for webhooks and refunds.
4. Add monitoring (CloudWatch/Grafana) and alerts.
5. Add tests (Jest) and CI.
6. Conduct a security audit before handling real funds.
