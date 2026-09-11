/**
 * End-to-end: the admin uploads a file, hands it to one recipient, and that
 * recipient signs in with nothing but a password and downloads it — while the
 * file they were not given stays out of reach.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startStack } from './harness.js';

const ADMIN_PASSWORD = 'the-admin-password';

const signIn = async (page, base, password) => {
  await page.goto(`${base}/login`);
  await page.fill('#password', password);
  await page.click('#submit');
};

test('a file handed to one recipient reaches them and nobody else', async (t) => {
  const { mock, base, page, problems } = await startStack(t, { port: 4176, password: ADMIN_PASSWORD });
  const workdir = await mkdtemp(path.join(tmpdir(), 'upload-r2-share-'));
  t.after(() => rm(workdir, { recursive: true, force: true }));

  // ---- the admin signs in and uploads two files ----
  await signIn(page, base, ADMIN_PASSWORD);
  await page.waitForFunction(() => document.getElementById('bucket-badge')?.textContent === 'r2://demo', undefined, {
    timeout: 30_000,
  });
  await page.waitForSelector('#sharing:not([hidden])');

  const shared = path.join(workdir, 'for-anh-b.bin');
  const secret = path.join(workdir, 'private.bin');
  const sharedBytes = randomBytes(1024 * 1024);
  await writeFile(shared, sharedBytes);
  await writeFile(secret, randomBytes(1024 * 1024));

  await page.setInputFiles('#file-input', [shared, secret]);
  await page.waitForFunction(
    () => [...document.querySelectorAll('#uploads .status')].filter((s) => s.textContent.startsWith('Uploaded')).length === 2,
    undefined,
    { timeout: 60_000 }
  );
  await page.waitForFunction(() => document.querySelectorAll('#files .item').length === 2, undefined, {
    timeout: 30_000,
  });

  // ---- and gives one of them to a recipient ----
  await page.click('#add-recipient');
  await page.waitForSelector('#recipient-form:not([hidden])');

  // A password is suggested; this test uses one it can sign in with afterwards.
  const suggested = await page.inputValue('#recipient-password');
  assert.equal(suggested.length, 16, 'a password is generated for the admin');
  await page.fill('#recipient-name', 'Anh B');
  await page.fill('#recipient-password', 'anh-b-password');
  await page.click('#recipient-save');

  // The password is shown once, the form closes, and the file picker opens straight away.
  await page.waitForSelector('#new-password code');
  assert.equal(await page.isVisible('#recipient-form'), false, 'the add form closes');
  assert.equal(await page.isVisible('#add-recipient'), true, 'and the Add button comes back');
  assert.equal(await page.textContent('#new-password code'), 'anh-b-password');
  await page.waitForFunction(
    () => document.querySelector('#recipients .item-name')?.textContent === 'Anh B',
    undefined,
    { timeout: 30_000 }
  );

  // Tick only the file meant for them.
  await page.waitForSelector('.picker-list label');
  await page.click('.picker-list label:has-text("for-anh-b.bin") input');
  await page.click('.picker-foot button');
  await page.waitForFunction(
    () => document.querySelector('#recipients .status')?.textContent === 'for-anh-b.bin',
    undefined,
    { timeout: 30_000 }
  );

  await page.click('#logout');
  await page.waitForURL(/\/login$/, { timeout: 30_000 });

  // ---- the recipient signs in with the password alone ----
  await signIn(page, base, 'anh-b-password');
  await page.waitForFunction(() => document.getElementById('greeting')?.textContent === 'Shared with Anh B', undefined, {
    timeout: 30_000,
  });

  // Exactly one file, and it is theirs.
  await page.waitForFunction(() => document.querySelectorAll('#files .item').length === 1, undefined, {
    timeout: 30_000,
  });
  assert.equal(await page.textContent('#files .item-name'), 'for-anh-b.bin');

  // There is no way to upload or delete from this page.
  assert.equal(await page.locator('#file-input').count(), 0, 'no upload control');
  assert.equal(await page.locator('#files button:has-text("Delete")').count(), 0, 'no delete button');

  // The other file is refused even when asked for by key.
  const otherKey = [...mock.objects.keys()].find((key) => key.includes('private.bin'));
  const refused = await page.evaluate(
    (key) => fetch(`/api/files/download-url?key=${encodeURIComponent(key)}`).then((r) => r.status),
    otherKey
  );
  assert.equal(refused, 404);

  // Uploading and sharing are refused too, not just hidden.
  const forbidden = await page.evaluate(() =>
    Promise.all([
      fetch('/api/uploads/create', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ filename: 'x.bin', size: 10 }),
      }).then((r) => r.status),
      fetch('/api/admin/users').then((r) => r.status),
    ])
  );
  assert.deepEqual(forbidden, [403, 403]);

  // ---- and the download really delivers the bytes ----
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 60_000 }),
    page.click('#files button:has-text("Download")'),
  ]);
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  assert.deepEqual(Buffer.concat(chunks), sharedBytes, 'the file arrived intact');

  // The 403/404s above are what this test is for; Chromium logs each as a console
  // error, so only anything else counts as a problem.
  const unexpected = problems.filter(
    (problem) => !/(403 \(Forbidden\)|404 \(Not Found\))/.test(problem)
  );
  assert.deepEqual(unexpected, [], 'no unexpected console or page errors');
});
