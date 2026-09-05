import { createHash, createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';

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

/** A session is just a signed expiry — there is only one account to represent. */
export function signSession() {
  const expiresAt = Date.now() + config.sessionTtlHours * 3600_000;
  const body = `v1.${expiresAt}`;
  return `${body}.${digest(body).toString('base64url')}`;
}

export function verifySession(token) {
  if (typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return false;

  const expiresAt = Number(parts[1]);
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return false;

  let signature;
  try {
    signature = Buffer.from(parts[2], 'base64url');
  } catch {
    return false;
  }
  return equal(signature, digest(`v1.${parts[1]}`));
}

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

export const isSignedIn = (req) => !authEnabled || verifySession(readCookie(req, COOKIE_NAME));

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
