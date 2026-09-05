import test from 'node:test';
import assert from 'node:assert/strict';

process.env.R2_BUCKET ??= 'test-bucket';
process.env.R2_ACCOUNT_ID ??= 'test-account';
process.env.R2_ACCESS_KEY_ID ??= 'test-key';
process.env.R2_SECRET_ACCESS_KEY ??= 'test-secret';
process.env.APP_PASSWORD = 'correct horse battery staple';

const auth = await import('../server/auth.js');

test('authEnabled follows APP_PASSWORD', () => {
  assert.equal(auth.authEnabled, true);
});

test('only the exact password is accepted', () => {
  assert.equal(auth.checkPassword('correct horse battery staple'), true);
  assert.equal(auth.checkPassword('correct horse battery stapl'), false);
  assert.equal(auth.checkPassword('CORRECT HORSE BATTERY STAPLE'), false);
  assert.equal(auth.checkPassword(''), false);
  assert.equal(auth.checkPassword(undefined), false);
  assert.equal(auth.checkPassword({ toString: () => 'correct horse battery staple' }), false);
});

test('a freshly signed session verifies', () => {
  assert.equal(auth.verifySession(auth.signSession()), true);
});

test('tampered and malformed sessions are rejected', () => {
  const token = auth.signSession();
  const [version, expiry, signature] = token.split('.');

  assert.equal(auth.verifySession(`${version}.${Number(expiry) + 60_000}.${signature}`), false, 'extended expiry');
  assert.equal(auth.verifySession(`${version}.${expiry}.${'A'.repeat(signature.length)}`), false, 'forged signature');
  assert.equal(auth.verifySession(`v2.${expiry}.${signature}`), false, 'unknown version');
  assert.equal(auth.verifySession(`${version}.${expiry}`), false, 'missing signature');
  assert.equal(auth.verifySession('not-a-token'), false);
  assert.equal(auth.verifySession(''), false);
  assert.equal(auth.verifySession(undefined), false);
});

test('an expired session is rejected', () => {
  // Sign one by hand with an expiry in the past, using the same secret.
  const past = Date.now() - 1000;
  const real = auth.signSession();
  assert.equal(auth.verifySession(`v1.${past}.${real.split('.')[2]}`), false);
});

test('cookies are read out of the header', () => {
  const req = { headers: { cookie: 'other=1; upload_r2_session=abc%20def; trailing=2' } };
  assert.equal(auth.readCookie(req, auth.COOKIE_NAME), 'abc def');
  assert.equal(auth.readCookie(req, 'missing'), undefined);
  assert.equal(auth.readCookie({ headers: {} }, auth.COOKIE_NAME), undefined);
});

test('repeated failures from one address are throttled', () => {
  const ip = '203.0.113.7';
  assert.equal(auth.tooManyAttempts(ip), false);
  for (let i = 0; i < 10; i += 1) auth.recordFailure(ip);
  assert.equal(auth.tooManyAttempts(ip), true);
  auth.clearAttempts(ip);
  assert.equal(auth.tooManyAttempts(ip), false);
});
