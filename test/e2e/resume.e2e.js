/**
 * End-to-end: pause an upload halfway, reload the page, hand the same file back
 * and check that only the missing chunks are sent.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startStack } from './harness.js';

const FILE_SIZE = 40 * 1024 * 1024;
const PART_SIZE = 5 * 1024 * 1024;
const PART_COUNT = FILE_SIZE / PART_SIZE;
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

test('a paused upload resumes after a page reload without re-sending finished chunks', async (t) => {
  // One chunk at a time, deliberately slowed down, so there is a middle to pause in.
  const { mock, page, problems } = await startStack(t, { port: 4174, partDelayMs: 400 });
  const workdir = await mkdtemp(path.join(tmpdir(), 'upload-r2-resume-'));
  t.after(() => rm(workdir, { recursive: true, force: true }));

  const source = Buffer.concat(Array.from({ length: FILE_SIZE / (1024 * 1024) }, () => randomBytes(1024 * 1024)));
  const sourcePath = path.join(workdir, 'resumable.bin');
  await writeFile(sourcePath, source);

  await page.selectOption('#part-size', String(PART_SIZE));
  await page.selectOption('#concurrency', '1');
  await page.setInputFiles('#file-input', sourcePath);

  // Wait until a couple of chunks have landed on the mock, then pause.
  const storedParts = () => (mock.uploads.size === 1 ? [...mock.uploads.values()][0].parts.size : 0);
  const deadline = Date.now() + 60_000;
  while (storedParts() < 2 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await page.getByRole('button', { name: 'Pause' }).click();
  await page.waitForFunction(
    () => document.querySelector('#uploads .status')?.textContent?.startsWith('Paused'),
    undefined,
    { timeout: 30_000 }
  );

  const partsBeforeReload = storedParts();
  assert.ok(partsBeforeReload >= 2, `expected some chunks to have landed, got ${partsBeforeReload}`);
  assert.ok(partsBeforeReload < PART_COUNT, 'the upload should still be unfinished');
  assert.equal(mock.objects.size, 0, 'nothing is stored until the upload completes');

  // A reload wipes the page, but the uploadId is remembered.
  await page.reload();
  await page.waitForFunction(() => document.getElementById('resumable').hidden === false, undefined, {
    timeout: 15_000,
  });
  await page.selectOption('#concurrency', '2');
  await page.setInputFiles('#file-input', sourcePath);
  await page.waitForFunction(
    () => document.querySelector('#uploads .status')?.textContent?.startsWith('Uploaded'),
    undefined,
    { timeout: 180_000 }
  );

  assert.equal(mock.stats.listParts, 1, 'the resumed upload should have asked R2 which parts it already had');
  assert.equal(mock.objects.size, 1);
  const [, object] = [...mock.objects.entries()][0];
  assert.equal(sha256(object.body), sha256(source), 'the reassembled file must match the source');
  assert.ok(
    mock.stats.partPuts < PART_COUNT * 2,
    `resume should not re-send everything (${mock.stats.partPuts} chunk uploads for ${PART_COUNT} chunks)`
  );
  assert.deepEqual(problems, [], 'no console or page errors');
});
