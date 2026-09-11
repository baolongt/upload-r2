import { api } from './api.js';
import { ChunkedUpload, UploadState, listResumable, forgetResumable, matchesRecord } from './uploader.js';
import { canStreamToDisk } from './downloader.js';
import { fileRow } from './filerow.js';
import { initRecipients, recipientsFilesChanged } from './recipients.js';
import {
  button,
  capitalize,
  el,
  formatBytes,
  formatDate,
  formatDuration,
  rowTemplate,
  speedOf,
} from './format.js';

const dropzone = el('dropzone');
const fileInput = el('file-input');
const uploadsEl = el('uploads');
const filesEl = el('files');
const partSizeEl = el('part-size');
const concurrencyEl = el('concurrency');

const uploads = new Map(); // id -> { upload, node, samples }
let resumableRecords = listResumable();

/* ---------- upload rows ---------- */

function renderUpload(upload) {
  const entry = uploads.get(upload.id);
  if (!entry) return;
  const { node } = entry;
  const bar = node.querySelector('.bar > span');
  const status = node.querySelector('.status');
  const actions = node.querySelector('.actions');

  bar.style.width = `${(upload.progress * 100).toFixed(1)}%`;
  node.classList.toggle('done', upload.state === UploadState.DONE);
  node.classList.toggle('error', upload.state === UploadState.ERROR);

  if (upload.state === UploadState.UPLOADING) {
    const speed = speedOf(entry, upload.loaded);
    const remaining = speed ? (upload.file.size - upload.loaded) / speed : NaN;
    status.textContent = `${(upload.progress * 100).toFixed(1)}% · ${formatBytes(upload.loaded)} of ${formatBytes(
      upload.file.size
    )}${speed ? ` · ${formatBytes(speed)}/s · ${formatDuration(remaining)} left` : ''}`;
  } else if (upload.state === UploadState.ERROR) {
    status.textContent = `Failed: ${upload.error?.message ?? 'unknown error'}`;
  } else if (upload.state === UploadState.DONE) {
    status.textContent = `Uploaded · ${upload.key}`;
  } else if (upload.state === UploadState.PAUSED) {
    status.textContent = `Paused at ${(upload.progress * 100).toFixed(1)}%`;
  } else {
    status.textContent = capitalize(upload.state);
  }

  actions.replaceChildren();
  if (upload.state === UploadState.UPLOADING || upload.state === UploadState.PREPARING) {
    actions.append(button('Pause', 'ghost', () => upload.pause()));
    actions.append(button('Cancel', 'ghost danger', () => upload.cancel()));
  } else if (upload.state === UploadState.PAUSED || upload.state === UploadState.ERROR) {
    actions.append(button('Resume', '', () => upload.resume()));
    actions.append(button('Cancel', 'ghost danger', () => upload.cancel()));
  } else if (upload.state === UploadState.DONE) {
    actions.append(
      button('Dismiss', 'ghost', () => {
        node.remove();
        uploads.delete(upload.id);
      })
    );
  } else if (upload.state === UploadState.CANCELED) {
    actions.append(
      button('Remove', 'ghost', () => {
        node.remove();
        uploads.delete(upload.id);
      })
    );
  }

  if (upload.state === UploadState.DONE && !entry.listed) {
    entry.listed = true;
    refreshFiles();
  }
}

let frameQueued = false;
const dirty = new Set();
function scheduleRender(upload) {
  dirty.add(upload);
  if (frameQueued) return;
  frameQueued = true;
  requestAnimationFrame(() => {
    frameQueued = false;
    for (const item of dirty) renderUpload(item);
    dirty.clear();
  });
}

async function addFile(file) {
  const record = resumableRecords.find((item) => matchesRecord(file, item));
  const upload = new ChunkedUpload(file, {
    partSize: Number(partSizeEl.value),
    concurrency: Number(concurrencyEl.value),
    onChange: scheduleRender,
  });

  if (uploads.has(upload.id)) return;
  const node = rowTemplate(file.name, file.size);
  uploads.set(upload.id, { upload, node, samples: [] });
  uploadsEl.prepend(node);
  renderUpload(upload);

  if (record) {
    // Same file as an interrupted upload: ask R2 which parts it already has.
    try {
      await upload.adopt(record);
      resumableRecords = resumableRecords.filter((item) => item.id !== record.id);
      renderResumable();
    } catch {
      forgetResumable(record.id);
    }
  }
  upload.start();
}

