import { api } from './api.js';

const SIGN_BATCH = 100;          // presigned URLs fetched per round trip
const SIGN_REFRESH_MARGIN = 60_000; // re-sign a part if its URL expires within a minute
const MAX_ATTEMPTS = 5;

export const UploadState = {
  IDLE: 'idle',
  PREPARING: 'preparing',
  UPLOADING: 'uploading',
  PAUSED: 'paused',
  COMPLETING: 'completing',
  DONE: 'done',
  ERROR: 'error',
  CANCELED: 'canceled',
};

const STORAGE_KEY = 'upload-r2:resumable';

class Interrupted extends Error {}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Splits a File in the browser and pushes every chunk straight to R2 with a
 * presigned URL. The file never passes through our server, so a 50 GB upload
 * costs the server nothing but a handful of small JSON calls.
 */
export class ChunkedUpload {
  constructor(file, { partSize, concurrency = 4, onChange = () => {} } = {}) {
    this.id = `${file.name}:${file.size}:${file.lastModified}`;
    this.file = file;
    this.requestedPartSize = partSize;
    this.concurrency = Math.max(1, concurrency);
    this.onChange = onChange;

    this.state = UploadState.IDLE;
    this.error = null;
    this.key = null;
    this.uploadId = null;
    this.partSize = partSize;
    this.loaded = 0;

    this.etags = new Map();     // partNumber -> ETag, parts R2 has accepted
    this.pending = [];          // part numbers still to send, in order
    this.urls = new Map();      // partNumber -> { url, expiresAt }
    this.attempted = new Map(); // partNumber -> bytes reported by the last attempt

    this._xhrs = new Set();
    this._paused = false;
    this._canceled = false;
    this._signChain = Promise.resolve();
  }

  get progress() {
    return this.file.size === 0 ? 1 : Math.min(this.loaded / this.file.size, 1);
  }

  get isActive() {
    return [UploadState.PREPARING, UploadState.UPLOADING, UploadState.COMPLETING].includes(this.state);
  }

  _set(state, error = null) {
    this.state = state;
    this.error = error;
    this.onChange(this);
  }

  async start() {
    if (this.isActive) return;
    this._paused = false;
    this._canceled = false;

    try {
      if (!this.key) await this._prepare();
      if (this._session?.mode === 'single') {
        await this._uploadWhole();
      } else {
        await this._uploadParts();
        if (this._paused || this._canceled) return;
        this._set(UploadState.COMPLETING);
        const parts = [...this.etags.entries()].map(([partNumber, etag]) => ({ partNumber, etag }));
        await api.completeUpload(this.key, this.uploadId, parts);
      }
      this.loaded = this.file.size;
      forgetResumable(this.id);
      this._set(UploadState.DONE);
    } catch (error) {
      if (error instanceof Interrupted) {
        this._set(this._canceled ? UploadState.CANCELED : UploadState.PAUSED);
        return;
      }
      this._set(UploadState.ERROR, error);
    }
  }

  pause() {
    if (!this.isActive) return;
    this._paused = true;
    this._abortInflight();
    this._set(UploadState.PAUSED);
  }

  resume() {
    if (this.state === UploadState.PAUSED || this.state === UploadState.ERROR) this.start();
  }

  async cancel() {
    this._canceled = true;
    this._abortInflight();
    const { key, uploadId } = this;
    this._set(UploadState.CANCELED);
    forgetResumable(this.id);
    if (key && uploadId) await api.abortUpload(key, uploadId).catch(() => {});
  }

  /** Re-attach to an upload that a previous page load left half-finished. */
  async adopt(record) {
    this.key = record.key;
    this.uploadId = record.uploadId;
    this.partSize = record.partSize;
    this._session = { mode: 'multipart' };

    const { parts } = await api.listParts(this.key, this.uploadId);
    for (const part of parts) {
      if (part.size === this._sizeOfPart(part.partNumber)) {
        this.etags.set(part.partNumber, part.etag);
        this.loaded += part.size;
      }
    }
    this._rebuildPending();
    this._set(UploadState.PAUSED);
  }

  async _prepare() {
    this._set(UploadState.PREPARING);
    const session = await api.createUpload(this.file, this.requestedPartSize);
    this._session = session;
    this.key = session.key;
    if (session.mode === 'multipart') {
      this.uploadId = session.uploadId;
      this.partSize = session.partSize;
      this._rebuildPending();
      rememberResumable({
        id: this.id,
        key: this.key,
        uploadId: this.uploadId,
        partSize: this.partSize,
        name: this.file.name,
        size: this.file.size,
        lastModified: this.file.lastModified,
        savedAt: Date.now(),
      });
    }
  }

  _partCount() {
    return Math.max(1, Math.ceil(this.file.size / this.partSize));
  }

  _sizeOfPart(partNumber) {
    const start = (partNumber - 1) * this.partSize;
    return Math.min(this.partSize, this.file.size - start);
  }

  _rebuildPending() {
    this.pending = [];
    for (let partNumber = 1; partNumber <= this._partCount(); partNumber += 1) {
      if (!this.etags.has(partNumber)) this.pending.push(partNumber);
    }
  }

