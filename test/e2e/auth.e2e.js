/**
 * End-to-end: with APP_PASSWORD set, nothing is reachable until the password is
 * entered, and signing out puts it back.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startStack } from './harness.js';

const PASSWORD = 'a-very-secret-password';

test('the app is locked behind the password', async (t) => {
  const { mock, base, page, problems } = await startStack(t, { port: 4175, password: PASSWORD });
  const workdir = await mkdtemp(path.join(tmpdir(), 'upload-r2-auth-'));
  t.after(() => rm(workdir, { recursive: true, force: true }));

  // The health check stays open, otherwise the platform would call the deploy dead.
  const health = await fetch(`${base}/healthz`, { redirect: 'manual' });
  assert.equal(health.status, 200);

  // Asking for the app lands on the login form instead.
  assert.match(page.url(), /\/login$/);
  await page.waitForSelector('#password');

  // The API refuses to answer without a session.
  const unauthorized = await page.evaluate(() => fetch('/api/files').then((r) => r.status));
  assert.equal(unauthorized, 401);

  // A wrong password is rejected and stays on the form.
  await page.fill('#password', 'not-the-password');
  await page.click('#submit');
  await page.waitForFunction(() => document.getElementById('error').textContent.length > 0, undefined, {
    timeout: 15_000,
  });
  assert.equal(await page.textContent('#error'), 'Wrong password');
  assert.match(page.url(), /\/login$/);

  // The right one lets us in.
  await page.fill('#password', PASSWORD);
  await page.click('#submit');
  await page.waitForFunction(() => document.getElementById('bucket-badge')?.textContent === 'r2://demo', undefined, {
    timeout: 20_000,
  });

  // ...and the session carries through a real upload.
  const sourcePath = path.join(workdir, 'after-login.bin');
  await writeFile(sourcePath, randomBytes(2 * 1024 * 1024));
  await page.setInputFiles('#file-input', sourcePath);
  await page.waitForFunction(
    () => document.querySelector('#uploads .status')?.textContent?.startsWith('Uploaded'),
    undefined,
    { timeout: 60_000 }
  );
  assert.equal(mock.objects.size, 1);

  // Signing out closes the door again.
  await page.click('#logout');
  await page.waitForURL(/\/login$/, { timeout: 15_000 });
  const afterLogout = await page.evaluate(() => fetch('/api/files').then((r) => r.status));
  assert.equal(afterLogout, 401);

  // The 401s above are what this test is for; Chromium logs each one as a console
  // error, so only anything else counts as a problem.
  const unexpected = problems.filter((problem) => !problem.includes('401 (Unauthorized)'));
  assert.deepEqual(unexpected, [], 'no unexpected console or page errors');
});
