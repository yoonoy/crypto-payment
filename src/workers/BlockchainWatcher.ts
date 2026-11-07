import { BalanceReader, Notifier, PaymentStore, TransitionOpts } from '../domain/ports';
import { Payment, PaymentStatus } from '../domain/types';

/**
 * Фоновый воркер. Каждые N секунд проверяет баланс адресов активных платежей.
 *   PENDING    -> CONFIRMING  когда на адресе уже есть нужная сумма
 *   CONFIRMING -> COMPLETED   когда сумма есть и после N подтверждений
 *   PENDING    -> EXPIRED     если время вышло
 */
export class BlockchainWatcher {
  private timer?: NodeJS.Timeout;
  private busy = false;

  constructor(
    private readonly payments: PaymentStore,
    private readonly reader: BalanceReader,
    private readonly notifier: Notifier,
    private readonly confirmations: number,
  ) {}

  start(intervalMs: number): void {
    this.timer = setInterval(() => this.tick().catch(console.error), intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      for (const p of await this.payments.listActive()) {
        try {
          await this.check(p);
        } catch (e) {
          console.error(`Watcher error for payment ${p.id}:`, e);
        }
      }
    } finally {
      this.busy = false;
    }
  }

  private async check(p: Payment): Promise<void> {
    if (!p.address) return;

    if (p.status === 'PENDING') {
      const balance = await this.reader.getBalance(p.address);
      if (balance >= p.amountWei) {
        return this.move(p, 'CONFIRMING', { details: { balance_wei: balance.toString() } });
      }
      if (p.expiresAt && p.expiresAt.getTime() < Date.now()) {
        return this.move(p, 'EXPIRED');
      }
      return;
    }

    if (p.status === 'CONFIRMING') {
      const confirmed = await this.reader.getConfirmedBalance(p.address, this.confirmations);
      if (confirmed >= p.amountWei) {
        return this.move(p, 'COMPLETED', {
          // Пополнение: сразу начисляем сумму на баланс клиента (в той же транзакции БД)
          creditClientWei: p.purpose === 'TOPUP' ? p.amountWei : undefined,
        });
      }
      const now = await this.reader.getBalance(p.address);
      if (now < p.amountWei) {
        return this.move(p, 'FAILED', { details: { reason: 'funds disappeared (reorg?)' } });
      }
    }
  }

  private async move(p: Payment, to: PaymentStatus, opts: TransitionOpts = {}): Promise<void> {
    const updated = await this.payments.transition(p.id, p.status, to, opts);
    if (updated) this.notifier.paymentChanged(updated);
  }
}
