import { createHmac } from 'node:crypto';
import { paymentDto } from '../dto';
import { Notifier } from '../domain/ports';
import { Payment } from '../domain/types';

/**
 * Отправляет webhook другому сервису. Тело подписано HMAC-SHA256 (заголовок x-signature).
 * Ретраи в памяти. В production лучше outbox-таблица + очередь.
 */
export class WebhookNotifier implements Notifier {
  constructor(private readonly secret: string) {}

  paymentChanged(p: Payment): void {
    if (!p.callbackUrl) return;
    void this.deliver(p);
  }

  private async deliver(p: Payment): Promise<void> {
    const body = JSON.stringify({
      event: `payment.${p.status.toLowerCase()}`,
      payment: paymentDto(p),
    });
    const signature = createHmac('sha256', this.secret).update(body).digest('hex');

    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        const res = await fetch(p.callbackUrl!, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-signature': signature },
          body,
          signal: AbortSignal.timeout(5000),
        });
        if (res.ok) return;
      } catch {
        // сеть недоступна: пробуем ещё раз
      }
      await new Promise((r) => setTimeout(r, 2 ** attempt * 1000));
    }
    console.error(`Webhook failed for payment ${p.id}`);
  }
}
