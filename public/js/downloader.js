import { api } from './api.js';

const DEFAULT_CHUNK_SIZE = 8 * 1024 * 1024;
const STREAM_THRESHOLD = 128 * 1024 * 1024; // above this, stream to disk instead of buffering
// A request that delivers no bytes at all for this long is treated as dead and retried.
// It covers the wait for headers and every gap during the body, so a connection that
// silently stops mid-chunk can no longer wedge the download forever.
const STALL_TIMEOUT_MS = 45_000;
const URL_REFRESH_MARGIN_MS = 5 * 60_000; // re-sign a download URL before it expires
// Buffering more than this in the page is not something a tab survives.
const MAX_MEMORY_DOWNLOAD = 2 * 1024 * 1024 * 1024;

export const canStreamToDisk = typeof window !== 'undefined' && 'showSaveFilePicker' in window;

/** Files this big are streamed to disk rather than buffered in the page. */
export const shouldStreamToDisk = (size) => canStreamToDisk && size > STREAM_THRESHOLD;

class Canceled extends Error {}

/**
 * Downloads an object from R2 with parallel HTTP Range requests.
 *
 * Where the browser supports the File System Access API the chunks are written
 * straight to the file the user picked, so a 50 GB download never has to fit in
 * memory. Everywhere else the chunks are collected as Blobs (the browser keeps
 * those on disk) and stitched together at the end.
 */
export class ChunkedDownload {
  constructor(key, { chunkSize = DEFAULT_CHUNK_SIZE, concurrency = 4, onChange = () => {}, writer = null } = {}) {
    this.key = key;
    this.chunkSize = chunkSize;
    this.concurrency = Math.max(1, concurrency);
    this.onChange = onChange;
    // A disk writer the caller opened while the user's click was still fresh.
    // The file picker needs that user gesture, and it does not survive the round
    // trip for the presigned URL — so it cannot be opened from in here.
    this.writer = writer;

    this.state = 'idle';
    this.error = null;
    this.loaded = 0;
    this.size = 0;
    // When bytes last arrived, so the UI can say "stuck" instead of just sitting there.
    this.lastProgressAt = Date.now();
    this.filename = key;
    this._canceled = false;
    this._controllers = new Set();
    this._url = null;
    this._urlExpiresAt = 0;
    this._refresh = Promise.resolve();
  }

  get progress() {
    return this.size ? Math.min(this.loaded / this.size, 1) : 0;
  }

  /** Seconds since the last byte arrived, while a transfer is in flight. */
  get stalledForSeconds() {
    return this.state === 'downloading' ? (Date.now() - this.lastProgressAt) / 1000 : 0;
  }

  get isActive() {
    return ['preparing', 'downloading', 'assembling', 'saving'].includes(this.state);
  }

  cancel() {
    this._canceled = true;
    for (const controller of this._controllers) controller.abort();
    this._controllers.clear();
    this._set('canceled');
  }

  _set(state, error = null) {
    this.state = state;
    this.error = error;
    this.onChange(this);
  }

  async start() {
    try {
      this._set('preparing');
      const info = await this._signUrl();
      this.size = info.size;
      this.filename = info.filename;

      // A multi-gigabyte file collected as Blobs will take the tab down with it.
      if (!this.writer && this.size > MAX_MEMORY_DOWNLOAD) {
        throw new Error(
          `This file is ${(this.size / 1024 ** 3).toFixed(1)} GB and this browser cannot stream ` +
            'downloads to disk. Open the app in Chrome or Edge, which can write the file out as ' +
            'it arrives instead of holding it in memory.'
        );
      }

      // Small file and nothing to stream into: one request, one save.
      if (this.size <= this.chunkSize && !this.writer) {
        this._set('downloading');
        const blob = await this._downloadRange(0, this.size - 1);
        this._set('saving');
        saveBlob(blob, this.filename);
        this._set('done');
        return;
      }

      const writer = this.writer ?? new BlobCollector();
      this._set('downloading');

      await this._pump(writer);

      // Stitching a multi-gigabyte Blob together is not instant, and neither is
      // handing it to the browser — both used to look like the download had died.
      this._set('assembling');
      const result = await writer.close();
      if (result) {
        this._set('saving');
        saveBlob(result, this.filename);
      }
      this._set('done');
    } catch (error) {
      if (error instanceof Canceled || error?.name === 'AbortError') {
        this._set('canceled');
        return;
      }
      this._set('error', error);
    }
  }

