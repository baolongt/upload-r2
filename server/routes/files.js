import { Router } from 'express';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { BUCKET, r2 } from '../r2.js';
import { config } from '../config.js';
import { assertOwnedKey, HttpError } from '../keys.js';

export const filesRouter = Router();

/** Everything stored under the configured prefix, newest first. */
filesRouter.get('/', async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 1000);
  const page = await r2.send(
    new ListObjectsV2Command({
      Bucket: BUCKET,
      Prefix: config.keyPrefix,
      MaxKeys: limit,
      ContinuationToken: req.query.cursor ? String(req.query.cursor) : undefined,
    })
  );

  const files = (page.Contents ?? [])
    .map((object) => ({
      key: object.Key,
      name: object.Key.slice(object.Key.lastIndexOf('/') + 1).replace(/^[0-9a-f]{12}-/, ''),
      size: object.Size,
      lastModified: object.LastModified,
      etag: object.ETag,
    }))
    .sort((a, b) => new Date(b.lastModified) - new Date(a.lastModified));

  res.json({ files, cursor: page.IsTruncated ? page.NextContinuationToken : null });
});

/**
 * A presigned GET plus the size, which is what the browser needs to slice the
 * download into ranged requests.
 */
filesRouter.get('/download-url', async (req, res) => {
  const key = assertOwnedKey(req.query.key);
  const head = await r2.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key })).catch((error) => {
    if (error?.$metadata?.httpStatusCode === 404 || error?.name === 'NotFound') {
      throw new HttpError(404, 'File not found');
    }
    throw error;
  });

  const filename = key.slice(key.lastIndexOf('/') + 1).replace(/^[0-9a-f]{12}-/, '');
  const url = await getSignedUrl(
    r2,
    new GetObjectCommand({
      Bucket: BUCKET,
      Key: key,
      ResponseContentDisposition: `attachment; filename="${filename.replace(/"/g, '')}"`,
    }),
    { expiresIn: config.presignExpires }
  );

  res.json({
    key,
    url,
    filename,
    size: head.ContentLength,
    contentType: head.ContentType ?? 'application/octet-stream',
    expiresIn: config.presignExpires,
  });
});

filesRouter.delete('/', async (req, res) => {
  const key = assertOwnedKey(req.query.key);
  await r2.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
  res.json({ deleted: true, key });
});
