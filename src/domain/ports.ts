// Порты (интерфейсы). Бизнес-логика зависит только от них (принципы I и D из SOLID).
import { Client, Payment, PaymentPurpose, PaymentStatus } from './types';

export interface AddressGenerator {
  deriveAddress(index: number): string;
}

export interface BalanceReader {
  getBalance(address: string): Promise<bigint>;
  /** Баланс адреса с учётом N подтверждений */
  getConfirmedBalance(address: string, confirmations: number): Promise<bigint>;
}

export interface FundsSender {
  /** Отправить всё, что есть на адресе, на адрес `to` (минус комиссия сети) */
  sweep(index: number, to: string): Promise<{ txHash: string; sentWei: bigint }>;
}

export interface Notifier {
  paymentChanged(payment: Payment): void;
}

export interface ClientStore {
  create(email: string, name: string): Promise<Client>;
  findById(id: string): Promise<Client | null>;
  list(): Promise<Client[]>;
}

export interface NewCryptoPayment {
  clientId: string;
  purpose: PaymentPurpose;
  amountWei: bigint;
  idempotencyKey: string;
  address: string;
  addressIndex: number;
  callbackUrl?: string;
  expiresAt: Date;
}

export interface NewBalancePayment {
  clientId: string;
  amountWei: bigint;
  idempotencyKey: string;
  callbackUrl?: string;
}

export interface TransitionOpts {
  refundAddress?: string;
  refundTxHash?: string;
  /** Начислить эту сумму на баланс клиента в той же транзакции БД */
  creditClientWei?: bigint;
  details?: Record<string, unknown>;
}

export interface PaymentStore {
  findById(id: string): Promise<Payment | null>;
  findByIdempotencyKey(key: string): Promise<Payment | null>;
  nextAddressIndex(): Promise<number>;
  insertCrypto(p: NewCryptoPayment): Promise<{ payment: Payment; created: boolean }>;
  /** Атомарно: проверить баланс, списать, создать платёж COMPLETED */
  insertFromBalance(p: NewBalancePayment): Promise<{ payment: Payment; created: boolean }>;
  /** Атомарная смена статуса. Вернёт null, если текущий статус уже не `from`. */
  transition(
    id: string,
    from: PaymentStatus,
    to: PaymentStatus,
    opts?: TransitionOpts,
  ): Promise<Payment | null>;
  listActive(): Promise<Payment[]>;
}
