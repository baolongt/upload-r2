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

const ADMIN = { role: 'admin', sub: 'admin' };
const RECIPIENT = { role: 'user', sub: 'u_abc', name: 'Anh B', stamp: 'abcdef123456' };

const payloadOf = (token) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));

test('a freshly signed session verifies and carries the identity back', () => {
  const admin = auth.readSession(auth.signSession(ADMIN));
  assert.equal(admin.role, 'admin');
  assert.equal(admin.sub, 'admin');

  const user = auth.readSession(auth.signSession(RECIPIENT));
  assert.equal(user.role, 'user');
  assert.equal(user.sub, 'u_abc');
  assert.equal(user.name, 'Anh B');
  assert.equal(user.stamp, 'abcdef123456');
});

test('tampered and malformed sessions are rejected', () => {
  const token = auth.signSession(RECIPIENT);
  const [version, body, signature] = token.split('.');

  // Promoting a recipient to admin invalidates the signature.
  const promoted = Buffer.from(
    JSON.stringify({ ...payloadOf(token), role: 'admin' }),
    'utf8'
  ).toString('base64url');
  assert.equal(auth.verifySession(`${version}.${promoted}.${signature}`), false, 'role swapped');

  const extended = Buffer.from(
    JSON.stringify({ ...payloadOf(token), exp: Date.now() + 10 * 365 * 24 * 3600_000 }),
    'utf8'
  ).toString('base64url');
  assert.equal(auth.verifySession(`${version}.${extended}.${signature}`), false, 'extended expiry');

  assert.equal(auth.verifySession(`${version}.${body}.${'A'.repeat(signature.length)}`), false, 'forged signature');
  assert.equal(auth.verifySession(`v1.${body}.${signature}`), false, 'unknown version');
  assert.equal(auth.verifySession(`${version}.${body}`), false, 'missing signature');
  assert.equal(auth.verifySession('not-a-token'), false);
  assert.equal(auth.verifySession(''), false);
  assert.equal(auth.verifySession(undefined), false);
});

test('an expired session is rejected', async () => {
  // Sign one by hand with an expiry in the past, so the signature is genuine.
  const real = auth.signSession(ADMIN);
  const expired = { ...payloadOf(real), exp: Date.now() - 1000 };
  const body = Buffer.from(JSON.stringify(expired), 'utf8').toString('base64url');
  const token = `v2.${body}.${'x'}`;
  assert.equal(auth.verifySession(token), false);

  // And one whose signature really does match, to prove it is the expiry that stops it.
  const { createHmac, createHash } = await import('node:crypto');
  const secret = createHash('sha256').update(`upload-r2:${process.env.APP_PASSWORD}`).digest();
  const signature = createHmac('sha256', secret).update(`v2.${body}`).digest('base64url');
  assert.equal(auth.verifySession(`v2.${body}.${signature}`), false);
});

test('requireAdmin lets the admin through and stops a recipient', () => {
  const calls = [];
  auth.requireAdmin({ identity: { role: 'admin' } }, {}, (error) => calls.push(error));
  auth.requireAdmin({ identity: { role: 'user' } }, {}, (error) => calls.push(error));
  auth.requireAdmin({}, {}, (error) => calls.push(error));

  assert.equal(calls[0], undefined, 'admin passes');
  assert.equal(calls[1]?.status, 403, 'recipient is refused');
  assert.equal(calls[2]?.status, 403, 'no identity is refused');
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