  /** Small files: one presigned PUT, still with real progress reporting. */
  async _uploadWhole() {
    this._set(UploadState.UPLOADING);
    const blob = this.file.slice(0, this.file.size, '');
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      this._checkInterrupted();
      try {
        await this._put(this._session.url, blob, 0);
        return;
      } catch (error) {
        this._rollbackPart(0);
        if (error instanceof Interrupted) throw error;
        if (attempt === MAX_ATTEMPTS) throw error;
        await sleep(Math.min(2 ** (attempt - 1) * 1000, 16_000));
      }
    }
  }

  /** Big files: a pool of workers chewing through the pending part numbers. */
  async _uploadParts() {
    this._set(UploadState.UPLOADING);
    const queue = [...this.pending];
    const workers = Array.from({ length: Math.min(this.concurrency, queue.length) }, async () => {
      while (queue.length) {
        this._checkInterrupted();
        const partNumber = queue.shift();
        await this._sendPart(partNumber);
        this.pending = this.pending.filter((n) => n !== partNumber);
        this.onChange(this);
      }
    });
    await Promise.all(workers);
  }

  async _sendPart(partNumber) {
    const start = (partNumber - 1) * this.partSize;
    // Slicing with an empty type keeps the browser from adding a Content-Type
    // header that was not part of the signature.
    const blob = this.file.slice(start, start + this._sizeOfPart(partNumber), '');

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      this._checkInterrupted();
      try {
        const url = await this._urlFor(partNumber);
        const etag = await this._put(url, blob, partNumber);
        this.etags.set(partNumber, etag);
        return;
      } catch (error) {
        this._rollbackPart(partNumber);
        if (error instanceof Interrupted) throw error;
        if (attempt === MAX_ATTEMPTS) throw new Error(`Part ${partNumber}: ${error.message}`);
        this.urls.delete(partNumber); // a stale signature is a plausible cause
        await sleep(Math.min(2 ** (attempt - 1) * 1000, 16_000) + Math.random() * 400);
      }
    }
  }

  _rollbackPart(partNumber) {
    this.loaded -= this.attempted.get(partNumber) ?? 0;
    this.attempted.delete(partNumber);
    this.onChange(this);
  }

  _put(url, blob, partNumber) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      this._xhrs.add(xhr);
      xhr.open('PUT', url, true);

      xhr.upload.onprogress = (event) => {
        const previous = this.attempted.get(partNumber) ?? 0;
        this.attempted.set(partNumber, event.loaded);
        this.loaded += event.loaded - previous;
        this.onChange(this);
      };

      xhr.onload = () => {
        this._xhrs.delete(xhr);
        if (xhr.status < 200 || xhr.status >= 300) {
          reject(new Error(`R2 answered HTTP ${xhr.status}`));
          return;
        }
        // Confirm the full part is accounted for even if no final progress event fired.
        const previous = this.attempted.get(partNumber) ?? 0;
        this.loaded += blob.size - previous;
        this.attempted.set(partNumber, blob.size);
        const etag = xhr.getResponseHeader('ETag');
        if (!etag && partNumber > 0) {
          reject(
            new Error(
              'R2 did not expose an ETag header. Add "ETag" to ExposeHeaders in the bucket CORS rules (npm run cors).'
            )
          );
          return;
        }
        resolve(etag);
      };

      xhr.onerror = () => {
        this._xhrs.delete(xhr);
        reject(new Error('Network error (check the bucket CORS rules and your connection)'));
      };
      xhr.onabort = () => {
        this._xhrs.delete(xhr);
        reject(new Interrupted('Upload interrupted'));
      };

      xhr.send(blob);
    });
  }

  /** Presigned URLs are fetched in batches and refreshed before they expire. */
  async _urlFor(partNumber) {
    const cached = this.urls.get(partNumber);
    if (cached && cached.expiresAt - Date.now() > SIGN_REFRESH_MARGIN) return cached.url;

    const signing = this._signChain.then(() => this._signBatch(partNumber));
    this._signChain = signing.catch(() => {});
    await signing;

    const fresh = this.urls.get(partNumber);
    if (!fresh) throw new Error(`No presigned URL for part ${partNumber}`);
    return fresh.url;
  }

  async _signBatch(partNumber) {
    const usable = (n) => {
      const entry = this.urls.get(n);
      return entry && entry.expiresAt - Date.now() > SIGN_REFRESH_MARGIN;
    };
    if (usable(partNumber)) return; // an earlier call in the chain already covered it

    const wanted = [partNumber];
    for (const n of this.pending) {
      if (wanted.length >= SIGN_BATCH) break;
      if (n !== partNumber && !usable(n)) wanted.push(n);
    }

    const { urls, expiresIn } = await api.signParts(this.key, this.uploadId, wanted);
    const expiresAt = Date.now() + expiresIn * 1000;
    for (const entry of urls) this.urls.set(entry.partNumber, { url: entry.url, expiresAt });
  }

  _abortInflight() {
    for (const xhr of this._xhrs) xhr.abort();
    this._xhrs.clear();
  }

  _checkInterrupted() {
    if (this._canceled || this._paused) throw new Interrupted('Upload interrupted');
  }
}

/* ---- resumable-upload bookkeeping in localStorage ---- */

export function listResumable() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
  } catch {
    return [];
  }
}

function rememberResumable(record) {
  const records = listResumable().filter((item) => item.id !== record.id);
  records.push(record);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(records.slice(-20)));
  } catch {
    /* storage full or disabled — resuming after a reload is a bonus, not a requirement */
  }
}

export function forgetResumable(id) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(listResumable().filter((item) => item.id !== id)));
  } catch {
    /* ignore */
  }
}

export function matchesRecord(file, record) {
  return file.name === record.name && file.size === record.size && file.lastModified === record.lastModified;
}
