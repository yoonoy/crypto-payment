import { config } from './config';
import { pool } from './infra/db';
import { PgClientStore, PgPaymentStore } from './infra/PgStores';
import { EthWalletGateway } from './infra/EthWalletGateway';
import { WebhookNotifier } from './infra/WebhookNotifier';
import { ClientService } from './services/ClientService';
import { PaymentService } from './services/PaymentService';
import { RefundService } from './services/RefundService';
import { BlockchainWatcher } from './workers/BlockchainWatcher';
import { createApp } from './http/server';

async function main(): Promise<void> {
  await pool.query('SELECT 1'); // проверка подключения к БД

  // Composition root: единственное место, где мы выбираем конкретные реализации (принцип D)
  const wallet = new EthWalletGateway(config.rpcUrl, config.mnemonic);
  const notifier = new WebhookNotifier(config.webhookSecret);
  const clientStore = new PgClientStore();
  const paymentStore = new PgPaymentStore();

  const clients = new ClientService(clientStore);
  const payments = new PaymentService(paymentStore, clientStore, wallet, notifier, config.paymentTtlMinutes);
  const refunds = new RefundService(paymentStore, wallet, notifier);
  const watcher = new BlockchainWatcher(paymentStore, wallet, notifier, config.confirmations);

  const app = createApp({
    apiKey: config.apiKey,
    sitePassword: config.sitePassword,
    cookieSecure: config.cookieSecure,
    clients,
    payments,
    refunds,
  });
  const server = app.listen(config.port, () => {
    console.log(`Payment service listening on :${config.port}`);
  });
  watcher.start(config.pollIntervalMs);

  const shutdown = async () => {
    watcher.stop();
    server.close();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
