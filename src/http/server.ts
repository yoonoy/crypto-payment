import path from 'node:path';
import express, { NextFunction, Request, RequestHandler, Response } from 'express';
import { parseEther } from 'ethers';
import { AppError } from '../errors';
import { clientDto, paymentDto } from '../dto';
import { ClientService } from '../services/ClientService';
import { PaymentService } from '../services/PaymentService';
import { RefundService } from '../services/RefundService';
import { readCookie, safeEqual, SessionStore, SESSION_TTL_SECONDS } from './session';

interface Deps {
  apiKey: string;
  sitePassword: string;
  cookieSecure: boolean;
  clients: ClientService;
  payments: PaymentService;
  refunds: RefundService;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function bad(code: string, message: string): never {
  throw new AppError(400, code, message);
}

function uuid(v: string): string {
  if (!UUID.test(v)) bad('INVALID_ID', 'id must be a UUID');
  return v;
}

function text(v: unknown, name: string, max = 200): string {
  if (typeof v !== 'string' || !v.trim() || v.length > max) {
    bad('INVALID_' + name.toUpperCase(), `${name} is required (string, max ${max} chars)`);
  }
  return v.trim();
}

function amount(v: unknown): bigint {
  if (typeof v !== 'string' || !/^\d+(\.\d{1,18})?$/.test(v)) {
    bad('INVALID_AMOUNT', 'amount must be a string like "0.01"');
  }
  const wei = parseEther(v);
  if (wei <= 0n) bad('INVALID_AMOUNT', 'amount must be greater than 0');
  return wei;
}

function optionalUrl(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  try {
    if (typeof v !== 'string') throw new Error();
    const u = new URL(v);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error();
    return v;
  } catch {
    return bad('INVALID_CALLBACK_URL', 'callback_url must be a valid http(s) URL');
  }
}

const wrap =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next);
  };

/** Все бизнес-эндпоинты. Подключаются дважды: для других сервисов (x-api-key) и для сайта (/web, сессия). */
function buildRoutes(deps: Deps): express.Router {
  const router = express.Router();

  // --- Клиенты ---
  router.get(
    '/clients',
    wrap(async (_req, res) => {
      res.json((await deps.clients.list()).map(clientDto));
    }),
  );

  router.post(
    '/clients',
    wrap(async (req, res) => {
      const c = await deps.clients.create(text(req.body?.email, 'email'), text(req.body?.name, 'name'));
      res.status(201).json(clientDto(c));
    }),
  );

  router.get(
    '/clients/:id',
    wrap(async (req, res) => {
      res.json(clientDto(await deps.clients.get(uuid(req.params.id))));
    }),
  );

  // Пополнение баланса криптой
  router.post(
    '/clients/:id/topups',
    wrap(async (req, res) => {
      const p = await deps.payments.createCrypto({
        clientId: uuid(req.params.id),
        amountWei: amount(req.body?.amount),
        purpose: 'TOPUP',
        idempotencyKey: text(req.body?.idempotency_key, 'idempotency_key'),
        callbackUrl: optionalUrl(req.body?.callback_url),
      });
      res.status(201).json(paymentDto(p));
    }),
  );

  // --- Платежи ---
  router.post(
    '/payments',
    wrap(async (req, res) => {
      const base = {
        clientId: uuid(text(req.body?.client_id, 'client_id')),
        amountWei: amount(req.body?.amount),
        idempotencyKey: text(req.body?.idempotency_key, 'idempotency_key'),
        callbackUrl: optionalUrl(req.body?.callback_url),
      };
      const method = req.body?.method;
      if (method === 'CRYPTO') {
        res.status(201).json(paymentDto(await deps.payments.createCrypto({ ...base, purpose: 'PURCHASE' })));
      } else if (method === 'BALANCE') {
        res.status(201).json(paymentDto(await deps.payments.createFromBalance(base)));
      } else {
        bad('INVALID_METHOD', 'method must be CRYPTO or BALANCE');
      }
    }),
  );

  router.get(
    '/payments/:id',
    wrap(async (req, res) => {
      res.json(paymentDto(await deps.payments.get(uuid(req.params.id))));
    }),
  );

  router.post(
    '/payments/:id/refund',
    wrap(async (req, res) => {
      const addr = typeof req.body?.refund_address === 'string' ? req.body.refund_address : undefined;
      res.json(paymentDto(await deps.refunds.refund(uuid(req.params.id), addr)));
    }),
  );

  return router;
}

export function createApp(deps: Deps) {
  const app = express();
  app.use(express.json({ limit: '100kb' }));

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  // Сайт: статические файлы (без ключей внутри)
  app.use(express.static(path.join(__dirname, '../../public')));

  // --- API для сайта: вход по паролю, сессия в httpOnly cookie ---
  // API-ключ в браузер не попадает. Сервер сам вызывает свою бизнес-логику.
  const sessions = new SessionStore();
  const attempts = new Map<string, { n: number; reset: number }>();
  const cookie = (value: string, maxAge: number) =>
    `sid=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${deps.cookieSecure ? '; Secure' : ''}`;

  const web = express.Router();

  web.post('/login', (req, res, next) => {
    const ip = req.ip ?? 'unknown';
    const now = Date.now();
    const a = attempts.get(ip);
    if (a && a.reset > now && a.n >= 10) {
      return next(new AppError(429, 'TOO_MANY_ATTEMPTS', 'too many attempts, try again later'));
    }
    const ok = typeof req.body?.password === 'string' && safeEqual(req.body.password, deps.sitePassword);
    if (!ok) {
      attempts.set(ip, a && a.reset > now ? { n: a.n + 1, reset: a.reset } : { n: 1, reset: now + 15 * 60_000 });
      return next(new AppError(401, 'WRONG_PASSWORD', 'wrong password'));
    }
    attempts.delete(ip);
    res.setHeader('Set-Cookie', cookie(sessions.create(), SESSION_TTL_SECONDS));
    res.json({ ok: true });
  });

  web.post('/logout', (req, res) => {
    sessions.destroy(readCookie(req.headers.cookie, 'sid'));
    res.setHeader('Set-Cookie', cookie('', 0));
    res.json({ ok: true });
  });

  web.use((req, _res, next) => {
    if (sessions.valid(readCookie(req.headers.cookie, 'sid'))) return next();
    next(new AppError(401, 'UNAUTHORIZED', 'login required'));
  });

  web.get('/session', (_req, res) => {
    res.json({ ok: true });
  });
  web.use(buildRoutes(deps));
  app.use('/web', web);

  // --- API для других сервисов: требуется x-api-key ---
  app.use((req, _res, next) => {
    const got = String(req.header('x-api-key') ?? '');
    if (!safeEqual(got, deps.apiKey)) {
      return next(new AppError(401, 'UNAUTHORIZED', 'invalid or missing x-api-key'));
    }
    next();
  });
  app.use(buildRoutes(deps));

  // --- Ошибки ---
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppError) {
      res.status(err.status).json({ error: { code: err.code, message: err.message } });
      return;
    }
    if ((err as any)?.type === 'entity.parse.failed') {
      res.status(400).json({ error: { code: 'INVALID_JSON', message: 'body is not valid JSON' } });
      return;
    }
    console.error(err);
    res.status(500).json({ error: { code: 'INTERNAL', message: 'internal server error' } });
  });

  return app;
}
