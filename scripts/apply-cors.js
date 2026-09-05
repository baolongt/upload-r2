/**
 * Applies the CORS rules the browser needs to talk to the bucket directly.
 *
 * Without these, presigned PUT/GET requests from the page are blocked, and the
 * uploader cannot read the ETag header it must send back on completion.
 *
 *   npm run cors           # uses CORS_ORIGIN from .env
 *   CORS_ORIGIN=https://app.example.com npm run cors
 */
import { GetBucketCorsCommand, PutBucketCorsCommand } from '@aws-sdk/client-s3';
import { BUCKET, r2 } from '../server/r2.js';
import { config } from '../server/config.js';

const origins = config.corsOrigin.split(',').map((origin) => origin.trim()).filter(Boolean);

const rules = [
  {
    AllowedOrigins: origins,
    AllowedMethods: ['GET', 'PUT', 'HEAD', 'DELETE'],
    AllowedHeaders: ['*'],
    // ETag is required: the browser sends it back when completing a multipart upload.
    ExposeHeaders: ['ETag', 'Content-Length', 'Content-Range', 'Content-Type'],
    MaxAgeSeconds: 3600,
  },
];

await r2.send(new PutBucketCorsCommand({ Bucket: BUCKET, CORSConfiguration: { CORSRules: rules } }));
console.log(`CORS applied to ${BUCKET} for: ${origins.join(', ')}`);

const current = await r2.send(new GetBucketCorsCommand({ Bucket: BUCKET }));
console.log(JSON.stringify(current.CORSRules, null, 2));
