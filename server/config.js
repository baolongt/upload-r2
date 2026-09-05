import 'dotenv/config';

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable ${name}. Copy .env.example to .env and fill it in.`
    );
  }
  return value;
}

function int(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Environment variable ${name} must be an integer, got "${raw}"`);
  }
  return parsed;
}

const accountId = process.env.R2_ACCOUNT_ID;

export const config = {
  port: int('PORT', 3000),
  bucket: required('R2_BUCKET'),
  accountId,
  endpoint:
    process.env.R2_ENDPOINT ||
    (accountId
      ? `https://${accountId}.r2.cloudflarestorage.com`
      : required('R2_ENDPOINT')),
  accessKeyId: required('R2_ACCESS_KEY_ID'),
  secretAccessKey: required('R2_SECRET_ACCESS_KEY'),
  // Path-style addressing (bucket in the path, not the hostname). R2 works either
  // way; local S3 mocks and MinIO need this on.
  forcePathStyle: process.env.R2_FORCE_PATH_STYLE === 'true',
  // Folder every object is written under, keeps the bucket tidy.
  keyPrefix: (process.env.R2_KEY_PREFIX ?? 'uploads/').replace(/^\/+/, ''),
  // Lifetime of the presigned PUT/GET URLs handed to the browser.
  presignExpires: int('PRESIGN_EXPIRES', 3600),
  // Hard ceiling enforced when a browser asks to start an upload.
  maxFileSize: int('MAX_FILE_SIZE', 5 * 1024 * 1024 * 1024 * 1024), // 5 TiB, the R2 object limit
  // Origin allowed to talk to the bucket directly, used by scripts/apply-cors.js.
  corsOrigin: process.env.CORS_ORIGIN || 'http://localhost:3000',
};

export const limits = {
  // R2 rejects parts smaller than 5 MiB (except the final one) and more than 10k parts.
  minPartSize: 5 * 1024 * 1024,
  maxPartSize: 5 * 1024 * 1024 * 1024,
  maxParts: 10000,
};
