/**
 * What a recipient sees: the files the admin shared with them, and a download
 * button on each. No upload, no delete, no listing of the rest of the bucket —
 * the server would refuse all three anyway.
 */
import { api } from './api.js';
import { canStreamToDisk } from './downloader.js';
import { fileRow } from './filerow.js';
import { el } from './format.js';

const filesEl = el('files');

async function refreshFiles() {
  try {
    const { files } = await api.listFiles();
    filesEl.replaceChildren();
    if (files.length === 0) {
      filesEl.innerHTML = '<p class="muted empty">Nothing has been shared with you yet.</p>';
      return;
    }
    for (const file of files) filesEl.append(fileRow(file, { concurrency: () => 4 }));
  } catch (error) {
    filesEl.innerHTML = `<p class="muted empty">Could not load your files: ${error.message}</p>`;
  }
}

el('refresh').addEventListener('click', refreshFiles);

el('logout').addEventListener('click', async () => {
  await api.logout().catch(() => {});
  location.href = '/login';
});

api
  .config()
  .then((config) => {
    if (config.name) el('greeting').textContent = `Shared with ${config.name}`;
    el('hint').textContent = canStreamToDisk
      ? 'Large downloads stream straight to disk, and pick up where they stopped if the connection drops.'
      : 'Tip: use a Chromium browser and very large downloads will stream straight to disk.';
  })
  .catch(() => {
    el('hint').textContent = '';
  });

refreshFiles();
