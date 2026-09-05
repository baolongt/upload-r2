/**
 * End-to-end: a real Chromium chunks a 40 MB file, pushes every part to a mock
 * R2 with presigned URLs from our server, then downloads it back with ranged
 * requests. Run with `npm run test:e2e`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startStack } from './harness.js';

const FILE_SIZE = 40 * 1024 * 1024;
const PART_SIZE = 5 * 1024 * 1024;
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

test('a 40 MB file survives a chunked round trip', async (t) => {
  const { mock, page, problems } = await startStack(t, { port: 4173 });
  const workdir = await mkdtemp(path.join(tmpdir(), 'upload-r2-'));
  t.after(() => rm(workdir, { recursive: true, force: true }));

  // Random contents, so a mis-ordered or duplicated chunk cannot slip through.
  const source = Buffer.concat(Array.from({ length: FILE_SIZE / (1024 * 1024) }, () => randomBytes(1024 * 1024)));
  const sourcePath = path.join(workdir, 'big-sample.bin');
  await writeFile(sourcePath, source);

  await page.selectOption('#part-size', String(PART_SIZE));
  await page.selectOption('#concurrency', '4');
  await page.setInputFiles('#file-input', sourcePath);
  await page.waitForFunction(
    () => document.querySelector('#uploads .status')?.textContent?.startsWith('Uploaded'),
    undefined,
    { timeout: 180_000 }
  );

  assert.equal(mock.objects.size, 1, 'exactly one object should exist');
  const [key, object] = [...mock.objects.entries()][0];
  assert.match(key, /^uploads\/\d{4}-\d{2}-\d{2}\/[0-9a-f]{12}-big-sample\.bin$/);
  assert.equal(object.body.length, FILE_SIZE);
  assert.equal(sha256(object.body), sha256(source), 'uploaded bytes must match the source byte for byte');
  assert.equal(mock.stats.partPuts, FILE_SIZE / PART_SIZE, 'the file should have been sent as 8 chunks');

  // ...and back down again, as parallel range requests.
  const row = page.locator('#files .item').first();
  await row.waitFor({ timeout: 15_000 });
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 180_000 }),
    row.getByRole('button', { name: 'Download' }).click(),
  ]);
  const downloaded = await readFile(await download.path());

  assert.equal(downloaded.length, FILE_SIZE);
  assert.equal(sha256(downloaded), sha256(source), 'downloaded bytes must match the source byte for byte');
  assert.ok(mock.stats.rangeGets > 1, 'the download should have been split into ranges');
  assert.deepEqual(problems, [], 'no console or page errors');
});
