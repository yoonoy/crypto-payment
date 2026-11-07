import { formatEther } from 'ethers';
import { Client, Payment } from './domain/types';

export function paymentDto(p: Payment) {
  return {
    id: p.id,
    client_id: p.clientId,
    method: p.method,
    purpose: p.purpose,
    amount: formatEther(p.amountWei),
    currency: 'ETH',
    status: p.status,
    address: p.address,
    expires_at: p.expiresAt,
    refund_address: p.refundAddress,
    refund_tx_hash: p.refundTxHash,
    created_at: p.createdAt,
  };
}

export function clientDto(c: Client) {
  return {
    id: c.id,
    email: c.email,
    name: c.name,
    balance: formatEther(c.balanceWei),
    currency: 'ETH',
  };
}
