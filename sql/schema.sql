CREATE TABLE clients (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email       TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  balance_wei NUMERIC(78,0) NOT NULL DEFAULT 0 CHECK (balance_wei >= 0),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Каждый платёж получает свой индекс HD-адреса
CREATE SEQUENCE address_index_seq START 1;

CREATE TABLE payments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id       UUID NOT NULL REFERENCES clients(id),
  method          TEXT NOT NULL CHECK (method IN ('CRYPTO','BALANCE')),
  purpose         TEXT NOT NULL CHECK (purpose IN ('PURCHASE','TOPUP')),
  amount_wei      NUMERIC(78,0) NOT NULL CHECK (amount_wei > 0),
  status          TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  address         TEXT UNIQUE,
  address_index   INT,
  refund_address  TEXT,
  refund_tx_hash  TEXT,
  callback_url    TEXT,
  expires_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_payments_active ON payments (status)
  WHERE status IN ('PENDING','CONFIRMING');

-- Аудит-лог: каждая смена статуса
CREATE TABLE payment_events (
  id          BIGSERIAL PRIMARY KEY,
  payment_id  UUID NOT NULL REFERENCES payments(id),
  from_status TEXT,
  to_status   TEXT NOT NULL,
  details     JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
