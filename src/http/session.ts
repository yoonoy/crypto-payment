import { createHash, randomBytes } from 'node:crypto';

export const SESSION_TTL_SECONDS = 12 * 60 * 60;

/** Простое хранилище сессий в памяти. После перезапуска сервера нужно войти заново. */
export class SessionStore {
  private readonly sessions = new Map<string, number>();

  create(): string {
    const token = randomBytes(32).toString('hex');
    this.sessions.set(token, Date.now() + SESSION_TTL_SECONDS * 1000);
    return token;
  }

  valid(token: string | undefined): boolean {
    if (!token) return false;
    const expires = this.sessions.get(token);
    if (!expires) return false;
    if (expires < Date.now()) {
      this.sessions.delete(token);
      return false;
    }
    return true;
  }

  destroy(token: string | undefined): void {
    if (token) this.sessions.delete(token);
  }
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

/** Сравнение строк без утечки по времени (сравниваем хеши одинаковой длины) */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha[i] ^ hb[i];
  return diff === 0;
}
