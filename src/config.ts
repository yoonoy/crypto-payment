function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env variable: ${name}`);
  return v;
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: req('DATABASE_URL'),
  rpcUrl: req('RPC_URL'),
  mnemonic: req('WALLET_MNEMONIC'),
  apiKey: req('API_KEY'),
  sitePassword: req('SITE_PASSWORD'),
  cookieSecure: process.env.COOKIE_SECURE === 'true',
  webhookSecret: req('WEBHOOK_SECRET'),
  confirmations: Number(process.env.CONFIRMATIONS ?? 3),
  paymentTtlMinutes: Number(process.env.PAYMENT_TTL_MINUTES ?? 30),
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS ?? 15000),
};
