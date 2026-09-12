import { createHash, createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';
import { HttpError } from './keys.js';

export const COOKIE_NAME = 'upload_r2_session';
export const authEnabled = Boolean(config.password);

const secret = config.sessionSecret
  ? Buffer.from(config.sessionSecret)
  : createHash('sha256').update(`upload-r2:${config.password}`).digest();

const digest = (value) => createHmac('sha256', secret).update(value).digest();

/** Compare two digests without leaking how far they matched. */
function equal(a, b) {
  return a.length === b.length && timingSafeEqual(a, b);
}

export function checkPassword(input) {
  if (!authEnabled || typeof input !== 'string') return false;
  return equal(createHash('sha256').update(input).digest(), createHash('sha256').update(config.password).digest());
}

/**
 * A session now says who is signed in, not just that someone is: the admin, or
 * one recipient. `stamp` is the head of that recipient's password digest, so
 * changing their password retires the sessions it opened.
 */
export function signSession(identity) {
  const payload = {
    role: identity.role,
    sub: identity.sub,
    name: identity.name ?? null,
    stamp: identity.stamp ?? null,
    exp: Date.now() + config.sessionTtlHours * 3600_000,
  };
  const body = `v2.${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}`;
  return `${body}.${digest(body).toString('base64url')}`;
}

/** The identity a token carries, or null if it is expired, forged or malformed. */
export function readSession(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v2') return null;

  let signature;
  try {
    signature = Buffer.from(parts[2], 'base64url');
  } catch {
    return null;
  }
  if (!equal(signature, digest(`v2.${parts[1]}`))) return null;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || (payload.role !== 'admin' && payload.role !== 'user')) return null;
  if (!Number.isFinite(payload.exp) || payload.exp < Date.now()) return null;
  return payload;
}

export const verifySession = (token) => readSession(token) !== null;

export function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) return decodeURIComponent(part.slice(index + 1).trim());
  }
  return undefined;
}

/** Behind Railway (or any TLS proxy) the cookie must be marked Secure. */
function isHttps(req) {
  return req.secure || req.headers['x-forwarded-proto']?.split(',')[0].trim() === 'https';
}

export function setSessionCookie(req, res, token) {
  const attributes = [
    `${COOKIE_NAME}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${config.sessionTtlHours * 3600}`,
  ];
  if (isHttps(req)) attributes.push('Secure');
  res.setHeader('Set-Cookie', attributes.join('; '));
}

export function clearSessionCookie(req, res) {
  const attributes = [`${COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (isHttps(req)) attributes.push('Secure');
  res.setHeader('Set-Cookie', attributes.join('; '));
}

/**
 * Who is making this request. With no APP_PASSWORD set the app is open, and the
 * single anonymous visitor is treated as the admin — the behaviour this app had
 * before recipients existed.
 */
export function identityOf(req) {
  if (!authEnabled) return { role: 'admin', sub: 'admin', name: null, stamp: null };
  return readSession(readCookie(req, COOKIE_NAME));
}

export const isSignedIn = (req) => identityOf(req) !== null;

/** Guards everything a recipient must not reach: uploading, deleting, sharing. */
export function requireAdmin(req, _res, next) {
  if (req.identity?.role === 'admin') return next();
  next(new HttpError(403, 'Only the admin can do that'));
}

/**
 * Slows down password guessing: a handful of failures from one address and that
 * address has to wait. In-memory, which is enough for a single-instance app.
 */
const attempts = new Map();
const WINDOW_MS = 15 * 60_000;
const MAX_ATTEMPTS = 10;

export function tooManyAttempts(ip) {
  const record = attempts.get(ip);
  if (!record) return false;
  if (Date.now() - record.first > WINDOW_MS) {
    attempts.delete(ip);
    return false;
  }
  return record.count >= MAX_ATTEMPTS;
}

export function recordFailure(ip) {
  const record = attempts.get(ip);
  if (!record || Date.now() - record.first > WINDOW_MS) {
    attempts.set(ip, { first: Date.now(), count: 1 });
    return;
  }
  record.count += 1;
}

export function clearAttempts(ip) {
  attempts.delete(ip);
}

/** Small random delay, so a wrong password cannot be timed against a rejected one. */
export const jitter = () => new Promise((resolve) => setTimeout(resolve, randomInt(80, 240)));
