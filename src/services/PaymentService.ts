import { AppError } from '../errors';
import { AddressGenerator, ClientStore, Notifier, PaymentStore } from '../domain/ports';
import { Payment, PaymentPurpose } from '../domain/types';

interface CreateCryptoInput {
  clientId: string;
  amountWei: bigint;
  purpose: PaymentPurpose;
  idempotencyKey: string;
  callbackUrl?: string;
}

interface CreateBalanceInput {
  clientId: string;
  amountWei: bigint;
  idempotencyKey: string;
  callbackUrl?: string;
}

/** Создание и чтение платежей. Возвраты вынесены в RefundService (принцип S). */
export class PaymentService {
  constructor(
    private readonly payments: PaymentStore,
    private readonly clients: ClientStore,
    private readonly addresses: AddressGenerator,
    private readonly notifier: Notifier,
    private readonly ttlMinutes: number,
  ) {}

  /** Платёж криптой: выдаём уникальный адрес, клиент отправляет на него деньги */
  async createCrypto(input: CreateCryptoInput): Promise<Payment> {
    await this.requireClient(input.clientId);

    const existing = await this.payments.findByIdempotencyKey(input.idempotencyKey);
    if (existing) return this.sameOrConflict(existing, input.clientId, input.amountWei);

    const addressIndex = await this.payments.nextAddressIndex();
    const address = this.addresses.deriveAddress(addressIndex);
    const expiresAt = new Date(Date.now() + this.ttlMinutes * 60_000);

    const { payment, created } = await this.payments.insertCrypto({
      ...input,
      address,
      addressIndex,
      expiresAt,
    });
    if (!created) return this.sameOrConflict(payment, input.clientId, input.amountWei);
    return payment;
  }

  /** Повторный платёж: списываем с внутреннего баланса клиента */
  async createFromBalance(input: CreateBalanceInput): Promise<Payment> {
    await this.requireClient(input.clientId);

    const existing = await this.payments.findByIdempotencyKey(input.idempotencyKey);
    if (existing) return this.sameOrConflict(existing, input.clientId, input.amountWei);

    const { payment, created } = await this.payments.insertFromBalance(input);
    if (!created) return this.sameOrConflict(payment, input.clientId, input.amountWei);

    this.notifier.paymentChanged(payment);
    return payment;
  }

  async get(id: string): Promise<Payment> {
    const p = await this.payments.findById(id);
    if (!p) throw new AppError(404, 'PAYMENT_NOT_FOUND', 'payment not found');
    return p;
  }

  private async requireClient(id: string): Promise<void> {
    if (!(await this.clients.findById(id))) {
      throw new AppError(404, 'CLIENT_NOT_FOUND', 'client not found');
    }
  }

  // Тот же idempotency_key с другими данными: это ошибка клиента
  private sameOrConflict(existing: Payment, clientId: string, amountWei: bigint): Payment {
    if (existing.clientId !== clientId || existing.amountWei !== amountWei) {
      throw new AppError(
        409,
        'IDEMPOTENCY_CONFLICT',
        'idempotency_key was already used with different parameters',
      );
    }
    return existing;
  }
}
