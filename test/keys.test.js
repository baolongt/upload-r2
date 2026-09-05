import test from 'node:test';
import assert from 'node:assert/strict';

process.env.R2_BUCKET ??= 'test-bucket';
process.env.R2_ACCOUNT_ID ??= 'test-account';
process.env.R2_ACCESS_KEY_ID ??= 'test-key';
process.env.R2_SECRET_ACCESS_KEY ??= 'test-secret';

const { safeName, buildKey, assertOwnedKey, choosePartSize, HttpError } = await import('../server/keys.js');
const { limits } = await import('../server/config.js');

test('safeName strips paths and unsafe characters', () => {
  assert.equal(safeName('../../etc/passwd'), 'passwd');
  assert.equal(safeName('C:\\videos\\my movie (1).mp4'), 'my_movie_1_.mp4');
  assert.equal(safeName(''), 'file');
  assert.equal(safeName('...'), 'file');
});

test('buildKey lands inside the configured prefix', () => {
  const key = buildKey('big.iso');
  assert.match(key, /^uploads\/\d{4}-\d{2}-\d{2}\/[0-9a-f]{12}-big\.iso$/);
  assert.equal(assertOwnedKey(key), key);
});

test('assertOwnedKey rejects traversal and foreign prefixes', () => {
  assert.throws(() => assertOwnedKey('uploads/../secrets/key.pem'), HttpError);
  assert.throws(() => assertOwnedKey('/uploads/a'), HttpError);
  assert.throws(() => assertOwnedKey('other-prefix/a'), HttpError);
  assert.throws(() => assertOwnedKey(''), HttpError);
});

test('choosePartSize honours the 5 MiB floor', () => {
  assert.equal(choosePartSize(100 * 1024 * 1024, 1024), limits.minPartSize);
  assert.equal(choosePartSize(100 * 1024 * 1024, 16 * 1024 * 1024), 16 * 1024 * 1024);
});

test('choosePartSize grows the part size to stay under 10 000 parts', () => {
  const fiveHundredGiB = 500 * 1024 ** 3;
  const partSize = choosePartSize(fiveHundredGiB, 8 * 1024 * 1024);
  assert.ok(Math.ceil(fiveHundredGiB / partSize) <= limits.maxParts);
  assert.ok(partSize >= limits.minPartSize);
  // 5 TiB, the largest object R2 accepts, still fits.
  const fiveTiB = 5 * 1024 ** 4;
  assert.ok(Math.ceil(fiveTiB / choosePartSize(fiveTiB, 8 * 1024 * 1024)) <= limits.maxParts);
});
