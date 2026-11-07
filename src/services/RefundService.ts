import { isAddress } from 'ethers';
import { AppError } from '../errors';
import { FundsSender, Notifier, PaymentStore } from '../domain/ports';
import { Payment } from '../domain/types';

export class RefundService {
  constructor(
    private readonly payments: PaymentStore,
    private readonly funds: FundsSender,
    private readonly notifier: Notifier,
  ) {}

  async refund(paymentId: string, refundAddress?: string): Promise<Payment> {
    const p = await this.payments.findById(paymentId);
    if (!p) throw new AppError(404, 'PAYMENT_NOT_FOUND', 'payment not found');
    if (p.purpose !== 'PURCHASE') {
      throw new AppError(400, 'REFUND_NOT_SUPPORTED', 'top-ups cannot be refunded');
    }
    if (p.status === 'REFUNDED') return p; // повторный вызов безопасен
    if (p.status !== 'COMPLETED') {
      throw new AppError(409, 'INVALID_STATUS', `cannot refund payment in status ${p.status}`);
    }

    // 1) Оплата с баланса: просто возвращаем деньги на баланс (атомарно)
    if (p.method === 'BALANCE') {
      const done = await this.payments.transition(p.id, 'COMPLETED', 'REFUNDED', {
        creditClientWei: p.amountWei,
        details: { type: 'balance_refund' },
      });
      if (!done) throw new AppError(409, 'CONFLICT', 'payment status changed, try again');
      this.notifier.paymentChanged(done);
      return done;
    }

    // 2) Оплата криптой: отправляем деньги обратно в блокчейне
    if (!refundAddress || !isAddress(refundAddress)) {
      throw new AppError(400, 'INVALID_REFUND_ADDRESS', 'refund_address must be a valid ETH address');
    }
    // Этот переход атомарный: два параллельных возврата не пройдут
    const pending = await this.payments.transition(p.id, 'COMPLETED', 'REFUND_PENDING', {
      refundAddress,
    });
    if (!pending) throw new AppError(409, 'CONFLICT', 'payment status changed, try again');

    try {
      const { txHash, sentWei } = await this.funds.sweep(p.addressIndex!, refundAddress);
      const done = await this.payments.transition(p.id, 'REFUND_PENDING', 'REFUNDED', {
        refundTxHash: txHash,
        details: { sent_wei: sentWei.toString() },
      });
      this.notifier.paymentChanged(done!);
      return done!;
    } catch (e) {
      await this.payments.transition(p.id, 'REFUND_PENDING', 'COMPLETED', {
        details: { refund_error: String(e) },
      });
      throw new AppError(502, 'REFUND_FAILED', 'could not send refund transaction');
    }
  }
}
