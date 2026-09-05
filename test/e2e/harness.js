/** Shared plumbing for the browser tests: mock R2 + our server + a Chromium page. */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createMockR2 } from '../mock-r2.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

async function startServer(endpoint, port) {
  const child = spawn(process.execPath, [path.join(root, 'server', 'index.js')], {
    env: {
      ...process.env,
      PORT: String(port),
      R2_ENDPOINT: endpoint,
      R2_BUCKET: 'demo',
      R2_ACCESS_KEY_ID: 'test-access-key',
      R2_SECRET_ACCESS_KEY: 'test-secret-key',
      R2_FORCE_PATH_STYLE: 'true',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr.on('data', (chunk) => process.stderr.write(`[server] ${chunk}`));

  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      if ((await fetch(`${base}/api/config`)).ok) return { child, base };
    } catch {
      /* not listening yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  child.kill();
  throw new Error('server did not start');
}

/**
 * Brings up the whole stack for one test and tears it down afterwards.
 * `problems` collects page errors so a test can assert the console stayed clean.
 */
export async function startStack(t, { port, partDelayMs = 0 } = {}) {
  const mock = createMockR2({ bucket: 'demo', partDelayMs });
  const endpoint = await mock.listen();
  const { child, base } = await startServer(endpoint, port);
  // CHROMIUM_PATH lets CI point at a browser Playwright did not download itself.
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();

  const problems = [];
  page.on('pageerror', (error) => problems.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(message.text());
  });

  t.after(async () => {
    await browser.close();
    child.kill();
    await mock.close();
  });

  await page.goto(base);
  await page.waitForFunction(() => document.getElementById('bucket-badge').textContent === 'r2://demo');

  return { mock, base, browser, page, problems };
}

export const uploadStatus = () =>
  document.querySelector('#uploads .status')?.textContent ?? '';
