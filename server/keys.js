import { randomBytes } from 'node:crypto';
import { config, limits } from './config.js';

const UNSAFE = /[^A-Za-z0-9._-]+/g;

/** Turn a browser-supplied filename into something safe to use in an object key. */
export function safeName(filename) {
  const base = String(filename ?? '')
    .split(/[/\\]/)
    .pop()
    .trim();
  const cleaned = base.replace(UNSAFE, '_').replace(/^\.+/, '').slice(0, 180);
  return cleaned || 'file';
}

/** Build a collision-free key: <prefix><date>/<random>-<name>. */
export function buildKey(filename) {
  const day = new Date().toISOString().slice(0, 10);
  const id = randomBytes(6).toString('hex');
  return `${config.keyPrefix}${day}/${id}-${safeName(filename)}`;
}

/**
 * Reject keys that try to escape the configured prefix. Every key the browser
 * sends back to us (sign / complete / abort / download / delete) goes through here.
 */
export function assertOwnedKey(key) {
  const value = String(key ?? '');
  if (!value || value.includes('..') || value.startsWith('/') || value.includes('\0')) {
    throw new HttpError(400, 'Invalid key');
  }
  if (!value.startsWith(config.keyPrefix)) {
    throw new HttpError(400, `Key must start with "${config.keyPrefix}"`);
  }
  return value;
}

/**
 * Pick a part size: at least R2's 5 MiB minimum, and small enough that the file
 * fits in 10 000 parts. Every part but the last must be exactly this size.
 */
export function choosePartSize(fileSize, requested) {
  let partSize = Math.max(Number(requested) || limits.minPartSize, limits.minPartSize);
  partSize = Math.min(partSize, limits.maxPartSize);
  while (Math.ceil(fileSize / partSize) > limits.maxParts) {
    partSize *= 2;
  }
  if (partSize > limits.maxPartSize) {
    throw new HttpError(400, 'File is too large to upload with the allowed part count');
  }
  return partSize;
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