function handleFiles(fileList) {
  for (const file of fileList) addFile(file);
}

/* ---------- resumable banner ---------- */

function renderResumable() {
  const el2 = el('resumable');
  const active = resumableRecords.filter((record) => !uploads.has(record.id));
  if (active.length === 0) {
    el2.hidden = true;
    return;
  }
  el2.hidden = false;
  el2.replaceChildren();
  const text = document.createElement('div');
  text.textContent = `${active.length} unfinished upload${active.length > 1 ? 's' : ''}: pick the same file again and it resumes where it stopped.`;
  el2.append(text);
  for (const record of active) {
    const line = document.createElement('div');
    line.className = 'muted';
    line.textContent = `• ${record.name} (${formatBytes(record.size)}, started ${formatDate(record.savedAt)})`;
    const forget = button('Forget', 'ghost', async () => {
      await api.abortUpload(record.key, record.uploadId).catch(() => {});
      forgetResumable(record.id);
      resumableRecords = resumableRecords.filter((item) => item.id !== record.id);
      renderResumable();
    });
    forget.style.marginLeft = '8px';
    line.append(forget);
    el2.append(line);
  }
}

/* ---------- bucket listing ---------- */

// Kept around so the sharing panel can offer the same files as checkboxes.
let bucketFiles = [];

async function refreshFiles() {
  try {
    const { files } = await api.listFiles();
    bucketFiles = files;
    filesEl.replaceChildren();
    if (files.length === 0) {
      filesEl.innerHTML = '<p class="muted empty">Nothing uploaded yet.</p>';
    } else {
      for (const file of files) {
        filesEl.append(
          fileRow(file, {
            concurrency: () => Number(concurrencyEl.value),
            onDelete: () => {
              bucketFiles = bucketFiles.filter((item) => item.key !== file.key);
              recipientsFilesChanged();
            },
          })
        );
      }
    }
    recipientsFilesChanged();
  } catch (error) {
    filesEl.innerHTML = `<p class="muted empty">Could not list files: ${error.message}</p>`;
  }
}

/* ---------- wiring ---------- */

// Kicked off here so the sharing panel can wait for the first listing before it
// offers those files as checkboxes.
const listed = refreshFiles();

dropzone.addEventListener('click', () => fileInput.click());
dropzone.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    fileInput.click();
  }
});
fileInput.addEventListener('change', () => {
  handleFiles(fileInput.files);
  fileInput.value = '';
});

for (const type of ['dragenter', 'dragover']) {
  dropzone.addEventListener(type, (event) => {
    event.preventDefault();
    dropzone.classList.add('over');
  });
}
for (const type of ['dragleave', 'drop']) {
  dropzone.addEventListener(type, (event) => {
    event.preventDefault();
    dropzone.classList.remove('over');
  });
}
dropzone.addEventListener('drop', (event) => handleFiles(event.dataTransfer.files));

el('refresh').addEventListener('click', refreshFiles);

window.addEventListener('beforeunload', (event) => {
  const active = [...uploads.values()].some((entry) => entry.upload.isActive);
  if (active) event.preventDefault();
});

api
  .config()
  .then(async (config) => {
    el('bucket-badge').textContent = `r2://${config.bucket}`;
    partSizeEl.value = String(config.defaultPartSize);
    concurrencyEl.value = String(config.defaultConcurrency);
    if (config.auth) {
      const logout = el('logout');
      logout.hidden = false;
      logout.addEventListener('click', async () => {
        await api.logout().catch(() => {});
        location.href = '/login';
      });
    }
    el('hint').textContent = canStreamToDisk
      ? 'Downloads over 128 MB stream straight to disk.'
      : 'Tip: use a Chromium browser to stream big downloads straight to disk.';

    // Recipients are told apart by their password, so with no APP_PASSWORD set
    // there is nothing to share *from* — the whole app is already open.
    if (!config.auth) return;
    el('sharing').hidden = false;
    await listed;
    await initRecipients({ files: () => bucketFiles });
  })
  .catch((error) => {
    el('bucket-badge').textContent = 'server not configured';
    el('hint').textContent = error.message;
  });

renderResumable();
