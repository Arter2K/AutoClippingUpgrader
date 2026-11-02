import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export function createPkce(encoding: 'hex' | 'base64url') {
  const verifier = randomBytes(48).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest(encoding), state: randomBytes(32).toString('base64url') };
}
export function isExactCallback(value: string, redirectUri: string): boolean {
  try {
    const u = new URL(value), expected = new URL(redirectUri);
    return u.origin === expected.origin && u.pathname === expected.pathname && !u.username && !u.password && !u.hash;
  } catch { return false; }
}
export class AuthorizationSession {
  readonly createdAt = Date.now();
  private consumed = false;
  get isConsumed() { return this.consumed; }
  constructor(readonly redirectUri: string, readonly pkce: ReturnType<typeof createPkce>, private ttlMs = 600000) {}
  accept(value: string): { code: string; verifier: string } {
    if (this.consumed || Date.now() - this.createdAt > this.ttlMs) throw new Error('OAuth session expired or already consumed');
    if (!isExactCallback(value, this.redirectUri)) throw new Error('OAuth redirect URI does not match');
    const u = new URL(value);
    for (const name of ['state', 'code', 'error']) if (u.searchParams.getAll(name).length > 1) throw new Error('Duplicate OAuth parameters');
    const state = u.searchParams.get('state') ?? '';
    const actual = Buffer.from(state), expected = Buffer.from(this.pkce.state);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error('OAuth state mismatch');
    if (u.searchParams.has('error')) { this.consumed = true; throw new Error('OAuth authorization denied'); }
    const code = u.searchParams.get('code');
    if (!code || code.length > 4096) throw new Error('Missing or invalid OAuth code');
    this.consumed = true;
    return { code, verifier: this.pkce.verifier };
  }
}
