/**
 * Who may download what.
 *
 * The whole mapping lives in one small JSON object in the same bucket as the
 * files — no database to run, and it survives a redeploy on a platform with an
 * ephemeral filesystem. It is stored outside `config.keyPrefix`, so it never
 * shows up in a file listing and the key-taking endpoints cannot reach it.
 */
import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { BUCKET, r2 } from './r2.js';
import { config } from './config.js';
import { HttpError } from './keys.js';

const MANIFEST_VERSION = 1;
export const MIN_PASSWORD_LENGTH = 8;

/** No 0/O/1/l — these get read aloud and typed by hand. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';

const empty = () => ({ version: MANIFEST_VERSION, secret: null, users: [], updatedAt: null });

async function fetchManifest() {
  try {
    const object = await r2.send(new GetObjectCommand({ Bucket: BUCKET, Key: config.sharesKey }));
    const parsed = JSON.parse(await object.Body.transformToString());
    return {
      ...empty(),
      ...parsed,
      users: Array.isArray(parsed.users) ? parsed.users : [],
    };
  } catch (error) {
    const status = error?.$metadata?.httpStatusCode;
    if (status === 404 || error?.name === 'NoSuchKey' || error?.name === 'NotFound') return empty();
    throw error;
  }
}

let cache = null;
let cachedAt = 0;
// Every request that touches a file reads the mapping, so it is cached — but only
// briefly. A second instance of this app revoking a recipient has to take effect
// here too, and this is what bounds how long that takes.
const CACHE_MS = 30_000;

export async function load({ force = false } = {}) {
  if (!cache || force || Date.now() - cachedAt > CACHE_MS) {
    cache = await fetchManifest();
    cachedAt = Date.now();
  }
  return cache;
}

// One instance, one writer: changes queue up rather than overwriting each other.
// A failed update must not poison the queue for the next one.
let queue = Promise.resolve();

/**
 * Read the manifest fresh, let `mutator` change it, write it back. Whatever the
 * mutator returns is passed on to the caller.
 */
export function update(mutator) {
  const run = queue.then(apply, apply);
  queue = run.then(
    () => {},
    () => {}
  );
  return run;

  async function apply() {
    const manifest = await fetchManifest();
    // Generated on the first write and kept for the life of the mapping, so
    // rotating APP_PASSWORD does not lock every recipient out.
    if (!manifest.secret) manifest.secret = randomBytes(32).toString('base64');
    const result = await mutator(manifest);
    manifest.version = MANIFEST_VERSION;
    manifest.updatedAt = new Date().toISOString();
    await r2.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: config.sharesKey,
        Body: JSON.stringify(manifest, null, 2),
        ContentType: 'application/json',
      })
    );
    cache = manifest;
    cachedAt = Date.now();
    return result;
  }
}

/**
 * A recipient password is recognised by its keyed digest, which makes a sign-in
 * one hash instead of one per recipient. The key sits in the manifest, in the
 * bucket that already holds the files this protects, so the digests are worth no
 * more than the bucket itself — what keeps a password safe is its own entropy.
 * `generatePassword` hands out 16 characters (~91 bits) for exactly that reason.
 */
const digestPassword = (manifest, password) =>
  createHmac('sha256', Buffer.from(manifest.secret, 'base64'))
    .update(`share-password:${password}`)
    .digest('base64url');

