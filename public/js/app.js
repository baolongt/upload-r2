import { api } from './api.js';
import { ChunkedUpload, UploadState, listResumable, forgetResumable, matchesRecord } from './uploader.js';
import { ChunkedDownload, canStreamToDisk, openDiskWriter, shouldStreamToDisk } from './downloader.js';

const el = (id) => document.getElementById(id);
const dropzone = el('dropzone');
const fileInput = el('file-input');
const uploadsEl = el('uploads');
const filesEl = el('files');
const partSizeEl = el('part-size');
const concurrencyEl = el('concurrency');

const uploads = new Map(); // id -> { upload, node, samples }
let resumableRecords = listResumable();

/* ---------- formatting helpers ---------- */

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];
function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '–';
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${UNITS[unit]}`;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '–';
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${Math.round(seconds % 60)}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

const capitalize = (value) => value.charAt(0).toUpperCase() + value.slice(1);

function formatDate(value) {
  return new Date(value).toLocaleString();
}

/* ---------- upload rows ---------- */

function rowTemplate(name, size) {
  const node = document.createElement('div');
  node.className = 'item';
  node.innerHTML = `
    <div class="item-head">
      <span class="item-name"></span>
      <span class="item-meta">${formatBytes(size)}</span>
    </div>
    <div class="bar"><span></span></div>
    <div class="item-foot">
      <span class="status"></span>
      <span class="actions"></span>
    </div>`;
  node.querySelector('.item-name').textContent = name;
  return node;
}

function button(label, className, onClick) {
  const b = document.createElement('button');
  b.textContent = label;
  if (className) b.className = className;
  b.addEventListener('click', onClick);
  return b;
}

function speedOf(entry, loaded) {
  const now = performance.now();
  entry.samples.push({ t: now, loaded });
  while (entry.samples.length > 2 && now - entry.samples[0].t > 5000) entry.samples.shift();
  const first = entry.samples[0];
  const elapsed = (now - first.t) / 1000;
  if (elapsed < 0.4) return null;
  return (loaded - first.loaded) / elapsed;
}

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

/* ---------- bucket listing + downloads ---------- */

async function refreshFiles() {
  try {
    const { files } = await api.listFiles();
    filesEl.replaceChildren();
    if (files.length === 0) {
      filesEl.innerHTML = '<p class="muted empty">Nothing uploaded yet.</p>';
      return;
    }
    for (const file of files) filesEl.append(fileRow(file));
  } catch (error) {
    filesEl.innerHTML = `<p class="muted empty">Could not list files: ${error.message}</p>`;
  }
}

function fileRow(file) {
  const node = rowTemplate(file.name, file.size);
  node.querySelector('.item-meta').textContent = `${formatBytes(file.size)} · ${formatDate(file.lastModified)}`;
  const status = node.querySelector('.status');
  const actions = node.querySelector('.actions');
  const bar = node.querySelector('.bar > span');
  status.textContent = 'Ready';

  let remove;

  const download = button('Download', '', async () => {
    // The save dialog has to be opened here, while the click is still counted as a
    // user gesture — asking for the presigned URL first would spend it, and the
    // dialog would then never appear.
    let writer = null;
    if (shouldStreamToDisk(file.size)) {
      try {
        status.textContent = 'Choose where to save…';
        writer = await openDiskWriter(file.name);
      } catch (error) {
        status.textContent = error?.name === 'AbortError' ? 'Ready' : `Failed: ${error.message}`;
        return;
      }
    } else if (file.size > 512 * 1024 * 1024) {
      status.textContent = 'Buffering in memory (browser cannot stream to disk)…';
    }

    const labels = {
      preparing: 'Requesting download link…',
      assembling: 'Assembling the file — this can take a while for a large one…',
      saving: 'Handing the file to the browser…',
    };

    const render = (d) => {
      bar.style.width = `${(d.progress * 100).toFixed(1)}%`;
      if (d.state === 'downloading') {
        const stalled = d.stalledForSeconds;
        const warning = stalled > 10 ? ` · no data for ${Math.round(stalled)}s, retrying` : '';
        status.textContent =
          `${(d.progress * 100).toFixed(1)}% · ${formatBytes(d.loaded)} of ${formatBytes(d.size)}${warning}`;
      } else if (d.state === 'error') {
        status.textContent = `Failed: ${d.error?.message ?? 'unknown error'}`;
        node.classList.add('error');
      } else if (d.state === 'done') {
        status.textContent = 'Downloaded';
        node.classList.add('done');
      } else {
        status.textContent = labels[d.state] ?? capitalize(d.state);
      }
    };

    const job = new ChunkedDownload(file.key, {
      concurrency: Number(concurrencyEl.value),
      writer,
      onChange: render,
    });

    // A download that stops receiving data used to look identical to one that is
    // simply slow, so the status is refreshed on a timer too, not only on progress.
    const ticker = setInterval(() => render(job), 1000);
    const cancel = button('Cancel', 'ghost danger', () => job.cancel());
    download.disabled = true;
    remove.disabled = true;
    actions.append(cancel);
    try {
      await job.start();
    } finally {
      clearInterval(ticker);
      cancel.remove();
      download.disabled = false;
      remove.disabled = false;
    }
  });

  remove = button('Delete', 'ghost danger', async () => {
    if (!confirm(`Delete ${file.name} from the bucket?`)) return;
    remove.disabled = true;
    try {
      await api.deleteFile(file.key);
      node.remove();
    } catch (error) {
      status.textContent = `Delete failed: ${error.message}`;
      remove.disabled = false;
    }
  });

  actions.append(download, remove);
  return node;
}

/* ---------- wiring ---------- */

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
  .then((config) => {
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
  })
  .catch((error) => {
    el('bucket-badge').textContent = 'server not configured';
    el('hint').textContent = error.message;
  });

renderResumable();
refreshFiles();
