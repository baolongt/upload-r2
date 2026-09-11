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
import * as shares from '../shares.js';
import { assertOwnedKey, HttpError } from '../keys.js';
import { requireAdmin } from '../auth.js';

export const filesRouter = Router();

/** The display name of an object: the key without its folder and random prefix. */
const displayName = (key) => key.slice(key.lastIndexOf('/') + 1).replace(/^[0-9a-f]{12}-/, '');

const isAdmin = (req) => req.identity?.role === 'admin';

/** Everything the admin stored under the configured prefix, newest first. */
async function listAll(req, res) {
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
      name: displayName(object.Key),
      size: object.Size,
      lastModified: object.LastModified,
      etag: object.ETag,
    }))
    .sort((a, b) => new Date(b.lastModified) - new Date(a.lastModified));

  res.json({ files, cursor: page.IsTruncated ? page.NextContinuationToken : null });
}

/**
 * A recipient sees the files assigned to them and nothing else. Each one is
 * looked up directly rather than filtered out of a listing, so a recipient never
 * learns that the other objects exist. An assignment whose object has since been
 * deleted is quietly dropped.
 */
async function listAssigned(req, res) {
  const user = await shares.getUser(req.identity.sub);
  if (!user) throw new HttpError(401, 'Not signed in');

  const found = await Promise.all(
    user.keys.map(async (key) => {
      const head = await r2.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key })).catch(() => null);
      if (!head) return null;
      return {
        key,
        name: displayName(key),
        size: head.ContentLength,
        lastModified: head.LastModified,
        etag: head.ETag,
      };
    })
  );

  const files = found.filter(Boolean).sort((a, b) => new Date(b.lastModified) - new Date(a.lastModified));
  res.json({ files, cursor: null });
}

filesRouter.get('/', async (req, res) => {
  await (isAdmin(req) ? listAll(req, res) : listAssigned(req, res));
});

/**
 * A presigned GET plus the size, which is what the browser needs to slice the
 * download into ranged requests.
 */
filesRouter.get('/download-url', async (req, res) => {
  const key = assertOwnedKey(req.query.key);
  if (!isAdmin(req) && !(await shares.userHasKey(req.identity.sub, key))) {
    // Same answer as a key that does not exist: probing tells a recipient nothing.
    throw new HttpError(404, 'File not found');
  }

  const head = await r2.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key })).catch((error) => {
    if (error?.$metadata?.httpStatusCode === 404 || error?.name === 'NotFound') {
      throw new HttpError(404, 'File not found');
    }
    throw error;
  });

  const filename = displayName(key);
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

filesRouter.delete('/', requireAdmin, async (req, res) => {
  const key = assertOwnedKey(req.query.key);
  await r2.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
  // Nobody should keep pointing at an object that is gone.
  await shares.forgetKey(key).catch(() => {});
  res.json({ deleted: true, key });
});
