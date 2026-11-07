import { AppError } from '../errors';
import {
  ClientStore,
  NewBalancePayment,
  NewCryptoPayment,
  PaymentStore,
  TransitionOpts,
} from '../domain/ports';
import { canTransition, Client, Payment, PaymentStatus } from '../domain/types';
import { pool, withTx } from './db';

function toPayment(r: any): Payment {
  return {
    id: r.id,
    clientId: r.client_id,
    method: r.method,
    purpose: r.purpose,
    amountWei: BigInt(r.amount_wei),
    status: r.status,
    idempotencyKey: r.idempotency_key,
    address: r.address,
    addressIndex: r.address_index,
    refundAddress: r.refund_address,
    refundTxHash: r.refund_tx_hash,
    callbackUrl: r.callback_url,
    expiresAt: r.expires_at,
    createdAt: r.created_at,
  };
}

function toClient(r: any): Client {
  return { id: r.id, email: r.email, name: r.name, balanceWei: BigInt(r.balance_wei) };
}

export class PgClientStore implements ClientStore {
  async create(email: string, name: string): Promise<Client> {
    try {
      const r = await pool.query('INSERT INTO clients (email, name) VALUES ($1, $2) RETURNING *', [
        email,
        name,
      ]);
      return toClient(r.rows[0]);
    } catch (e: any) {
      if (e.code === '23505') {
        throw new AppError(409, 'EMAIL_EXISTS', 'client with this email already exists');
      }
      throw e;
    }
  }

  async findById(id: string): Promise<Client | null> {
    const r = await pool.query('SELECT * FROM clients WHERE id = $1', [id]);
    return r.rows[0] ? toClient(r.rows[0]) : null;
  }

  async list(): Promise<Client[]> {
    const r = await pool.query('SELECT * FROM clients ORDER BY created_at DESC, id');
    return r.rows.map(toClient);
  }
}

export class PgPaymentStore implements PaymentStore {
  async findById(id: string): Promise<Payment | null> {
    const r = await pool.query('SELECT * FROM payments WHERE id = $1', [id]);
    return r.rows[0] ? toPayment(r.rows[0]) : null;
  }

  async findByIdempotencyKey(key: string): Promise<Payment | null> {
    const r = await pool.query('SELECT * FROM payments WHERE idempotency_key = $1', [key]);
    return r.rows[0] ? toPayment(r.rows[0]) : null;
  }

  async nextAddressIndex(): Promise<number> {
    const r = await pool.query("SELECT nextval('address_index_seq') AS i");
    return Number(r.rows[0].i);
  }

  async insertCrypto(p: NewCryptoPayment): Promise<{ payment: Payment; created: boolean }> {
    return withTx(async (c) => {
      const r = await c.query(
        `INSERT INTO payments
           (client_id, method, purpose, amount_wei, status, idempotency_key,
            address, address_index, callback_url, expires_at)
         VALUES ($1, 'CRYPTO', $2, $3::numeric, 'PENDING', $4, $5, $6, $7, $8)
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING *`,
        [
          p.clientId,
          p.purpose,
          p.amountWei.toString(),
          p.idempotencyKey,
          p.address,
          p.addressIndex,
          p.callbackUrl ?? null,
          p.expiresAt,
        ],
      );
      if (!r.rows[0]) {
        const e = await c.query('SELECT * FROM payments WHERE idempotency_key = $1', [
          p.idempotencyKey,
        ]);
        return { payment: toPayment(e.rows[0]), created: false };
      }
      await c.query('INSERT INTO payment_events (payment_id, to_status) VALUES ($1, $2)', [
        r.rows[0].id,
        'PENDING',
      ]);
      return { payment: toPayment(r.rows[0]), created: true };
    });
  }

  async insertFromBalance(p: NewBalancePayment): Promise<{ payment: Payment; created: boolean }> {
    return withTx(async (c) => {
      // Блокируем строку клиента: два списания одновременно не пройдут
      const cl = await c.query('SELECT balance_wei FROM clients WHERE id = $1 FOR UPDATE', [
        p.clientId,
      ]);
      if (!cl.rows[0]) throw new AppError(404, 'CLIENT_NOT_FOUND', 'client not found');

      const r = await c.query(
        `INSERT INTO payments
           (client_id, method, purpose, amount_wei, status, idempotency_key, callback_url)
         VALUES ($1, 'BALANCE', 'PURCHASE', $2::numeric, 'COMPLETED', $3, $4)
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING *`,
        [p.clientId, p.amountWei.toString(), p.idempotencyKey, p.callbackUrl ?? null],
      );
      if (!r.rows[0]) {
        const e = await c.query('SELECT * FROM payments WHERE idempotency_key = $1', [
          p.idempotencyKey,
        ]);
        return { payment: toPayment(e.rows[0]), created: false };
      }

      // Если денег не хватает, исключение откатит и вставку платежа
      if (BigInt(cl.rows[0].balance_wei) < p.amountWei) {
        throw new AppError(402, 'INSUFFICIENT_FUNDS', 'not enough balance');
      }
      await c.query('UPDATE clients SET balance_wei = balance_wei - $2::numeric WHERE id = $1', [
        p.clientId,
        p.amountWei.toString(),
      ]);
      await c.query('INSERT INTO payment_events (payment_id, to_status) VALUES ($1, $2)', [
        r.rows[0].id,
        'COMPLETED',
      ]);
      return { payment: toPayment(r.rows[0]), created: true };
    });
  }

  async transition(
    id: string,
    from: PaymentStatus,
    to: PaymentStatus,
    opts: TransitionOpts = {},
  ): Promise<Payment | null> {
    if (!canTransition(from, to)) {
      throw new Error(`Illegal status transition ${from} -> ${to}`);
    }
    return withTx(async (c) => {
      const r = await c.query(
        `UPDATE payments
            SET status = $3,
                updated_at = now(),
                refund_address = COALESCE($4, refund_address),
                refund_tx_hash = COALESCE($5, refund_tx_hash)
          WHERE id = $1 AND status = $2
          RETURNING *`,
        [id, from, to, opts.refundAddress ?? null, opts.refundTxHash ?? null],
      );
      if (!r.rows[0]) return null; // кто-то другой уже поменял статус

      if (opts.creditClientWei) {
        await c.query('UPDATE clients SET balance_wei = balance_wei + $2::numeric WHERE id = $1', [
          r.rows[0].client_id,
          opts.creditClientWei.toString(),
        ]);
      }
      await c.query(
        'INSERT INTO payment_events (payment_id, from_status, to_status, details) VALUES ($1, $2, $3, $4)',
        [id, from, to, opts.details ? JSON.stringify(opts.details) : null],
      );
      return toPayment(r.rows[0]);
    });
  }

  async listActive(): Promise<Payment[]> {
    const r = await pool.query(
      "SELECT * FROM payments WHERE status IN ('PENDING','CONFIRMING') ORDER BY created_at LIMIT 500",
    );
    return r.rows.map(toPayment);
  }
}