function sameDigest(a, b) {
  const left = Buffer.from(String(a ?? ''), 'utf8');
  const right = Buffer.from(String(b ?? ''), 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

export function generatePassword(length = 16) {
  let out = '';
  for (let i = 0; i < length; i += 1) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

/** The password a visitor typed, turned into the recipient it belongs to. */
export async function findUserByPassword(password) {
  if (typeof password !== 'string' || !password) return null;
  const manifest = await load({ force: true });
  if (!manifest.secret || manifest.users.length === 0) return null;

  const digest = digestPassword(manifest, password);
  const user = manifest.users.find((candidate) => sameDigest(candidate.password, digest));
  return user ? publicUser(user) : null;
}

/** Everything about a recipient except the digest that lets them in. */
export const publicUser = (user) => ({
  id: user.id,
  name: user.name,
  keys: [...(user.keys ?? [])],
  createdAt: user.createdAt,
  // Changes whenever the password does, which is what retires open sessions.
  stamp: String(user.password ?? '').slice(0, 12),
});

export async function listUsers() {
  const manifest = await load();
  return manifest.users.map(publicUser);
}

export async function getUser(id) {
  const manifest = await load();
  const user = manifest.users.find((candidate) => candidate.id === id);
  return user ? publicUser(user) : null;
}

function assertPassword(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw new HttpError(400, `A password needs at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  // The admin password is checked first at sign-in, so handing it to a recipient
  // would quietly make them an admin instead.
  if (config.password && password === config.password) {
    throw new HttpError(409, 'That is the admin password — give the recipient one of their own');
  }
  return password;
}

/** Refuse a password that already belongs to someone else, or to the admin. */
function assertUnused(manifest, digest, exceptId) {
  if (manifest.users.some((user) => user.id !== exceptId && sameDigest(user.password, digest))) {
    throw new HttpError(409, 'That password is already in use');
  }
}

export async function createUser({ name, password }) {
  const chosen = assertPassword(password || generatePassword());
  return update((manifest) => {
    const digest = digestPassword(manifest, chosen);
    assertUnused(manifest, digest);
    const user = {
      id: `u_${randomBytes(6).toString('hex')}`,
      name: String(name ?? '').trim().slice(0, 80) || 'Recipient',
      password: digest,
      keys: [],
      createdAt: new Date().toISOString(),
    };
    manifest.users.push(user);
    // The only moment the plain password exists: the admin has to pass it on.
    return { user: publicUser(user), password: chosen };
  });
}

export async function setPassword(id, password) {
  const chosen = assertPassword(password || generatePassword());
  return update((manifest) => {
    const user = manifest.users.find((candidate) => candidate.id === id);
    if (!user) throw new HttpError(404, 'No such recipient');
    const digest = digestPassword(manifest, chosen);
    assertUnused(manifest, digest, id);
    user.password = digest;
    return { user: publicUser(user), password: chosen };
  });
}

export function renameUser(id, name) {
  return update((manifest) => {
    const user = manifest.users.find((candidate) => candidate.id === id);
    if (!user) throw new HttpError(404, 'No such recipient');
    user.name = String(name ?? '').trim().slice(0, 80) || user.name;
    return publicUser(user);
  });
}

export function deleteUser(id) {
  return update((manifest) => {
    const before = manifest.users.length;
    manifest.users = manifest.users.filter((candidate) => candidate.id !== id);
    if (manifest.users.length === before) throw new HttpError(404, 'No such recipient');
    return { deleted: true, id };
  });
}

/** Replace a recipient's whole list of files. */
export function setUserFiles(id, keys) {
  return update((manifest) => {
    const user = manifest.users.find((candidate) => candidate.id === id);
    if (!user) throw new HttpError(404, 'No such recipient');
    user.keys = [...new Set(keys)];
    return publicUser(user);
  });
}

/** A deleted object should not linger in anyone's list. */
export async function forgetKey(key) {
  const current = await load({ force: true });
  // Most deletes are of files nobody was given; those need no write at all.
  if (!current.users.some((user) => (user.keys ?? []).includes(key))) return { key };

  return update((manifest) => {
    for (const user of manifest.users) {
      user.keys = (user.keys ?? []).filter((candidate) => candidate !== key);
    }
    return { key };
  });
}

/** Is this recipient allowed to touch this object? */
export async function userHasKey(id, key) {
  const user = await getUser(id);
  return Boolean(user?.keys.includes(key));
}
