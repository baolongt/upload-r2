/**
 * Applies the CORS rules the browser needs to talk to the bucket directly.
 *
 * Without these, presigned PUT/GET requests from the page are blocked, and the
 * uploader cannot read the ETag header it must send back on completion.
 *
 *   npm run cors           # uses CORS_ORIGIN from .env
 *   CORS_ORIGIN=https://app.example.com npm run cors
 *
 * Note: editing bucket configuration needs an R2 API token with "Admin Read &
 * Write". The "Object Read & Write" token the app itself runs on is not enough,
 * and R2 answers AccessDenied. Setting the same rules by hand in the dashboard
 * (bucket -> Settings -> CORS Policy) works just as well.
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

try {
  await r2.send(new PutBucketCorsCommand({ Bucket: BUCKET, CORSConfiguration: { CORSRules: rules } }));
  console.log(`CORS applied to ${BUCKET} for: ${origins.join(', ')}`);

  const current = await r2.send(new GetBucketCorsCommand({ Bucket: BUCKET }));
  console.log(JSON.stringify(current.CORSRules, null, 2));
} catch (error) {
  if (error.name === 'AccessDenied' || error.$metadata?.httpStatusCode === 403) {
    console.error(
      [
        '',
        `Access denied while setting the CORS policy on "${BUCKET}".`,
        '',
        'Changing bucket configuration needs an R2 API token with "Admin Read & Write".',
        'A token with only "Object Read & Write" (what the app itself needs) cannot do it.',
        '',
        'Either create an Admin Read & Write token and re-run this, or paste these rules',
        'into the dashboard by hand: R2 -> your bucket -> Settings -> CORS Policy:',
        '',
        JSON.stringify(rules, null, 2),
        '',
      ].join('\n')
    );
    process.exit(1);
  }
  throw error;
}