  /**
   * Runs `concurrency` range requests at a time but only ever holds a small
   * window of finished chunks, so memory stays bounded no matter the file size.
   */
  async _pump(writer) {
    const total = Math.ceil(this.size / this.chunkSize);
    const ready = new Map();
    const lookahead = this.concurrency * 2;
    let next = 0;
    let nextToWrite = 0;
    let writeChain = Promise.resolve();
    let writeError = null;
    let releaseSlot;
    let slot = new Promise((resolve) => { releaseSlot = resolve; });

    const flush = () => {
      writeChain = writeChain
        .then(async () => {
          while (ready.has(nextToWrite)) {
            const blob = ready.get(nextToWrite);
            ready.delete(nextToWrite);
            await writer.write(blob);
            nextToWrite += 1;
            releaseSlot();
            slot = new Promise((resolve) => { releaseSlot = resolve; });
          }
        })
        .catch((error) => {
          writeError ??= error;
          releaseSlot(); // never leave a worker parked on a write that failed
        });
      return writeChain;
    };

    const worker = async () => {
      while (next < total) {
        if (writeError) throw writeError;
        if (this._canceled) throw new Canceled('Download canceled');
        // Do not race too far ahead of the writer.
        while (next - nextToWrite >= lookahead) await slot;
        const index = next;
        next += 1;
        const start = index * this.chunkSize;
        const end = Math.min(start + this.chunkSize, this.size) - 1;
        // Bytes are counted inside _downloadRange as they stream in.
        ready.set(index, await this._downloadRange(start, end));
        flush();
      }
    };

    await Promise.all(Array.from({ length: Math.min(this.concurrency, total) }, worker));
    await flush();
    await writeChain;
    if (writeError) throw writeError;
  }

  /**
   * Presigned URLs live an hour; a download of tens of gigabytes can outlast that,
   * so the URL is re-signed before it lapses rather than every range suddenly 403ing
   * halfway through.
   */
  async _signUrl() {
    const info = await api.downloadUrl(this.key);
    this._url = info.url;
    this._urlExpiresAt = Date.now() + info.expiresIn * 1000;
    return info;
  }

  async _currentUrl() {
    if (this._url && this._urlExpiresAt - Date.now() > URL_REFRESH_MARGIN_MS) return this._url;
    const refresh = this._refresh.then(() => {
      if (this._url && this._urlExpiresAt - Date.now() > URL_REFRESH_MARGIN_MS) return; // someone beat us to it
      return this._signUrl();
    });
    this._refresh = refresh.catch(() => {});
    await refresh;
    return this._url;
  }

  /**
   * Fetches one range and returns it as a Blob, counting bytes into `loaded` as they
   * arrive rather than in one jump at the end — on a multi-gigabyte file a whole chunk
   * is far too coarse to show as progress, and a body that stops halfway has to be
   * noticed rather than waited on forever.
   */
  async _downloadRange(start, end, attempt = 1) {
    if (this._canceled) throw new Canceled('Download canceled');
    const url = await this._currentUrl();
    const controller = new AbortController();
    this._controllers.add(controller);

    let counted = 0; // bytes this attempt has already added to `loaded`
    let stalled = false;
    let lastByteAt = Date.now();
    const watchdog = setInterval(() => {
      if (Date.now() - lastByteAt > STALL_TIMEOUT_MS) {
        stalled = true;
        controller.abort();
      }
    }, 2000);

    try {
      const response = await fetch(url, {
        headers: { Range: `bytes=${start}-${end}` },
        signal: controller.signal,
      });
      if (response.status === 403) {
        // Almost always an expired signature: drop it and the retry will re-sign.
        this._url = null;
        throw new Error(`R2 refused bytes ${start}-${end} (expired link)`);
      }
      if (!response.ok) throw new Error(`R2 answered HTTP ${response.status} for bytes ${start}-${end}`);
      if (!response.body) return await response.blob(); // no stream to read, take it whole

      const reader = response.body.getReader();
      const parts = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value);
        counted += value.length;
        lastByteAt = Date.now();
        this.loaded += value.length;
        this.lastProgressAt = lastByteAt;
        this.onChange(this);
      }
      return new Blob(parts);
    } catch (error) {
      // A failed attempt must not leave its bytes on the counter.
      this.loaded -= counted;
      this.onChange(this);

      if (this._canceled) throw new Canceled('Download canceled');
      // An abort we caused ourselves must not look like the user cancelling.
      const cause = stalled
        ? new Error(`no data for ${STALL_TIMEOUT_MS / 1000}s on bytes ${start}-${end}`)
        : error;
      if (attempt >= 4) throw cause;
      await new Promise((resolve) => setTimeout(resolve, 2 ** attempt * 500));
      return this._downloadRange(start, end, attempt + 1);
    } finally {
      clearInterval(watchdog);
      this._controllers.delete(controller);
    }
  }
}

/**
 * Must be called straight from the click handler: the browser only opens the save
 * dialog while the user's gesture is still active. Throws AbortError if the user
 * dismisses the dialog.
 */
export async function openDiskWriter(filename) {
  const handle = await window.showSaveFilePicker({ suggestedName: filename });
  const stream = await handle.createWritable();
  return {
    write: (blob) => stream.write(blob),
    close: async () => {
      await stream.close();
      return null; // already on disk, nothing left to save
    },
  };
}

class BlobCollector {
  constructor() {
    this.parts = [];
  }
  write(blob) {
    this.parts.push(blob);
  }
  async close() {
    return new Blob(this.parts);
  }
}

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // Revoked when the page goes away rather than on a timer: a multi-gigabyte blob
  // can still be being written to disk long after any timeout we would pick, and
  // revoking early truncates the download.
  window.addEventListener('pagehide', () => URL.revokeObjectURL(url), { once: true });
}
