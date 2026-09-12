/**
 * The share list, exercised against the in-memory R2 mock: a password only ever
 * opens the recipient it belongs to, and only the files ticked for them.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMockR2 } from './mock-r2.js';

const mock = createMockR2({ bucket: 'demo' });
const endpoint = await mock.listen();

process.env.R2_BUCKET = 'demo';
process.env.R2_ENDPOINT = endpoint;
process.env.R2_ACCESS_KEY_ID = 'test-key';
process.env.R2_SECRET_ACCESS_KEY = 'test-secret';
process.env.R2_FORCE_PATH_STYLE = 'true';
process.env.APP_PASSWORD = 'admin-password';

const shares = await import('../server/shares.js');
const { config } = await import('../server/config.js');

test.after(() => mock.close());

test('the mapping starts empty and no password opens it', async () => {
  assert.deepEqual(await shares.listUsers(), []);
  assert.equal(await shares.findUserByPassword('anything'), null);
});

test('a recipient is found by their own password and nobody else’s', async () => {
  const first = await shares.createUser({ name: 'Anh B', password: 'first-password' });
  const second = await shares.createUser({ name: 'Chi C', password: 'second-password' });

  assert.equal((await shares.findUserByPassword('first-password')).id, first.user.id);
  assert.equal((await shares.findUserByPassword('second-password')).id, second.user.id);
  assert.equal(await shares.findUserByPassword('third-password'), null);
  assert.equal(await shares.findUserByPassword(''), null);
  assert.equal(await shares.findUserByPassword(undefined), null);
});

test('a generated password is handed back once and is long enough to be worth keeping', async () => {
  const created = await shares.createUser({ name: 'Auto' });
  assert.equal(created.password.length, 16);
  assert.equal((await shares.findUserByPassword(created.password)).id, created.user.id);
  // Only the digest is kept, so nothing can read the password back out.
  const stored = await shares.getUser(created.user.id);
  assert.equal(stored.password, undefined);
  assert.ok(!JSON.stringify(stored).includes(created.password));
});

test('a password that is already in use is refused', async () => {
  await assert.rejects(() => shares.createUser({ name: 'Copycat', password: 'first-password' }), /already in use/);
});

test('a short password is refused', async () => {
  await assert.rejects(() => shares.createUser({ name: 'Short', password: 'abc' }), /at least 8/);
});

test('the admin password cannot be handed to a recipient', async () => {
  // It is checked first at sign-in, so this would make them an admin, not a recipient.
  await assert.rejects(
    () => shares.createUser({ name: 'Sneaky', password: 'admin-password' }),
    /the admin password/
  );
  const anh = await shares.findUserByPassword('first-password');
  await assert.rejects(() => shares.setPassword(anh.id, 'admin-password'), /the admin password/);
});

test('files are shared per recipient, and nobody sees anyone else’s', async () => {
  const anh = await shares.findUserByPassword('first-password');
  const chi = await shares.findUserByPassword('second-password');

  await shares.setUserFiles(anh.id, ['uploads/2026-01-01/aaaaaaaaaaaa-one.zip']);
  await shares.setUserFiles(chi.id, ['uploads/2026-01-01/bbbbbbbbbbbb-two.zip']);

  assert.equal(await shares.userHasKey(anh.id, 'uploads/2026-01-01/aaaaaaaaaaaa-one.zip'), true);
  assert.equal(await shares.userHasKey(anh.id, 'uploads/2026-01-01/bbbbbbbbbbbb-two.zip'), false);
  assert.equal(await shares.userHasKey(chi.id, 'uploads/2026-01-01/bbbbbbbbbbbb-two.zip'), true);
  assert.equal(await shares.userHasKey('u_nobody', 'uploads/2026-01-01/aaaaaaaaaaaa-one.zip'), false);
});

test('assigning the same file twice keeps one entry', async () => {
  const anh = await shares.findUserByPassword('first-password');
  const key = 'uploads/2026-01-01/aaaaaaaaaaaa-one.zip';
  const updated = await shares.setUserFiles(anh.id, [key, key]);
  assert.deepEqual(updated.keys, [key]);
});

test('a new password retires the old one, and the stamp changes with it', async () => {
  const before = await shares.findUserByPassword('first-password');
  const { password } = await shares.setPassword(before.id, 'replacement-password');

  assert.equal(await shares.findUserByPassword('first-password'), null);
  const after = await shares.findUserByPassword(password);
  assert.equal(after.id, before.id);
  assert.notEqual(after.stamp, before.stamp, 'the stamp is what retires an open session');
  // The files stay put through a password change.
  assert.deepEqual(after.keys, before.keys);
});

test('deleting a file drops it from every list that pointed at it', async () => {
  const key = 'uploads/2026-01-01/shared-with-both.zip';
  const anh = await shares.findUserByPassword('replacement-password');
  const chi = await shares.findUserByPassword('second-password');
  await shares.setUserFiles(anh.id, [...anh.keys, key]);
  await shares.setUserFiles(chi.id, [...chi.keys, key]);

  await shares.forgetKey(key);

  assert.equal(await shares.userHasKey(anh.id, key), false);
  assert.equal(await shares.userHasKey(chi.id, key), false);
});

test('removing a recipient takes their password with them', async () => {
  const chi = await shares.findUserByPassword('second-password');
  await shares.deleteUser(chi.id);

  assert.equal(await shares.findUserByPassword('second-password'), null);
  assert.equal(await shares.getUser(chi.id), null);
  await assert.rejects(() => shares.deleteUser(chi.id), /No such recipient/);
});

test('the mapping is stored outside the prefix the app lists and signs', async () => {
  assert.ok(!config.sharesKey.startsWith(config.keyPrefix));
  assert.ok(mock.objects.has(config.sharesKey), 'the manifest really is in the bucket');
  const { assertOwnedKey } = await import('../server/keys.js');
  assert.throws(() => assertOwnedKey(config.sharesKey), /must start with/);
});

test('concurrent changes do not overwrite each other', async () => {
  const people = await Promise.all(
    Array.from({ length: 5 }, (_, index) => shares.createUser({ name: `Bulk ${index}` }))
  );
  const names = (await shares.listUsers()).map((user) => user.name);
  for (const person of people) assert.ok(names.includes(person.user.name), `${person.user.name} survived`);
});
