import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { AuthorizationSession, createPkce, isExactCallback } from '../src/main/services/auth/pkce';
import { EncryptedTokenVault, type Encryption } from '../src/main/services/auth/token-vault';
import { startLoopback } from '../src/main/services/auth/loopback';
import { TikTokOAuth, TIKTOK_REDIRECT_URI, TIKTOK_SCOPES } from '../src/main/services/tiktok/oauth';
import { GoogleOAuth, DRIVE_FILE_SCOPE } from '../src/main/services/google-drive/oauth';
import { ApiError, assertUploadUrl, safeMessage } from '../src/main/services/http';
import { TestTokenStore, fetchMock, json, token } from './publishing-helpers';

test('provider-specific PKCE, exact callback, state, duplicates and one-time code consumption', () => {
  const pkce = createPkce('hex');
  assert.equal(pkce.challenge, createHash('sha256').update(pkce.verifier).digest('hex'));
  assert.equal(createPkce('base64url').challenge.length, 43);
  const session = new AuthorizationSession(TIKTOK_REDIRECT_URI, pkce);
  const callback = `${TIKTOK_REDIRECT_URI}?code=abc%2Bdef&state=${pkce.state}`;
  assert.equal(isExactCallback(callback, TIKTOK_REDIRECT_URI), true);
  for (const bad of [callback.replace('arter2k.github.io', 'arter2k.github.io.evil.com'), callback.replace('/callback?', '/callback/extra?'),
    `${callback}#fragment`, callback.replace(pkce.state, 'wrong'), `${callback}&state=duplicate`, `${callback}&code=duplicate`])
    assert.throws(() => session.accept(bad));
  assert.deepEqual(session.accept(callback), { code: 'abc+def', verifier: pkce.verifier });
  assert.throws(() => session.accept(callback));
  const expired = new AuthorizationSession(TIKTOK_REDIRECT_URI, createPkce('hex'), -1);
  assert.throws(() => expired.accept(callback));
});
test('OAuth denial consumes session only when state matches', () => {
  const s = new AuthorizationSession(TIKTOK_REDIRECT_URI, createPkce('hex'));
  assert.throws(() => s.accept(`${TIKTOK_REDIRECT_URI}?error=access_denied&state=wrong`));
  assert.equal(s.isConsumed, false);
  assert.throws(() => s.accept(`${TIKTOK_REDIRECT_URI}?error=access_denied&state=${s.pkce.state}`));
  assert.equal(s.isConsumed, true);
});
test('TikTok auth URL, form exchange, expiry and rotating refresh token', async () => {
  const store = new TestTokenStore();
  let requests = 0;
  const oauth = new TikTokOAuth('client', 'client-secret', store, fetchMock((url, init) => {
    assert.equal(url, 'https://open.tiktokapis.com/v2/oauth/token/');
    const form = new URLSearchParams(init.body as string);
    assert.equal(form.get('client_key'), 'client'); assert.equal(form.get('client_secret'), 'client-secret');
    if (requests++ === 0) { assert.equal(form.get('code'), 'a+b'); assert.ok(form.get('code_verifier')); assert.equal(form.get('redirect_uri'), TIKTOK_REDIRECT_URI); }
    else { assert.equal(form.get('grant_type'), 'refresh_token'); assert.equal(form.get('refresh_token'), 'refresh-1'); }
    return json({ access_token: `access-${requests}`, refresh_token: `refresh-${requests}`, expires_in: requests === 1 ? 1 : 3600,
      refresh_expires_in: 86400, scope: TIKTOK_SCOPES.join(','), open_id: 'creator' });
  }));
  const auth = oauth.begin(), url = new URL(auth.authorizationUrl);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('redirect_uri'), TIKTOK_REDIRECT_URI);
  assert.equal(url.searchParams.get('code_challenge'), auth.session.pkce.challenge);
  await oauth.complete(auth.session, `${TIKTOK_REDIRECT_URI}?code=a%2Bb&state=${auth.session.pkce.state}`);
  assert.equal(await oauth.accessToken(), 'access-2');
  assert.equal((await store.get('tiktok'))?.refreshToken, 'refresh-2');
  assert.equal(requests, 2);
});
test('Google concurrent refresh is single-flight, keeps old refresh token and retries 401 once', async () => {
  const store = new TestTokenStore();
  await store.set('google', token('client', [DRIVE_FILE_SCOPE], Date.now() - 1));
  let refreshes = 0, apiCalls = 0;
  const oauth = new GoogleOAuth('client', undefined, [DRIVE_FILE_SCOPE], store, fetchMock(async (url, init) => {
    if (url.endsWith('/token')) {
      refreshes++; assert.equal(new URLSearchParams(init.body as string).get('refresh_token'), 'refresh-test-secret');
      await new Promise(resolve => setTimeout(resolve, 10));
      return json({ access_token: `access-${refreshes}`, expires_in: 3600 });
    }
    apiCalls++;
    return json({}, apiCalls === 1 ? 401 : 200);
  }));
  const tokens = await Promise.all([oauth.accessToken(), oauth.accessToken(), oauth.accessToken()]);
  assert.deepEqual(tokens, ['access-1', 'access-1', 'access-1']); assert.equal(refreshes, 1);
  assert.equal((await store.get('google'))?.refreshToken, 'refresh-test-secret');
  assert.equal((await oauth.authorized('https://www.googleapis.com/drive/v3/files')).status, 200);
  assert.equal(refreshes, 2); assert.equal(apiCalls, 2);
  await assert.rejects(() => oauth.requireScopes(['ungranted']));
});
test('Google desktop auth uses external-browser-compatible loopback + base64url PKCE', async () => {
  const store = new TestTokenStore();
  const oauth = new GoogleOAuth('client', 'secret', [DRIVE_FILE_SCOPE], store, fetchMock((_url, init) => {
    const body = new URLSearchParams(init.body as string);
    assert.equal(body.get('code_verifier')?.length, 64);
    return json({ access_token: 'a', refresh_token: 'r', expires_in: 3600, scope: DRIVE_FILE_SCOPE });
  }));
  const auth = oauth.begin('http://127.0.0.1:32123/callback');
  const url = new URL(auth.authorizationUrl);
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('code_challenge'), createHash('sha256').update(auth.session.pkce.verifier).digest('base64url'));
  assert.throws(() => oauth.begin('https://somewhere.example/callback'));
  await oauth.exchange(auth.session.redirectUri, 'code', auth.session.pkce.verifier);
  assert.equal((await oauth.account()).connected, true);
});
test('cancelling one consumer does not cancel a shared rotating-token refresh', async () => {
  const store = new TestTokenStore(); await store.set('google', token('client', [DRIVE_FILE_SCOPE], Date.now() - 1));
  let refreshes = 0;
  const oauth = new GoogleOAuth('client', undefined, [DRIVE_FILE_SCOPE], store, fetchMock(async () => {
    refreshes++; await new Promise(resolve => setTimeout(resolve, 25));
    return json({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 });
  }));
  const controller = new AbortController();
  const cancelled = oauth.accessToken(controller.signal), surviving = oauth.accessToken();
  controller.abort();
  const result = await Promise.allSettled([cancelled, surviving]);
  assert.equal(result[0]!.status, 'rejected');
  assert.deepEqual(result[1], { status: 'fulfilled', value: 'new-access' });
  assert.equal(refreshes, 1); assert.equal((await store.get('google'))?.refreshToken, 'new-refresh');
});
test('real loopback receiver rejects bad state, accepts callback, closes on cancellation', async () => {
  const receiver = await startLoopback(undefined, 2000);
  const session = new AuthorizationSession(receiver.redirectUri, createPkce('base64url')); receiver.attach(session);
  assert.equal((await fetch(`${receiver.redirectUri}?state=wrong&code=bad`)).status, 400);
  assert.equal((await fetch(`${receiver.redirectUri}?state=${session.pkce.state}&code=good`)).status, 200);
  assert.equal((await receiver.result).code, 'good'); receiver.close();
  const controller = new AbortController();
  const cancelled = await startLoopback(controller.signal, 2000); controller.abort();
  await assert.rejects(cancelled.result);
});
test('encrypted vault serializes updates, survives reopen, rejects plaintext backend', async () => {
  const key = randomBytes(32);
  const encryption: Encryption = {
    isEncryptionAvailable: () => true,
    encryptString: value => { const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', key, iv); const ciphertext = Buffer.concat([c.update(value, 'utf8'), c.final()]); return Buffer.concat([iv, c.getAuthTag(), ciphertext]); },
    decryptString: value => { const d = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12)); d.setAuthTag(value.subarray(12, 28)); return Buffer.concat([d.update(value.subarray(28)), d.final()]).toString('utf8'); },
  };
  const dir = await mkdtemp(path.join(tmpdir(), 'acu-vault-test-'));
  try {
    const file = path.join(dir, 'tokens.bin');
    const vault = new EncryptedTokenVault(file, encryption);
    await Promise.all([vault.set('tiktok', token('tik', [])), vault.set('google', token('google', []))]);
    assert.equal((await new EncryptedTokenVault(file, encryption).get('google'))?.clientId, 'google');
    assert.equal((await readFile(file)).includes(Buffer.from('access-test-secret')), false);
    await vault.remove('tiktok'); assert.equal(await vault.get('tiktok'), null);
    assert.equal((await vault.get('google'))?.clientId, 'google');
    await assert.rejects(() => new EncryptedTokenVault(file, { ...encryption, getSelectedStorageBackend: () => 'basic_text' }).get('google'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('signed upload destinations are allowlisted and untrusted error text is hidden', () => {
  for (const url of ['http://upload.us.tiktokapis.com/video/', 'https://tiktokapis.com.evil.com/', 'https://evil.com/', 'https://a:b@upload.tiktokapis.com/'])
    assert.throws(() => assertUploadUrl(url, 'tiktok'));
  assert.ok(assertUploadUrl('https://upload.us.tiktokapis.com/video/?token=secret', 'tiktok'));
  assert.throws(() => assertUploadUrl('https://accounts.google.com/', 'google'));
  assert.ok(!safeMessage(new Error('https://signed.url/?secret')).includes('secret'));
  assert.match(safeMessage(new ApiError('TikTok', 403, 'scope_not_authorized', 'Недостаточно прав')), /scope_not_authorized/);
});
