export type PaymentStatus =
  | 'PENDING'
  | 'CONFIRMING'
  | 'COMPLETED'
  | 'EXPIRED'
  | 'FAILED'
  | 'REFUND_PENDING'
  | 'REFUNDED';

export type PaymentMethod = 'CRYPTO' | 'BALANCE';
export type PaymentPurpose = 'PURCHASE' | 'TOPUP';

export interface Client {
  id: string;
  email: string;
  name: string;
  balanceWei: bigint;
}

export interface Payment {
  id: string;
  clientId: string;
  method: PaymentMethod;
  purpose: PaymentPurpose;
  amountWei: bigint;
  status: PaymentStatus;
  idempotencyKey: string;
  address: string | null;
  addressIndex: number | null;
  refundAddress: string | null;
  refundTxHash: string | null;
  callbackUrl: string | null;
  expiresAt: Date | null;
  createdAt: Date;
}

// Это State-диаграмма в виде кода: какие переходы разрешены
const ALLOWED: Record<PaymentStatus, PaymentStatus[]> = {
  PENDING: ['CONFIRMING', 'EXPIRED'],
  CONFIRMING: ['COMPLETED', 'FAILED'],
  COMPLETED: ['REFUND_PENDING', 'REFUNDED'],
  REFUND_PENDING: ['REFUNDED', 'COMPLETED'],
  EXPIRED: [],
  FAILED: [],
  REFUNDED: [],
};

export function canTransition(from: PaymentStatus, to: PaymentStatus): boolean {
  return ALLOWED[from].includes(to);
}
