import { Router } from 'express';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  ListPartsCommand,
  PutObjectCommand,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { BUCKET, r2 } from '../r2.js';
import { config, limits } from '../config.js';
import { assertOwnedKey, buildKey, choosePartSize, HttpError } from '../keys.js';

export const uploadsRouter = Router();

const MAX_SIGN_BATCH = 200;

/**
 * Step 1 — the browser announces a file, we reserve a key and open a multipart
 * upload. Nothing is streamed through this server; the browser talks to R2 directly.
 */
uploadsRouter.post('/create', async (req, res) => {
  const { filename, size, contentType, partSize: requestedPartSize } = req.body ?? {};
  const fileSize = Number(size);

  if (!Number.isFinite(fileSize) || fileSize < 0) {
    throw new HttpError(400, 'size must be a non-negative number');
  }
  if (fileSize > config.maxFileSize) {
    throw new HttpError(413, `File exceeds the ${config.maxFileSize} byte limit`);
  }

  const key = buildKey(filename);
  const type = typeof contentType === 'string' && contentType ? contentType : 'application/octet-stream';

  // Small files do not need multipart: one presigned PUT is a single round trip.
  if (fileSize <= limits.minPartSize) {
    const url = await getSignedUrl(
      r2,
      new PutObjectCommand({ Bucket: BUCKET, Key: key }),
      { expiresIn: config.presignExpires }
    );
    return res.json({ mode: 'single', key, url, expiresIn: config.presignExpires });
  }

  const partSize = choosePartSize(fileSize, requestedPartSize);
  const created = await r2.send(
    new CreateMultipartUploadCommand({
      Bucket: BUCKET,
      Key: key,
      ContentType: type,
      Metadata: { 'original-name': encodeURIComponent(String(filename ?? 'file')) },
    })
  );

  res.json({
    mode: 'multipart',
    key,
    uploadId: created.UploadId,
    partSize,
    partCount: Math.ceil(fileSize / partSize),
    expiresIn: config.presignExpires,
  });
});

/**
 * Step 2 — hand out presigned URLs for a batch of part numbers. The browser asks
 * for more as it works through the file, so URLs never go stale mid-upload.
 */
uploadsRouter.post('/sign', async (req, res) => {
  const { uploadId, partNumbers } = req.body ?? {};
  const key = assertOwnedKey(req.body?.key);

  if (!uploadId) throw new HttpError(400, 'uploadId is required');
  if (!Array.isArray(partNumbers) || partNumbers.length === 0) {
    throw new HttpError(400, 'partNumbers must be a non-empty array');
  }
  if (partNumbers.length > MAX_SIGN_BATCH) {
    throw new HttpError(400, `Ask for at most ${MAX_SIGN_BATCH} parts at a time`);
  }

  const urls = await Promise.all(
    partNumbers.map(async (raw) => {
      const partNumber = Number(raw);
      if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > limits.maxParts) {
        throw new HttpError(400, `Invalid part number: ${raw}`);
      }
      const url = await getSignedUrl(
        r2,
        new UploadPartCommand({ Bucket: BUCKET, Key: key, UploadId: uploadId, PartNumber: partNumber }),
        { expiresIn: config.presignExpires }
      );
      return { partNumber, url };
    })
  );

  res.json({ urls, expiresIn: config.presignExpires });
});

/** Which parts did R2 already accept? Used to resume an upload after a reload. */
uploadsRouter.get('/parts', async (req, res) => {
  const key = assertOwnedKey(req.query.key);
  const uploadId = req.query.uploadId;
  if (!uploadId) throw new HttpError(400, 'uploadId is required');

  const parts = [];
  let marker;
  do {
    const page = await r2.send(
      new ListPartsCommand({
        Bucket: BUCKET,
        Key: key,
        UploadId: String(uploadId),
        PartNumberMarker: marker,
      })
    );
    for (const part of page.Parts ?? []) {
      parts.push({ partNumber: part.PartNumber, etag: part.ETag, size: part.Size });
    }
    marker = page.IsTruncated ? page.NextPartNumberMarker : undefined;
  } while (marker);

  res.json({ parts });
});

/** Step 3 — stitch the parts together into the final object. */
uploadsRouter.post('/complete', async (req, res) => {
  const { uploadId, parts } = req.body ?? {};
  const key = assertOwnedKey(req.body?.key);

  if (!uploadId) throw new HttpError(400, 'uploadId is required');
  if (!Array.isArray(parts) || parts.length === 0) {
    throw new HttpError(400, 'parts must be a non-empty array');
  }

  const ordered = [...parts]
    .map((part) => ({ PartNumber: Number(part.partNumber ?? part.PartNumber), ETag: part.etag ?? part.ETag }))
    .sort((a, b) => a.PartNumber - b.PartNumber);

  if (ordered.some((part) => !Number.isInteger(part.PartNumber) || !part.ETag)) {
    throw new HttpError(400, 'Every part needs a partNumber and an etag');
  }

  const result = await r2.send(
    new CompleteMultipartUploadCommand({
      Bucket: BUCKET,
      Key: key,
      UploadId: uploadId,
      MultipartUpload: { Parts: ordered },
    })
  );

  res.json({ key, etag: result.ETag, location: result.Location ?? null });
});

/** Cancel an upload and let R2 drop the parts it is holding. */
uploadsRouter.post('/abort', async (req, res) => {
  const { uploadId } = req.body ?? {};
  const key = assertOwnedKey(req.body?.key);
  if (!uploadId) throw new HttpError(400, 'uploadId is required');

  await r2.send(new AbortMultipartUploadCommand({ Bucket: BUCKET, Key: key, UploadId: uploadId }));
  res.json({ aborted: true });
});
