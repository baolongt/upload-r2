import { api } from './api.js';

const DEFAULT_CHUNK_SIZE = 8 * 1024 * 1024;
const STREAM_THRESHOLD = 128 * 1024 * 1024; // above this, stream to disk instead of buffering
const RESPONSE_TIMEOUT_MS = 60_000; // give up waiting for a range request to answer

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
    this.filename = key;
    this._canceled = false;
    this._controllers = new Set();
  }

  get progress() {
    return this.size ? Math.min(this.loaded / this.size, 1) : 0;
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
      const info = await api.downloadUrl(this.key);
      this.size = info.size;
      this.filename = info.filename;

      // Small file and nothing to stream into: one request, one save.
      if (this.size <= this.chunkSize && !this.writer) {
        this._set('downloading');
        const blob = await this._fetchRange(info.url, 0, this.size - 1).then((r) => r.blob());
        saveBlob(blob, this.filename);
        this._set('done');
        return;
      }

      const writer = this.writer ?? new BlobCollector();
      this._set('downloading');

      await this._pump(info.url, writer);
      const result = await writer.close();
      if (result) saveBlob(result, this.filename);
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
  async _pump(url, writer) {
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
        const response = await this._fetchRange(url, start, end);
        ready.set(index, await response.blob());
        this.loaded += end - start + 1;
        this.onChange(this);
        flush();
      }
    };

    await Promise.all(Array.from({ length: Math.min(this.concurrency, total) }, worker));
    await flush();
    await writeChain;
    if (writeError) throw writeError;
  }

  async _fetchRange(url, start, end, attempt = 1) {
    if (this._canceled) throw new Canceled('Download canceled');
    const controller = new AbortController();
    this._controllers.add(controller);
    // Only the wait for response headers is capped — once bytes start flowing a slow
    // connection is allowed to take as long as it needs.
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, RESPONSE_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        headers: { Range: `bytes=${start}-${end}` },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!response.ok) throw new Error(`R2 answered HTTP ${response.status} for bytes ${start}-${end}`);
      return response;
    } catch (error) {
      clearTimeout(timer);
      if (this._canceled) throw new Canceled('Download canceled');
      // An abort we caused ourselves must not look like the user cancelling.
      const cause = timedOut
        ? new Error(`R2 did not respond within ${RESPONSE_TIMEOUT_MS / 1000}s for bytes ${start}-${end}`)
        : error;
      if (attempt >= 4) throw cause;
      await new Promise((resolve) => setTimeout(resolve, 2 ** attempt * 500));
      return this._fetchRange(url, start, end, attempt + 1);
    } finally {
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
